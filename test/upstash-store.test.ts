import { afterEach, describe, expect, test, vi } from "vitest";
import { UpstashStore } from "../src/store/upstash.js";

/**
 * `UpstashStore` against a stubbed Upstash REST API, so the replies have the
 * shapes the real service sends. The other tests use `MemoryStore`, which is
 * why a key that registered and then read back as unknown went unnoticed
 * until a real device used Production.
 */

/** Answers each REST call with `{result}` from [reply], given the command. */
function stubUpstash(reply: (command: unknown[]) => unknown) {
  const fetchStub = vi.fn((_url: unknown, init?: RequestInit) => {
    const command = JSON.parse(init?.body as string) as unknown[];
    return Promise.resolve(
      new Response(JSON.stringify({ result: reply(command) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

const store = () => new UpstashStore("https://example.upstash.io", "token");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UpstashStore.getKey", () => {
  test("reads a stored key from HGETALL's flat field/value reply", async () => {
    const fetchStub = stubUpstash(() => ["publicKey", "cHVibGljS2V5", "counter", "3"]);

    expect(await store().getKey("a2V5")).toEqual({ publicKey: "cHVibGljS2V5", counter: 3 });
    expect(JSON.parse(fetchStub.mock.calls[0]?.[1]?.body as string)).toEqual(["hgetall", "attest:key:a2V5"]);
  });

  test("a key that isn't there is null", async () => {
    stubUpstash(() => []);

    expect(await store().getKey("a2V5")).toBeNull();
  });

  test("a stored key missing a field, or with a bad counter, is null", async () => {
    stubUpstash(() => ["publicKey", "cHVibGljS2V5"]);
    expect(await store().getKey("a2V5")).toBeNull();

    stubUpstash(() => ["publicKey", "cHVibGljS2V5", "counter", "not a number"]);
    expect(await store().getKey("a2V5")).toBeNull();
  });

  test("the public key stays the stored string, never JSON-parsed", async () => {
    stubUpstash(() => ["publicKey", "12345", "counter", "0"]);

    expect(await store().getKey("a2V5")).toEqual({ publicKey: "12345", counter: 0 });
  });
});
