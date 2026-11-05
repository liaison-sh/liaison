// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomBytes } from "node:crypto"
import type Redis from "ioredis"

/**
 * Issue a single-use opaque token backed by Redis (P3: consumeToken pattern).
 * Used for challenge tokens, WS tickets, and any short-lived credential.
 */
export async function issueToken(
  redis: Redis,
  prefix: string,
  payload: Record<string, unknown>,
  ttlSeconds: number,
): Promise<string> {
  const token = randomBytes(32).toString("hex")
  const key = `${prefix}:${token}`
  await redis.set(key, JSON.stringify(payload), "EX", ttlSeconds)
  return token
}
