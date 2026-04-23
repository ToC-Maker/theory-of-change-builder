/**
 * AES-256-GCM envelope encryption for BYOK (Bring Your Own Key) API keys.
 *
 * - Master key: 32 bytes (256-bit) stored as base64 in `BYOK_ENCRYPTION_KEY`.
 * - IV: fresh 12 random bytes per encryption. GCM nonce reuse is catastrophic
 *   (trivially breaks confidentiality and authenticity) so this is non-negotiable.
 * - AAD: `user_id` bytes -- binds ciphertext to the row's owner so a
 *   database-level row-swap attacker cannot move an encrypted key to a
 *   different user and have it decrypt.
 * - Layout: `iv (12 bytes) || ciphertext || tag (16 bytes)` as one Uint8Array.
 *   `crypto.subtle.encrypt` already appends the 16-byte GCM tag to the
 *   ciphertext; we only prepend the IV.
 */

function importMasterKey(b64: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (bytes.byteLength !== 32) {
    throw new Error(`BYOK_ENCRYPTION_KEY must decode to 32 bytes; got ${bytes.byteLength}`);
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptByokKey(
  plaintext: string,
  userId: string,
  masterKeyB64: string,
): Promise<Uint8Array> {
  const key = await importMasterKey(masterKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(userId);
  const pt = new TextEncoder().encode(plaintext);
  const ctWithTag = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, pt),
  );
  const out = new Uint8Array(iv.byteLength + ctWithTag.byteLength);
  out.set(iv, 0);
  out.set(ctWithTag, iv.byteLength);
  return out;
}

export async function decryptByokKey(
  encrypted: Uint8Array,
  userId: string,
  masterKeyB64: string,
): Promise<string> {
  const key = await importMasterKey(masterKeyB64);
  const iv = encrypted.slice(0, 12);
  const ctWithTag = encrypted.slice(12);
  const aad = new TextEncoder().encode(userId);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    ctWithTag,
  );
  return new TextDecoder().decode(pt);
}

/**
 * @internal
 * Round-trip self-check for manual invocation from a scratch Worker test or
 * smoke harness. Verifies encrypt/decrypt correctness and that AAD mismatch
 * causes decryption to fail.
 *
 * Do NOT invoke at module load -- this would run on every isolate boot and
 * waste CPU budget. Call it only from a test harness or ad-hoc endpoint.
 */
export async function __roundTripSelfCheck(masterKeyB64: string): Promise<void> {
  const enc = await encryptByokKey('sk-ant-test-xAb3', 'user-abc', masterKeyB64);
  const dec = await decryptByokKey(enc, 'user-abc', masterKeyB64);
  if (dec !== 'sk-ant-test-xAb3') throw new Error('BYOK self-check failed: decrypt mismatch');
  // AAD mismatch must throw (Web Crypto surfaces it as a generic OperationError).
  try {
    await decryptByokKey(enc, 'user-xyz', masterKeyB64);
    throw new Error('BYOK self-check failed: AAD mismatch should have thrown');
  } catch (e) {
    if ((e as Error).message.includes('AAD mismatch should have thrown')) throw e;
    // Any other error is the expected Web Crypto auth failure -- pass.
  }
}
