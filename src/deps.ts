import { randomBytes } from "node:crypto";
import { APPLE_APP_ATTEST_ROOT_PEM } from "./attest/apple-root.js";
import { ConfigError, readConfig, type Config } from "./config.js";
import { consoleLogger, type Logger } from "./log.js";
import type { ProxyStore } from "./store/store.js";
import { UpstashStore } from "./store/upstash.js";
import { anthropicUpstream, type CoachUpstream } from "./upstream.js";

/**
 * Everything a handler needs from the outside world. Production builds it
 * from the environment (`productionDeps`); tests pass fakes. The store and
 * the upstream are functions so a missing secret fails only the requests
 * that need it (the kill switch answers with nothing configured).
 */
export interface Deps {
  config: Config;
  store(): ProxyStore;
  upstream(): CoachUpstream;
  /** Trusted App Attest roots, PEM. Production: Apple's root only. */
  appleRoots: readonly string[];
  now(): Date;
  randomBytes(size: number): Uint8Array;
  log: Logger;
}

let cached: Deps | undefined;

export function productionDeps(): Deps {
  if (cached !== undefined) return cached;
  const config = readConfig(process.env);
  let store: ProxyStore | undefined;
  let upstream: CoachUpstream | undefined;
  cached = {
    config,
    store() {
      if (store !== undefined) return store;
      if (config.redisUrl === undefined || config.redisToken === undefined) {
        throw new ConfigError("Upstash Redis REST URL and token are not set");
      }
      store = new UpstashStore(config.redisUrl, config.redisToken);
      return store;
    },
    upstream() {
      if (upstream !== undefined) return upstream;
      if (config.anthropicApiKey === undefined) throw new ConfigError("ANTHROPIC_API_KEY is not set");
      upstream = anthropicUpstream(config.anthropicApiKey);
      return upstream;
    },
    appleRoots: [APPLE_APP_ATTEST_ROOT_PEM],
    now: () => new Date(),
    randomBytes: (size) => new Uint8Array(randomBytes(size)),
    log: consoleLogger,
  };
  return cached;
}
