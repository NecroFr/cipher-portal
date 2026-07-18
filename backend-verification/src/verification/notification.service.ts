import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { VerificationGateway } from './verification.gateway';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface SessionPayload {
  words: string[];       // The 5 words shown on the login screen
  answerKey: string[];   // The 2 correct words in the required order
  status: SessionStatus;
  createdAt: number;     // Unix ms — used for TTL checks
}

// ---------------------------------------------------------------------------
// Word Dictionary — 50 common, easy-to-read words
// ---------------------------------------------------------------------------

const WORD_DICTIONARY: string[] = [
  'apple',   'bridge',  'canvas',  'daisy',   'eagle',
  'falcon',  'garden',  'harbor',  'island',  'jungle',
  'kite',    'lemon',   'marble',  'nectar',  'ocean',
  'pillow',  'quartz',  'ribbon',  'sunset',  'timber',
  'umbrella','valley',  'walnut',  'xenon',   'yellow',
  'zebra',   'arrow',   'basket',  'candle',  'delta',
  'ember',   'forest',  'glacier', 'honey',   'indigo',
  'jasper',  'kettle',  'lantern', 'mosaic',  'noble',
  'onyx',    'pebble',  'quest',   'rustic',  'silver',
  'tundra',  'utopia',  'violet',  'whisper', 'zenith',
];

// How long a session is valid (5 minutes)
const SESSION_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns `count` unique random items from `arr` without mutating the source.
 */
function sampleWithoutReplacement<T>(arr: T[], count: number): T[] {
  const copy = [...arr];
  const result: T[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(...copy.splice(idx, 1));
  }
  return result;
}

/**
 * Returns `count` unique random integers in [0, max) in ascending order.
 */
function randomIndicesAscending(max: number, count: number): number[] {
  const indices = new Set<number>();
  while (indices.size < count) {
    indices.add(Math.floor(Math.random() * max));
  }
  return Array.from(indices).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  /**
   * In-memory session store.
   * Key   → sessionId
   * Value → SessionPayload
   *
   * Replace Map with a Redis client if you need persistence or
   * multi-instance support (e.g. `@nestjs/cache-manager` + `cache-manager-redis-yet`).
   */
  private readonly sessionStore = new Map<string, SessionPayload>();

  constructor(
    @Inject(forwardRef(() => VerificationGateway))
    private readonly gateway: VerificationGateway,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Initiates a word-game verification session.
   *
   * Steps:
   *  1. Pick 5 random words from the dictionary.
   *  2. Pick 2 random indices (in ascending order) → these form the answer key.
   *  3. Persist the session with status PENDING.
   *  4. Return the 5 words to the caller (login screen displays them).
   */
  initiateNotificationVerification(sessionId: string): {
    sessionId: string;
    words: string[];
    answerIndices: number[]; // returned for debug/logging only — do NOT send to client
  } {
    this.expireStaleSessions();

    const words = sampleWithoutReplacement(WORD_DICTIONARY, 5);
    const answerIndices = randomIndicesAscending(words.length, 2);
    const answerKey = answerIndices.map((i) => words[i]);

    const payload: SessionPayload = {
      words,
      answerKey,
      status: 'PENDING',
      createdAt: Date.now(),
    };

    this.sessionStore.set(sessionId, payload);

    this.logger.log(
      `[Session: ${sessionId}] Initiated — words: [${words.join(', ')}] ` +
        `| answer: [${answerKey.join(', ')}] (indices ${answerIndices.join(', ')})`,
    );

    return { sessionId, words, answerIndices };
  }

  /**
   * Validates the 2 words chosen (in order) on the trusted device.
   *
   * Steps:
   *  1. Look up the session — reject if not found / expired / already resolved.
   *  2. Compare `chosenWords` with the stored answer key (order matters).
   *  3. On match → mark APPROVED and emit `verification:approved` via the gateway.
   *  4. On mismatch → mark REJECTED and emit `verification:rejected`.
   *  5. Return `{ success: boolean }`.
   */
  submitDeviceVerification(
    sessionId: string,
    chosenWords: string[],
  ): { success: boolean; reason?: string } {
    const session = this.sessionStore.get(sessionId);

    // ---------- guard clauses ----------
    if (!session) {
      this.logger.warn(`[Session: ${sessionId}] Not found.`);
      return { success: false, reason: 'Session not found.' };
    }

    if (this.isExpired(session)) {
      this.sessionStore.delete(sessionId);
      this.logger.warn(`[Session: ${sessionId}] Expired.`);
      return { success: false, reason: 'Session has expired.' };
    }

    if (session.status !== 'PENDING') {
      this.logger.warn(
        `[Session: ${sessionId}] Already resolved with status: ${session.status}`,
      );
      return {
        success: false,
        reason: `Session already ${session.status.toLowerCase()}.`,
      };
    }

    // ---------- comparison (order-sensitive) ----------
    const isCorrect =
      chosenWords.length === session.answerKey.length &&
      chosenWords.every((word, i) => word === session.answerKey[i]);

    if (isCorrect) {
      session.status = 'APPROVED';
      this.logger.log(`[Session: ${sessionId}] APPROVED ✔`);

      // Notify the login page via WebSocket
      this.gateway.notifySessionApproved(sessionId, session.words);

      return { success: true };
    } else {
      session.status = 'REJECTED';
      this.logger.warn(
        `[Session: ${sessionId}] REJECTED — expected [${session.answerKey.join(', ')}], ` +
          `got [${chosenWords.join(', ')}]`,
      );

      // Notify the login page so it can show a failure state immediately
      this.gateway.notifySessionRejected(sessionId);

      return { success: false, reason: 'Incorrect words or wrong order.' };
    }
  }

  /**
   * Returns the current session payload for a given sessionId.
   * Useful for the gateway or other services to query state.
   */
  getSession(sessionId: string): SessionPayload | undefined {
    const session = this.sessionStore.get(sessionId);
    if (session && this.isExpired(session)) {
      this.sessionStore.delete(sessionId);
      return undefined;
    }
    return session;
  }

  /**
   * Manually marks a session as REJECTED (e.g. user explicitly denies on trusted device).
   */
  rejectSession(sessionId: string): { success: boolean; reason?: string } {
    const session = this.sessionStore.get(sessionId);
    if (!session) return { success: false, reason: 'Session not found.' };
    if (session.status !== 'PENDING')
      return {
        success: false,
        reason: `Session already ${session.status.toLowerCase()}.`,
      };

    session.status = 'REJECTED';
    this.logger.log(`[Session: ${sessionId}] Manually REJECTED by trusted device.`);
    this.gateway.notifySessionRejected(sessionId);
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private isExpired(session: SessionPayload): boolean {
    return Date.now() - session.createdAt > SESSION_TTL_MS;
  }

  /** Evicts sessions older than TTL to prevent unbounded memory growth. */
  private expireStaleSessions(): void {
    for (const [id, session] of this.sessionStore.entries()) {
      if (this.isExpired(session)) {
        this.sessionStore.delete(id);
        this.logger.debug(`[Session: ${id}] Evicted (TTL expired).`);
      }
    }
  }
}
