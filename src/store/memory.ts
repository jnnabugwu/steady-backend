import type { CounterResult, ProxyStore, StoredKey } from "./store.js";

/**
 * An in-memory `ProxyStore` with the same semantics as the Upstash one,
 * including expiry against an injected clock. For tests and the local smoke
 * test's fixtures; never used in a deployment.
 */
export class MemoryStore implements ProxyStore {
  private readonly values = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  private read<T>(key: string): T | undefined {
    const entry = this.values.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.nowMs()) {
      this.values.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  private write(key: string, value: unknown, expiresAt: number): void {
    this.values.set(key, { value, expiresAt });
  }

  putChallenge(challenge: string, ttlSeconds: number): Promise<void> {
    this.write(`challenge:${challenge}`, 1, this.nowMs() + ttlSeconds * 1000);
    return Promise.resolve();
  }

  takeChallenge(challenge: string): Promise<boolean> {
    const present = this.read(`challenge:${challenge}`) !== undefined;
    this.values.delete(`challenge:${challenge}`);
    return Promise.resolve(present);
  }

  putKey(keyId: string, key: StoredKey, ttlSeconds: number): Promise<void> {
    this.write(`key:${keyId}`, { ...key }, this.nowMs() + ttlSeconds * 1000);
    return Promise.resolve();
  }

  getKey(keyId: string): Promise<StoredKey | null> {
    const key = this.read<StoredKey>(`key:${keyId}`);
    return Promise.resolve(key === undefined ? null : { ...key });
  }

  advanceCounter(keyId: string, counter: number, ttlSeconds: number): Promise<CounterResult> {
    const key = this.read<StoredKey>(`key:${keyId}`);
    if (key === undefined) return Promise.resolve("unknown");
    if (counter <= key.counter) return Promise.resolve("stale");
    this.write(`key:${keyId}`, { ...key, counter }, this.nowMs() + ttlSeconds * 1000);
    return Promise.resolve("advanced");
  }

  incrementDaily(key: string, expireAtUnixSeconds: number): Promise<number> {
    const count = (this.read<number>(`daily:${key}`) ?? 0) + 1;
    const existing = this.values.get(`daily:${key}`);
    const expiresAt = count === 1 || existing === undefined ? expireAtUnixSeconds * 1000 : existing.expiresAt;
    this.write(`daily:${key}`, count, expiresAt);
    return Promise.resolve(count);
  }
}
