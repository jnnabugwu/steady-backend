/**
 * Settings, read from environment variables (README.md, "Environment
 * variables"). Parsing never throws for a missing secret: the kill switch has
 * to work even when nothing else is configured. The clients that need a
 * secret check for it when they're created (`deps.ts`).
 */

export type AttestEnv = "production" | "development";

export interface Config {
  /** `COACH_ENABLED === "true"`. Anything else switches the coach off. */
  coachEnabled: boolean;
  anthropicApiKey: string | undefined;
  redisUrl: string | undefined;
  redisToken: string | undefined;
  /** Team id and bundle id, `UXZV3C926U.com.jmagic.steady`. */
  appId: string;
  /** Which App Attest environment's keys are accepted. */
  attestEnv: AttestEnv;
  /** Requests per attested device per UTC day. */
  dailyLimit: number;
  /** Requests across all devices per UTC day. */
  globalDailyLimit: number;
  /** `COACH_DEV_BYPASS_TOKEN`, if set. Honoured only outside production. */
  devBypassToken: string | undefined;
  /** Vercel's own `VERCEL_ENV`: `production`, `preview` or `development`. */
  vercelEnv: string | undefined;
}

export const DEFAULT_APP_ID = "UXZV3C926U.com.jmagic.steady";
export const DEFAULT_DAILY_LIMIT = 60;
export const DEFAULT_GLOBAL_DAILY_LIMIT = 1000;

/** A setting is present but unusable. The handlers answer `server_error`. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

type Env = Record<string, string | undefined>;

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === "" ? undefined : value.trim();

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return fallback;
  // Digits only, and small enough to be exact: a cap that rounds (or is
  // Infinity) could never trip.
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
    throw new ConfigError(`${name} must be a positive whole number`);
  }
  return Number(raw);
}

export function readConfig(env: Env): Config {
  const attestEnv = nonEmpty(env.APP_ATTEST_ENV) ?? "production";
  if (attestEnv !== "production" && attestEnv !== "development") {
    throw new ConfigError("APP_ATTEST_ENV must be production or development");
  }
  return {
    coachEnabled: env.COACH_ENABLED === "true",
    anthropicApiKey: nonEmpty(env.ANTHROPIC_API_KEY),
    // Upstash's own names first, then the ones the Vercel Marketplace
    // integration sets.
    redisUrl: nonEmpty(env.UPSTASH_REDIS_REST_URL) ?? nonEmpty(env.KV_REST_API_URL),
    redisToken: nonEmpty(env.UPSTASH_REDIS_REST_TOKEN) ?? nonEmpty(env.KV_REST_API_TOKEN),
    appId: nonEmpty(env.APP_ATTEST_APP_ID) ?? DEFAULT_APP_ID,
    attestEnv,
    dailyLimit: positiveInt(env, "COACH_DAILY_LIMIT", DEFAULT_DAILY_LIMIT),
    globalDailyLimit: positiveInt(env, "COACH_GLOBAL_DAILY_LIMIT", DEFAULT_GLOBAL_DAILY_LIMIT),
    devBypassToken: nonEmpty(env.COACH_DEV_BYPASS_TOKEN),
    vercelEnv: nonEmpty(env.VERCEL_ENV),
  };
}
