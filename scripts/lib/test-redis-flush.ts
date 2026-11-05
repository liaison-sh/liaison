// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Redis resets for test runs. A NAMESPACED run (every run scripts/test-run.ts
// starts) uses `sweepRedisPrefix` below: its own keys, nothing else. The flush
// helpers that follow are for a bare run on a dedicated database.
//
// Which Redis database a bare pretest reset may flush.
//
// The reset ran a bare `redis-cli FLUSHDB`: database 0 of whatever Redis
// listens on localhost, whatever the test env pointed at. On a machine that
// also runs dev servers, that is THEIR database, and every reset wiped their
// sessions, queues and caches. The reset now flushes only the database the
// test env names in REDIS_URL (the process env, else `.env.test`), and never
// database 0, the one everything shares by default: with no URL, or one on
// database 0, nothing is flushed (the worker envs clear their own prefixes).

export type RedisFlushTarget = { url: string; db: number } | { skip: string }

/** REDIS_URL as `.env.test` sets it, or undefined. */
export function redisUrlFromEnvFile(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?REDIS_URL\s*=\s*(.*?)\s*$/)
    if (m) return m[1]!.replace(/^(["'])(.*)\1$/, "$2") || undefined
  }
  return undefined
}

export function testRedisFlushTarget(
  env: Record<string, string | undefined>,
  envFileText = "",
): RedisFlushTarget {
  const url = env.REDIS_URL || redisUrlFromEnvFile(envFileText)
  if (!url) return { skip: "no REDIS_URL in the test env" }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { skip: `REDIS_URL is not a URL (${url})` }
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    return { skip: `REDIS_URL is not a redis:// URL (${parsed.protocol})` }
  }
  const path = parsed.pathname.replace(/^\//, "")
  const db = path === "" ? 0 : Number(path)
  if (!Number.isInteger(db) || db < 0) return { skip: `REDIS_URL names no database (${path})` }
  if (db === 0) return { skip: "REDIS_URL is on database 0, shared by everything on that Redis" }
  return { url, db }
}

/** The pretest reset's flush, `redis-cli -u <url> FLUSHDB` on that database, or why none. */
export function testRedisFlushCommand(
  env: Record<string, string | undefined>,
  envFileText = "",
): { cmd: string[] } | { skip: string } {
  const target = testRedisFlushTarget(env, envFileText)
  return "skip" in target ? target : { cmd: ["redis-cli", "-u", target.url, "FLUSHDB"] }
}

/**
 * The pretest reset of a NAMESPACED run: unlink every key under the run's own
 * prefix and nothing else. Redis is shared by every checkout and every dev
 * server, so a FLUSHDB is never this run's to issue. SCAN walks the whole
 * keyspace whatever the pattern, so it asks for large pages: at the default
 * COUNT of 10 a 200k-key database takes seconds of round trips.
 */
export async function sweepRedisPrefix(url: string, prefix: string): Promise<number> {
  if (!prefix) throw new Error("refusing to sweep Redis with an empty prefix")
  // Bun's built-in client: the repo root declares no Redis package of its own.
  const redis = new Bun.RedisClient(url, { autoReconnect: false, connectionTimeout: 5_000 })
  let removed = 0
  try {
    let cursor = "0"
    do {
      const [next, keys] = (await redis.send("SCAN", [
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        "10000",
      ])) as [string, string[]]
      cursor = next
      if (keys.length > 0) removed += Number(await redis.send("UNLINK", keys))
    } while (cursor !== "0")
  } finally {
    redis.close()
  }
  return removed
}
