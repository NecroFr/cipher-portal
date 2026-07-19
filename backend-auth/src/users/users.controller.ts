import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';
import { RegisterDto } from './dto/register.dto';
import { AssessRiskDto } from './dto/assess-risk.dto';
import { RecoveryChallengeDto } from './dto/recovery-challenge.dto';
import { RecoveryVerifyDto } from './dto/recovery-verify.dto';

@Controller('api')
export class UsersController {
  private readonly logger = new Logger(UsersController.name);
  constructor(
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/register
  // Creates a new user. Generates Ed25519 keypair + 15 recovery words.
  // The private key and recovery words are returned ONCE and never stored.
  // ─────────────────────────────────────────────────────────────────────────
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto) {
    const result = await this.usersService.register(dto);
    return {
      success: true,
      data: result,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/login/assess-risk
  // Evaluates context signals and returns a risk flow tier:
  //   HIGH (≥80)     → Direct Passkey login
  //   MODERATE (40–79) → QR / Notification required
  //   LOW (<40)      → Notification verification only
  // ─────────────────────────────────────────────────────────────────────────
  @Post('login/assess-risk')
  @HttpCode(HttpStatus.OK)
  async assessRisk(@Body() dto: AssessRiskDto) {
    const result = await this.usersService.assessRisk(dto);
    return {
      success: true,
      data: result,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/login/record-success
  // Called by the frontend after a successful MODERATE or LOW verification
  // (word-game / QR) to mark the pending LoginEvent as successful=true.
  // This prevents successful logins from being counted as "failed attempts"
  // in future safe-score assessments, which would otherwise degrade the score
  // and force users into increasingly restricted login flows.
  // ─────────────────────────────────────────────────────────────────────────
  @Post('login/record-success')
  @HttpCode(HttpStatus.OK)
  async recordLoginSuccess(@Body() body: { userId: string }) {
    const { userId } = body;
    if (!userId) {
      throw new BadRequestException('userId is required.');
    }

    // Resolve human-readable userId → internal DB id
    const user = await this.prisma.user.findUnique({ where: { userId } });
    if (!user) {
      throw new NotFoundException(`User '${userId}' not found.`);
    }

    await this.usersService.recordLoginSuccess(user.id);
    this.logger.log(`[POST /api/login/record-success] userId=${userId}`);

    return { success: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/recovery/challenge
  // Returns 2–3 random word-position indices for the recovery challenge.
  // ─────────────────────────────────────────────────────────────────────────
  @Post('recovery/challenge')
  @HttpCode(HttpStatus.OK)
  async recoveryChallenge(@Body() dto: RecoveryChallengeDto) {
    const indices = await this.usersService.getRecoveryChallenge(dto.userId);
    return {
      success: true,
      data: { indices },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/recovery/verify
  // Verifies the user's submitted recovery words against the stored hash.
  // On success, signals the frontend to prompt passkey re-registration.
  // ─────────────────────────────────────────────────────────────────────────
  @Post('recovery/verify')
  @HttpCode(HttpStatus.OK)
  async recoveryVerify(@Body() dto: RecoveryVerifyDto) {
    const result = await this.usersService.verifyRecovery(dto.userId, dto.words);
    return {
      success: true,
      data: result,
    };
  }
  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/user/:userId
  // Returns the user's public profile: publicKey, name, age.
  // The PUBLIC key is safe to return — it's designed to be shared.
  // Private key + recovery words are NEVER returned by any endpoint.
  // ─────────────────────────────────────────────────────────────────────────
  @Get('user/:userId')
  async getUser(@Param('userId') userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { userId },
      select: { userId: true, name: true, age: true, publicKey: true },
    });
    if (!user) {
      throw new NotFoundException(`User '${userId}' not found.`);
    }
    return {
      success: true,
      data: {
        userId: user.userId,
        name: user.name,
        age: user.age,
        publicKey: user.publicKey, // Ed25519 public key — safe to expose
      },
    };
  }
}
