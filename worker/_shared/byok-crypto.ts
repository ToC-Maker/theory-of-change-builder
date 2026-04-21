// STUB: Will be superseded by Unit 2 (U2) on merge.
// Matches the interface documented in plans/cost-controls.md §Integration contracts.
//
// Real implementation must use AES-GCM via Web Crypto, a fresh 12-byte IV per
// encryption, layout `iv || ciphertext || tag`, and AAD = user_id bytes. See
// plans/cost-controls.md §Subtask 1 for the full spec.

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(masterKeyB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(masterKeyB64);
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptByokKey(
  plaintext: string,
  userId: string,
  masterKeyB64: string
): Promise<Uint8Array> {
  const key = await importKey(masterKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(userId);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      key,
      new TextEncoder().encode(plaintext)
    )
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

export async function decryptByokKey(
  encrypted: Uint8Array,
  userId: string,
  masterKeyB64: string
): Promise<string> {
  const key = await importKey(masterKeyB64);
  const iv = encrypted.slice(0, 12);
  const ctAndTag = encrypted.slice(12);
  const aad = new TextEncoder().encode(userId);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    ctAndTag
  );
  return new TextDecoder().decode(pt);
}
