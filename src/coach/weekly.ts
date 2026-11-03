/**
 * The weekly session's topic openings, moved word for word from the app's
 * `features/coach/coach_domain/lib/src/coach_weekly.dart` (`weeklyTopicPrompt`).
 *
 * The app sends `{role: "app", topic}` where a topic opens; the server expands
 * it here, so the app never sends prompt text. These are app prompts, not the
 * person's words: the app's transcript never shows them, only the coach's
 * reply.
 */

/** One thread of the weekly session, by the app's `WeeklyTopic` names. */
export const WEEKLY_TOPICS = ["logging", "steps", "cravings", "nextWeek"] as const;
export type WeeklyTopic = (typeof WEEKLY_TOPICS)[number];

/**
 * What the coach is told to start `topic` with.
 *
 * The craving prompt follows `docs/research/craving_support.md` ("What the
 * weekly review could reflect on"): when and what was behind them, as an
 * observation with a question; no grade, no comparison with other weeks,
 * nothing about calories or food.
 */
export function weeklyTopicPrompt(topic: WeeklyTopic): string {
  switch (topic) {
    case "logging":
      return (
        "Begin the weekly check-in by asking how the week felt. Keep it to " +
        "logging consistency: which days were logged fully, partly or " +
        "skipped. Make at most one observation from the data, and ask how " +
        "the week felt as your only question."
      );
    case "steps":
      return (
        "Move to a new topic: step consistency this week. Leave logging behind. " +
        "One observation from the step data, one question. If there is no " +
        "step data, say so briefly and ask how moving felt this week."
      );
    case "cravings":
      return (
        "Move to a new topic: the craving check-ins this week. Describe when " +
        "they came and what was behind them, as an observation, then ask " +
        "one question. No grades, no comparison with other weeks, and " +
        "nothing about calories or food choices."
      );
    case "nextWeek":
      return (
        "Last topic: ask if there's one small thing they'd like to try next " +
        "week. If they pick one, help phrase it as something to do, like " +
        "\"If I'm tired in the afternoon, then I'll have the snack I " +
        'brought." ' +
        "Let them choose; never suggest calorie targets or diets."
      );
  }
}
