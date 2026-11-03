import { createHash, X509Certificate } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import { APPLE_APP_ATTEST_ROOT_PEM, APPLE_APP_ATTEST_ROOT_SHA256 } from "../src/attest/apple-root.js";
import { replyClientData, verifyAssertion } from "../src/attest/assertion.js";
import { verifyAttestation, type AttestationInput } from "../src/attest/attestation.js";
import { AAGUID, parseAuthData } from "../src/attest/auth-data.js";
import { fromBase64, toBase64, utf8 } from "../src/attest/bytes.js";
import { readAppleNonce } from "../src/attest/der.js";
import { buildAuthData, createAttestFixture, nonceExtensionValue, TEST_APP_ID, type AttestFixture } from "./helpers/attest-fixtures.js";

const CHALLENGE = "A".repeat(43);

let device: AttestFixture;
let stranger: AttestFixture;

beforeAll(async () => {
  [device, stranger] = await Promise.all([createAttestFixture(), createAttestFixture()]);
});

const input = async (overrides: Partial<AttestationInput> = {}, attestationOverrides = {}): Promise<AttestationInput> => ({
  keyId: device.keyId,
  attestation: await device.attestation(CHALLENGE, attestationOverrides),
  challenge: CHALLENGE,
  appId: TEST_APP_ID,
  env: "development",
  roots: [device.rootPem],
  now: new Date(),
  ...overrides,
});

const reasonFor = async (overrides: Partial<AttestationInput> = {}, attestationOverrides = {}) => {
  const result = verifyAttestation(await input(overrides, attestationOverrides));
  return result.ok ? "ok" : result.reason;
};

describe("Apple's pinned root", () => {
  test("matches the fingerprint in its comment", () => {
    const der = new X509Certificate(APPLE_APP_ATTEST_ROOT_PEM).raw;
    const fingerprint = createHash("sha256").update(der).digest("hex").toUpperCase().match(/../g)?.join(":");
    expect(fingerprint).toBe(APPLE_APP_ATTEST_ROOT_SHA256);
  });

  test("is Apple's App Attestation root, a CA valid until 2045", () => {
    const root = new X509Certificate(APPLE_APP_ATTEST_ROOT_PEM);
    expect(root.subject).toContain("CN=Apple App Attestation Root CA");
    expect(root.ca).toBe(true);
    expect(new Date(root.validTo).getUTCFullYear()).toBe(2045);
  });

  test("a test-CA attestation fails against Apple's root", async () => {
    expect(await reasonFor({ roots: [APPLE_APP_ATTEST_ROOT_PEM] })).toBe("chain");
  });
});

describe("attestation", () => {
  test("a valid attestation passes and returns the key's public key", async () => {
    const result = verifyAttestation(await input());
    expect(result).toEqual({ ok: true, publicKeySpki: device.publicKeySpki });
  });

  test("production accepts only the production AAGUID", async () => {
    expect(await reasonFor({ env: "production" }, { aaguid: AAGUID.production })).toBe("ok");
    expect(await reasonFor({ env: "production" }, { aaguid: AAGUID.development })).toBe("aaguid");
  });

  test("development accepts only the development AAGUID", async () => {
    expect(await reasonFor({ env: "development" }, { aaguid: AAGUID.production })).toBe("aaguid");
  });

  test("a chain from another CA fails", async () => {
    expect(await reasonFor({}, { chainFrom: stranger })).toBe("chain");
  });

  test("no intermediate fails", async () => {
    expect(await reasonFor({}, { leafOnly: true })).toBe("format");
  });

  test("an expired credential certificate fails", async () => {
    expect(await reasonFor({ now: new Date(Date.now() + 400 * 24 * 3600 * 1000) })).toBe("expired");
  });

  test("a different challenge fails the nonce", async () => {
    expect(await reasonFor({ challenge: "B".repeat(43) })).toBe("nonce");
  });

  test("a wrong nonce in the certificate fails", async () => {
    expect(await reasonFor({}, { nonce: new Uint8Array(32) })).toBe("nonce");
  });

  test("a certificate without the nonce extension fails", async () => {
    expect(await reasonFor({}, { omitNonce: true })).toBe("nonce");
  });

  test("another key's id fails", async () => {
    expect(await reasonFor({ keyId: stranger.keyId })).toBe("public_key");
  });

  test("a key id that isn't 32 bytes of base64 fails", async () => {
    expect(await reasonFor({ keyId: "not-base64!" })).toBe("key_id");
  });

  test("another app's RP ID fails", async () => {
    expect(await reasonFor({}, { appId: "UXZV3C926U.com.example.other" })).toBe("rp_id");
  });

  test("a non-zero counter fails", async () => {
    expect(await reasonFor({}, { counter: 1 })).toBe("counter");
  });

  test("a credential id that isn't the key id fails", async () => {
    expect(await reasonFor({}, { credentialId: new Uint8Array(32).fill(7) })).toBe("credential_id");
  });

  test("another attestation format fails", async () => {
    expect(await reasonFor({}, { fmt: "packed" })).toBe("format");
  });

  test("bytes that aren't CBOR fail", async () => {
    expect(await reasonFor({ attestation: new Uint8Array([0xff, 0x00, 0x01]) })).toBe("cbor");
  });
});

describe("assertion", () => {
  const body = utf8('{"kind":"chat"}');
  const clientData = replyClientData(CHALLENGE, body);
  const verify = (assertion: Uint8Array, overrides: Partial<Parameters<typeof verifyAssertion>[0]> = {}) =>
    verifyAssertion({ assertion, clientData, publicKeySpki: device.publicKeySpki, appId: TEST_APP_ID, ...overrides });

  test("a valid assertion passes and returns its counter", () => {
    expect(verify(device.assertion(clientData, 7))).toEqual({ ok: true, counter: 7 });
  });

  test("the client data is the challenge followed by the exact body bytes", () => {
    expect(Buffer.from(clientData).toString()).toBe(`${CHALLENGE}{"kind":"chat"}`);
  });

  test("a changed body fails the signature", () => {
    expect(verify(device.assertion(clientData, 1), { clientData: replyClientData(CHALLENGE, utf8("{}")) })).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  test("a different challenge fails the signature", () => {
    const other = replyClientData("C".repeat(43), body);
    expect(verify(device.assertion(clientData, 1), { clientData: other }).ok).toBe(false);
  });

  test("another key's signature fails", () => {
    expect(verify(stranger.assertion(clientData, 1))).toEqual({ ok: false, reason: "signature" });
  });

  test("another app's RP ID fails", () => {
    expect(verify(device.assertion(clientData, 1, { appId: "other.app" }))).toEqual({ ok: false, reason: "rp_id" });
  });

  test("bytes that aren't CBOR fail", () => {
    expect(verify(new Uint8Array([0xff]))).toEqual({ ok: false, reason: "cbor" });
  });
});

describe("DER and authenticator data", () => {
  test("reads the nonce extension", () => {
    const nonce = new Uint8Array(32).fill(9);
    expect(readAppleNonce(nonceExtensionValue(nonce))).toEqual(nonce);
  });

  test("rejects trailing bytes, wrong tags and truncation", () => {
    const good = nonceExtensionValue(new Uint8Array(32));
    expect(readAppleNonce(new Uint8Array([...good, 0]))).toBeNull();
    expect(readAppleNonce(new Uint8Array([0x31, ...good.subarray(1)]))).toBeNull();
    expect(readAppleNonce(good.subarray(0, good.length - 1))).toBeNull();
    expect(readAppleNonce(new Uint8Array([0x30, 0x80]))).toBeNull();
  });

  test("parses an assertion's authenticator data", () => {
    const parsed = parseAuthData(buildAuthData({ attested: false, counter: 42 }));
    expect(parsed?.counter).toBe(42);
    expect(parsed?.aaguid).toBeUndefined();
  });

  test("rejects authenticator data that's too short", () => {
    expect(parseAuthData(new Uint8Array(36))).toBeNull();
    expect(parseAuthData(buildAuthData({ attested: true }).subarray(0, 60))).toBeNull();
  });

  test("strict base64", () => {
    expect(fromBase64(toBase64(new Uint8Array([1, 2, 3])))).toEqual(new Uint8Array([1, 2, 3]));
    expect(fromBase64("AQID")).toEqual(new Uint8Array([1, 2, 3]));
    expect(fromBase64("AQI")).toBeNull();
    expect(fromBase64("")).toBeNull();
    expect(fromBase64("AQ-_")).toBeNull();
  });
});
