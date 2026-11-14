import { createPublicKey, verify } from "node:crypto";
import { decode } from "cborg";
import { parseAssertionAuthData } from "./auth-data.js";
import { equalBytes, sha256, utf8 } from "./bytes.js";

/**
 * Verifies an App Attest **assertion** (every coach request), following
 * Apple's "Validating apps that connect to your server":
 *
 * 1. clientDataHash = SHA-256(clientData); nonce = SHA-256(authenticatorData ‖
 *    clientDataHash).
 * 2. The signature (ECDSA P-256, DER) is valid for the nonce under the key's
 *    stored public key.
 * 3. The RP ID hash is SHA-256 of the app id.
 *
 * Returns the assertion's counter. The caller checks that it's strictly
 * greater than the stored one, atomically (`ProxyStore.advanceCounter`).
 */

export interface AssertionInput {
  /** The assertion, CBOR: `{signature, authenticatorData}`. */
  assertion: Uint8Array;
  /** What the app hashed into clientDataHash (`replyClientData`). */
  clientData: Uint8Array;
  /** The key's public key, SubjectPublicKeyInfo DER. */
  publicKeySpki: Uint8Array;
  appId: string;
}

export type AssertionFailure = "cbor" | "format" | "auth_data" | "rp_id" | "signature";

export type AssertionResult = { ok: true; counter: number } | { ok: false; reason: AssertionFailure };

/**
 * The client data a reply's assertion covers: the one-time challenge (UTF-8)
 * followed by the exact request body bytes. The challenge is a fixed-length
 * base64url string, so the concatenation is unambiguous.
 */
export const replyClientData = (challenge: string, body: Uint8Array): Uint8Array =>
  new Uint8Array([...utf8(challenge), ...body]);

export function verifyAssertion(input: AssertionInput): AssertionResult {
  let object: unknown;
  try {
    object = decode(input.assertion, { rejectDuplicateMapKeys: true });
  } catch {
    return { ok: false, reason: "cbor" };
  }
  if (typeof object !== "object" || object === null) return { ok: false, reason: "format" };
  const { signature, authenticatorData } = object as Record<string, unknown>;
  if (!(signature instanceof Uint8Array) || !(authenticatorData instanceof Uint8Array)) {
    return { ok: false, reason: "format" };
  }

  const parsed = parseAssertionAuthData(authenticatorData);
  if (parsed === null) return { ok: false, reason: "auth_data" };
  if (!equalBytes(parsed.rpIdHash, sha256(utf8(input.appId)))) return { ok: false, reason: "rp_id" };

  const nonce = sha256(authenticatorData, sha256(input.clientData));
  let valid: boolean;
  try {
    const key = createPublicKey({ key: Buffer.from(input.publicKeySpki), format: "der", type: "spki" });
    valid = verify("sha256", nonce, { key, dsaEncoding: "der" }, signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature" };
  return { ok: true, counter: parsed.counter };
}
