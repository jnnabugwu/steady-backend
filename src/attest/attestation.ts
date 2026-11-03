import { X509Certificate } from "node:crypto";
import { decode } from "cborg";
import type { AttestEnv } from "../config.js";
import { AAGUID, parseAuthData } from "./auth-data.js";
import { equalBytes, fromBase64, sha256, utf8 } from "./bytes.js";
import { findAppleNonceExtension, readAppleNonce } from "./der.js";

/**
 * Verifies an App Attest **attestation** (once per key, `/api/attest/register`),
 * following Apple's "Validating apps that connect to your server":
 *
 * 1. The `x5c` chain (credential certificate, then intermediate) chains to a
 *    pinned root (Apple's App Attest root CA in production), every
 *    certificate inside its validity period.
 * 2. nonce = SHA-256(authData ‖ clientDataHash), where clientDataHash =
 *    SHA-256(UTF-8 challenge). The credential certificate's extension
 *    1.2.840.113635.100.8.2 must carry exactly that nonce.
 * 3. SHA-256 of the credential public key (uncompressed P-256 point) equals
 *    the key id.
 * 4. authData: the RP ID hash is SHA-256 of the app id, the counter is 0, the
 *    AAGUID matches the environment, and the credential id is the key id.
 *
 * The challenge itself is checked (one-time, live) by the caller before this
 * runs. Returns the public key to store.
 */

export interface AttestationInput {
  /** The key id from `DCAppAttestService.generateKey`, base64. */
  keyId: string;
  /** The attestation object, CBOR. */
  attestation: Uint8Array;
  /** The challenge the app hashed into clientDataHash. */
  challenge: string;
  appId: string;
  env: AttestEnv;
  /** Trusted roots, PEM. Production passes only Apple's. */
  roots: readonly string[];
  now: Date;
}

export type AttestationFailure =
  | "key_id"
  | "cbor"
  | "format"
  | "chain"
  | "expired"
  | "nonce"
  | "public_key"
  | "auth_data"
  | "rp_id"
  | "counter"
  | "aaguid"
  | "credential_id";

export type AttestationResult =
  | { ok: true; publicKeySpki: Uint8Array }
  | { ok: false; reason: AttestationFailure };

const fail = (reason: AttestationFailure): AttestationResult => ({ ok: false, reason });

const withinValidity = (cert: X509Certificate, now: Date): boolean =>
  new Date(cert.validFrom).getTime() <= now.getTime() && now.getTime() <= new Date(cert.validTo).getTime();

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

export function verifyAttestation(input: AttestationInput): AttestationResult {
  const keyId = fromBase64(input.keyId);
  if (keyId?.length !== 32) return fail("key_id");

  let object: unknown;
  try {
    object = decode(input.attestation, { rejectDuplicateMapKeys: true });
  } catch {
    return fail("cbor");
  }
  if (typeof object !== "object" || object === null) return fail("format");
  const { fmt, attStmt, authData } = object as Record<string, unknown>;
  if (fmt !== "apple-appattest" || !isBytes(authData)) return fail("format");
  if (typeof attStmt !== "object" || attStmt === null) return fail("format");
  const x5c = (attStmt as Record<string, unknown>).x5c;
  if (!Array.isArray(x5c) || x5c.length < 2 || !x5c.every(isBytes)) return fail("format");

  // 1. The chain.
  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  let roots: X509Certificate[];
  try {
    leaf = new X509Certificate(x5c[0] as Uint8Array);
    intermediate = new X509Certificate(x5c[1] as Uint8Array);
    roots = input.roots.map((pem) => new X509Certificate(pem));
  } catch {
    return fail("chain");
  }
  const root = roots.find((r) => r.ca && intermediate.checkIssued(r) && intermediate.verify(r.publicKey));
  if (root === undefined) return fail("chain");
  if (!intermediate.ca || !leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) {
    return fail("chain");
  }
  if (![leaf, intermediate, root].every((cert) => withinValidity(cert, input.now))) return fail("expired");

  // 2. The nonce.
  const nonce = sha256(authData, sha256(utf8(input.challenge)));
  const extensionValue = findAppleNonceExtension(new Uint8Array(leaf.raw));
  const certNonce = extensionValue === null ? null : readAppleNonce(extensionValue);
  if (certNonce === null || !equalBytes(certNonce, nonce)) return fail("nonce");

  // 3. The public key is the key id's.
  const jwk = leaf.publicKey.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.x === undefined || jwk.y === undefined) {
    return fail("public_key");
  }
  const point = new Uint8Array([0x04, ...Buffer.from(jwk.x, "base64url"), ...Buffer.from(jwk.y, "base64url")]);
  if (point.length !== 65 || !equalBytes(sha256(point), keyId)) return fail("public_key");

  // 4. The authenticator data.
  const parsed = parseAuthData(authData);
  if (parsed?.aaguid === undefined || parsed.credentialId === undefined) return fail("auth_data");
  if (!equalBytes(parsed.rpIdHash, sha256(utf8(input.appId)))) return fail("rp_id");
  if (parsed.counter !== 0) return fail("counter");
  if (!equalBytes(parsed.aaguid, AAGUID[input.env])) return fail("aaguid");
  if (!equalBytes(parsed.credentialId, keyId)) return fail("credential_id");

  return {
    ok: true,
    publicKeySpki: new Uint8Array(leaf.publicKey.export({ type: "spki", format: "der" })),
  };
}
