import assert from 'node:assert';
import { describe, it } from 'node:test';
import { PasswordService } from './password.service.js';

// No-op resolver for unit tests
const noopResolver = () => {
  throw new Error('Resolver not available in unit tests');
};

describe('PasswordService', () => {
  const passwords = PasswordService.factory({}, noopResolver);

  it('should hash and verify passwords correctly', async () => {
    const password = 'mySecurePassword123!';
    const hash = await passwords.hash(password);

    // Hash should be different from password
    assert.notStrictEqual(hash, password);

    // Verify should return true for correct password
    const isValid = await passwords.verify(password, hash);
    assert.strictEqual(isValid, true);

    // Verify should return false for wrong password
    const isInvalid = await passwords.verify('wrongPassword', hash);
    assert.strictEqual(isInvalid, false);
  });

  it('should generate different hashes for same password', async () => {
    const password = 'testPassword';
    const hash1 = await passwords.hash(password);
    const hash2 = await passwords.hash(password);

    // Hashes should be different due to unique salts
    assert.notStrictEqual(hash1, hash2);

    // But both should verify correctly
    assert.strictEqual(await passwords.verify(password, hash1), true);
    assert.strictEqual(await passwords.verify(password, hash2), true);
  });
});
