import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

/**
 * The one call to Anthropic, behind an interface so tests script the stream
 * and never reach the network.
 */

/** A streaming reply: raw events, then the accumulated message. */
export interface CoachStream extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
}

export interface CoachUpstream {
  stream(params: BetaMessageStreamParams, signal: AbortSignal): CoachStream;
}

/**
 * How long the SDK waits on Anthropic, under the function's 120 s
 * `maxDuration` (vercel.json) so the app gets an `error` event, not a cut
 * connection.
 */
export const UPSTREAM_TIMEOUT_MS = 100_000;

export function anthropicUpstream(apiKey: string): CoachUpstream {
  // One retry on connection errors, 429 and 5xx (the SDK's own backoff).
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: UPSTREAM_TIMEOUT_MS });
  return {
    stream: (params, signal) => client.beta.messages.stream(params, { signal }),
  };
}

export type UpstreamFailure = "upstream_unavailable" | "server_error" | "aborted";

/**
 * Maps an error from the stream to what the app is told, by the SDK's typed
 * error classes and the API's error `type`, never by message text.
 *
 * Anthropic overloaded (529), rate limited (429), any other 5xx and network
 * failures are `upstream_unavailable` (worth retrying later). Anything else,
 * such as a 400 from a request this proxy built, is `server_error`.
 */
export function classifyUpstreamError(error: unknown): UpstreamFailure {
  if (error instanceof Anthropic.APIUserAbortError) return "aborted";
  if (error instanceof Anthropic.RateLimitError) return "upstream_unavailable";
  if (error instanceof Anthropic.APIConnectionError) return "upstream_unavailable";
  if (error instanceof Anthropic.InternalServerError) return "upstream_unavailable";
  if (error instanceof Anthropic.APIError) {
    // A mid-stream `error` event carries no HTTP status, only its type.
    if (error.type === "overloaded_error" || error.type === "rate_limit_error" || error.type === "api_error") {
      return "upstream_unavailable";
    }
    if (error.status !== undefined && (error.status === 529 || error.status >= 500)) {
      return "upstream_unavailable";
    }
  }
  return "server_error";
}

/** A short, content-free description of an upstream error for the logs. */
export function describeUpstreamError(error: unknown): string {
  if (error instanceof Anthropic.APIError) {
    return [error.constructor.name, error.status, error.type].filter((p) => p !== undefined && p !== null).join(" ");
  }
  return error instanceof Error ? error.name : typeof error;
}
