import { describe, expect, test } from "vitest";
import { WEEKLY_TOPICS, weeklyTopicPrompt } from "../src/coach/weekly.js";

/** Ported from the app's `coach_domain/test/coach_weekly_test.dart` (the prompt tests). */
describe("weekly topic prompts", () => {
  test("the topics are the app's WeeklyTopic names, in order", () => {
    expect(WEEKLY_TOPICS).toEqual(["logging", "steps", "cravings", "nextWeek"]);
  });

  test("the logging topic opens by asking how the week felt, as its only question", () => {
    const prompt = weeklyTopicPrompt("logging");
    expect(prompt).toContain("asking how the week felt");
    expect(prompt).toContain("logging consistency");
    // One question per reply (RULES). The prompt used to ask for the feeling
    // question *and* a second one from the data.
    expect(prompt).toContain("as your only question");
    expect(prompt).not.toContain("one question");
  });

  test("each later topic is a new thread that leaves the last behind", () => {
    expect(weeklyTopicPrompt("steps")).toContain("new topic");
    expect(weeklyTopicPrompt("steps")).toContain("Leave logging behind");
    expect(weeklyTopicPrompt("cravings")).toContain("new topic");
  });

  test("the craving reflection is an observation with a question, never a grade, a comparison or food advice", () => {
    const prompt = weeklyTopicPrompt("cravings");
    for (const phrase of [
      "when they came and what was behind them",
      "as an observation",
      "ask one question",
      "No grades",
      "no comparison with other weeks",
      "nothing about calories or food choices",
    ]) {
      expect(prompt, phrase).toContain(phrase);
    }
  });

  test("next week is one small thing the person chooses, never a calorie target or diet", () => {
    const prompt = weeklyTopicPrompt("nextWeek");
    expect(prompt).toContain("one small thing");
    expect(prompt).toContain("something to do");
    expect(prompt).toContain("Let them choose");
    expect(prompt).toContain("never suggest calorie targets or diets");
  });
});
