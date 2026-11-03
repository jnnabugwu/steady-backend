import { productionDeps } from "../../src/deps.js";
import { consoleLogger } from "../../src/log.js";
import { handleReply } from "../../src/handlers/reply.js";
import { sseError } from "../../src/http.js";

/** `POST /api/coach/reply`, streamed as SSE. README.md, "API contract". */
export async function POST(request: Request): Promise<Response> {
  try {
    return await handleReply(request, productionDeps());
  } catch {
    // productionDeps throws only for an unusable setting (ConfigError),
    // before the handler can log, so log the request here.
    consoleLogger({ route: "coach.reply", status: 500, latencyMs: 0, code: "server_error", reason: "config" });
    return sseError("server_error");
  }
}
