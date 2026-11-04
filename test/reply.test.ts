import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";
import { MAX_BODY_BYTES } from "../src/coach/request.js";
import { handleReply, remainingDeadlineMs, REPLY_DEADLINE_MS, terminalEvent } from "../src/handlers/reply.js";
import { FakeUpstream, finalMessage, httpError, streamErrorEvent, THINKING_TEXT, type Script } from "./helpers/fake-upstream.js";
import { bypassRequest, chatBody, makeDeps, readSse } from "./helpers/harness.js";

const run = async (script: Script, body = chatBody()) => {
  const deps = makeDeps({ upstream: new FakeUpstream(script) });
  const response = await handleReply(bypassRequest(body), deps);
  return { deps, response, events: await readSse(response) };
};

describe("streaming", () => {
  test("snapshots carry the whole reply so far, then one done", async () => {
    const { response, events } = await run({ chunks: ["You logged", " every day", "."] });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(events).toEqual([
      { event: "snapshot", data: { text: "You logged" } },
      { event: "snapshot", data: { text: "You logged every day" } },
      { event: "snapshot", data: { text: "You logged every day." } },
      { event: "done", data: { stopReason: "end_turn" } },
    ]);
  });

  test("max_tokens ends with done {stopReason: max_tokens}", async () => {
    const { events } = await run({ chunks: ["Partly"], stopReason: "max_tokens" });
    expect(events.at(-1)).toEqual({ event: "done", data: { stopReason: "max_tokens" } });
  });

  test("a refusal before any output is error {code: refusal}, with no text", async () => {
    const { response, events } = await run({ chunks: [], stopReason: "refusal", refusalCategory: "bio" });
    expect(response.status).toBe(200);
    expect(events).toEqual([{ event: "error", data: { code: "refusal" } }]);
  });

  test("a refusal mid-stream ends with error {code: refusal} (the app discards the partial text)", async () => {
    const { events } = await run({ chunks: ["Let me", " think"], stopReason: "refusal" });
    expect(events.at(-1)).toEqual({ event: "error", data: { code: "refusal" } });
    expect(events.filter((e) => e.event === "done")).toHaveLength(0);
  });

  test("a mid-stream fallback keeps the cumulative snapshot going", async () => {
    const { deps, events } = await run({ chunks: ["One", null, " two."], fallback: true, model: "claude-opus-5" });
    expect(events).toEqual([
      { event: "snapshot", data: { text: "One" } },
      { event: "snapshot", data: { text: "One two." } },
      { event: "done", data: { stopReason: "end_turn" } },
    ]);
    expect(deps.logs[0]).toMatchObject({ fallback: true, model: "claude-opus-5" });
  });

  test("thinking never reaches the app", async () => {
    // The scripted stream opens with a thinking block that has text.
    const { events } = await run({ chunks: ["Hi."] });
    expect(events).toEqual([
      { event: "snapshot", data: { text: "Hi." } },
      { event: "done", data: { stopReason: "end_turn" } },
    ]);
    expect(JSON.stringify(events)).not.toContain(THINKING_TEXT);
  });

  test.each([
    ["overloaded mid-stream", streamErrorEvent("overloaded_error"), "upstream_unavailable"],
    ["a connection drop", new Anthropic.APIConnectionError({ message: "reset" }), "upstream_unavailable"],
    ["something unexpected", new Error("boom"), "server_error"],
  ])("%s after text ends with error {code: %s}", async (_name, error, code) => {
    const { response, events } = await run({ chunks: ["Hi", " there"], failAfterChunks: { count: 1, error } });
    expect(response.status).toBe(200);
    expect(events).toEqual([
      { event: "snapshot", data: { text: "Hi" } },
      { event: "error", data: { code } },
    ]);
  });

  test.each([
    ["429", httpError(429, "rate_limit_error"), 503, "upstream_unavailable"],
    ["529 overloaded", httpError(529, "overloaded_error"), 503, "upstream_unavailable"],
    ["500", httpError(500, "api_error"), 503, "upstream_unavailable"],
    ["a timeout", new Anthropic.APIConnectionTimeoutError(), 503, "upstream_unavailable"],
    ["a 400 from a request we built", httpError(400, "invalid_request_error"), 500, "server_error"],
    ["a bad API key", httpError(401, "authentication_error"), 500, "server_error"],
  ])("Anthropic %s before any output: HTTP %i, error {code: %s}", async (_name, error, status, code) => {
    const { response, events } = await run({ failOnStart: error });
    expect(response.status).toBe(status);
    expect(events).toEqual([{ event: "error", data: { code } }]);
  });

  test("every stream ends with exactly one done or error", async () => {
    for (const script of [
      { chunks: ["a"] },
      { chunks: ["a"], stopReason: "max_tokens" as const },
      { chunks: ["a"], stopReason: "refusal" as const },
      { chunks: ["a"], failAfterChunks: { count: 1, error: new Error("x") } },
      { failOnStart: httpError(529, "overloaded_error") },
    ]) {
      const { events } = await run(script);
      const terminals = events.filter((e) => e.event === "done" || e.event === "error");
      expect(terminals).toHaveLength(1);
      expect(events.at(-1)).toBe(terminals[0]);
    }
  });

  test("the app cancelling aborts the upstream request", async () => {
    const deps = makeDeps({ upstream: new FakeUpstream({ chunks: ["Hi", " there"], hangAfterChunks: 1 }) });
    const response = await handleReply(bypassRequest(chatBody()), deps);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"text":"Hi"');
    await reader.cancel();
    expect(deps.fake.calls[0]?.signal.aborted).toBe(true);
    expect(deps.logs[0]).toMatchObject({ status: 200, cancelled: true });
  });
});

describe("before streaming", () => {
  test("the kill switch answers coach_disabled (503) without calling Anthropic", async () => {
    for (const value of ["false", "", "TRUE", "1"]) {
      const deps = makeDeps({ env: { COACH_ENABLED: value } });
      const response = await handleReply(bypassRequest(chatBody()), deps);
      expect(response.status).toBe(503);
      expect(await readSse(response)).toEqual([{ event: "error", data: { code: "coach_disabled" } }]);
      expect(deps.fake.calls).toHaveLength(0);
    }
  });

  test("a malformed body is bad_request (400)", async () => {
    const deps = makeDeps();
    const response = await handleReply(bypassRequest('{"kind":"chat"}'), deps);
    expect(response.status).toBe(400);
    expect(await readSse(response)).toEqual([{ event: "error", data: { code: "bad_request" } }]);
    expect(deps.fake.calls).toHaveLength(0);
  });

  test("a body over the size limit is bad_request (400)", async () => {
    const deps = makeDeps();
    const response = await handleReply(bypassRequest("x".repeat(MAX_BODY_BYTES + 1)), deps);
    expect(response.status).toBe(400);
  });

  test("invalid UTF-8 is bad_request", async () => {
    const deps = makeDeps();
    const request = new Request("https://proxy.test/api/coach/reply", {
      method: "POST",
      headers: { "x-steady-dev-bypass": "dev-token-for-tests" },
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    });
    expect((await handleReply(request, deps)).status).toBe(400);
  });

  test("no attestation is attestation_failed (401)", async () => {
    const deps = makeDeps();
    const request = new Request("https://proxy.test/api/coach/reply", { method: "POST", body: chatBody() });
    const response = await handleReply(request, deps);
    expect(response.status).toBe(401);
    expect(await readSse(response)).toEqual([{ event: "error", data: { code: "attestation_failed" } }]);
  });

  test("over the device's daily limit is rate_limited (429) with retryAfter to UTC midnight", async () => {
    const deps = makeDeps({ env: { COACH_DAILY_LIMIT: "2" }, now: new Date("2026-11-02T23:00:00Z") });
    for (let i = 0; i < 2; i++) await readSse(await handleReply(bypassRequest(chatBody()), deps));
    const response = await handleReply(bypassRequest(chatBody()), deps);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3600");
    expect(await readSse(response)).toEqual([{ event: "error", data: { code: "rate_limited", retryAfter: 3600 } }]);
    expect(deps.fake.calls).toHaveLength(2);
  });

  test("a store failure is server_error (500)", async () => {
    const deps = makeDeps();
    deps.store = () => {
      throw new Error("redis down");
    };
    const response = await handleReply(bypassRequest(chatBody()), deps);
    expect(response.status).toBe(500);
    expect(await readSse(response)).toEqual([{ event: "error", data: { code: "server_error" } }]);
  });
});

describe("what's sent and what's logged", () => {
  test("the request carries the server's instructions and the person's turns", async () => {
    const { deps } = await run({ chunks: ["Hi."] });
    const params = deps.fake.calls[0]!.params;
    expect(params.model).toBe("claude-opus-5-5");
    expect(JSON.stringify(params.system)).toContain("You are Steady's coach.");
    expect(params.messages).toEqual([{ role: "user", content: [{ type: "text", text: "How did I do this week?" }] }]);
  });

  test("logs are metadata only: no turns, no week context, no reply text, no raw key id", async () => {
    const secret = "SECRET-PERSON-TEXT-91";
    const deps = makeDeps({ upstream: new FakeUpstream({ chunks: ["SECRET-REPLY-TEXT"], usage: { cache_read_input_tokens: 512 } }) });
    const body = chatBody({ weekContext: "SECRET-WEEK-CONTEXT", turns: [{ role: "person", text: secret }] });
    await readSse(await handleReply(bypassRequest(body), deps));
    expect(deps.logs).toHaveLength(1);
    const line = JSON.stringify(deps.logs[0]);
    for (const leaked of [secret, "SECRET-WEEK-CONTEXT", "SECRET-REPLY-TEXT", "dev-token-for-tests"]) {
      expect(line).not.toContain(leaked);
    }
    expect(deps.logs[0]).toMatchObject({
      route: "coach.reply",
      status: 200,
      kind: "chat",
      key: "dev-bypass",
      stopReason: "end_turn",
      inputTokens: 900,
      outputTokens: 120,
      cacheReadTokens: 512,
      fallback: false,
    });
  });

  test("a streamed reply logs the time before Anthropic and to the first text", async () => {
    const { deps } = await run({ chunks: ["Hi."] });
    expect(deps.logs[0]?.preStreamMs).toBeGreaterThanOrEqual(0);
    expect(deps.logs[0]?.firstTextMs).toBeGreaterThanOrEqual(0);
  });

  test("a request refused before Anthropic logs no preStreamMs", async () => {
    const deps = makeDeps({ upstream: new FakeUpstream({ chunks: ["Hi."] }) });
    await readSse(await handleReply(bypassRequest("{"), deps));
    expect(deps.logs[0]).toMatchObject({ code: "bad_request" });
    expect(deps.logs[0]?.preStreamMs).toBeUndefined();
  });

  test("a refusal logs its category", async () => {
    const { deps } = await run({ chunks: [], stopReason: "refusal", refusalCategory: "bio" });
    expect(deps.logs[0]).toMatchObject({ code: "refusal", stopReason: "refusal", refusalCategory: "bio" });
  });

  test("an upstream error logs its class, not its message", async () => {
    const { deps } = await run({ failOnStart: httpError(529, "overloaded_error") });
    expect(deps.logs[0]?.upstreamError).toContain("529");
    expect(JSON.stringify(deps.logs[0])).not.toContain("upstream says no");
  });
});

describe("deadline", () => {
  test("counts from the request's start, so setup time comes off the stream's share", () => {
    expect(remainingDeadlineMs(1_000, 1_000)).toBe(REPLY_DEADLINE_MS);
    expect(remainingDeadlineMs(1_000, 16_000)).toBe(REPLY_DEADLINE_MS - 15_000);
    expect(remainingDeadlineMs(0, REPLY_DEADLINE_MS + 5)).toBe(0);
    expect(REPLY_DEADLINE_MS).toBeLessThan(120_000); // vercel.json maxDuration
  });
});

describe("terminalEvent", () => {
  test.each([
    ["end_turn", { event: "done", data: { stopReason: "end_turn" } }],
    ["stop_sequence", { event: "done", data: { stopReason: "end_turn" } }],
    ["max_tokens", { event: "done", data: { stopReason: "max_tokens" } }],
    ["model_context_window_exceeded", { event: "done", data: { stopReason: "max_tokens" } }],
    ["refusal", { event: "error", data: { code: "refusal" } }],
    ["tool_use", { event: "error", data: { code: "server_error" } }],
    ["pause_turn", { event: "error", data: { code: "server_error" } }],
  ] as const)("%s", (stopReason, expected) => {
    expect(terminalEvent(finalMessage({ stopReason }))).toEqual(expected);
  });
});
