import { Injectable } from '@nestjs/common';
import { generateKeyPairSync } from 'crypto';

export interface UserKeyPair {
  publicKey: string;
  privateKey: string;
}

@Injectable()
export class CryptoKeysService {
  /**
   * Generates a cryptographically secure Ed25519 keypair.
   *
   * - The **public key** is exported in SPKI PEM format and stored in the DB.
   * - The **private key** is exported in PKCS8 PEM format and returned ONCE
   *   to the user at registration time — it is never persisted server-side.
   *
   * @returns `{ publicKey: string, privateKey: string }` — both PEM-encoded.
   */
  generateUserKeyPair(): UserKeyPair {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
      },
    });

    return { publicKey, privateKey };
  }
}
