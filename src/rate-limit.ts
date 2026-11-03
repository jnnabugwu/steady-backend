import type { Config } from "./config.js";
import type { ProxyStore } from "./store/store.js";

/**
 * Cost caps, per UTC day: one counter per device (keyed by the attested key's
 * hash) and one across every device, a backstop so a burst of new
 * attestations can't run past the Anthropic Console's spend limit before it
 * trips. Both reset at the next UTC midnight.
 */

export type LimitResult = { ok: true } | { ok: false; scope: "device" | "global"; retryAfter: number };

/** The UTC day of `now`, `yyyy-mm-dd`, and the next UTC midnight in seconds. */
export function utcDay(now: Date): { day: string; resetAt: number } {
  const day = now.toISOString().slice(0, 10);
  const resetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000;
  return { day, resetAt };
}

export async function checkDailyLimits(
  store: ProxyStore,
  subject: string,
  config: Config,
  now: Date,
): Promise<LimitResult> {
  const { day, resetAt } = utcDay(now);
  const retryAfter = Math.max(1, Math.ceil(resetAt - now.getTime() / 1000));
  // The device first: a device over its own limit doesn't use up the
  // global allowance.
  const device = await store.incrementDaily(`device:${day}:${subject}`, resetAt);
  if (device > config.dailyLimit) return { ok: false, scope: "device", retryAfter };
  const global = await store.incrementDaily(`global:${day}`, resetAt);
  if (global > config.globalDailyLimit) return { ok: false, scope: "global", retryAfter };
  return { ok: true };
}
