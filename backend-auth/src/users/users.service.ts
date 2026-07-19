import {
  Injectable,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoKeysService } from '../auth/crypto-keys.service';
import { RecoveryService } from '../auth/recovery.service';
import { SafeScoreService } from '../risk/safe-score.service';
import { RegisterDto } from './dto/register.dto';
import { AssessRiskDto } from './dto/assess-risk.dto';

// ─── Risk tier thresholds ─────────────────────────────────────────────────────
const SCORE_HIGH = 80;
const SCORE_MODERATE = 40;

export type RiskFlow = 'HIGH' | 'MODERATE' | 'LOW';

export interface RegisterResult {
  userId: string;
  name: string;
  age: number;
  publicKey: string;
  privateKey: string;
  recoveryWords: string[];
}

export interface AssessRiskResult {
  flow: RiskFlow;
  safeScore: number;
  message: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cryptoKeys: CryptoKeysService,
    private readonly recovery: RecoveryService,
    private readonly safeScore: SafeScoreService,
  ) {}

  // ─── Registration ──────────────────────────────────────────────────────────

  async register(dto: RegisterDto): Promise<RegisterResult> {
    // Guard: userId (username/email) must be globally unique
    const existing = await this.prisma.user.findUnique({
      where: { userId: dto.userId },
    });
    if (existing) {
      throw new ConflictException(
        `User ID '${dto.userId}' is already registered.`,
      );
    }

    // 1. Generate Ed25519 keypair — private key returned to user, NEVER stored
    const { publicKey, privateKey } = this.cryptoKeys.generateUserKeyPair();

    // 2. Generate 15 recovery words + AES-encrypted hash for DB storage
    const { words, recoveryHash } = this.recovery.generateRecoveryCodes();

    // 3. Persist the user record (public key + recovery hash only)
    const user = await this.prisma.user.create({
      data: {
        userId: dto.userId,
        name: dto.name,
        age: dto.age,
        publicKey,
        recoveryHash,
      },
    });

    this.logger.log(`New user registered: ${user.id} (${dto.userId})`);

    return {
      userId: user.userId,
      name: user.name,
      age: user.age,
      publicKey,
      privateKey, // shown once — never stored
      recoveryWords: words, // shown once — never stored in plaintext
    };
  }

  // ─── Risk Assessment ───────────────────────────────────────────────────────

  async assessRisk(dto: AssessRiskDto): Promise<AssessRiskResult> {
    const user = await this.prisma.user.findUnique({
      where: { userId: dto.userId },
      include: { credentials: true },
    });

    if (!user) {
      throw new NotFoundException(`User '${dto.userId}' not found.`);
    }

    const hasPasskeyRegistered = user.credentials.length > 0;

    const safeScore = await this.safeScore.evaluateSafeScore({
      userId: user.id,
      currentIp: dto.currentIp,
      currentGeo: dto.currentGeo,
      browserExtensions: dto.browserExtensions ?? [],
      userAgent: dto.userAgent ?? '',
      hasPasskeyRegistered,
    });

    const flow = this._resolveFlow(safeScore);
    const message = this._flowMessage(flow);

    // ── Persist this login attempt as a LoginEvent (successful = false until
    //    WebAuthn verify confirms the credential).  This gives future
    //    assess-risk calls real data for the "failed attempts", "novel country",
    //    and "impossible travel" rules.
    //    vpnDetected is true when the CIDR check flags the IP.
    const vpnDetected = !!(dto.currentIp && this._isVpnIp(dto.currentIp));
    const location = dto.currentGeo
      ? `${dto.currentGeo.lat},${dto.currentGeo.lon},${dto.currentGeo.country}`
      : '0,0,XX';

    try {
      await this.prisma.loginEvent.create({
        data: {
          userId: user.id,
          ipAddress: dto.currentIp ?? '0.0.0.0',
          location,
          userAgent: dto.userAgent ?? null,
          vpnDetected,
          successful: false,  // marked true only after WebAuthn verify
          safeScore,
        },
      });
    } catch (e) {
      // Non-fatal — don't block the login flow if the audit write fails
      this.logger.warn('Failed to write LoginEvent (audit): ' + String(e));
    }

    this.logger.log(
      `Risk assessment for ${dto.userId}: score=${safeScore} flow=${flow} vpn=${vpnDetected}`,
    );

    return { flow, safeScore, message };
  }

  /**
   * Called by WebAuthnController after a successful `verifyAuthenticationResponse`.
   * Marks the most-recent pending LoginEvent for this user as successful=true,
   * so subsequent assess-risk calls can use real history for novel-country /
   * impossible-travel / failed-attempt rules.
   */
  async recordLoginSuccess(userId: string): Promise<void> {
    // Find the most recent pending (unsuccessful) event for this user
    const event = await this.prisma.loginEvent.findFirst({
      where: { userId, successful: false },
      orderBy: { timestamp: 'desc' },
    });
    if (!event) return;

    await this.prisma.loginEvent.update({
      where: { id: event.id },
      data: { successful: true },
    });
  }

  /** Checks whether an IP matches the hardcoded home IP. */
  private _isVpnIp(ip: string): boolean {
    const HARDCODED_HOME_IP = '152.58.17.6';
    return ip !== HARDCODED_HOME_IP && ip !== '127.0.0.1' && ip !== '::1' && ip !== '0.0.0.0';
  }

  // ─── Recovery ──────────────────────────────────────────────────────────────

  async getRecoveryChallenge(userId: string): Promise<number[]> {
    const user = await this.prisma.user.findUnique({ where: { userId } });
    if (!user) {
      throw new NotFoundException(`User '${userId}' not found.`);
    }
    return this.recovery.generateRecoveryChallenge();
  }

  async verifyRecovery(
    userId: string,
    words: Record<number, string>,
  ): Promise<{ success: boolean; message: string }> {
    const user = await this.prisma.user.findUnique({ where: { userId } });
    if (!user) {
      throw new NotFoundException(`User '${userId}' not found.`);
    }

    const valid = this.recovery.verifyRecoveryResponse(user.recoveryHash, words);

    if (!valid) {
      throw new UnauthorizedException(
        'Recovery words do not match. Please check the words and try again.',
      );
    }

    this.logger.log(`Account recovered for user ${userId}`);

    return {
      success: true,
      message: 'Account recovered, please register a new passkey',
    };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private _resolveFlow(score: number): RiskFlow {
    if (score >= SCORE_HIGH) return 'HIGH';
    if (score >= SCORE_MODERATE) return 'MODERATE';
    return 'LOW';
  }

  private _flowMessage(flow: RiskFlow): string {
    switch (flow) {
      case 'HIGH':
        return 'Direct Passkey login allowed';
      case 'MODERATE':
        return 'QR code or Notification required';
      case 'LOW':
        return 'Notification verification only';
    }
  }
}
