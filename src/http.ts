/**
 * The wire contract's shared pieces: error codes, their HTTP statuses, SSE
 * framing, and the JSON shape the attest endpoints use. README.md, "API
 * contract", documents all of it for the app (steady#150, steady#151).
 */

export const ERROR_CODES = [
  "refusal",
  "rate_limited",
  "attestation_failed",
  "bad_request",
  "upstream_unavailable",
  "server_error",
  "coach_disabled",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** The HTTP status for an error answered before any reply has streamed. */
export const HTTP_STATUS: Record<ErrorCode, number> = {
  refusal: 200, // always mid-stream: the model's answer was a refusal
  rate_limited: 429,
  attestation_failed: 401,
  bad_request: 400,
  upstream_unavailable: 503,
  server_error: 500,
  coach_disabled: 503,
};

export type StopReason = "end_turn" | "max_tokens";

export type CoachEvent =
  | { event: "snapshot"; data: { text: string } }
  | { event: "done"; data: { stopReason: StopReason } }
  | { event: "error"; data: { code: ErrorCode; retryAfter?: number } };

const encoder = new TextEncoder();

/** One SSE event: `event: <name>\ndata: <json>\n\n`. JSON has no raw newlines. */
export const encodeEvent = (e: CoachEvent): Uint8Array<ArrayBuffer> =>
  encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
} as const;

/** A stream that is only one `error` event: for errors before the reply. */
export function sseError(code: ErrorCode, retryAfter?: number): Response {
  const headers: Record<string, string> = { ...SSE_HEADERS };
  if (retryAfter !== undefined) headers["retry-after"] = String(retryAfter);
  const data = retryAfter === undefined ? { code } : { code, retryAfter };
  return new Response(encodeEvent({ event: "error", data }), { status: HTTP_STATUS[code], headers });
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/** The attest endpoints' error shape: `{"error": {"code": ...}}`. */
export const jsonError = (code: ErrorCode): Response => jsonResponse(HTTP_STATUS[code], { error: { code } });

/**
 * The request body, or `null` if it's larger than `maxBytes` (checked against
 * `content-length` first, then while reading, so a lying header can't get
 * past it).
 */
export async function readBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return null;
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
