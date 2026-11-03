import { readConfig, type Config } from "../../src/config.js";
import type { Deps } from "../../src/deps.js";
import type { LogEntry } from "../../src/log.js";
import { MemoryStore } from "../../src/store/memory.js";
import { FakeUpstream } from "./fake-upstream.js";

/** Deps for a handler under test: in-memory store, scripted upstream, captured logs. */
export interface TestDeps extends Deps {
  memory: MemoryStore;
  fake: FakeUpstream;
  logs: LogEntry[];
  clock: { now: Date };
}

export function testConfig(env: Record<string, string> = {}): Config {
  return readConfig({
    COACH_ENABLED: "true",
    ANTHROPIC_API_KEY: "test-key-not-real",
    APP_ATTEST_ENV: "development",
    VERCEL_ENV: "preview",
    COACH_DEV_BYPASS_TOKEN: "dev-token-for-tests",
    ...env,
  });
}

export function makeDeps(
  options: { env?: Record<string, string>; upstream?: FakeUpstream; roots?: string[]; now?: Date } = {},
): TestDeps {
  const clock = { now: options.now ?? new Date("2026-11-02T12:00:00Z") };
  const memory = new MemoryStore(() => clock.now.getTime());
  const fake = options.upstream ?? new FakeUpstream();
  const logs: LogEntry[] = [];
  let counter = 0;
  return {
    config: testConfig(options.env),
    store: () => memory,
    upstream: () => fake,
    appleRoots: options.roots ?? [],
    now: () => clock.now,
    randomBytes: (size) => {
      counter++;
      return new Uint8Array(size).fill(counter % 256);
    },
    log: (entry) => logs.push(entry),
    memory,
    fake,
    logs,
    clock,
  };
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Reads a whole SSE response into its events. */
export async function readSse(response: Response): Promise<SseEvent[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "";
      const data = lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

export const chatBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "chat",
    weekContext: "Days, oldest first (Mon Nov 2 is today and may not be finished):\nMon Nov 2: logged fully",
    turns: [{ role: "person", text: "How did I do this week?" }],
    ...overrides,
  });

export function bypassRequest(body: string, token = "dev-token-for-tests"): Request {
  return new Request("https://proxy.test/api/coach/reply", {
    method: "POST",
    headers: { "content-type": "application/json", "x-steady-dev-bypass": token },
    body,
  });
}
