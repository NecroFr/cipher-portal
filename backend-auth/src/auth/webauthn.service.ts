import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { PrismaService } from '../prisma/prisma.service';

// ─── In-memory challenge store (TTL-aware, no Redis required) ─────────────────

const CHALLENGE_TTL_MS = 120_000; // 2 minutes

interface ChallengeEntry {
  value: string;
  expiresAt: number;
}

/**
 * Simple in-process Map used as a challenge store.
 *
 * Why not Redis?  Redis is the right choice for a multi-instance production
 * deployment (challenges must be shared across nodes).  However, for a
 * single-process dev server — or any environment where Redis is not available
 * — this Map is 100% sufficient and removes the external dependency entirely.
 *
 * To switch back to Redis: replace the four `challengeStore.*` call-sites
 * with equivalent `redis.set / redis.get / redis.del` calls.
 */
class ChallengeStore {
  private readonly map = new Map<string, ChallengeEntry>();

  set(key: string, value: string): void {
    this.map.set(key, { value, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  }

  get(key: string): string | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

// ─── Key namespaces ───────────────────────────────────────────────────────────
const registrationKey = (userId: string) => `webauthn:reg-challenge:${userId}`;
const authKey         = (userId: string) => `webauthn:auth-challenge:${userId}`;

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class WebAuthnService {
  private readonly logger = new Logger(WebAuthnService.name);

  /** RP configuration — read from environment at startup */
  private readonly rpName: string;
  private readonly rpID: string;
  private readonly origin: string;

  private readonly challenges = new ChallengeStore();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.rpName = this.config.getOrThrow<string>('RP_NAME');
    this.rpID   = this.config.getOrThrow<string>('RP_ID');
    this.origin = this.config.getOrThrow<string>('RP_ORIGIN');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REGISTRATION FLOW
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * **Step 1 — Generate registration options.**
   *
   * Called by `POST /api/webauthn/register/options`.
   *
   * - Looks up the user record and their existing credentials.
   * - Calls `generateRegistrationOptions()` from SimpleWebAuthn.
   * - Persists the challenge in the in-memory store with a 2-minute TTL.
   * - Returns the full options JSON to the client (passed directly into
   *   `startRegistration()` on the browser side).
   */
  async generateRegistrationChallenge(
    userId: string,
    deviceLabel?: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    // Fetch the user so we know their username for the RP
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { credentials: true },
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    // Build the excludeCredentials list to prevent re-registering the same device.
    // cred.id is the WebAuthn credential ID (base64url string) stored during registration.
    const excludeCredentials = user.credentials.map((cred) => ({
      id: cred.id,
      transports: ['internal'] as AuthenticatorTransportFuture[],
    }));

    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userName: user.userId, // human-readable identifier
      // Suppress attestation for smoother UX — we don't need device certs
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
        // Prefer the platform (built-in) authenticator (Face ID, Touch ID, Windows Hello)
        authenticatorAttachment: 'platform',
      },
      // ES256 + RS256 — broadest authenticator support
      supportedAlgorithmIDs: [-7, -257],
    });

    // Persist challenge with 2-minute TTL — MUST be validated server-side
    this.challenges.set(
      registrationKey(userId),
      JSON.stringify({ challenge: options.challenge, deviceLabel }),
    );

    this.logger.log(
      `Registration challenge issued for user ${userId} (TTL ${CHALLENGE_TTL_MS / 1000}s)`,
    );

    return options;
  }

  /**
   * **Step 2 — Verify registration response & persist credential.**
   *
   * Called by `POST /api/webauthn/register/verify`.
   *
   * - Retrieves and **deletes** the challenge (one-time use).
   * - Calls `verifyRegistrationResponse()`.
   * - On success, writes the new `Credential` row linked to the user.
   *
   * @throws BadRequestException on stale/missing challenge or failed verification.
   */
  async verifyRegistrationResponse(
    userId: string,
    response: RegistrationResponseJSON,
  ): Promise<{ verified: boolean; credentialId: string }> {
    // Retrieve the stored challenge — reject if expired or not found
    const raw = this.challenges.get(registrationKey(userId));
    if (!raw) {
      throw new BadRequestException(
        'Registration challenge expired or not found. Please restart the registration flow.',
      );
    }

    const { challenge, deviceLabel } = JSON.parse(raw) as {
      challenge: string;
      deviceLabel?: string;
    };

    // Delete immediately — challenges are single-use
    this.challenges.delete(registrationKey(userId));

    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
      });
    } catch (err) {
      this.logger.warn(
        `Registration verification failed for ${userId}: ${(err as Error).message}`,
      );
      throw new BadRequestException(
        `WebAuthn registration verification failed: ${(err as Error).message}`,
      );
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException('Registration was not verified.');
    }

    const { credential } = verification.registrationInfo;

    // Persist the new Credential record
    await this.prisma.credential.create({
      data: {
        id: credential.id,
        userId,
        publicKey: Buffer.from(credential.publicKey),
        signCounter: BigInt(credential.counter),
        deviceLabel: deviceLabel ?? null,
      },
    });

    this.logger.log(
      `Credential ${credential.id} registered for user ${userId}`,
    );

    return { verified: true, credentialId: credential.id };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTHENTICATION FLOW
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * **Step 1 — Generate authentication options.**
   *
   * Called by `POST /api/webauthn/login/options`.
   *
   * - Fetches the user's registered credentials to build `allowCredentials`.
   * - Generates a fresh challenge via `generateAuthenticationOptions()`.
   * - Stores it in the in-memory challenge store with a 2-minute TTL.
   */
  async generateAuthenticationChallenge(
    userId: string,
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { credentials: true },
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    if (user.credentials.length === 0) {
      throw new BadRequestException(
        `User ${userId} has no registered credentials. Please register a passkey first.`,
      );
    }

    // allowCredentials tells the browser exactly which credentials to offer.
    // - id     : the real WebAuthn credential ID stored during registration (cred.id)
    // - transports: ['internal'] tells the browser these are platform (built-in)
    //              authenticators → Windows Hello, Touch ID, Face ID show up first.
    //   Without this hint the browser only shows external options (phone / security key).
    const allowCredentials = user.credentials.map((cred) => ({
      id: cred.id,
      transports: ['internal'] as AuthenticatorTransportFuture[],
    }));

    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials,
      userVerification: 'required',
    });

    // Persist challenge — single-use, expires in 2 minutes
    this.challenges.set(authKey(userId), options.challenge);

    this.logger.log(
      `Authentication challenge issued for user ${userId} (TTL ${CHALLENGE_TTL_MS / 1000}s)`,
    );

    return options;
  }

  /**
   * **Step 2 — Verify authentication response & update sign counter.**
   *
   * Called by `POST /api/webauthn/login/verify`.
   *
   * - Retrieves and **deletes** the challenge from the store.
   * - Looks up the matching `Credential` from the DB.
   * - Calls `verifyAuthenticationResponse()`.
   * - Updates the `signCounter` in the DB to allow replay-attack detection.
   *
   * @throws UnauthorizedException / BadRequestException on any failure.
   */
  async verifyAuthenticationResponse(
    userId: string,
    response: AuthenticationResponseJSON,
  ): Promise<{ verified: boolean }> {
    // Retrieve and immediately invalidate the stored challenge
    const challenge = this.challenges.get(authKey(userId));
    if (!challenge) {
      throw new BadRequestException(
        'Authentication challenge expired or not found. Please try again.',
      );
    }
    this.challenges.delete(authKey(userId));

    // Find the matching credential in the database
    const credential = await this.prisma.credential.findUnique({
      where: { id: response.id },
    });

    if (!credential || credential.userId !== userId) {
      throw new UnauthorizedException('Credential not found or does not belong to this user.');
    }

    let verification: VerifiedAuthenticationResponse;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        credential: {
          id: credential.id,
          publicKey: new Uint8Array(credential.publicKey),
          counter: Number(credential.signCounter),
          // transports not stored in schema — pass undefined
          transports: undefined,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Authentication verification failed for ${userId}: ${(err as Error).message}`,
      );
      throw new UnauthorizedException(
        `WebAuthn authentication failed: ${(err as Error).message}`,
      );
    }

    if (!verification.verified) {
      throw new UnauthorizedException('Passkey authentication was not verified.');
    }

    // ── Update signature counter (replay-attack mitigation) ──────────────────
    const { newCounter } = verification.authenticationInfo;
    await this.prisma.credential.update({
      where: { id: credential.id },
      data: { signCounter: BigInt(newCounter) },
    });

    this.logger.log(
      `User ${userId} authenticated with credential ${credential.id} (counter: ${newCounter})`,
    );

    return { verified: true };
  }
}
