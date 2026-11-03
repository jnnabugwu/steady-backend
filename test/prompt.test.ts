import { describe, expect, test } from "vitest";
import { CHAT, forSession, SUMMARY, SUMMARY_REQUEST, WEEKLY_SESSION } from "../src/coach/instructions.js";
import { buildCoachParams, buildMessages, buildSystem, FALLBACK_BETA, MODEL } from "../src/coach/prompt.js";
import type { CoachRequest } from "../src/coach/request.js";
import { weeklyTopicPrompt } from "../src/coach/weekly.js";

const week = "Days, oldest first:\nMon Nov 2: logged fully; 8412 steps";
const secret = "PERSON-TYPED-THIS-7f3a";

const chat: CoachRequest = {
  kind: "chat",
  weekContext: week,
  turns: [
    { role: "person", text: `How was my week? ${secret}` },
    { role: "coach", text: "You logged every day." },
    { role: "person", text: "Thanks" },
  ],
};
const weekly: CoachRequest = {
  kind: "weekly",
  weekContext: week,
  turns: [
    { role: "app", topic: "logging" },
    { role: "coach", text: "How did the week feel?" },
    { role: "person", text: `Fine ${secret}` },
    { role: "coach", text: "Good to hear." },
    { role: "app", topic: "steps" },
  ],
};
const summary: CoachRequest = {
  kind: "summary",
  weekContext: "",
  turns: [
    { role: "app", topic: "logging" },
    { role: "coach", text: "How did the week feel?" },
    { role: "person", text: `Fine ${secret}` },
  ],
};

const systemText = (request: CoachRequest) => buildSystem(request).map((b) => b.text).join("\n\n");

describe("Opus 5.5 settings", () => {
  test.each([chat, weekly, summary])("$kind: model, effort, max_tokens, fallback, no sampling or thinking", (request) => {
    const params = buildCoachParams(request, "abc123");
    expect(params.model).toBe(MODEL);
    expect(MODEL).toBe("claude-opus-5-5");
    expect(params.output_config).toEqual({ effort: "low" });
    expect(params.max_tokens).toBeGreaterThanOrEqual(2048);
    expect(params.betas).toEqual([FALLBACK_BETA]);
    expect(FALLBACK_BETA).toBe("server-side-fallback-2026-07-01");
    expect(params.fallbacks).toBe("default");
    expect(params.metadata).toEqual({ user_id: "abc123" });
    // Thinking can't be disabled on Opus 5.5; left out, it runs adaptive.
    expect(params).not.toHaveProperty("thinking");
    for (const field of ["temperature", "top_p", "top_k", "stop_sequences", "tools"]) {
      expect(params).not.toHaveProperty(field);
    }
  });

  test("chat and weekly use automatic caching for the conversation; a summary doesn't", () => {
    expect(buildCoachParams(chat, "k").cache_control).toEqual({ type: "ephemeral" });
    expect(buildCoachParams(weekly, "k").cache_control).toEqual({ type: "ephemeral" });
    expect(buildCoachParams(summary, "k")).not.toHaveProperty("cache_control");
  });
});

describe("system", () => {
  test("chat: the cached chat instructions, then the week, reading as the app's forSession", () => {
    const blocks = buildSystem(chat);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: CHAT, cache_control: { type: "ephemeral" } });
    expect(blocks[1]).toEqual({ type: "text", text: `The person's data:\n${week}` });
    expect(systemText(chat)).toBe(forSession(CHAT, week));
  });

  test("weekly: the weekly session's instructions, then the week", () => {
    expect(buildSystem(weekly)[0]?.text).toBe(WEEKLY_SESSION);
    expect(systemText(weekly)).toBe(forSession(WEEKLY_SESSION, week));
  });

  test("summary: only the summary instructions, no week data", () => {
    expect(buildSystem(summary)).toEqual([{ type: "text", text: SUMMARY, cache_control: { type: "ephemeral" } }]);
  });

  test.each([chat, weekly, summary])("$kind: the person's text never reaches the system prompt", (request) => {
    expect(systemText(request)).not.toContain(secret);
    expect(JSON.stringify(buildCoachParams(request, "k").system)).not.toContain(secret);
  });
});

describe("messages", () => {
  test("chat: person turns as user, coach turns as assistant, plain text", () => {
    expect(buildMessages(chat)).toEqual([
      { role: "user", content: [{ type: "text", text: `How was my week? ${secret}` }] },
      { role: "assistant", content: [{ type: "text", text: "You logged every day." }] },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
    ]);
  });

  test("weekly: app topics are expanded on the server into user turns", () => {
    const messages = buildMessages(weekly);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(messages[0]?.content).toEqual([{ type: "text", text: weeklyTopicPrompt("logging") }]);
    expect(messages[4]?.content).toEqual([{ type: "text", text: weeklyTopicPrompt("steps") }]);
  });

  test("consecutive turns on one side share a message", () => {
    const messages = buildMessages({
      kind: "weekly",
      weekContext: week,
      turns: [
        { role: "person", text: "One more thing" },
        { role: "app", topic: "nextWeek" },
      ],
    });
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "One more thing" },
          { type: "text", text: weeklyTopicPrompt("nextWeek") },
        ],
      },
    ]);
  });

  test("no thinking blocks are ever sent back (the proxy is stateless)", () => {
    for (const request of [chat, weekly]) {
      for (const message of buildMessages(request)) {
        for (const block of message.content as { type: string }[]) expect(block.type).toBe("text");
      }
    }
  });

  test("summary: one user turn, the app's summary request then the transcript, app prompts left out", () => {
    expect(buildMessages(summary)).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${SUMMARY_REQUEST}\n\nThe conversation:\nCoach: How did the week feel?\nPerson: Fine ${secret}`,
          },
        ],
      },
    ]);
  });
});
