import { describe, expect, it } from 'vitest';
import { encryptByokKey, decryptByokKey } from '../../worker/_shared/byok-crypto';

// Generate a test master key (32 bytes, base64). Do NOT use in production.
const TEST_MASTER_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

describe('byok-crypto round-trip', () => {
  it('encrypts and decrypts a key', async () => {
    const plain = 'sk-ant-example-1234567890abcdef';
    const encrypted = await encryptByokKey(plain, 'user-abc', TEST_MASTER_KEY);
    const decrypted = await decryptByokKey(encrypted, 'user-abc', TEST_MASTER_KEY);
    expect(decrypted).toBe(plain);
  });

  it('AAD mismatch fails', async () => {
    const encrypted = await encryptByokKey('sk-ant-xxx', 'user-alice', TEST_MASTER_KEY);
    await expect(decryptByokKey(encrypted, 'user-bob', TEST_MASTER_KEY)).rejects.toThrow();
  });

  it('IV freshness: two encryptions of same plaintext produce different ciphertexts', async () => {
    const plain = 'sk-ant-same-plaintext';
    const e1 = await encryptByokKey(plain, 'user-1', TEST_MASTER_KEY);
    const e2 = await encryptByokKey(plain, 'user-1', TEST_MASTER_KEY);
    expect(e1).not.toEqual(e2);
  });

  it('rejects master keys that are not 32 bytes', async () => {
    const tooShort = btoa('short');
    await expect(encryptByokKey('sk-ant-x', 'user-1', tooShort)).rejects.toThrow();
  });
});
