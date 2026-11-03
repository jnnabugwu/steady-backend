/**
 * What the proxy keeps in Redis. No conversation text, ever: one-time
 * challenges, each attested key's public key and counter, and daily request
 * counts. Production uses Upstash (`upstash.ts`); tests use `memory.ts`.
 */

/** An attested App Attest key. */
export interface StoredKey {
  /** The key's public key, SubjectPublicKeyInfo DER, base64. */
  publicKey: string;
  /** The last assertion counter accepted (0 right after attestation). */
  counter: number;
}

export type CounterResult = "advanced" | "stale" | "unknown";

export interface ProxyStore {
  /** Stores a one-time challenge for `ttlSeconds`. */
  putChallenge(challenge: string, ttlSeconds: number): Promise<void>;
  /**
   * Deletes `challenge` and says whether it was there (live and unused).
   * Atomic, so a challenge can only ever be taken once.
   */
  takeChallenge(challenge: string): Promise<boolean>;
  /** Stores (or replaces) an attested key, kept for `ttlSeconds`. */
  putKey(keyId: string, key: StoredKey, ttlSeconds: number): Promise<void>;
  getKey(keyId: string): Promise<StoredKey | null>;
  /**
   * Sets the key's counter to `counter` if it's strictly greater than the
   * stored one, and refreshes its TTL. Atomic. `stale` if it isn't greater (a
   * replay), `unknown` if the key isn't stored.
   */
  advanceCounter(keyId: string, counter: number, ttlSeconds: number): Promise<CounterResult>;
  /**
   * Adds one to the counter at `key` and returns the new count. The counter
   * expires at `expireAtUnixSeconds` (set when it's created).
   */
  incrementDaily(key: string, expireAtUnixSeconds: number): Promise<number>;
}
