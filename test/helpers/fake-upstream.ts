import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CoachStream, CoachUpstream } from "../../src/upstream.js";

/**
 * A scripted Anthropic stream: no network. Each script is the raw events the
 * API would send, the final message the SDK would accumulate, and optionally
 * an error to throw at some point.
 */

export interface Script {
  /** Text deltas, each its own `text_delta`. A `null` starts a fallback block. */
  chunks?: (string | null)[];
  stopReason?: BetaMessage["stop_reason"];
  refusalCategory?: string | null;
  model?: string;
  fallback?: boolean;
  usage?: Partial<BetaMessage["usage"]>;
  /** Throw this before any event. */
  failOnStart?: Error;
  /** Throw this after this many chunks. */
  failAfterChunks?: { count: number; error: Error };
  /** Stop after this many chunks and wait until aborted. */
  hangAfterChunks?: number;
}

export interface Call {
  params: BetaMessageStreamParams;
  signal: AbortSignal;
}

const event = (e: unknown) => e as BetaRawMessageStreamEvent;

export function finalMessage(script: Script): BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: script.model ?? "claude-opus-5-5",
    content: [],
    stop_reason: script.stopReason ?? "end_turn",
    stop_sequence: null,
    stop_details:
      script.stopReason === "refusal"
        ? { type: "refusal", category: script.refusalCategory ?? null, explanation: null }
        : null,
    usage: {
      input_tokens: 900,
      output_tokens: 120,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: script.fallback ? [{ type: "fallback_message" }] : [{ type: "message" }],
      ...script.usage,
    },
  } as unknown as BetaMessage;
}

function abortError(): Error {
  return new Anthropic.APIUserAbortError();
}

export function scriptedStream(script: Script, signal: AbortSignal): CoachStream {
  async function* events(): AsyncGenerator<BetaRawMessageStreamEvent> {
    if (signal.aborted) throw abortError();
    if (script.failOnStart !== undefined) throw script.failOnStart;
    yield event({ type: "message_start", message: { ...finalMessage(script), stop_reason: null } });
    let index = 0;
    yield event({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
    yield event({ type: "content_block_stop", index });
    index++;
    yield event({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    let sent = 0;
    for (const chunk of script.chunks ?? []) {
      if (signal.aborted) throw abortError();
      if (script.failAfterChunks?.count === sent) throw script.failAfterChunks.error;
      if (script.hangAfterChunks === sent) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw abortError();
      }
      if (chunk === null) {
        // A mid-stream fallback: the declined model's text stays, a fallback
        // block marks the switch, and the next model writes a new text block.
        yield event({ type: "content_block_stop", index });
        index++;
        yield event({
          type: "content_block_start",
          index,
          content_block: { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } },
        });
        yield event({ type: "content_block_stop", index });
        index++;
        yield event({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
        continue;
      }
      yield event({ type: "content_block_delta", index, delta: { type: "text_delta", text: chunk } });
      sent++;
    }
    if (script.failAfterChunks?.count === sent) throw script.failAfterChunks.error;
    if (script.hangAfterChunks === sent) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw abortError();
    }
    yield event({ type: "content_block_stop", index });
    yield event({ type: "message_delta", delta: { stop_reason: script.stopReason ?? "end_turn" }, usage: {} });
    yield event({ type: "message_stop" });
  }
  const iterable = events();
  return {
    [Symbol.asyncIterator]: () => iterable,
    finalMessage: () => Promise.resolve(finalMessage(script)),
  };
}

export class FakeUpstream implements CoachUpstream {
  readonly calls: Call[] = [];
  constructor(private readonly script: Script = { chunks: ["Hello", " there."] }) {}

  stream(params: BetaMessageStreamParams, signal: AbortSignal): CoachStream {
    this.calls.push({ params, signal });
    return scriptedStream(this.script, signal);
  }
}

/** An SDK error as the SDK would build it for an HTTP status. */
export function httpError(status: number, type: string): InstanceType<typeof Anthropic.APIError> {
  return Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message: "upstream says no" } },
    undefined,
    new Headers(),
  );
}

/** An SDK error as the SDK raises a mid-stream `error` event. */
export function streamErrorEvent(type: string): InstanceType<typeof Anthropic.APIError> {
  return new Anthropic.APIError(undefined, { type: "error", error: { type, message: "x" } }, undefined, new Headers(), type as never);
}
