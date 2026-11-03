import { productionDeps } from "../../src/deps.js";
import { consoleLogger } from "../../src/log.js";
import { handleChallenge } from "../../src/handlers/attest.js";
import { jsonError } from "../../src/http.js";

/** `GET /api/attest/challenge`. README.md, "API contract". */
export async function GET(request: Request): Promise<Response> {
  try {
    return await handleChallenge(request, productionDeps());
  } catch {
    // productionDeps throws only for an unusable setting (ConfigError),
    // before the handler can log, so log the request here.
    consoleLogger({ route: "attest.challenge", status: 500, latencyMs: 0, code: "server_error", reason: "config" });
    return jsonError("server_error");
  }
}
