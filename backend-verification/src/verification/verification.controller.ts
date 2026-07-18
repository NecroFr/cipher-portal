import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { NotificationService } from './notification.service';
import { QrService } from './qr.service';
import { VerificationGateway } from './verification.gateway';

// ---------------------------------------------------------------------------
// Request / Response DTOs (plain objects — add class-validator later if needed)
// ---------------------------------------------------------------------------

interface InitiateBody {
  sessionId: string;
  userId?: string;
  verificationType?: 'word_game' | 'qr';
}

interface NotifyVerifyBody {
  sessionId: string;
  chosenWords: string[];
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * VerificationController
 *
 * Routes
 * ──────
 *  POST /api/verification/initiate   → start a word-game or QR session
 *  POST /api/notification/verify     → submit 2-of-5 word answer from trusted device
 *  GET  /api/qr/verify               → QR scan landing (validate token, approve session)
 */
@Controller()
export class VerificationController {
  private readonly logger = new Logger(VerificationController.name);

  constructor(
    private readonly notificationService: NotificationService,
    private readonly qrService: QrService,
    private readonly gateway: VerificationGateway,
  ) {}

  // -------------------------------------------------------------------------
  // POST /api/verification/initiate
  // -------------------------------------------------------------------------

  /**
   * Called by the login browser to kick off a secondary verification flow.
   *
   * Body:
   *   { sessionId: string, userId?: string, verificationType?: 'word_game' | 'qr' }
   *
   * Returns:
   *   - word_game → { words: string[5], sessionId }
   *   - qr        → { dataUrl: string, validationUrl: string, expiresInSeconds: number }
   */
  @Post('api/verification/initiate')
  @HttpCode(HttpStatus.OK)
  async initiateVerification(@Body() body: InitiateBody) {
    const { sessionId, userId, verificationType = 'word_game' } = body;

    if (!sessionId) {
      throw new BadRequestException('sessionId is required.');
    }

    this.logger.log(
      `[POST /api/verification/initiate] sessionId=${sessionId}  type=${verificationType}  userId=${userId ?? 'anonymous'}`,
    );

    // ── Word-game flow ──
    if (verificationType === 'word_game') {
      const { words } = this.notificationService.initiateNotificationVerification(sessionId);

      // Push notification to the trusted device simulator if userId is provided
      if (userId && this.gateway.isSimulatorOnline(userId)) {
        this.gateway.pushNotificationAlert(userId, sessionId, words, 'word_game');
        this.logger.log(`Pushed word-game alert to simulator for userId=${userId}`);
      }

      return {
        success: true,
        verificationType: 'word_game',
        sessionId,
        words, // Displayed on the login screen
        wordCount: words.length,
        requiredSelections: 2,
        message: 'Display these 5 words on the login screen. The user selects 2 on their trusted device.',
      };
    }

    // ── QR-code flow ──
    if (verificationType === 'qr') {
      const result = await this.qrService.generateQRChallenge(sessionId);

      return {
        success: true,
        verificationType: 'qr',
        sessionId,
        ...result, // dataUrl, validationUrl, expiresInSeconds
        message: 'Display this QR code on the login screen for the user to scan.',
      };
    }

    throw new BadRequestException(
      `Unknown verificationType "${verificationType}". Use "word_game" or "qr".`,
    );
  }

  // -------------------------------------------------------------------------
  // POST /api/notification/verify
  // -------------------------------------------------------------------------

  /**
   * Called by the trusted device simulator after the user selects 2 words.
   *
   * Body:
   *   { sessionId: string, chosenWords: string[2] }
   *
   * Returns:
   *   { success: boolean, reason?: string }
   *
   * On success → gateway emits `verification_approved` to the login browser room.
   * On failure → gateway emits `verification_rejected`.
   */
  @Post('api/notification/verify')
  @HttpCode(HttpStatus.OK)
  submitNotificationVerification(@Body() body: NotifyVerifyBody) {
    const { sessionId, chosenWords } = body;

    if (!sessionId) {
      throw new BadRequestException('sessionId is required.');
    }
    if (!Array.isArray(chosenWords) || chosenWords.length !== 2) {
      throw new BadRequestException('chosenWords must be an array of exactly 2 strings.');
    }

    this.logger.log(
      `[POST /api/notification/verify] sessionId=${sessionId}  words=[${chosenWords.join(', ')}]`,
    );

    const session = this.notificationService.getSession(sessionId);
    if (!session) {
      throw new NotFoundException('Session not found or expired.');
    }

    const result = this.notificationService.submitDeviceVerification(sessionId, chosenWords);

    return {
      ...result,
      sessionId,
    };
  }

  // -------------------------------------------------------------------------
  // GET /api/qr/verify
  // -------------------------------------------------------------------------

  /**
   * QR code scan landing endpoint.
   * The QR image encodes a URL like:
   *   http://localhost:3002/api/qr/verify?session=<id>&token=<uuid>
   *
   * When scanned (or simulated via the simulator page), this endpoint:
   *  1. Validates the token against the stored challenge.
   *  2. Marks the session APPROVED.
   *  3. Fires `verification_approved` via Socket.IO to the login browser.
   *
   * Query params:
   *   session — the session ID
   *   token   — the UUID token embedded in the QR image
   */
  @Get('api/qr/verify')
  verifyQRCode(
    @Query('session') sessionId: string,
    @Query('token') token: string,
  ) {
    if (!sessionId || !token) {
      throw new BadRequestException('Both "session" and "token" query params are required.');
    }

    this.logger.log(
      `[GET /api/qr/verify] sessionId=${sessionId}  token=${token.slice(0, 8)}…`,
    );

    const result = this.qrService.verifyQRCode(sessionId, token);

    // Return a browser-friendly HTML page when accessed directly
    // (so scanning the QR on a real phone shows a confirmation page)
    return {
      ...result,
      sessionId,
      verifiedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // GET /api/qr/status   (bonus — lets UI poll if WebSocket is unavailable)
  // -------------------------------------------------------------------------

  /**
   * Returns current QR session status and remaining TTL.
   * Query param: session — the session ID
   */
  @Get('api/qr/status')
  getQRStatus(@Query('session') sessionId: string) {
    if (!sessionId) {
      throw new BadRequestException('"session" query param is required.');
    }

    const session   = this.qrService.getQRSession(sessionId);
    const remaining = this.qrService.getRemainingTTL(sessionId);

    if (!session) {
      return { found: false, status: 'EXPIRED_OR_NOT_FOUND', remainingSeconds: 0 };
    }

    return {
      found           : true,
      status          : session.status,
      remainingSeconds: remaining,
      sessionId,
    };
  }

  // -------------------------------------------------------------------------
  // GET /api/session/status   (generic session status lookup)
  // -------------------------------------------------------------------------

  /**
   * Polls the word-game session status.
   * Query param: session — the session ID
   */
  @Get('api/session/status')
  getSessionStatus(@Query('session') sessionId: string) {
    if (!sessionId) {
      throw new BadRequestException('"session" query param is required.');
    }

    const session = this.notificationService.getSession(sessionId);

    if (!session) {
      return { found: false, status: 'EXPIRED_OR_NOT_FOUND' };
    }

    return {
      found    : true,
      status   : session.status,
      sessionId,
      words    : session.words, // still useful for re-displaying on refresh
    };
  }
}
