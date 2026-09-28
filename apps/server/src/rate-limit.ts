// SPDX-License-Identifier: LGPL-3.0-only
//
// Token-bucket rate limiting (ARCHITECTURE.md §9.3): each key (client address + tenant) holds
// a bucket of `capacity` tokens refilled at `refillPerSecond`; a request takes one token or is
// refused with the delay after which one will be available. Pure function + a bounded store.

export interface Bucket {
  readonly tokens: number;
  /** Last refill, milliseconds since the epoch. */
  readonly at: number;
}

export interface BucketPolicy {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

/** Takes one token from `bucket` at `now` (a missing bucket starts full). */
export function takeToken(
  bucket: Bucket | undefined,
  now: number,
  policy: BucketPolicy,
): { readonly bucket: Bucket; readonly allowed: boolean; readonly retryAfterMs: number } {
  const elapsed = bucket ? Math.max(0, now - bucket.at) : 0;
  const available = bucket
    ? Math.min(policy.capacity, bucket.tokens + (elapsed / 1000) * policy.refillPerSecond)
    : policy.capacity;
  if (available >= 1)
    return { bucket: { tokens: available - 1, at: now }, allowed: true, retryAfterMs: 0 };
  const retryAfterMs = Math.ceil(((1 - available) / policy.refillPerSecond) * 1000);
  return { bucket: { tokens: available, at: now }, allowed: false, retryAfterMs };
}

/**
 * Buckets in memory, at most `maxKeys` (the least recently used key is dropped first, so a
 * flood of addresses cannot exhaust the memory).
 */
export function createRateLimiter(policy: BucketPolicy, maxKeys = 100_000) {
  const buckets = new Map<string, Bucket>();
  return {
    take(key: string, now: number = Date.now()): { allowed: boolean; retryAfterMs: number } {
      const current = buckets.get(key);
      const result = takeToken(current, now, policy);
      buckets.delete(key);
      buckets.set(key, result.bucket);
      if (buckets.size > maxKeys) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
      return { allowed: result.allowed, retryAfterMs: result.retryAfterMs };
    },
    size: (): number => buckets.size,
  };
}
