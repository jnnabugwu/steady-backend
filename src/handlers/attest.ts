import { verifyAttestation } from "../attest/attestation.js";
import { fromBase64, shortHash, toBase64, toBase64Url } from "../attest/bytes.js";
import { CHALLENGE_PATTERN, CHALLENGE_TTL_SECONDS, KEY_TTL_SECONDS } from "../auth.js";
import type { Deps } from "../deps.js";
import { jsonError, jsonResponse, readBody } from "../http.js";
import type { LogEntry } from "../log.js";

/** An attestation object is a few KB (two certificates and a receipt). */
const MAX_REGISTER_BYTES = 32 * 1024;

/**
 * `GET /api/attest/challenge`: a one-time challenge for the next attestation
 * or assertion, good for `CHALLENGE_TTL_SECONDS`.
 */
export async function handleChallenge(_request: Request, deps: Deps): Promise<Response> {
  const started = Date.now();
  const log = (entry: Omit<LogEntry, "route" | "latencyMs">) =>
    deps.log({ route: "attest.challenge", latencyMs: Date.now() - started, ...entry });
  try {
    const challenge = toBase64Url(deps.randomBytes(32));
    await deps.store().putChallenge(challenge, CHALLENGE_TTL_SECONDS);
    log({ status: 200 });
    return jsonResponse(200, { challenge, expiresInSeconds: CHALLENGE_TTL_SECONDS });
  } catch {
    log({ status: 500, code: "server_error" });
    return jsonError("server_error");
  }
}

/**
 * `POST /api/attest/register` with `{keyId, attestation, challenge}`:
 * verifies the attestation for a new key and stores its public key with
 * counter 0. `204` on success.
 */
export async function handleRegister(request: Request, deps: Deps): Promise<Response> {
  const started = Date.now();
  const log = (entry: Omit<LogEntry, "route" | "latencyMs">) =>
    deps.log({ route: "attest.register", latencyMs: Date.now() - started, ...entry });
  try {
    const raw = await readBody(request, MAX_REGISTER_BYTES);
    if (raw === null) {
      log({ status: 400, code: "bad_request", reason: "too_large" });
      return jsonError("bad_request");
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      body = undefined;
    }
    const { keyId, attestation, challenge } = (typeof body === "object" && body !== null ? body : {}) as Record<
      string,
      unknown
    >;
    const attestationBytes = typeof attestation === "string" ? fromBase64(attestation) : null;
    if (
      typeof keyId !== "string" ||
      typeof challenge !== "string" ||
      !CHALLENGE_PATTERN.test(challenge) ||
      attestationBytes === null ||
      Object.keys(body as object).length !== 3
    ) {
      log({ status: 400, code: "bad_request", reason: "schema" });
      return jsonError("bad_request");
    }

    const store = deps.store();
    if (!(await store.takeChallenge(challenge))) {
      log({ status: 401, code: "attestation_failed", reason: "challenge" });
      return jsonError("attestation_failed");
    }
    const result = verifyAttestation({
      keyId,
      attestation: attestationBytes,
      challenge,
      appId: deps.config.appId,
      env: deps.config.attestEnv,
      roots: deps.appleRoots,
      now: deps.now(),
    });
    if (!result.ok) {
      log({ status: 401, code: "attestation_failed", reason: result.reason });
      return jsonError("attestation_failed");
    }
    await store.putKey(keyId, { publicKey: toBase64(result.publicKeySpki), counter: 0 }, KEY_TTL_SECONDS);
    log({ status: 204, key: shortHash(keyId) });
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch {
    log({ status: 500, code: "server_error" });
    return jsonError("server_error");
  }
}
