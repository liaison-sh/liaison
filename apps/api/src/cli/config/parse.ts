// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Config file loader + `${ENV}` interpolator for the provisioning CLI.
 *
 * Single responsibility: a config file path becomes an interpolated plain
 * object (no schema yet — that is `schema.ts`/`validateConfig`). Format is
 * detected by extension (`.json` → JSON, everything else → YAML). Scalar
 * strings undergo `${VAR}` / `${VAR:-default}` interpolation; an unresolved
 * `${VAR}` with no default is a fatal usage error (exit 2).
 *
 * This module NEVER logs values — it returns the object to the caller, which
 * owns the stdout/stderr split and the no-secret-logging discipline.
 */
import { readFileSync } from "node:fs"
import { extname } from "node:path"
import { parse as parseYaml } from "yaml"

/**
 * A typed, exit-code-bearing config failure. Plan-time validation errors and
 * unresolved env interpolation both surface as `ConfigError(exitCode: 2)` so
 * the driver can abort BEFORE any write with a usage-error exit code.
 */
export class ConfigError extends Error {
  readonly exitCode: 2
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
    this.exitCode = 2
  }
}

export type ParseResult = { ok: true; raw: unknown } | { ok: false; code: 2; message: string }

/**
 * Load a YAML or JSON config file into a raw plain object. Format is detected
 * by extension — `.json` → `JSON.parse`; `.yaml`/`.yml`/anything else → YAML
 * (the spec's primary format). I/O and parse failures both return a typed
 * `{ ok: false, code: 2 }` rather than throwing, so the caller can map them to
 * the usage exit code.
 */
export function parseConfigFile(path: string): ParseResult {
  let contents: string
  try {
    contents = readFileSync(path, "utf8")
  } catch (err) {
    return { ok: false, code: 2, message: `cannot read config file '${path}': ${errMessage(err)}` }
  }

  const ext = extname(path).toLowerCase()
  try {
    const raw = ext === ".json" ? JSON.parse(contents) : parseYaml(contents)
    return { ok: true, raw }
  } catch (err) {
    return { ok: false, code: 2, message: `cannot parse config file '${path}': ${errMessage(err)}` }
  }
}

/**
 * Recursively interpolate `${VAR}` / `${VAR:-default}` references in every
 * string scalar reachable from `value`. Numbers, booleans, and null pass
 * through untouched (no coercion). An unresolved `${VAR}` with no default
 * throws `ConfigError(exitCode: 2)` naming the variable.
 *
 * Pure: takes an explicit `env` map (defaults to `process.env`) so it is
 * deterministically testable.
 */
export function interpolateEnv(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): unknown {
  if (typeof value === "string") return interpolateString(value, env)
  if (Array.isArray(value)) return value.map((item) => interpolateEnv(item, env))
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v, env)
    return out
  }
  return value
}

// `${VAR}` or `${VAR:-default}` — VAR is an env-style identifier; the optional
// `:-default` group captures everything up to the closing brace (defaults may
// themselves contain anything but `}`).
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

function interpolateString(input: string, env: Record<string, string | undefined>): string {
  return input.replace(ENV_REF, (_match, name: string, fallback: string | undefined) => {
    const resolved = env[name]
    if (resolved !== undefined) return resolved
    if (fallback !== undefined) return fallback
    throw new ConfigError(
      `environment variable '${name}' is not set and has no default in '\${${name}}'`,
    )
  })
}

/**
 * `interpolateEnv` for reading a file back (`config pull`): a reference to an
 * unset variable without a default stays as written instead of throwing.
 */
export function interpolateEnvLenient(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_REF, (match, name: string, fallback: string | undefined) => {
      const resolved = env[name]
      if (resolved !== undefined) return resolved
      return fallback !== undefined ? fallback : match
    })
  }
  if (Array.isArray(value)) return value.map((item) => interpolateEnvLenient(item, env))
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnvLenient(v, env)
    return out
  }
  return value
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A config key that names a secret: `apiKey`, `token`, `clientSecret`, `password`, ... */
const SECRET_KEY_RE = /(key|token|secret|password|passphrase)$/i
/** A value that is only `${VAR}` references (an empty `:-` default allowed): it holds no secret itself. */
const REFERENCE_ONLY_RE = /^(\$\{[A-Za-z_][A-Za-z0-9_]*(:-)?\})+$/

/**
 * The paths (`apiConnectors.0.credentials.token`) of the secret values the
 * parsed, NOT yet interpolated, config holds literally: a non-empty string
 * under a secret-named key or a `credentials` block that is not only `${VAR}`
 * references (a non-empty `${VAR:-default}` default counts as literal). The
 * file-permission warning is about these; a file of references only leaks
 * nothing.
 */
export function literalSecretPaths(
  raw: unknown,
  path: string[] = [],
  inCredentials = false,
): string[] {
  if (typeof raw === "string") {
    const key = path[path.length - 1] ?? ""
    const secretKey = inCredentials || SECRET_KEY_RE.test(key)
    return secretKey && raw !== "" && !REFERENCE_ONLY_RE.test(raw) ? [path.join(".")] : []
  }
  if (Array.isArray(raw))
    return raw.flatMap((v, i) => literalSecretPaths(v, [...path, String(i)], inCredentials))
  if (raw !== null && typeof raw === "object") {
    return Object.entries(raw).flatMap(([k, v]) =>
      literalSecretPaths(v, [...path, k], inCredentials || k === "credentials"),
    )
  }
  return []
}
