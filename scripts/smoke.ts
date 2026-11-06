/**
 * Manual smoke test against a running proxy, using the dev bypass token
 * instead of App Attest. Makes real Anthropic calls (a few cents): never run
 * in CI.
 *
 *   npm run smoke -- <base-url> [chat|weekly|summary]
 *
 *   # local, after `vercel env pull .env.local` and `vercel dev`
 *   node --env-file=.env.local --import tsx scripts/smoke.ts http://localhost:3000
 *
 *   # a Preview deployment
 *   COACH_DEV_BYPASS_TOKEN=... npm run smoke -- https://steady-backend-git-feat-x.vercel.app weekly
 *
 * Env: COACH_DEV_BYPASS_TOKEN (required). VERCEL_AUTOMATION_BYPASS_SECRET if
 * the deployment has Vercel Authentication on (Preview deployments do by
 * default): it's sent as `x-vercel-protection-bypass`.
 *
 * Prints each SSE event as it arrives, then the time to the first snapshot
 * and the total. Run the same kind twice within 5 minutes and check the
 * function logs' `cacheReadTokens` for prompt caching.
 */

const [baseUrl, kind = "chat"] = process.argv.slice(2);
const token = process.env.COACH_DEV_BYPASS_TOKEN;
if (baseUrl === undefined || token === undefined || token === "") {
  console.error("usage: COACH_DEV_BYPASS_TOKEN=... npm run smoke -- <base-url> [chat|weekly|summary]");
  process.exit(2);
}

const weekContext = [
  "Days, oldest first (a finished week; today is Fri Oct 30):",
  "Fri Oct 23: logged fully; ate 2140 kcal; 8412 steps",
  "Sat Oct 24: logged partly; 10233 steps",
  "Sun Oct 25: no check-in; 4120 steps",
  "Mon Oct 26: logged fully; ate 1980 kcal; 7600 steps",
  "Tue Oct 27: skipped logging; 6900 steps",
  "Wed Oct 28: logged fully; ate 2210 kcal; 9050 steps",
  "Thu Oct 29: logged fully; ate 2050 kcal; 8800 steps",
  "Craving check-ins: 2 (2 in the evening). What was behind them: tired 1, bored 1.",
].join("\n");

const bodies: Record<string, unknown> = {
  chat: { kind: "chat", weekContext, turns: [{ role: "person", text: "Which days did I skip this week?" }] },
  weekly: { kind: "weekly", weekContext, turns: [{ role: "app", topic: "logging" }] },
  summary: {
    kind: "summary",
    // As the app sends it: no topic turns (the proxy rejects them outside weekly).
    turns: [
      { role: "coach", text: "You logged five of seven days. How did the week feel?" },
      { role: "person", text: "Busy, the weekend was hard." },
      { role: "coach", text: "Weekends can be harder to keep up. What got in the way on Sunday?" },
      { role: "person", text: "I was travelling. I'll log on my phone at lunch next weekend." },
    ],
  },
};
const body = bodies[kind];
if (body === undefined) {
  console.error(`unknown kind ${kind}`);
  process.exit(2);
}

const headers: Record<string, string> = { "content-type": "application/json", "x-steady-dev-bypass": token };
const protection = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
if (protection) headers["x-vercel-protection-bypass"] = protection;

const base = baseUrl.replace(/\/$/, "");

// The challenge endpoint exercises Redis.
const challenge = await fetch(`${base}/api/attest/challenge`, { headers });
console.log(`GET /api/attest/challenge -> ${challenge.status} ${await challenge.text()}`);

const started = Date.now();
let firstSnapshot: number | undefined;
const response = await fetch(`${base}/api/coach/reply`, { method: "POST", headers, body: JSON.stringify(body) });
console.log(`POST /api/coach/reply (${kind}) -> ${response.status} ${response.headers.get("content-type") ?? ""}`);
if (response.body === null) process.exit(1);

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let split: number;
  while ((split = buffer.indexOf("\n\n")) !== -1) {
    const block = buffer.slice(0, split);
    buffer = buffer.slice(split + 2);
    const event = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (event === "snapshot") firstSnapshot ??= Date.now() - started;
    console.log(`${String(Date.now() - started).padStart(6)} ms  ${event ?? "?"}  ${data ?? ""}`);
  }
}
console.log(`first snapshot: ${firstSnapshot ?? "-"} ms, total: ${Date.now() - started} ms`);
