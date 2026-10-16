import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2';
import { AppConfigService } from '@/config';
import { VerificationSecretShape } from '@/shared/enums';

@Injectable()
export class SecretHashService {
  constructor(private readonly config: AppConfigService) {}

  // =========================================================================
  // Passwords — argon2id, not bcrypt
  // =========================================================================

  async hashPassword(password: string): Promise<string> {
    const { memoryCost, timeCost, parallelism } = this.config.auth.argon2;
    return argon2Hash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost,
      timeCost,
      parallelism,
    });
  }

  /**
   * Returns false rather than throwing on a malformed stored hash, so a corrupt
   * row reads as "wrong password" instead of a 500 that reveals it exists.
   */
  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2Verify(hash, password);
    } catch {
      return false;
    }
  }

  // =========================================================================
  // Verification secrets — HMAC-SHA256 under a server-side pepper
  // =========================================================================

  /**
   * Generates a verification secret of the shape the kind calls for.
   *
   * A six-digit code is only 1-in-a-million PER GUESS, which is why attempt
   * limiting — not code entropy — is the real security control. A link that has
   * to survive an inbox gets high entropy instead, because its window is long.
   */
  generateSecret(shape: VerificationSecretShape, size: number): string {
    if (shape === VerificationSecretShape.NumericCode) {
      // randomInt is CSPRNG-backed; Math.random would be guessable.
      let code = '';
      for (let i = 0; i < size; i += 1) code += String(randomInt(0, 10));
      return code;
    }
    return randomBytes(size).toString('base64url');
  }

  /**
   * NEVER STORE THE SECRET. Plain SHA-256 would be useless here: a six-digit
   * code has a million possibilities, so an attacker holding the table could
   * exhaust it instantly. The pepper — which lives in the secret manager, not
   * the database — is what makes a leaked table worthless.
   */
  hashSecret(secret: string): string {
    return createHmac('sha256', this.config.crypto.verificationPepper).update(secret).digest('hex');
  }

  /**
   * Compares digests in constant time. A plain `===` on strings leaks the length
   * of the matching prefix through timing.
   */
  verifySecret(storedHash: string, submitted: string): boolean {
    const expected = Buffer.from(storedHash, 'utf8');
    const actual = Buffer.from(this.hashSecret(submitted), 'utf8');
    // timingSafeEqual throws on a length mismatch, which would itself be a
    // timing signal; the length check is constant with respect to content.
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  // =========================================================================
  // Opaque tokens — refresh tokens, OAuth state
  // =========================================================================

  /** A refresh token: 32 random bytes. The row is the session; this proves it. */
  generateOpaqueToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /**
   * SHA-256 via HMAC for the sessions table. A hash of a high-entropy random
   * token needs no salt or work factor — there is nothing to brute-force.
   */
  hashOpaqueToken(token: string): string {
    return createHmac('sha256', this.config.crypto.verificationPepper).update(token).digest('hex');
  }
}
