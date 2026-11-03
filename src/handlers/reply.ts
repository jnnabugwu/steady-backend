import type { BetaMessage, BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { authenticateReply } from "../auth.js";
import { buildCoachParams } from "../coach/prompt.js";
import { MAX_BODY_BYTES, parseCoachRequest } from "../coach/request.js";
import type { Deps } from "../deps.js";
import { encodeEvent, HTTP_STATUS, readBody, SSE_HEADERS, sseError, type CoachEvent, type ErrorCode } from "../http.js";
import type { LogEntry } from "../log.js";
import { checkDailyLimits } from "../rate-limit.js";
import { classifyUpstreamError, describeUpstreamError } from "../upstream.js";

/**
 * The longest a reply may run before the proxy gives up and sends
 * `error {code: "upstream_unavailable"}`: under the function's 120 s
 * `maxDuration` (vercel.json), so the stream always ends with an event.
 */
export const REPLY_DEADLINE_MS = 110_000;

/**
 * What ends a reply, from the final message's `stop_reason`. Only checked
 * after the stream finishes, since a refusal can come before any output or
 * mid-stream.
 *
 * - `refusal`: the whole fallback chain declined. `error {code: "refusal"}`;
 *   the app discards any partial text and shows its help line.
 * - `end_turn` (and `stop_sequence`, which this proxy never sets): `done`.
 * - `max_tokens` (and `model_context_window_exceeded`, far beyond these
 *   request sizes): `done {stopReason: "max_tokens"}`; the app decides.
 * - Anything else (`tool_use`, `pause_turn`, ...) can't happen without tools
 *   and is a `server_error`.
 */
export function terminalEvent(message: BetaMessage): CoachEvent {
  switch (message.stop_reason) {
    case "refusal":
      return { event: "error", data: { code: "refusal" } };
    case "end_turn":
    case "stop_sequence":
      return { event: "done", data: { stopReason: "end_turn" } };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { event: "done", data: { stopReason: "max_tokens" } };
    default:
      return { event: "error", data: { code: "server_error" } };
  }
}

/** Token counts and fallback use, for the log. Metadata only. */
function usageFields(message: BetaMessage): Partial<LogEntry> {
  const usage = message.usage;
  return {
    stopReason: message.stop_reason,
    refusalCategory: message.stop_reason === "refusal" ? (message.stop_details?.category ?? null) : undefined,
    model: message.model,
    fallback: (usage.iterations ?? []).some((i) => i.type === "fallback_message"),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * `POST /api/coach/reply`: verify, validate, cap, then stream the coach's
 * reply as SSE (README.md, "API contract").
 *
 * Errors before the reply starts are a single `error` event with the code's
 * HTTP status. Once streaming, the status is 200 and the stream is
 * `snapshot` events (the whole reply so far) ending in exactly one `done` or
 * `error`. If the app cancels, the upstream request is aborted.
 */
export async function handleReply(request: Request, deps: Deps): Promise<Response> {
  const started = Date.now();
  const fields: Partial<LogEntry> = {};
  let logged = false;
  const log = (status: number, extra: Partial<LogEntry> = {}) => {
    if (logged) return;
    logged = true;
    deps.log({ route: "coach.reply", status, latencyMs: Date.now() - started, ...fields, ...extra });
  };
  const reject = (code: ErrorCode, reason?: string, retryAfter?: number): Response => {
    log(HTTP_STATUS[code], { code, ...(reason === undefined ? {} : { reason }) });
    return sseError(code, retryAfter);
  };

  try {
    // The kill switch comes first and touches nothing else.
    if (!deps.config.coachEnabled) return reject("coach_disabled");

    const body = await readBody(request, MAX_BODY_BYTES);
    if (body === null) return reject("bad_request", "too_large");

    const auth = await authenticateReply(request, body, deps);
    if (!auth.ok) return reject("attestation_failed", auth.reason);
    fields.key = auth.subject;

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      return reject("bad_request", "utf8");
    }
    const parsed = parseCoachRequest(text);
    if (!parsed.ok) return reject("bad_request", parsed.reason);
    fields.kind = parsed.request.kind;

    const limit = await checkDailyLimits(deps.store(), auth.subject, deps.config, deps.now());
    if (!limit.ok) return reject("rate_limited", limit.scope, limit.retryAfter);

    return await streamReply(deps, buildCoachParams(parsed.request, auth.subject), log, fields);
  } catch {
    return reject("server_error");
  }
}

async function streamReply(
  deps: Deps,
  params: ReturnType<typeof buildCoachParams>,
  log: (status: number, extra?: Partial<LogEntry>) => void,
  fields: Partial<LogEntry>,
): Promise<Response> {
  const started = Date.now();
  const abort = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, REPLY_DEADLINE_MS);

  const failureCode = (error: unknown): ErrorCode => {
    if (timedOut) return "upstream_unavailable";
    const failure = classifyUpstreamError(error);
    return failure === "aborted" ? "upstream_unavailable" : failure;
  };

  const stream = deps.upstream().stream(params, abort.signal);
  const iterator = stream[Symbol.asyncIterator]();

  // Wait for the first event before answering, so an upstream failure at
  // the start gets its own HTTP status (503) rather than a 200.
  let pending: IteratorResult<BetaRawMessageStreamEvent> | null;
  try {
    pending = await iterator.next();
  } catch (error) {
    clearTimeout(deadline);
    const code = failureCode(error);
    log(HTTP_STATUS[code], { code, upstreamError: describeUpstreamError(error) });
    return sseError(code);
  }

  let reply = "";
  let cancelled = false;
  let finished = false;

  const end = (controller: ReadableStreamDefaultController<Uint8Array>, event: CoachEvent) => {
    finished = true;
    clearTimeout(deadline);
    if (cancelled) return;
    controller.enqueue(encodeEvent(event));
    controller.close();
  };

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const step = pending ?? (await iterator.next());
          pending = null;
          if (step.done) {
            const message = await stream.finalMessage();
            const event = terminalEvent(message);
            Object.assign(fields, usageFields(message));
            log(200, event.event === "error" ? { code: event.data.code } : {});
            end(controller, event);
            return;
          }
          const event = step.value;
          if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text !== "") {
            // Text blocks are concatenated in order. After a mid-stream
            // fallback the new model continues in a new text block, and the
            // text already sent stays valid.
            reply += event.delta.text;
            fields.firstTextMs ??= Date.now() - started;
            if (!cancelled) controller.enqueue(encodeEvent({ event: "snapshot", data: { text: reply } }));
            return;
          }
        }
      } catch (error) {
        if (cancelled || finished) return;
        const code = failureCode(error);
        log(200, { code, upstreamError: describeUpstreamError(error) });
        end(controller, { event: "error", data: { code } });
      }
    },
    cancel() {
      cancelled = true;
      clearTimeout(deadline);
      abort.abort();
      log(200, { cancelled: true });
    },
  });

  return new Response(body, { status: 200, headers: SSE_HEADERS });
}
