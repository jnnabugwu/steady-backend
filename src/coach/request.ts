import { z } from "zod";
import { WEEKLY_TOPICS, type WeeklyTopic } from "./weekly.js";

/**
 * The `/api/coach/reply` request body and its limits.
 *
 * The app sends the session's kind, the week's context and the conversation;
 * it never sends instruction or prompt text (the server owns those,
 * `instructions.ts`). Anything malformed or over a limit is a 400
 * `bad_request`.
 */

/** The most bytes a request body may have. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * The most UTF-16 code units in `weekContext`: the app's
 * `coachWeekContextMaxChars`, which `formatCoachWeek` cuts to with Dart's
 * `String.length` (also UTF-16 code units).
 */
export const WEEK_CONTEXT_MAX_CHARS = 1200;

/**
 * The most characters (Unicode code points) in one person turn: the app's
 * `coachMaxMessageChars`, which it counts in Dart runes.
 */
export const PERSON_TURN_MAX_CHARS = 1000;

/**
 * The most characters (code points) in one coach turn. The instructions ask
 * for two to four sentences; this is a backstop, not a style limit.
 */
export const COACH_TURN_MAX_CHARS = 4000;

/** The most turns in one request, of any role. */
export const MAX_TURNS = 100;

/** The most characters (code points) across every turn's text together. */
export const MAX_TOTAL_TEXT_CHARS = 40_000;

export const SESSION_KINDS = ["chat", "weekly", "summary"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export type Turn =
  | { role: "person"; text: string }
  | { role: "coach"; text: string }
  | { role: "app"; topic: WeeklyTopic };

/** A validated request. Coach turns with no text have been dropped. */
export interface CoachRequest {
  kind: SessionKind;
  /** The app's `formatCoachWeek` text. Empty for `summary`, which ignores it. */
  weekContext: string;
  turns: Turn[];
}

/** Unicode code points, as Dart counts runes. */
const codePoints = (s: string): number => Array.from(s).length;

const turnSchema = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("person"), text: z.string() }),
  z.strictObject({ role: z.literal("coach"), text: z.string() }),
  z.strictObject({ role: z.literal("app"), topic: z.enum(WEEKLY_TOPICS) }),
]);

const bodySchema = z.strictObject({
  kind: z.enum(SESSION_KINDS),
  weekContext: z.string().max(WEEK_CONTEXT_MAX_CHARS).optional(),
  turns: z.array(turnSchema).min(1).max(MAX_TURNS),
});

/** Why a body was rejected. For tests and logs; never sent to the app. */
export type RejectReason =
  | "json"
  | "schema"
  | "person_turn_empty"
  | "person_turn_too_long"
  | "coach_turn_too_long"
  | "total_too_long"
  | "week_context_missing"
  | "app_turn_outside_weekly"
  | "starts_with_coach"
  | "ends_with_coach"
  | "no_person_turn"
  | "no_turns";

export type ParseResult =
  | { ok: true; request: CoachRequest }
  | { ok: false; reason: RejectReason };

/** Parses and validates a raw request body. */
export function parseCoachRequest(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "json" };
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "schema" };
  const { kind, weekContext, turns: rawTurns } = parsed.data;

  let total = 0;
  const turns: Turn[] = [];
  for (const turn of rawTurns) {
    switch (turn.role) {
      case "person": {
        if (turn.text.trim() === "") return { ok: false, reason: "person_turn_empty" };
        const n = codePoints(turn.text);
        if (n > PERSON_TURN_MAX_CHARS) return { ok: false, reason: "person_turn_too_long" };
        total += n;
        turns.push({ role: "person", text: turn.text });
        break;
      }
      case "coach": {
        const n = codePoints(turn.text);
        if (n > COACH_TURN_MAX_CHARS) return { ok: false, reason: "coach_turn_too_long" };
        total += n;
        // A reply stopped before any text: nothing was said, so nothing to
        // send (the API rejects empty text blocks).
        if (turn.text.trim() !== "") turns.push({ role: "coach", text: turn.text });
        break;
      }
      case "app":
        if (kind !== "weekly") return { ok: false, reason: "app_turn_outside_weekly" };
        turns.push({ role: "app", topic: turn.topic });
        break;
    }
  }
  if (total > MAX_TOTAL_TEXT_CHARS) return { ok: false, reason: "total_too_long" };
  if (turns.length === 0) return { ok: false, reason: "no_turns" };

  if (kind === "summary") {
    if (!turns.some((t) => t.role === "person")) return { ok: false, reason: "no_person_turn" };
    return { ok: true, request: { kind, weekContext: "", turns } };
  }

  if (weekContext === undefined || weekContext.trim() === "") {
    return { ok: false, reason: "week_context_missing" };
  }
  // The conversation has to start and end on the person's (or the app's)
  // side: the API's first message must be a user turn, and Opus 5.5 rejects
  // an assistant turn at the end (no prefill).
  if (turns[0]?.role === "coach") return { ok: false, reason: "starts_with_coach" };
  if (turns.at(-1)?.role === "coach") return { ok: false, reason: "ends_with_coach" };
  return { ok: true, request: { kind, weekContext, turns } };
}
