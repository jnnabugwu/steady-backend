import { describe, expect, test } from "vitest";
import { CHAT, forSession, HELP_LINE, RULES, SUMMARY, SUMMARY_REQUEST, WEEKLY_SESSION } from "../src/coach/instructions.js";

/**
 * Guards the coach's tone and safety constraints (steady#82), ported one test
 * per test from the app's `coach_domain/test/coach_instructions_test.dart`.
 * Each test names one constraint; if an edit to the instructions drops it,
 * that test fails. Checked against every session kind, since each one is a
 * complete set of instructions on its own.
 *
 * Not ported: the Dart file's `contextSummary` group (6 tests). Those
 * instructions only carried a long chat across the on-device 4,096-token
 * window and weren't moved to the server (steady#149).
 */

const expectAll = (text: string, phrases: string[]) => {
  const lower = text.toLowerCase();
  for (const phrase of phrases) {
    expect(lower, phrase).toContain(phrase.toLowerCase());
  }
};

const kinds = { "weekly session": WEEKLY_SESSION, chat: CHAT };

for (const [kind, text] of Object.entries(kinds)) {
  describe(kind, () => {
    test("starts from the shared rules", () => {
      expect(text.startsWith(RULES)).toBe(true);
    });

    test("is a coach, not a therapist, and gives no medical advice", () => {
      expectAll(text, ["You are a coach, not a therapist", "don't give medical advice"]);
    });

    test("reflects on the person's own logged data and asks questions", () => {
      expectAll(text, ["Reflect on the person's own logged data", "ask questions"]);
    });

    test("keeps replies short, with at most one question", () => {
      expectAll(text, ["two to four sentences", "at most one question"]);
    });

    test("never originates calorie targets, weight goals, deficits or diets, including from craving data", () => {
      expectAll(text, [
        "Never give a calorie target",
        "a weight goal",
        "a calorie deficit",
        "a diet",
        "a meal plan",
        "even if asked",
        "not from craving data either",
      ]);
    });

    test("only uses numbers from the data", () => {
      expectAll(text, ["Don't make up numbers"]);
    });

    test("no streaks, grades or shame for missed or partial days", () => {
      expectAll(text, [
        "No streaks, grades, scores or shame",
        "A missed or partial day is information, not a failure",
        "Don't call days or foods good or bad",
      ]);
    });

    test("points to help, and does not coach through, disordered eating, feeling out of control with food, or a crisis", () => {
      expectAll(text, [
        "disordered eating",
        "out of control with food",
        "a crisis",
        "don't coach through it",
        "Thank them for saying it",
        "ANAD",
        "1-888-375-7767",
        "call or text 988",
      ]);
    });

    test("the numbers rule exempts the help lines, so it cannot suppress them", () => {
      // "Only mention numbers that are in the person's data" would otherwise
      // forbid the two numbers the Safety section requires.
      expectAll(text, ["apart from the help-line numbers under Safety"]);
      const rule = text.indexOf("Only mention numbers");
      expect(rule).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("1-888-375-7767")).toBeGreaterThan(rule);
    });

    test("stays compact", () => {
      // The Dart test's bound, kept: the hosted model has no 4,096-token
      // window, but the instructions are word for word from the app and
      // growing them should be a deliberate edit to this test.
      expect(text.length).toBeLessThan(2600);
    });
  });
}

test("the weekly session keeps logging and steps as separate threads", () => {
  expect(WEEKLY_SESSION).toContain("two things, one at a time, as separate topics");
  const logging = WEEKLY_SESSION.indexOf("first logging consistency");
  const steps = WEEKLY_SESSION.indexOf("then step consistency");
  expect(logging).toBeGreaterThanOrEqual(0);
  expect(steps).toBeGreaterThan(logging);
});

test("the weekly session is about 5 minutes, and says to keep it brief", () => {
  expect(WEEKLY_SESSION).toContain(
    "about 5 minutes, so keep it brief: one or two questions per topic and short replies",
  );
  expect(WEEKLY_SESSION).not.toContain("15 minutes");
});

test("the weekly session reflects on cravings without comparing weeks", () => {
  expect(WEEKLY_SESSION).toContain("Don't compare craving counts with other weeks");
});

describe("session instructions and the summary request", () => {
  test("a session's instructions are its kind's, then the data", () => {
    const text = forSession(CHAT, "Mon Oct 19: logged fully");
    expect(text.startsWith(CHAT)).toBe(true);
    expect(text.endsWith("The person's data:\nMon Oct 19: logged fully")).toBe(true);
  });

  test("the summary request is short and defers to the summary instructions", () => {
    expect(SUMMARY_REQUEST).toContain("neutral");
    expect(SUMMARY_REQUEST).toContain("following your instructions");
    expect(SUMMARY_REQUEST.length).toBeLessThan(400);
  });
});

describe("summary instructions", () => {
  test("don't carry the coaching rules, which ask for questions", () => {
    // The coaching rules say "ask questions"; a summary must not.
    expect(SUMMARY).not.toContain(RULES);
    expect(SUMMARY.toLowerCase()).not.toContain("ask questions");
    expectAll(SUMMARY, ["you are not the coach", "don't coach", "don't ask anything"]);
  });

  test("covers tracking habits and next week, briefly", () => {
    expectAll(SUMMARY, ["two or three short, neutral sentences", "tracking habits", "anything they chose to try next week"]);
  });

  test("gives no advice, questions, judgement, streaks or praise", () => {
    expectAll(SUMMARY, [
      "No advice, no questions and no judgement",
      "No streaks, grades, scores or praise",
      "Don't call days or foods good or bad",
    ]);
  });

  test("leaves out cravings and exact numbers (the app's CLAUDE.md §7)", () => {
    expectAll(SUMMARY, ["Leave out cravings", "Leave out exact numbers", "no calories, steps, weights or counts"]);
  });

  test("never adds calorie targets, weight goals, deficits or diets", () => {
    expectAll(SUMMARY, ["Never add a calorie target", "a weight goal", "a calorie deficit", "a diet", "a meal plan"]);
  });

  test("handles disordered eating or a crisis without detail", () => {
    expectAll(SUMMARY, [
      "disordered eating",
      "out of control with food",
      "a crisis",
      "say only that they talked about something hard",
      "were pointed to help",
    ]);
  });

  test("stays compact", () => {
    expect(SUMMARY.length).toBeLessThan(2600);
  });
});

describe("copy", () => {
  test("the help line names the same numbers as the instructions", () => {
    for (const number of ["1-888-375-7767", "988"]) {
      expect(HELP_LINE).toContain(number);
      expect(RULES).toContain(number);
    }
  });

  test("the help line points to help without coaching", () => {
    // Ported from the Dart "not-medical-advice note" test's slot: that copy
    // stays in the app (it's UI text, not instructions). What the server
    // keeps is the help line the app shows on `error {code: "refusal"}`.
    expect(HELP_LINE).toContain("you don't have to sort it out alone");
    expect(HELP_LINE).toContain("call or text 988");
  });
});
