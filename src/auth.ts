import { timingSafeEqual } from "node:crypto";
import { type AssertionFailure, replyClientData, verifyAssertion } from "./attest/assertion.js";
import { fromBase64, sha256, shortHash, utf8 } from "./attest/bytes.js";
import type { Config } from "./config.js";
import type { Deps } from "./deps.js";

/** Request headers a coach reply carries (README.md, "Headers"). */
export const HEADERS = {
  keyId: "x-steady-attest-key-id",
  assertion: "x-steady-attest-assertion",
  challenge: "x-steady-attest-challenge",
  devBypass: "x-steady-dev-bypass",
} as const;

/** How long a challenge stays usable. */
export const CHALLENGE_TTL_SECONDS = 300;

/** How long an attested key is kept without use; each assertion renews it. */
export const KEY_TTL_SECONDS = 180 * 24 * 60 * 60;

/** A challenge: 32 random bytes, base64url without padding. */
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type AuthFailure =
  | "missing_headers"
  | "bad_headers"
  | "challenge"
  | "unknown_key"
  /** The assertion didn't verify; the suffix is which check failed (`AssertionFailure`). */
  | `assertion_${AssertionFailure}`
  | "counter"
  | "bypass_in_production"
  | "bypass_not_configured"
  | "bypass_token";

export type AuthResult =
  | { ok: true; subject: string; via: "assertion" | "bypass" }
  | { ok: false; reason: AuthFailure };

/** The subject that dev-bypass requests are counted and logged under. */
export const BYPASS_SUBJECT = "dev-bypass";

/**
 * Whether this deployment may honour the dev bypass at all: never in
 * Vercel's production environment, never when App Attest is in production
 * mode, and only when a token is configured.
 */
export function bypassAllowed(config: Config): boolean {
  return config.vercelEnv !== "production" && config.attestEnv !== "production" && config.devBypassToken !== undefined;
}

/** Constant-time comparison of two strings of any lengths. */
export function tokensMatch(given: string, expected: string): boolean {
  // Hash first so the comparison is over equal lengths and leaks nothing
  // about the expected token's length.
  return timingSafeEqual(sha256(utf8(given)), sha256(utf8(expected)));
}

/**
 * Proves a reply request comes from the genuine app: an App Attest assertion
 * over the one-time challenge and the exact body bytes, or (outside
 * production only) the dev bypass token. A request carrying the bypass header
 * where the bypass isn't allowed is rejected outright, even if it also
 * carries an assertion.
 */
export async function authenticateReply(request: Request, body: Uint8Array, deps: Deps): Promise<AuthResult> {
  const bypass = request.headers.get(HEADERS.devBypass);
  if (bypass !== null) {
    const { config } = deps;
    if (config.vercelEnv === "production" || config.attestEnv === "production") {
      return { ok: false, reason: "bypass_in_production" };
    }
    if (!bypassAllowed(config) || config.devBypassToken === undefined) {
      return { ok: false, reason: "bypass_not_configured" };
    }
    if (!tokensMatch(bypass, config.devBypassToken)) return { ok: false, reason: "bypass_token" };
    return { ok: true, subject: BYPASS_SUBJECT, via: "bypass" };
  }

  const keyId = request.headers.get(HEADERS.keyId);
  const assertionHeader = request.headers.get(HEADERS.assertion);
  const challenge = request.headers.get(HEADERS.challenge);
  if (keyId === null || assertionHeader === null || challenge === null) {
    return { ok: false, reason: "missing_headers" };
  }
  const assertion = fromBase64(assertionHeader);
  if (assertion === null || fromBase64(keyId)?.length !== 32 || !CHALLENGE_PATTERN.test(challenge)) {
    return { ok: false, reason: "bad_headers" };
  }

  const store = deps.store();
  // Burn the challenge first: a failed attempt can't be retried with it.
  if (!(await store.takeChallenge(challenge))) return { ok: false, reason: "challenge" };
  const key = await store.getKey(keyId);
  if (key === null) return { ok: false, reason: "unknown_key" };
  const publicKeySpki = fromBase64(key.publicKey);
  if (publicKeySpki === null) return { ok: false, reason: "unknown_key" };

  const verified = verifyAssertion({
    assertion,
    clientData: replyClientData(challenge, body),
    publicKeySpki,
    appId: deps.config.appId,
  });
  if (!verified.ok) return { ok: false, reason: `assertion_${verified.reason}` };

  const advanced = await store.advanceCounter(keyId, verified.counter, KEY_TTL_SECONDS);
  if (advanced === "unknown") return { ok: false, reason: "unknown_key" };
  if (advanced === "stale") return { ok: false, reason: "counter" };
  return { ok: true, subject: shortHash(keyId), via: "assertion" };
}
