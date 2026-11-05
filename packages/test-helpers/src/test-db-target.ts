// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Which Postgres database a test run is configured for, read from its URL env vars, never
 * assumed. Every path that resets, drift-checks or preflights the test database resolves the name
 * here, so a run pointed at a private database never resets the shared `liaison_test`, and a
 * run whose variables disagree is refused before anything is dropped.
 *
 * Pure (no I/O): callers pass the environment and the text of `.env.test` and the repo-root
 * `.env`. The root `.env` matters because `bun run` auto-loads it into any process started from
 * the repo root: a `DATABASE_URL` equal to the root `.env` value is the dev configuration that
 * leaked in, not a test target, so it is ignored.
 */

/** The shared test database every checkout on a machine uses unless told otherwise. */
export const SHARED_TEST_DB = "liaison_test"
/** The development database: never a test target, never reset by a test path. */
export const DEV_DB = "liaison_dev"

/** Env vars that name the test database, by URL (or by name for E2E_DB_NAME). */
export const TEST_DB_VARS = [
  "DATABASE_URL",
  "E2E_DATABASE_URL",
  "E2E_SERVER_DATABASE_URL",
  "DATABASE_URL_SUPERUSER",
  "MIGRATION_DATABASE_URL_TEST",
  "E2E_DB_NAME",
] as const

/**
 * Set by a caller that spawns `scripts/db-reset.ts`: the database it has resolved and expects to
 * be reset. db-reset refuses when its own resolution names another one.
 */
export const RESET_EXPECT_DB_VAR = "LIAISON_RESET_EXPECT_DB"

export class TestDbTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TestDbTargetError"
  }
}

type Env = Record<string, string | undefined>

/** The database name in a Postgres URL, or null when the URL names none or does not parse. */
export function dbNameFromUrl(url: string): string | null {
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""))
    return name && !name.includes("/") ? name : null
  } catch {
    return null
  }
}

/** The same URL with its database path removed (`postgres://u:p@h:5432`). */
export function serverBaseUrl(url: string): string {
  const u = new URL(url)
  u.pathname = ""
  u.search = ""
  return u.toString().replace(/\/+$/, "")
}

/** Minimal dotenv reader: KEY=VALUE lines, optional quotes, `#` comments. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2] ?? ""
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
    out[m[1]!] = value
  }
  return out
}

export interface TestDbTarget {
  /** The database name. */
  name: string
  /** Where it came from: the env vars that named it, or the `.env.test` / default fallback. */
  sources: string[]
}

/**
 * Resolve the test database. Every explicitly set variable in TEST_DB_VARS must name the same
 * database (a value equal to the root `.env` one counts as unset, see the header); with none set,
 * `.env.test`'s DATABASE_URL decides, then the shared default. Throws when the variables
 * disagree, when one does not parse, or when the result is the dev database.
 */
export function resolveTestDb(input: {
  env: Env
  envTestText?: string
  rootEnvText?: string
}): TestDbTarget {
  const rootEnv = parseDotEnv(input.rootEnvText ?? "")
  const named = new Map<string, string[]>()
  for (const v of TEST_DB_VARS) {
    const value = input.env[v]?.trim()
    if (!value) continue
    if (rootEnv[v] !== undefined && rootEnv[v] === value) continue
    const name = v === "E2E_DB_NAME" ? value : dbNameFromUrl(value)
    if (!name) {
      throw new TestDbTargetError(
        `${v} does not name a database: refusing to guess the test database`,
      )
    }
    named.set(name, [...(named.get(name) ?? []), v])
  }
  let target: TestDbTarget
  if (named.size > 1) {
    const list = [...named.entries()].map(([db, vars]) => `${db} (${vars.join(", ")})`).join("; ")
    throw new TestDbTargetError(
      `the test run is configured for more than one database: ${list}. Point every DB URL variable at the same database.`,
    )
  } else if (named.size === 1) {
    const [[name, sources]] = [...named.entries()] as [[string, string[]]]
    target = { name, sources }
  } else {
    const fromFile = parseDotEnv(input.envTestText ?? "").DATABASE_URL
    const name = fromFile ? dbNameFromUrl(fromFile) : null
    target = name
      ? { name, sources: [".env.test DATABASE_URL"] }
      : { name: SHARED_TEST_DB, sources: ["default"] }
  }
  if (target.name === DEV_DB) {
    throw new TestDbTargetError(
      `the test database resolves to the dev database ${DEV_DB} (${target.sources.join(", ")}): refusing`,
    )
  }
  return target
}

/**
 * Throw unless `dbName` is the database the run is configured for. The guard every reset path
 * runs right before it drops anything.
 */
export function assertResetTarget(dbName: string, expected: string | undefined): void {
  if (expected !== undefined && expected !== "" && expected !== dbName) {
    throw new TestDbTargetError(
      `refusing to reset ${dbName}: the run is configured for ${expected}`,
    )
  }
}

/**
 * A child env for a test process: DATABASE_URL is dropped only when it is the root `.env` dev
 * value that `bun run` auto-loaded (so `--env-file=.env.test` can set it), and kept when the
 * caller set it, so a run pointed at a private database stays there.
 */
export function stripAutoLoadedDatabaseUrl(env: Env, rootEnvText: string | undefined): Env {
  const out = { ...env }
  const rootValue = parseDotEnv(rootEnvText ?? "").DATABASE_URL
  if (rootValue !== undefined && out.DATABASE_URL === rootValue) delete out.DATABASE_URL
  return out
}
