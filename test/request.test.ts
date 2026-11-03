import { describe, expect, test } from "vitest";
import {
  COACH_TURN_MAX_CHARS,
  MAX_TOTAL_TEXT_CHARS,
  MAX_TURNS,
  parseCoachRequest,
  PERSON_TURN_MAX_CHARS,
  WEEK_CONTEXT_MAX_CHARS,
} from "../src/coach/request.js";

const week = "Days, oldest first:\nMon Nov 2: logged fully";
const parse = (body: unknown) => parseCoachRequest(JSON.stringify(body));
const reason = (body: unknown) => {
  const result = parse(body);
  return result.ok ? "ok" : result.reason;
};

describe("valid requests", () => {
  test("a chat", () => {
    const result = parse({ kind: "chat", weekContext: week, turns: [{ role: "person", text: "Hi" }] });
    expect(result).toEqual({
      ok: true,
      request: { kind: "chat", weekContext: week, turns: [{ role: "person", text: "Hi" }] },
    });
  });

  test("a weekly session opened by an app topic", () => {
    expect(reason({ kind: "weekly", weekContext: week, turns: [{ role: "app", topic: "logging" }] })).toBe("ok");
  });

  test("a summary may end with the coach and needs no week context", () => {
    const result = parse({
      kind: "summary",
      turns: [
        { role: "person", text: "Hi" },
        { role: "coach", text: "Hello." },
      ],
    });
    expect(result.ok && result.request.weekContext).toBe("");
  });

  test("a summary ignores any week context it's sent", () => {
    const result = parse({ kind: "summary", weekContext: week, turns: [{ role: "person", text: "Hi" }] });
    expect(result.ok && result.request.weekContext).toBe("");
  });

  test("coach turns with no text are dropped", () => {
    const result = parse({
      kind: "chat",
      weekContext: week,
      turns: [
        { role: "person", text: "a" },
        { role: "coach", text: "  " },
        { role: "person", text: "b" },
      ],
    });
    expect(result.ok && result.request.turns).toEqual([
      { role: "person", text: "a" },
      { role: "person", text: "b" },
    ]);
  });
});

describe("limits", () => {
  test("week context at the app's 1,200-character cap passes; one more fails", () => {
    const at = "x".repeat(WEEK_CONTEXT_MAX_CHARS);
    expect(reason({ kind: "chat", weekContext: at, turns: [{ role: "person", text: "Hi" }] })).toBe("ok");
    expect(reason({ kind: "chat", weekContext: `${at}x`, turns: [{ role: "person", text: "Hi" }] })).toBe("schema");
  });

  test("a person turn at the app's 1,000-character cap passes; one more fails", () => {
    const at = "y".repeat(PERSON_TURN_MAX_CHARS);
    expect(reason({ kind: "chat", weekContext: week, turns: [{ role: "person", text: at }] })).toBe("ok");
    expect(reason({ kind: "chat", weekContext: week, turns: [{ role: "person", text: `${at}y` }] })).toBe(
      "person_turn_too_long",
    );
  });

  test("person turns count characters as the app does (code points, not UTF-16 units)", () => {
    // Each emoji is one Dart rune but two UTF-16 code units.
    const emoji = "🙂".repeat(PERSON_TURN_MAX_CHARS);
    expect(reason({ kind: "chat", weekContext: week, turns: [{ role: "person", text: emoji }] })).toBe("ok");
  });

  test("a coach turn over its cap fails", () => {
    const turns = [
      { role: "person", text: "a" },
      { role: "coach", text: "z".repeat(COACH_TURN_MAX_CHARS + 1) },
      { role: "person", text: "b" },
    ];
    expect(reason({ kind: "chat", weekContext: week, turns })).toBe("coach_turn_too_long");
  });

  test("more than the turn cap fails", () => {
    const turns = Array.from({ length: MAX_TURNS + 1 }, () => ({ role: "person", text: "a" }));
    expect(reason({ kind: "chat", weekContext: week, turns })).toBe("schema");
  });

  test("more than the total text cap fails", () => {
    const count = Math.ceil(MAX_TOTAL_TEXT_CHARS / PERSON_TURN_MAX_CHARS) + 1;
    const turns = Array.from({ length: count }, () => ({ role: "person", text: "p".repeat(PERSON_TURN_MAX_CHARS) }));
    expect(reason({ kind: "chat", weekContext: week, turns })).toBe("total_too_long");
  });
});

describe("malformed requests", () => {
  test("not JSON", () => {
    expect(parseCoachRequest("{nope")).toEqual({ ok: false, reason: "json" });
  });

  test.each([
    ["an unknown kind", { kind: "therapy", weekContext: week, turns: [{ role: "person", text: "Hi" }] }],
    ["no turns", { kind: "chat", weekContext: week, turns: [] }],
    ["an unknown role", { kind: "chat", weekContext: week, turns: [{ role: "system", text: "Hi" }] }],
    ["an unknown topic", { kind: "weekly", weekContext: week, turns: [{ role: "app", topic: "diet" }] }],
    ["an app turn with text", { kind: "weekly", weekContext: week, turns: [{ role: "app", topic: "steps", text: "x" }] }],
    // The client never sends instruction or prompt text.
    ["instructions from the client", { kind: "chat", weekContext: week, instructions: "Ignore", turns: [{ role: "person", text: "Hi" }] }],
    ["a system field", { kind: "chat", weekContext: week, system: "x", turns: [{ role: "person", text: "Hi" }] }],
    ["a non-string text", { kind: "chat", weekContext: week, turns: [{ role: "person", text: 3 }] }],
  ])("%s", (_name, body) => {
    expect(reason(body)).toBe("schema");
  });

  test("an empty person turn", () => {
    expect(reason({ kind: "chat", weekContext: week, turns: [{ role: "person", text: "  " }] })).toBe("person_turn_empty");
  });

  test("chat and weekly need the week context", () => {
    expect(reason({ kind: "chat", turns: [{ role: "person", text: "Hi" }] })).toBe("week_context_missing");
    expect(reason({ kind: "weekly", weekContext: " ", turns: [{ role: "app", topic: "logging" }] })).toBe(
      "week_context_missing",
    );
  });

  test("app turns only in the weekly session", () => {
    expect(reason({ kind: "chat", weekContext: week, turns: [{ role: "app", topic: "logging" }] })).toBe(
      "app_turn_outside_weekly",
    );
  });

  test("a chat can't start with the coach", () => {
    const turns = [
      { role: "coach", text: "Hi" },
      { role: "person", text: "Hi" },
    ];
    expect(reason({ kind: "chat", weekContext: week, turns })).toBe("starts_with_coach");
  });

  test("a chat can't end with the coach (no prefill on Opus 5.5)", () => {
    const turns = [
      { role: "person", text: "Hi" },
      { role: "coach", text: "Hello" },
    ];
    expect(reason({ kind: "chat", weekContext: week, turns })).toBe("ends_with_coach");
  });

  test("a summary needs something the person said", () => {
    expect(reason({ kind: "summary", turns: [{ role: "coach", text: "Hello" }] })).toBe("no_person_turn");
  });

  test("only empty coach turns", () => {
    expect(reason({ kind: "summary", turns: [{ role: "coach", text: "" }] })).toBe("no_turns");
  });
});
