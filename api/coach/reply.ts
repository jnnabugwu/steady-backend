import { productionDeps } from "../../src/deps.js";
import { handleReply } from "../../src/handlers/reply.js";
import { sseError } from "../../src/http.js";

/** `POST /api/coach/reply`, streamed as SSE. README.md, "API contract". */
export async function POST(request: Request): Promise<Response> {
  try {
    return await handleReply(request, productionDeps());
  } catch {
    // productionDeps throws only for an unusable setting (ConfigError).
    return sseError("server_error");
  }
}
