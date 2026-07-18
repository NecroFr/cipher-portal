import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import * as QRCode from 'qrcode';
import { VerificationGateway } from './verification.gateway';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QRSessionStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface QRSessionPayload {
  token: string;
  status: QRSessionStatus;
  createdAt: number; // Unix ms — used for TTL checks
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** QR challenges expire after 2 minutes */
const QR_TTL_MS = 2 * 60 * 1000;

/**
 * Base URL for the QR validation deep-link.
 * In production this would come from process.env.APP_BASE_URL.
 */
const BASE_URL =
  process.env.APP_BASE_URL ?? 'http://localhost:3002';

// ---------------------------------------------------------------------------
// QR Service
// ---------------------------------------------------------------------------

@Injectable()
export class QrService {
  private readonly logger = new Logger(QrService.name);

  /**
   * In-memory store: sessionId → QRSessionPayload
   *
   * Swap out for Redis/cache-manager for multi-instance setups:
   *   await this.cacheManager.set(sessionId, payload, QR_TTL_MS);
   */
  private readonly qrStore = new Map<string, QRSessionPayload>();

  constructor(
    @Inject(forwardRef(() => VerificationGateway))
    private readonly gateway: VerificationGateway,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generates a QR Code challenge for the given session.
   *
   * Flow:
   *  1. Create a cryptographically random UUID token.
   *  2. Build the validation URL embedding `sessionId` + `token`.
   *  3. Encode the URL into a QR Code PNG and return it as a data URL.
   *  4. Persist `{ token, status: PENDING }` with a 2-minute TTL.
   *
   * @returns Promise containing the Base64 PNG data URL and the validation URL.
   */
  async generateQRChallenge(sessionId: string): Promise<{
    dataUrl: string;
    validationUrl: string;
    expiresInSeconds: number;
  }> {
    this.evictExpiredQRSessions();

    // Overwrite any pre-existing challenge for this session
    if (this.qrStore.has(sessionId)) {
      this.logger.debug(
        `[QR Session: ${sessionId}] Replacing existing QR challenge.`,
      );
    }

    const token = uuidv4();

    const validationUrl = `${BASE_URL}/api/qr/verify?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;

    // Generate QR Code as a PNG data URL (base64)
    const dataUrl = await QRCode.toDataURL(validationUrl, {
      errorCorrectionLevel: 'H', // High — tolerates up to 30% damage
      type: 'image/png',
      margin: 2,
      color: {
        dark: '#1a1a2e',  // Rich dark navy ink
        light: '#ffffff', // White background
      },
      width: 300,
    });

    const payload: QRSessionPayload = {
      token,
      status: 'PENDING',
      createdAt: Date.now(),
    };

    this.qrStore.set(sessionId, payload);

    this.logger.log(
      `[QR Session: ${sessionId}] Challenge generated — token: ${token} | expires in ${QR_TTL_MS / 1000}s`,
    );

    return {
      dataUrl,
      validationUrl,
      expiresInSeconds: QR_TTL_MS / 1000,
    };
  }

  /**
   * Validates a scanned QR token against the stored challenge.
   *
   * Flow:
   *  1. Look up the session — reject if not found, expired, or already resolved.
   *  2. Compare the provided `token` with the stored token (constant-time style).
   *  3. On match → mark APPROVED, emit `verification:approved` to the login page.
   *  4. On mismatch → mark REJECTED, emit `verification:rejected`.
   *  5. Return `{ success, reason? }`.
   *
   * @param sessionId - The session identifier embedded in the QR code URL.
   * @param token     - The UUID token embedded in the QR code URL.
   */
  verifyQRCode(
    sessionId: string,
    token: string,
  ): { success: boolean; reason?: string } {
    const session = this.qrStore.get(sessionId);

    // ---------- guard clauses ----------
    if (!session) {
      this.logger.warn(`[QR Session: ${sessionId}] Not found.`);
      return { success: false, reason: 'QR session not found.' };
    }

    if (this.isExpired(session)) {
      session.status = 'EXPIRED';
      this.qrStore.delete(sessionId);
      this.logger.warn(`[QR Session: ${sessionId}] Token expired.`);
      this.gateway.notifySessionExpired(sessionId);
      return { success: false, reason: 'QR code has expired. Please request a new one.' };
    }

    if (session.status !== 'PENDING') {
      this.logger.warn(
        `[QR Session: ${sessionId}] Already resolved: ${session.status}`,
      );
      return {
        success: false,
        reason: `Session already ${session.status.toLowerCase()}.`,
      };
    }

    // ---------- token comparison ----------
    const isValid = this.safeCompare(session.token, token);

    if (isValid) {
      session.status = 'APPROVED';
      this.logger.log(`[QR Session: ${sessionId}] APPROVED ✔`);

      // Push real-time approval to the login page via Socket.IO
      this.gateway.notifySessionApproved(sessionId, []);

      return { success: true };
    } else {
      session.status = 'REJECTED';
      this.logger.warn(
        `[QR Session: ${sessionId}] REJECTED — token mismatch.`,
      );

      // Push real-time rejection so the login page can react immediately
      this.gateway.notifySessionRejected(sessionId);

      return { success: false, reason: 'Invalid or tampered QR token.' };
    }
  }

  /**
   * Returns the current QR session status.
   * Used for polling fallback or gateway queries.
   */
  getQRSession(sessionId: string): QRSessionPayload | undefined {
    const session = this.qrStore.get(sessionId);
    if (session && this.isExpired(session)) {
      session.status = 'EXPIRED';
      this.qrStore.delete(sessionId);
      return undefined;
    }
    return session;
  }

  /**
   * Returns seconds remaining before the QR challenge expires.
   * Returns 0 if session is not found or already expired.
   */
  getRemainingTTL(sessionId: string): number {
    const session = this.qrStore.get(sessionId);
    if (!session || this.isExpired(session)) return 0;
    const elapsed = Date.now() - session.createdAt;
    return Math.max(0, Math.floor((QR_TTL_MS - elapsed) / 1000));
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private isExpired(session: QRSessionPayload): boolean {
    return Date.now() - session.createdAt > QR_TTL_MS;
  }

  /**
   * Evicts sessions whose TTL has elapsed to prevent unbounded Map growth.
   * Called lazily on every new challenge generation.
   */
  private evictExpiredQRSessions(): void {
    for (const [id, session] of this.qrStore.entries()) {
      if (this.isExpired(session)) {
        this.qrStore.delete(id);
        this.logger.debug(`[QR Session: ${id}] Evicted (TTL expired).`);
      }
    }
  }

  /**
   * Constant-time string comparison to prevent timing-based token leakage.
   * Not cryptographically perfect in JS, but adds a meaningful baseline.
   */
  private safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }
}
