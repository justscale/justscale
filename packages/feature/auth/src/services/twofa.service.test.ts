import assert from 'node:assert';
import { describe, it } from 'node:test';
import { TwoFactorService } from './twofa.service.js';

// No-op resolver for unit tests
const noopResolver = () => {
  throw new Error('Resolver not available in unit tests');
};

describe('TwoFactorService', () => {
  // Mock deps - we only test TOTP methods which don't need real deps
  const mockUsers = {
    get: async () => null,
    update: async () => ({}),
  };
  const mockExecutor = {
    createSignal: () => ({ emit: async () => {}, on: () => {} }),
  };
  const twofa = TwoFactorService.factory(
    { users: mockUsers as any, executor: mockExecutor as any },
    noopResolver,
  );

  it('should generate a valid TOTP secret', () => {
    const secret = twofa.generateSecret();

    // Should be 20 characters (160 bits in base32)
    assert.strictEqual(secret.length, 20);
    // Should only contain valid base32 characters
    assert.ok(/^[A-Z2-7]+$/.test(secret));
  });

  it('should generate unique secrets', () => {
    const secret1 = twofa.generateSecret();
    const secret2 = twofa.generateSecret();

    // Each secret should be unique
    assert.notStrictEqual(secret1, secret2);
  });

  it('should generate a valid otpauth URL', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const url = twofa.generateOtpauthUrl(secret, 'user@example.com', 'MyApp');

    assert.ok(url.startsWith('otpauth://totp/'));
    assert.ok(url.includes('secret=JBSWY3DPEHPK3PXP'));
    assert.ok(url.includes('issuer=MyApp'));
    assert.ok(url.includes('user%40example.com'));
    assert.ok(url.includes('algorithm=SHA1'));
    assert.ok(url.includes('digits=6'));
    assert.ok(url.includes('period=30'));
  });

  it('should use default issuer when not provided', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const url = twofa.generateOtpauthUrl(secret, 'user@example.com');

    assert.ok(url.includes('issuer=JustScale'));
  });

  it('should verify TOTP code format', () => {
    // Invalid codes (wrong format)
    assert.strictEqual(twofa.verifyTOTP('12345', 'JBSWY3DPEHPK3PXP'), false); // too short
    assert.strictEqual(twofa.verifyTOTP('1234567', 'JBSWY3DPEHPK3PXP'), false); // too long
    assert.strictEqual(twofa.verifyTOTP('abcdef', 'JBSWY3DPEHPK3PXP'), false); // letters
    assert.strictEqual(twofa.verifyTOTP('12345a', 'JBSWY3DPEHPK3PXP'), false); // mixed

    // Valid code generated from the secret
    const secret = twofa.generateSecret();
    const code = twofa.generateCurrentCode(secret);
    assert.strictEqual(twofa.verifyTOTP(code, secret), true);
  });
});
