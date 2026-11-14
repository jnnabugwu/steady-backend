/**
 * WebAuthn-style authenticator data, as App Attest uses it:
 *
 *   rpIdHash (32) | flags (1) | signCount (4, big-endian)
 *   [ aaguid (16) | credentialIdLength (2) | credentialId | credentialPublicKey ]
 *
 * The bracketed attested credential data is present in an attestation
 * (flag 0x40) and absent in an assertion. The credential public key (COSE)
 * isn't read: the public key comes from the verified certificate instead.
 */

export interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  counter: number;
  aaguid?: Uint8Array;
  credentialId?: Uint8Array;
}

const ATTESTED_CREDENTIAL_DATA = 0x40;

export function parseAuthData(bytes: Uint8Array): AuthData | null {
  if (bytes.length < 37) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint8(32);
  const data: AuthData = {
    rpIdHash: bytes.subarray(0, 32),
    flags,
    counter: view.getUint32(33),
  };
  if ((flags & ATTESTED_CREDENTIAL_DATA) === 0) return data;
  if (bytes.length < 55) return null;
  const idLength = view.getUint16(53);
  if (bytes.length < 55 + idLength) return null;
  data.aaguid = bytes.subarray(37, 53);
  data.credentialId = bytes.subarray(55, 55 + idLength);
  return data;
}

/**
 * An assertion's authenticator data: only the fixed 37-byte header (RP ID
 * hash, flags, counter), whatever the flags say. Apple's assertions can have
 * the attested-credential-data flag set without carrying that data, so
 * `parseAuthData` would reject them; an assertion's checks need only the
 * header.
 */
export function parseAssertionAuthData(bytes: Uint8Array): AuthData | null {
  if (bytes.length < 37) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { rpIdHash: bytes.subarray(0, 32), flags: view.getUint8(32), counter: view.getUint32(33) };
}

/** App Attest's AAGUIDs: which environment a key was made in. */
export const AAGUID = {
  // "appattestdevelop"
  development: new TextEncoder().encode("appattestdevelop"),
  // "appattest" followed by seven zero bytes
  production: new Uint8Array([...new TextEncoder().encode("appattest"), 0, 0, 0, 0, 0, 0, 0]),
} as const;
