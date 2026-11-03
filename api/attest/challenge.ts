import { productionDeps } from "../../src/deps.js";
import { handleChallenge } from "../../src/handlers/attest.js";
import { jsonError } from "../../src/http.js";

/** `GET /api/attest/challenge`. README.md, "API contract". */
export async function GET(request: Request): Promise<Response> {
  try {
    return await handleChallenge(request, productionDeps());
  } catch {
    return jsonError("server_error");
  }
}
