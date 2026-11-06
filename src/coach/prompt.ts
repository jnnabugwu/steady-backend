import type {
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTextBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { CHAT, DATA_HEADER, SUMMARY, SUMMARY_REQUEST, WEEKLY_SESSION } from "./instructions.js";
import type { CoachRequest, SessionKind, Turn } from "./request.js";
import { weeklyTopicPrompt } from "./weekly.js";

/** The model every coach reply uses. */
export const MODEL = "claude-opus-5-5";

/**
 * The beta for `fallbacks: "default"`: a request a safety classifier declines
 * is re-run server-side on the model Anthropic recommends for that refusal
 * category, instead of failing. (The array form uses a different header.)
 */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Thinking depth per kind. Opus 5.5 always thinks (`thinking` is left out, so
 * it runs adaptive) and its default effort is `medium`, so effort is set
 * explicitly. `low` everywhere to start; raise it only after measuring
 * quality, latency and cost (steady#149).
 */
export const EFFORT: Record<SessionKind, "low" | "medium" | "high"> = {
  chat: "low",
  weekly: "low",
  summary: "low",
};

/**
 * `max_tokens` per kind. It covers thinking and the visible reply together,
 * so it's generous; the instructions keep replies to two to five sentences.
 * Not the app's old 512-token on-device cap, which could stop a reply while
 * it was still thinking.
 */
export const MAX_TOKENS: Record<SessionKind, number> = {
  chat: 4096,
  weekly: 4096,
  summary: 2048,
};

/** The fixed instructions for each kind. */
export function instructionsFor(kind: SessionKind): string {
  switch (kind) {
    case "chat":
      return CHAT;
    case "weekly":
      return WEEKLY_SESSION;
    case "summary":
      return SUMMARY;
  }
}

/**
 * The system blocks: the kind's fixed instructions first, marked for prompt
 * caching, then (for chat and weekly) the person's week, which changes per
 * session and so sits after the cached block. Joined with a blank line, they
 * read as the app's `CoachInstructions.forSession(kind, data)`.
 *
 * Only the app's computed week context goes here, never anything the person
 * typed: their words go only in user turns.
 */
export function buildSystem(request: CoachRequest): BetaTextBlockParam[] {
  const instructions: BetaTextBlockParam = {
    type: "text",
    text: instructionsFor(request.kind),
    cache_control: { type: "ephemeral" },
  };
  if (request.kind === "summary") return [instructions];
  return [instructions, { type: "text", text: `${DATA_HEADER}${request.weekContext}` }];
}

/** `turns` as plain lines, "Person: …" and "Coach: …", as the app wrote them. */
export function transcriptLines(turns: readonly Turn[]): string {
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.role === "person") lines.push(`Person: ${turn.text}`);
    else if (turn.role === "coach") lines.push(`Coach: ${turn.text}`);
    // App turns are prompts the person never saw; a summary leaves them out.
  }
  return lines.join("\n");
}

/** The single user turn a summary request sends. */
export function summaryPrompt(turns: readonly Turn[]): string {
  return `${SUMMARY_REQUEST}\n\nThe conversation:\n${transcriptLines(turns)}`;
}

/**
 * The conversation as API messages, oldest first: person turns and expanded
 * app topic openings as `user`, coach turns as `assistant` (plain text, no
 * thinking blocks: the proxy is stateless and never has them). Consecutive
 * turns on the same side share one message.
 */
export function buildMessages(request: CoachRequest): BetaMessageParam[] {
  if (request.kind === "summary") {
    return [{ role: "user", content: [{ type: "text", text: summaryPrompt(request.turns) }] }];
  }
  const messages: { role: "user" | "assistant"; content: BetaTextBlockParam[] }[] = [];
  for (const turn of request.turns) {
    const role = turn.role === "coach" ? "assistant" : "user";
    const text = turn.role === "app" ? weeklyTopicPrompt(turn.topic) : turn.text;
    const last = messages.at(-1);
    if (last?.role === role) last.content.push({ type: "text", text });
    else messages.push({ role, content: [{ type: "text", text }] });
  }
  return messages;
}

/**
 * The full streaming request for `request`. `userId` is an opaque hash of the
 * device's key id, so Anthropic can tell devices apart for abuse handling
 * without learning anything about the person.
 */
export function buildCoachParams(request: CoachRequest, userId: string): BetaMessageStreamParams {
  const params: BetaMessageStreamParams = {
    model: MODEL,
    max_tokens: MAX_TOKENS[request.kind],
    output_config: { effort: EFFORT[request.kind] },
    system: buildSystem(request),
    messages: buildMessages(request),
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    metadata: { user_id: userId },
  };
  // Chats and the weekly session resend a growing conversation every turn,
  // a minute or so apart: automatic caching lets each request read the
  // previous one's prefix. A summary is a one-off, so it isn't cached.
  if (request.kind !== "summary") params.cache_control = { type: "ephemeral" };
  return params;
}
