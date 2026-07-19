import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

// ─── BIP-39-style Dictionary (100 common words) ───────────────────────────────
const DICTIONARY: string[] = [
  'apple',   'bridge',  'candle',  'dancer',  'engine',
  'forest',  'garden',  'harbor',  'island',  'jungle',
  'kettle',  'lemon',   'mirror',  'napkin',  'orange',
  'pencil',  'quartz',  'ribbon',  'silver',  'table',
  'umbrella','valley',  'walnut',  'xenon',   'yellow',
  'zebra',   'anchor',  'breeze',  'castle',  'dollar',
  'eagle',   'falcon',  'glacier', 'hammer',  'igloo',
  'jasper',  'kitten',  'lantern', 'magnet',  'needle',
  'ocean',   'pillow',  'quiver',  'rocket',  'saddle',
  'temple',  'urchin',  'violet',  'winter',  'xyster',
  'yogurt',  'zipper',  'barrel',  'crimson', 'diamond',
  'emerald', 'feather', 'granite', 'harvest', 'indigo',
  'journey', 'key',     'labyrinth','marble',  'nomad',
  'onyx',    'portal',  'quarry',  'refuge',  'summit',
  'timber',  'upland',  'vessel',  'whisper', 'xenolith',
  'yonder',  'zenith',  'acorn',   'blizzard','compass',
  'dagger',  'ember',   'flint',   'goblet',  'haven',
  'iron',    'jewel',   'knight',  'lotus',   'mystic',
  'nectar',  'opal',    'pine',    'quill',   'raven',
  'stone',   'tower',   'umber',   'viper',   'warden',
];

export interface RecoveryCodesResult {
  /** Ordered word list shown once to the user: ['1: apple', '2: table', …] */
  words: string[];
  /** AES-256-GCM ciphertext stored in the User.recoveryHash DB column */
  recoveryHash: string;
}

@Injectable()
export class RecoveryService {
  private readonly encKey: Buffer;

  constructor(private readonly config: ConfigService) {
    // Derive a 32-byte AES key from the env secret using scrypt
    const secret = this.config.getOrThrow<string>('RECOVERY_ENCRYPTION_KEY');
    this.encKey = scryptSync(secret, 'cipher-quorum-recovery-salt', 32);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Generates 15 unique recovery words.
   *
   * **Storage strategy — AES-256-GCM encryption (not BCrypt):**
   * BCrypt is one-way, so it cannot support partial-index verification.
   * Instead we encrypt the ordered phrase and store the ciphertext in
   * `recoveryHash`. At challenge time we decrypt, look up the requested
   * indices, and compare in constant time.
   *
   * @returns `words`        — shown once to the user (never stored in plaintext)
   * @returns `recoveryHash` — encrypted ciphertext to persist in the DB
   */
  generateRecoveryCodes(): RecoveryCodesResult {
    const selected = this._pickUniqueWords(15);
    const words = selected.map((word, i) => `${i + 1}: ${word}`);
    const plainPhrase = selected.join(' '); // "apple table ... warden"
    const recoveryHash = this._encrypt(plainPhrase);
    return { words, recoveryHash };
  }

  /**
   * Selects 2 or 3 random 1-based positions from 1..15 for the challenge.
   * @returns e.g. [4, 11] or [2, 7, 14]
   */
  generateRecoveryChallenge(): number[] {
    const count = Math.random() < 0.5 ? 2 : 3;
    const positions = new Set<number>();
    while (positions.size < count) {
      positions.add(Math.floor(Math.random() * 15) + 1);
    }
    return Array.from(positions).sort((a, b) => a - b);
  }

  /**
   * Verifies the user's challenge response against the stored ciphertext.
   *
   * @param storedHash  — value from `User.recoveryHash` (AES-256-GCM ciphertext)
   * @param userWords   — map of 1-based position → submitted word
   *                      e.g. `{ 4: 'table', 11: 'house' }`
   * @returns `true` if every submitted word matches the original at that index
   */
  verifyRecoveryResponse(
    storedHash: string,
    userWords: Record<number, string>,
  ): boolean {
    try {
      const plainPhrase = this._decrypt(storedHash);
      const originalWords = plainPhrase.split(' '); // index 0 → position 1

      return Object.entries(userWords).every(([posStr, submitted]) => {
        const pos = parseInt(posStr, 10);
        if (pos < 1 || pos > 15) return false;
        const original = originalWords[pos - 1] ?? '';
        // Constant-time comparison to resist timing attacks
        return this._safeEqual(original.toLowerCase(), submitted.toLowerCase());
      });
    } catch {
      // Decryption failure (tampered ciphertext) → reject
      return false;
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private _pickUniqueWords(count: number): string[] {
    const pool = [...DICTIONARY];
    const result: string[] = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      result.push(pool.splice(idx, 1)[0]);
    }
    return result;
  }

  /**
   * AES-256-GCM encrypt.
   * Output format (Base64): `<iv:12bytes>.<authTag:16bytes>.<ciphertext>`
   */
  private _encrypt(plaintext: string): string {
    const iv = randomBytes(12); // 96-bit IV recommended for GCM
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
      iv.toString('base64'),
      authTag.toString('base64'),
      encrypted.toString('base64'),
    ].join('.');
  }

  /**
   * AES-256-GCM decrypt.
   * Throws on authentication failure (tampered data).
   */
  private _decrypt(ciphertext: string): string {
    const [ivB64, tagB64, dataB64] = ciphertext.split('.');
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(data) + decipher.final('utf8');
  }

  /** Constant-time string comparison to prevent timing side-channels. */
  private _safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }
}
