import { describe, expect, test } from "vitest";
import { ConfigError, readConfig } from "../src/config.js";
import { checkDailyLimits, utcDay } from "../src/rate-limit.js";
import { MemoryStore } from "../src/store/memory.js";
import { classifyUpstreamError } from "../src/upstream.js";
import Anthropic from "@anthropic-ai/sdk";
import { httpError, streamErrorEvent } from "./helpers/fake-upstream.js";
import { testConfig } from "./helpers/harness.js";

describe("daily limits", () => {
  const now = new Date("2026-11-02T18:30:00Z");

  test("resets at the next UTC midnight", () => {
    expect(utcDay(now)).toEqual({ day: "2026-11-02", resetAt: Date.UTC(2026, 10, 3) / 1000 });
  });

  test("a device over its limit is refused with retryAfter, and doesn't use up the global allowance", async () => {
    const store = new MemoryStore(() => now.getTime());
    const config = testConfig({ COACH_DAILY_LIMIT: "2", COACH_GLOBAL_DAILY_LIMIT: "10" });
    expect(await checkDailyLimits(store, "a", config, now)).toEqual({ ok: true });
    expect(await checkDailyLimits(store, "a", config, now)).toEqual({ ok: true });
    expect(await checkDailyLimits(store, "a", config, now)).toEqual({ ok: false, scope: "device", retryAfter: 5.5 * 3600 });
    expect(await store.incrementDaily("global:2026-11-02", 0)).toBe(3); // two counted, plus this one
  });

  test("the global backstop applies across devices", async () => {
    const store = new MemoryStore(() => now.getTime());
    const config = testConfig({ COACH_DAILY_LIMIT: "5", COACH_GLOBAL_DAILY_LIMIT: "2" });
    expect((await checkDailyLimits(store, "a", config, now)).ok).toBe(true);
    expect((await checkDailyLimits(store, "b", config, now)).ok).toBe(true);
    expect(await checkDailyLimits(store, "c", config, now)).toMatchObject({ ok: false, scope: "global" });
  });

  test("counts start again the next UTC day", async () => {
    let clock = now.getTime();
    const store = new MemoryStore(() => clock);
    const config = testConfig({ COACH_DAILY_LIMIT: "1" });
    expect((await checkDailyLimits(store, "a", config, new Date(clock))).ok).toBe(true);
    expect((await checkDailyLimits(store, "a", config, new Date(clock))).ok).toBe(false);
    clock = Date.UTC(2026, 10, 3, 0, 0, 1);
    expect((await checkDailyLimits(store, "a", config, new Date(clock))).ok).toBe(true);
  });
});

describe("config", () => {
  test("defaults: coach off, production attestation, the Steady app id", () => {
    const config = readConfig({});
    expect(config).toMatchObject({
      coachEnabled: false,
      attestEnv: "production",
      appId: "UXZV3C926U.com.jmagic.steady",
      dailyLimit: 60,
      globalDailyLimit: 1000,
      devBypassToken: undefined,
    });
  });

  test("only the exact string true turns the coach on", () => {
    expect(readConfig({ COACH_ENABLED: "true" }).coachEnabled).toBe(true);
    for (const value of ["True", "1", "yes", " true"]) expect(readConfig({ COACH_ENABLED: value }).coachEnabled).toBe(false);
  });

  test("reads Upstash's names first, then the Marketplace integration's", () => {
    expect(readConfig({ KV_REST_API_URL: "https://kv", KV_REST_API_TOKEN: "t" })).toMatchObject({ redisUrl: "https://kv", redisToken: "t" });
    expect(
      readConfig({ UPSTASH_REDIS_REST_URL: "https://up", UPSTASH_REDIS_REST_TOKEN: "u", KV_REST_API_URL: "https://kv" }),
    ).toMatchObject({ redisUrl: "https://up", redisToken: "u" });
  });

  test("rejects unusable values", () => {
    expect(() => readConfig({ APP_ATTEST_ENV: "staging" })).toThrow(ConfigError);
    expect(() => readConfig({ COACH_DAILY_LIMIT: "0" })).toThrow(ConfigError);
    expect(() => readConfig({ COACH_GLOBAL_DAILY_LIMIT: "ten" })).toThrow(ConfigError);
  });
});

describe("upstream errors", () => {
  test.each([
    [httpError(429, "rate_limit_error"), "upstream_unavailable"],
    [httpError(529, "overloaded_error"), "upstream_unavailable"],
    [httpError(503, "api_error"), "upstream_unavailable"],
    [streamErrorEvent("overloaded_error"), "upstream_unavailable"],
    [new Anthropic.APIConnectionError({ message: "x" }), "upstream_unavailable"],
    [httpError(400, "invalid_request_error"), "server_error"],
    [httpError(403, "permission_error"), "server_error"],
    [new Anthropic.APIUserAbortError(), "aborted"],
    [new TypeError("x"), "server_error"],
  ])("%s → %s", (error, expected) => {
    expect(classifyUpstreamError(error)).toBe(expected);
  });
});
