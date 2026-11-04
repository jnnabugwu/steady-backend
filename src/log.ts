/**
 * Metadata-only logging: one JSON line per request.
 *
 * The fields are fixed by `LogEntry`, so nothing else can reach the logs: no
 * request or response bodies, no week context, no turns, no raw key id (only
 * `shortHash`), and no upstream error message (those can quote a request).
 */

export interface LogEntry {
  route: "attest.challenge" | "attest.register" | "coach.reply";
  status: number;
  latencyMs: number;
  /** The error code sent to the app, if any. */
  code?: string;
  /** Why attestation or validation failed, from a fixed set (no input echoed). */
  reason?: string;
  kind?: string;
  /** `shortHash` of the key id, or `dev-bypass`. */
  key?: string;
  stopReason?: string | null;
  refusalCategory?: string | null;
  /** The model that served the reply (differs from Opus 5.5 after a fallback). */
  model?: string;
  fallback?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * From the request's start to calling Anthropic: reading the body, Redis
   * (challenge, key, counter, daily counts) and verification. With
   * `firstTextMs`, splits a slow start between the proxy and Anthropic.
   */
  preStreamMs?: number;
  /** From calling Anthropic to the first snapshot. */
  firstTextMs?: number;
  /** The upstream error's class and status, e.g. `RateLimitError 429`. */
  upstreamError?: string;
  /** The app cancelled the stream. */
  cancelled?: boolean;
}

export type Logger = (entry: LogEntry) => void;

export const consoleLogger: Logger = (entry) => {
  console.log(JSON.stringify(entry));
};
