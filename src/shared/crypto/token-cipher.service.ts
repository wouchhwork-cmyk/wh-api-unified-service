import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '@/config';

/**
 * Encrypts provider tokens before INSERT and decrypts after SELECT, so Postgres
 * only ever stores ciphertext (schema.md §14). "At rest" here means the value in
 * the column is already unreadable: a dump, a replica, a backup, or a stolen
 * disk yields nothing usable.
 *
 * The column holds a SELF-DESCRIBING ENVELOPE, not raw ciphertext, because
 * ciphertext alone cannot be decrypted — AES-GCM needs the nonce, needs the
 * authentication tag, and after the first rotation needs to know which key
 * version encrypted this particular row:
 *
 *     v1:k3:<base64url(nonce)>:<base64url(ciphertext||tag)>
 *      │  │
 *      │  └── key version — which master key encrypted this row
 *      └───── envelope format version, so the format itself can change later
 */
const ENVELOPE_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
/** 96-bit nonce: the size GCM is specified for. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

@Injectable()
export class TokenCipherService {
  constructor(private readonly config: AppConfigService) {}

  /**
   * Encrypts under the ACTIVE key. A random nonce per encryption, never derived
   * from the row — nonce reuse under GCM is catastrophic, not merely weak.
   */
  encrypt(plaintext: string): string {
    const { activeKeyId } = this.config.crypto;
    const key = this.keyFor(activeKeyId);

    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      ENVELOPE_VERSION,
      activeKeyId,
      nonce.toString('base64url'),
      Buffer.concat([ciphertext, tag]).toString('base64url'),
    ].join(':');
  }

  /**
   * Decrypts any envelope whose key version we still hold, so rows written under
   * an older key stay readable and rotation needs no big-bang re-encryption.
   *
   * A failure here is an ALERT, not a fallback: it means key loss or tampering,
   * and silently treating it as "no token" would present to a user as a
   * mysterious re-auth prompt.
   */
  decrypt(envelope: string): string {
    const parts = envelope.split(':');
    if (parts.length !== 4) {
      throw new Error('token envelope is malformed: expected version:keyId:nonce:ciphertext');
    }
    const [version, keyId, nonceB64, payloadB64] = parts as [string, string, string, string];

    if (version !== ENVELOPE_VERSION) {
      throw new Error(`unsupported token envelope version "${version}"`);
    }

    const key = this.keyFor(keyId);
    const nonce = Buffer.from(nonceB64, 'base64url');
    const payload = Buffer.from(payloadB64, 'base64url');

    if (nonce.length !== NONCE_BYTES || payload.length <= TAG_BYTES) {
      throw new Error('token envelope is malformed: nonce or payload has the wrong length');
    }

    const ciphertext = payload.subarray(0, payload.length - TAG_BYTES);
    const tag = payload.subarray(payload.length - TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);
    // final() throws if the tag does not verify — a tampered ciphertext fails
    // loudly instead of yielding garbage. That is the point of an AEAD.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** True when the value is a well-formed envelope rather than a plaintext token. */
  isEnvelope(value: string): boolean {
    const parts = value.split(':');
    return parts.length === 4 && parts[0] === ENVELOPE_VERSION && /^k\d+$/.test(parts[1] ?? '');
  }

  /** Whether a row should be re-encrypted on its next write (lazy rotation). */
  needsRotation(envelope: string): boolean {
    const keyId = envelope.split(':')[1];
    return keyId !== undefined && keyId !== this.config.crypto.activeKeyId;
  }

  private keyFor(keyId: string): Buffer {
    const key = this.config.crypto.keys.get(keyId);
    if (!key) {
      // Never include the envelope or any ciphertext in the message.
      throw new Error(`no token-encryption key configured for version "${keyId}"`);
    }
    return key;
  }
}
