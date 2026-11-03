import { createHash } from "node:crypto";

export const sha256 = (...parts: Uint8Array[]): Uint8Array => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Strict standard base64 (with padding), or `null`. */
export function fromBase64(text: string): Uint8Array | null {
  if (text.length === 0 || !BASE64.test(text)) return null;
  return new Uint8Array(Buffer.from(text, "base64"));
}

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

export const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** A short, non-reversible id for logs and counters: 12 hex chars of SHA-256. */
export const shortHash = (text: string): string =>
  Buffer.from(sha256(utf8(text))).toString("hex").slice(0, 12);
