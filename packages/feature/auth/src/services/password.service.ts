import {
  type ScryptOptions,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { defineService } from '@justscale/core';

const SALT_LENGTH = 32;
const KEY_LENGTH = 64;
const SCRYPT_PARAMS: ScryptOptions = { N: 16384, r: 8, p: 1 };
// scrypt has no built-in length cap and N=16384/r=8 on a 10 MB password
// burns serious CPU. The HTTP layer caps body size, but a service-level
// guard means a direct caller (CLI, process, internal RPC) can't trigger
// the same DoS. NIST SP 800-63B floor is 64 chars; a 1024-byte ceiling
// is well above any realistic password.
const MAX_PASSWORD_BYTES = 1024;

export class PasswordTooLongError extends Error {
  constructor() {
    super(`Password exceeds ${MAX_PASSWORD_BYTES} bytes`);
    this.name = 'PasswordTooLongError';
  }
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export class PasswordService extends defineService({
  inject: {},
  factory: () => ({
    async hash(password: string): Promise<string> {
      if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
        throw new PasswordTooLongError();
      }
      const salt = randomBytes(SALT_LENGTH);
      const derivedKey = await scryptAsync(
        password,
        salt,
        KEY_LENGTH,
        SCRYPT_PARAMS,
      );
      return `${salt.toString('hex')}:${derivedKey.toString('hex')}`;
    },

    async verify(password: string, hash: string): Promise<boolean> {
      // Reject before scrypt so a login with a 10 MB password can't burn
      // CPU. Returning false (not throwing) means /auth/login looks the
      // same as wrong-credentials — no signal to a probing attacker.
      if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
        return false;
      }
      const [saltHex, keyHex] = hash.split(':');
      if (!saltHex || !keyHex) return false;

      const salt = Buffer.from(saltHex, 'hex');
      const storedKey = Buffer.from(keyHex, 'hex');
      const derivedKey = await scryptAsync(
        password,
        salt,
        KEY_LENGTH,
        SCRYPT_PARAMS,
      );

      // A corrupted/truncated hash would make `storedKey.length !==
      // derivedKey.length` and crash `timingSafeEqual`. Fall back to a
      // same-length dummy compare so the caller gets `false` without a
      // throw, and without a length-based timing leak.
      if (storedKey.length !== derivedKey.length) {
        timingSafeEqual(derivedKey, derivedKey);
        return false;
      }

      return timingSafeEqual(storedKey, derivedKey);
    },
  }),
}) {}

export type PasswordServiceInstance = ReturnType<typeof PasswordService.factory>;
