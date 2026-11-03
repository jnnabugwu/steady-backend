import { productionDeps } from "../../src/deps.js";
import { handleRegister } from "../../src/handlers/attest.js";
import { jsonError } from "../../src/http.js";

/** `POST /api/attest/register`. README.md, "API contract". */
export async function POST(request: Request): Promise<Response> {
  try {
    return await handleRegister(request, productionDeps());
  } catch {
    return jsonError("server_error");
  }
}
