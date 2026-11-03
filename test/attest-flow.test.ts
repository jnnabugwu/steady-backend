import { beforeAll, describe, expect, test } from "vitest";
import { replyClientData } from "../src/attest/assertion.js";
import { toBase64, utf8 } from "../src/attest/bytes.js";
import { bypassAllowed, HEADERS, tokensMatch } from "../src/auth.js";
import { handleChallenge, handleRegister } from "../src/handlers/attest.js";
import { handleReply } from "../src/handlers/reply.js";
import { createAttestFixture, type AttestFixture } from "./helpers/attest-fixtures.js";
import { bypassRequest, chatBody, makeDeps, readSse, testConfig, type TestDeps } from "./helpers/harness.js";

let device: AttestFixture;
let stranger: AttestFixture;
beforeAll(async () => {
  [device, stranger] = await Promise.all([createAttestFixture(), createAttestFixture()]);
});

const getChallenge = async (deps: TestDeps): Promise<string> => {
  const response = await handleChallenge(new Request("https://proxy.test/api/attest/challenge"), deps);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { challenge: string; expiresInSeconds: number };
  expect(body.expiresInSeconds).toBe(300);
  return body.challenge;
};

const register = async (deps: TestDeps, fixture = device, overrides: Record<string, unknown> = {}) => {
  const challenge = await getChallenge(deps);
  const body = {
    keyId: fixture.keyId,
    attestation: toBase64(await fixture.attestation(challenge)),
    challenge,
    ...overrides,
  };
  return handleRegister(
    new Request("https://proxy.test/api/attest/register", { method: "POST", body: JSON.stringify(body) }),
    deps,
  );
};

/** A reply request signed the way the app signs it. */
const signedReply = async (
  deps: TestDeps,
  options: { counter: number; body?: string; signBody?: string; fixture?: AttestFixture; challenge?: string } ,
) => {
  const challenge = options.challenge ?? (await getChallenge(deps));
  const body = options.body ?? chatBody();
  const fixture = options.fixture ?? device;
  const assertion = fixture.assertion(replyClientData(challenge, utf8(options.signBody ?? body)), options.counter);
  return new Request("https://proxy.test/api/coach/reply", {
    method: "POST",
    headers: {
      [HEADERS.keyId]: device.keyId,
      [HEADERS.assertion]: toBase64(assertion),
      [HEADERS.challenge]: challenge,
    },
    body,
  });
};

describe("challenge", () => {
  test("is 32 random bytes, base64url, stored for 5 minutes and usable once", async () => {
    const deps = makeDeps();
    const challenge = await getChallenge(deps);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await deps.memory.takeChallenge(challenge)).toBe(true);
    expect(await deps.memory.takeChallenge(challenge)).toBe(false);
  });

  test("expires after 5 minutes", async () => {
    const deps = makeDeps();
    const challenge = await getChallenge(deps);
    deps.clock.now = new Date(deps.clock.now.getTime() + 301_000);
    expect(await deps.memory.takeChallenge(challenge)).toBe(false);
  });
});

describe("register", () => {
  test("a valid attestation stores the key with counter 0 (204)", async () => {
    const deps = makeDeps({ roots: [device.rootPem] });
    const response = await register(deps);
    expect(response.status).toBe(204);
    expect(await deps.memory.getKey(device.keyId)).toEqual({ publicKey: toBase64(device.publicKeySpki), counter: 0 });
  });

  test("an attestation from an untrusted CA is attestation_failed (401) and stores nothing", async () => {
    const deps = makeDeps({ roots: [device.rootPem] });
    const response = await register(deps, stranger);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "attestation_failed" } });
    expect(await deps.memory.getKey(stranger.keyId)).toBeNull();
  });

  test("a challenge the server never issued is attestation_failed", async () => {
    const deps = makeDeps({ roots: [device.rootPem] });
    const response = await register(deps, device, { challenge: "Z".repeat(43) });
    expect(response.status).toBe(401);
  });

  test("a challenge can't be used twice", async () => {
    const deps = makeDeps({ roots: [device.rootPem] });
    const challenge = await getChallenge(deps);
    const body = JSON.stringify({ keyId: device.keyId, attestation: toBase64(await device.attestation(challenge)), challenge });
    const request = () => new Request("https://proxy.test/api/attest/register", { method: "POST", body });
    expect((await handleRegister(request(), deps)).status).toBe(204);
    expect((await handleRegister(request(), deps)).status).toBe(401);
  });

  test("a malformed body is bad_request (400)", async () => {
    const deps = makeDeps({ roots: [device.rootPem] });
    for (const body of ["nope", "{}", JSON.stringify({ keyId: "a", attestation: "%%%", challenge: "A".repeat(43) })]) {
      const response = await handleRegister(new Request("https://proxy.test/api/attest/register", { method: "POST", body }), deps);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "bad_request" } });
    }
  });

  test("logs a short key hash, never the key id or the attestation", async () => {
    const deps = makeDeps({ roots: [device.rootPem] });
    await register(deps);
    const line = JSON.stringify(deps.logs);
    expect(line).not.toContain(device.keyId);
    expect(deps.logs.at(-1)).toMatchObject({ route: "attest.register", status: 204 });
    expect(deps.logs.at(-1)?.key).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("reply with an assertion", () => {
  const registered = async () => {
    const deps = makeDeps({ roots: [device.rootPem] });
    expect((await register(deps)).status).toBe(204);
    return deps;
  };

  test("a valid assertion streams the reply and stores the new counter", async () => {
    const deps = await registered();
    const response = await handleReply(await signedReply(deps, { counter: 1 }), deps);
    expect(response.status).toBe(200);
    expect((await readSse(response)).at(-1)).toEqual({ event: "done", data: { stopReason: "end_turn" } });
    expect((await deps.memory.getKey(device.keyId))?.counter).toBe(1);
  });

  test("the counter must strictly increase", async () => {
    const deps = await registered();
    expect((await handleReply(await signedReply(deps, { counter: 5 }), deps)).status).toBe(200);
    for (const counter of [5, 4]) {
      const response = await handleReply(await signedReply(deps, { counter }), deps);
      expect(response.status).toBe(401);
      expect(await readSse(response)).toEqual([{ event: "error", data: { code: "attestation_failed" } }]);
    }
    expect((await handleReply(await signedReply(deps, { counter: 6 }), deps)).status).toBe(200);
    expect(deps.fake.calls).toHaveLength(2);
  });

  test("a counter of 0 (the attestation's) is rejected", async () => {
    const deps = await registered();
    expect((await handleReply(await signedReply(deps, { counter: 0 }), deps)).status).toBe(401);
  });

  test("an unknown key id is attestation_failed, so the app re-attests", async () => {
    const deps = makeDeps({ roots: [device.rootPem] });
    const response = await handleReply(await signedReply(deps, { counter: 1 }), deps);
    expect(response.status).toBe(401);
    expect(deps.logs.at(-1)).toMatchObject({ code: "attestation_failed", reason: "unknown_key" });
  });

  test("an assertion over a different body is rejected", async () => {
    const deps = await registered();
    const request = await signedReply(deps, { counter: 1, signBody: chatBody({ kind: "weekly" }) });
    expect((await handleReply(request, deps)).status).toBe(401);
  });

  test("an assertion signed by another key is rejected", async () => {
    const deps = await registered();
    expect((await handleReply(await signedReply(deps, { counter: 1, fixture: stranger }), deps)).status).toBe(401);
  });

  test("a challenge can't be replayed", async () => {
    const deps = await registered();
    const challenge = await getChallenge(deps);
    expect((await handleReply(await signedReply(deps, { counter: 1, challenge }), deps)).status).toBe(200);
    const replay = await handleReply(await signedReply(deps, { counter: 2, challenge }), deps);
    expect(replay.status).toBe(401);
  });

  test("missing headers are rejected", async () => {
    const deps = await registered();
    const request = new Request("https://proxy.test/api/coach/reply", {
      method: "POST",
      headers: { [HEADERS.keyId]: device.keyId },
      body: chatBody(),
    });
    expect((await handleReply(request, deps)).status).toBe(401);
  });

  test("the daily limit counts per key, not per request source", async () => {
    const deps = makeDeps({ roots: [device.rootPem], env: { COACH_DAILY_LIMIT: "1" } });
    await register(deps);
    expect((await handleReply(await signedReply(deps, { counter: 1 }), deps)).status).toBe(200);
    expect((await handleReply(await signedReply(deps, { counter: 2 }), deps)).status).toBe(429);
    // Another device still has its allowance.
    expect((await handleReply(bypassRequest(chatBody()), deps)).status).toBe(200);
  });
});

describe("dev bypass", () => {
  test("is honoured in Preview with the right token", async () => {
    const deps = makeDeps();
    expect((await handleReply(bypassRequest(chatBody()), deps)).status).toBe(200);
  });

  test("a wrong token is rejected", async () => {
    const deps = makeDeps();
    expect((await handleReply(bypassRequest(chatBody(), "wrong"), deps)).status).toBe(401);
    expect((await handleReply(bypassRequest(chatBody(), ""), deps)).status).toBe(401);
  });

  test("is rejected outright in Vercel production, even with the configured token", async () => {
    const deps = makeDeps({ env: { VERCEL_ENV: "production" } });
    const response = await handleReply(bypassRequest(chatBody()), deps);
    expect(response.status).toBe(401);
    expect(await readSse(response)).toEqual([{ event: "error", data: { code: "attestation_failed" } }]);
    expect(deps.logs.at(-1)).toMatchObject({ reason: "bypass_in_production" });
    expect(deps.fake.calls).toHaveLength(0);
  });

  test("is rejected outright when APP_ATTEST_ENV=production", async () => {
    const deps = makeDeps({ env: { APP_ATTEST_ENV: "production" } });
    expect((await handleReply(bypassRequest(chatBody()), deps)).status).toBe(401);
    expect(deps.logs.at(-1)).toMatchObject({ reason: "bypass_in_production" });
  });

  test("is rejected in production even alongside a valid assertion", async () => {
    const deps = makeDeps({ roots: [device.rootPem], env: { VERCEL_ENV: "production" } });
    await register(deps);
    const request = await signedReply(deps, { counter: 1 });
    request.headers.set(HEADERS.devBypass, "dev-token-for-tests");
    expect((await handleReply(request, deps)).status).toBe(401);
  });

  test("is rejected when no token is configured", async () => {
    const deps = makeDeps({ env: { COACH_DEV_BYPASS_TOKEN: "" } });
    expect((await handleReply(bypassRequest(chatBody()), deps)).status).toBe(401);
    expect(deps.logs.at(-1)).toMatchObject({ reason: "bypass_not_configured" });
  });

  test("bypassAllowed needs non-production on both settings and a token", () => {
    expect(bypassAllowed(testConfig())).toBe(true);
    expect(bypassAllowed(testConfig({ VERCEL_ENV: "production" }))).toBe(false);
    expect(bypassAllowed(testConfig({ APP_ATTEST_ENV: "production" }))).toBe(false);
    expect(bypassAllowed(testConfig({ COACH_DEV_BYPASS_TOKEN: "" }))).toBe(false);
  });

  test("tokens compare in constant time over any lengths", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("a", "a much longer token")).toBe(false);
  });
});
