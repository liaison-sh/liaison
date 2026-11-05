// SPDX-License-Identifier: FSL-1.1-ALv2
//
// db-gate configuration — read from env, validated at startup. Refuses to
// start (throws) on a weak token or a missing required var, per Task 4 §4.1.

export interface DbGateConfig {
  dsn: string
  token: string
  catalogPath: string
  allowQuery: boolean
  port: number
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

const MIN_TOKEN_LENGTH = 32

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DbGateConfig {
  const dsn = env.DB_GATE_DSN
  if (!dsn) throw new ConfigError("DB_GATE_DSN is required")

  const token = env.DB_GATE_TOKEN
  if (!token) throw new ConfigError("DB_GATE_TOKEN is required")
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `DB_GATE_TOKEN is too weak (${token.length} chars, minimum ${MIN_TOKEN_LENGTH}) — refusing to start`,
    )
  }

  const catalogPath = env.DB_GATE_CATALOG ?? "/catalog.yaml"
  const allowQuery = env.DB_GATE_ALLOW_QUERY === "true"
  const port = env.DB_GATE_PORT ? Number(env.DB_GATE_PORT) : 8478
  if (Number.isNaN(port)) throw new ConfigError("DB_GATE_PORT must be a number")

  return { dsn, token, catalogPath, allowQuery, port }
}

/** Minimal shape of a startup probe result this gate needs to decide
 *  whether it's safe to start with DB_GATE_ALLOW_QUERY=true. */
export interface StartupProbeResult {
  ok: boolean
}

/**
 * The startup gate (spec §3.3 / Task 4 §4.1, C2/M9): `DB_GATE_ALLOW_QUERY=
 * true` refuses to actually start unless the startup probe confirms no
 * write grants AND no dangerous EXECUTE grants beyond the curated allow-
 * list. Extracted as a pure function (config + probe result in, throw or
 * not) so the three cases are unit-testable without booting a real gate
 * process or a real DB connection.
 *
 *   - allowQuery=true,  dirty probe -> throws (refuse to start)
 *   - allowQuery=true,  clean probe -> returns (ok to start)
 *   - allowQuery=false, dirty probe -> returns (curated-reads-only gate
 *     doesn't need a clean write-grant probe to be safe — the raw /query
 *     route is disabled either way)
 */
export function assertCleanStartupOrThrow(
  config: Pick<DbGateConfig, "allowQuery">,
  probe: StartupProbeResult,
): void {
  if (config.allowQuery && !probe.ok) {
    throw new ConfigError(
      "DB_GATE_ALLOW_QUERY=true requires a clean startup probe (no write grants, no dangerous " +
        "EXECUTE grants beyond the curated allow-list) — refusing to start",
    )
  }
}
