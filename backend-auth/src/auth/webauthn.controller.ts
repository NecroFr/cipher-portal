import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { WebAuthnService } from './webauthn.service';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';

// ─── Request body shapes ──────────────────────────────────────────────────────

interface RegisterOptionsBody {
  /** Human-readable userId (e.g. email or username) */
  userId: string;
  deviceLabel?: string;
}

interface RegisterVerifyBody {
  userId: string;
  response: RegistrationResponseJSON;
}

interface LoginOptionsBody {
  /** Human-readable userId — we look up the DB id inside */
  userId: string;
}

interface LoginVerifyBody {
  userId: string;
  response: AuthenticationResponseJSON;
}

// ─── Controller ───────────────────────────────────────────────────────────────

/**
 * WebAuthnController
 *
 * All routes sit under `/api/webauthn/`.
 *
 * Registration flow:
 *   POST /api/webauthn/register/options  → returns PublicKeyCredentialCreationOptionsJSON
 *   POST /api/webauthn/register/verify   → verifies & persists the credential
 *
 * Authentication flow:
 *   POST /api/webauthn/login/options     → returns PublicKeyCredentialRequestOptionsJSON
 *   POST /api/webauthn/login/verify      → verifies the assertion & returns success
 *
 * All body `userId` values are the **human-readable** userId (e.g. an email).
 * This controller resolves the internal DB `id` via PrismaService before calling
 * WebAuthnService (which expects the DB `id` UUID).
 */
@Controller('api/webauthn')
export class WebAuthnController {
  private readonly logger = new Logger(WebAuthnController.name);

  constructor(
    private readonly webAuthn: WebAuthnService,
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  // ─── Internal helper ──────────────────────────────────────────────────────

  /**
   * Resolves the human-readable `userId` string to the internal DB `id` (UUID).
   * Throws a BadRequestException if the user is not found so callers get a
   * clean 400 rather than a 500.
   */
  private async resolveDbId(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { userId } });
    if (!user) {
      throw new BadRequestException(`User '${userId}' not found.`);
    }
    return user.id;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REGISTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/webauthn/register/options
   *
   * Generates WebAuthn registration options (challenge + RP config) for a
   * given user.  The browser passes the returned JSON directly into
   * `startRegistration({ optionsJSON })`.
   */
  @Post('register/options')
  @HttpCode(HttpStatus.OK)
  async registrationOptions(@Body() body: RegisterOptionsBody) {
    const { userId, deviceLabel } = body;
    if (!userId) {
      throw new BadRequestException('userId is required.');
    }

    this.logger.log(`[POST /api/webauthn/register/options] userId=${userId}`);

    const dbId = await this.resolveDbId(userId);
    const options = await this.webAuthn.generateRegistrationChallenge(
      dbId,
      deviceLabel,
    );

    return options; // PublicKeyCredentialCreationOptionsJSON
  }

  /**
   * POST /api/webauthn/register/verify
   *
   * Verifies the authenticator's attestation response and persists the new
   * credential to the database.
   */
  @Post('register/verify')
  @HttpCode(HttpStatus.OK)
  async registrationVerify(@Body() body: RegisterVerifyBody) {
    const { userId, response } = body;
    if (!userId || !response) {
      throw new BadRequestException('userId and response are required.');
    }

    this.logger.log(`[POST /api/webauthn/register/verify] userId=${userId}`);

    const dbId = await this.resolveDbId(userId);
    const result = await this.webAuthn.verifyRegistrationResponse(dbId, response);

    return {
      success: result.verified,
      credentialId: result.credentialId,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTHENTICATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/webauthn/login/options
   *
   * Generates WebAuthn authentication options (challenge + allowed credentials)
   * for a given user.  The browser passes the returned JSON directly into
   * `startAuthentication({ optionsJSON })`.
   */
  @Post('login/options')
  @HttpCode(HttpStatus.OK)
  async loginOptions(@Body() body: LoginOptionsBody) {
    const { userId } = body;
    if (!userId) {
      throw new BadRequestException('userId is required.');
    }

    this.logger.log(`[POST /api/webauthn/login/options] userId=${userId}`);

    const dbId = await this.resolveDbId(userId);
    const options = await this.webAuthn.generateAuthenticationChallenge(dbId);

    return options; // PublicKeyCredentialRequestOptionsJSON
  }

  /**
   * POST /api/webauthn/login/verify
   *
   * Verifies the authenticator's assertion response.  On success the frontend
   * can save the session and redirect to the dashboard.
   */
  @Post('login/verify')
  @HttpCode(HttpStatus.OK)
  async loginVerify(@Body() body: LoginVerifyBody) {
    const { userId, response } = body;
    if (!userId || !response) {
      throw new BadRequestException('userId and response are required.');
    }

    this.logger.log(`[POST /api/webauthn/login/verify] userId=${userId}`);

    const dbId = await this.resolveDbId(userId);
    const result = await this.webAuthn.verifyAuthenticationResponse(dbId, response);

    if (result.verified) {
      // Mark the most-recent pending LoginEvent as successful so future
      // risk assessments have accurate login history.
      await this.usersService.recordLoginSuccess(dbId).catch(() => {
        this.logger.warn('recordLoginSuccess failed silently for user ' + userId);
      });
    }

    return { success: result.verified };
  }
}
