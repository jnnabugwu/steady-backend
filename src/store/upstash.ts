import { Redis } from "@upstash/redis";
import type { CounterResult, ProxyStore, StoredKey } from "./store.js";

/**
 * Compare-and-set for an assertion counter: the new counter must be strictly
 * greater than the stored one. Lua, so the read and the write are one atomic
 * step (two requests can't both pass with the same counter).
 * Returns -1 for an unknown key, 0 for a stale counter, 1 when advanced.
 */
const ADVANCE_COUNTER = `
local current = redis.call('HGET', KEYS[1], 'counter')
if not current then return -1 end
if tonumber(ARGV[1]) <= tonumber(current) then return 0 end
redis.call('HSET', KEYS[1], 'counter', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

const challengeKey = (challenge: string) => `attest:challenge:${challenge}`;
const keyKey = (keyId: string) => `attest:key:${keyId}`;
const dailyKey = (key: string) => `coach:count:${key}`;

/** `ProxyStore` on Upstash Redis, over its REST API. */
export class UpstashStore implements ProxyStore {
  private readonly redis: Redis;

  constructor(url: string, token: string) {
    // Values stay strings: nothing is JSON-parsed behind our back.
    this.redis = new Redis({ url, token, automaticDeserialization: false });
  }

  async putChallenge(challenge: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(challengeKey(challenge), "1", { ex: ttlSeconds });
  }

  async takeChallenge(challenge: string): Promise<boolean> {
    return (await this.redis.getdel<string>(challengeKey(challenge))) !== null;
  }

  async putKey(keyId: string, key: StoredKey, ttlSeconds: number): Promise<void> {
    await this.redis
      .multi()
      .del(keyKey(keyId))
      .hset(keyKey(keyId), { publicKey: key.publicKey, counter: String(key.counter) })
      .expire(keyKey(keyId), ttlSeconds)
      .exec();
  }

  async getKey(keyId: string): Promise<StoredKey | null> {
    const hash = await this.redis.hgetall<Record<string, string>>(keyKey(keyId));
    if (hash === null || typeof hash.publicKey !== "string" || hash.counter === undefined) return null;
    const counter = Number(hash.counter);
    if (!Number.isSafeInteger(counter)) return null;
    return { publicKey: hash.publicKey, counter };
  }

  async advanceCounter(keyId: string, counter: number, ttlSeconds: number): Promise<CounterResult> {
    const result = Number(
      await this.redis.eval(ADVANCE_COUNTER, [keyKey(keyId)], [String(counter), String(ttlSeconds)]),
    );
    if (result === 1) return "advanced";
    if (result === 0) return "stale";
    return "unknown";
  }

  async incrementDaily(key: string, expireAtUnixSeconds: number): Promise<number> {
    // The expiry is the same instant for every increment in a day, so setting
    // it each time is idempotent.
    const [count] = await this.redis
      .multi()
      .incr(dailyKey(key))
      .expireat(dailyKey(key), expireAtUnixSeconds)
      .exec<[number, number]>();
    return Number(count);
  }
}
