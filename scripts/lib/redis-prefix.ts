// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A private Redis namespace for a test run that bypasses the orchestrator.
//
// `lib/redis.ts` keys everything off `REDIS_PREFIX`, and BullMQ derives its own
// queue prefix from it. With the variable unset the prefix is empty, so every
// process pointed at the same Redis database shares one `bull:` namespace: two
// API processes then consume each other's jobs. A stolen `agent-subrun` job is
// marked completed by the thief in about a millisecond, the owner's awaiter
// never receives the completion it subscribed for, and the test dies on
// `await_timeout` with nothing wrong in its own code.
//
// `scripts/test-run.ts` and `scripts/test-unit-parallel.ts` already hand every
// file its own prefix. Runs that go around them (this wrapper) need the same
// guard, so they get one here.

/**
 * The Redis prefix a wrapped test command should run under.
 *
 * An explicit `REDIS_PREFIX` always wins: the parallel runners set one per file
 * and the chaos orchestrator pins one per run. Only an absent or empty value is
 * replaced, and the replacement is unique per call so two concurrent wrapped
 * runs never share a namespace.
 */
export function resolveTestRedisPrefix(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
  random: () => number = Math.random,
): string {
  const explicit = env.REDIS_PREFIX
  if (explicit !== undefined && explicit !== "") return explicit
  const token = Math.floor(random() * 0xffffff)
    .toString(36)
    .padStart(4, "0")
  return `wtl${pid}_${token}:`
}
