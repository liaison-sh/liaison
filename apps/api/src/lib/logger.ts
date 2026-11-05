// SPDX-License-Identifier: FSL-1.1-ALv2
import pino from "pino"
import { env } from "~/lib/env"

// The dev pretty transport writes to fd 2 (stderr) — NOT its default stdout —
// for the same I/O-discipline reason the no-transport path pins fd 2 below: a
// `config apply --format json` run under NODE_ENV=development must never see a
// human-formatted log line on its parseable stdout.
const transport =
  env.NODE_ENV === "development"
    ? { target: "pino-pretty", options: { colorize: true, destination: 2 } }
    : undefined

/**
 * Pino redact paths. Exported so tests can assert the configured policy without
 * scraping the live root logger's transport. Top-level field + `*.` wildcard
 * variants are kept paired so a secret is masked whether it sits at the log
 * root or nested one level deep in a structured object.
 */
export const REDACT_PATHS: string[] = [
  // Top-level fields (shallow logs)
  "password",
  "passwordHash",
  "totpSecret",
  "recoveryCodes",
  "clientSecret",
  "refreshToken",
  "accessToken",
  "inviteToken",
  "token",
  // NOTE (known pre-existing, intentionally left): bare `code` / `*.code` are
  // over-broad — they also mask non-secret fields named `code` (e.g. an error's
  // `err.code` like ENOENT, an HTTP status `code`). Narrowing to the specific
  // OAuth-grant paths (`req.query.code`, `body.code`) is the correct long-term
  // fix, but tightening it here risks unredacting a structured-log shape some
  // existing call site relies on; deferred to avoid scope-creep on this pass.
  "code",
  "deviceCode",
  "codeVerifier",
  // Provisioning CLI secrets (config apply / connect / byok). The config file
  // carries provider API keys, app connection credentials, and BYOK keys — none
  // may reach a structured log line. (Defense-in-depth: the CLI also avoids
  // logging the raw config / credentials maps in the first place.)
  "apiKey",
  "apiToken",
  "credentials",
  "byok",
  "providerKeys",
  // Knowledge / Google Drive sensitive context
  "resourceKey", // Drive link-shared file resource key
  "pageToken", // Drive pagination cursor — embeds query state
  // Wildcard paths — redact nested occurrences of the same fields so secrets
  // carried in structured objects (e.g. { user: { accessToken: "..." } })
  // are not logged in plain text.
  "*.password",
  "*.passwordHash",
  "*.totpSecret",
  "*.recoveryCodes",
  "*.clientSecret",
  "*.refreshToken",
  "*.accessToken",
  "*.inviteToken",
  "*.token",
  "*.code",
  "*.deviceCode",
  "*.codeVerifier",
  "*.apiKey",
  "*.apiToken",
  "*.credentials",
  "*.byok",
  "*.providerKeys",
  "*.resourceKey",
  "*.pageToken",
  // HTTP layer
  "req.headers.authorization",
  "req.headers.cookie",
  "*.headers.authorization",
  "*.headers.cookie",
  // The wrapped shells present the refresh token in a header rather than in
  // the cookie (lib/response.ts), so this one carries the same live 30 day
  // credential `cookie` above does. Bracket form because pino's path grammar
  // reads a dash as part of an expression otherwise.
  'req.headers["x-liaison-refresh"]',
  '*.headers["x-liaison-refresh"]',
  // A desktop local turn's credential (S59): live for its turn, never logged.
  'req.headers["x-liaison-turn"]',
  '*.headers["x-liaison-turn"]',
  "turnCredential",
  "*.turnCredential",
  // A secret typed into a secret card, by whatever name a caller gives it.
  "secret",
  "*.secret",
]

/** The fields a database error carries beside its message (postgres.js names). */
const DB_ERROR_FIELDS = [
  "severity",
  "detail",
  "hint",
  "position",
  "where",
  "routine",
  "schema_name",
  "table_name",
  "column_name",
  "constraint_name",
] as const

/** How deep a cause chain is followed; a cycle stops at the first repeat. */
const MAX_CAUSE_DEPTH = 5

function serializeCause(cause: unknown, seen: Set<unknown>, depth: number): unknown {
  if (!(cause instanceof Error)) return cause === undefined ? undefined : String(cause)
  if (seen.has(cause) || depth > MAX_CAUSE_DEPTH)
    return { type: cause.name, message: cause.message }
  seen.add(cause)
  const fields = cause as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { type: cause.name, message: cause.message }
  // SQLSTATE under its own name: the bare `code` path is redacted (REDACT_PATHS).
  if (typeof fields.code === "string" || typeof fields.code === "number") {
    out.sqlstate = fields.code
  }
  for (const key of DB_ERROR_FIELDS) {
    if (fields[key] !== undefined && fields[key] !== null) out[key] = fields[key]
  }
  const next = serializeCause(fields.cause, seen, depth + 1)
  if (next !== undefined) out.cause = next
  return out
}

/**
 * The `err` serializer: pino's own, plus the error's CAUSE as a field of its
 * own. drizzle throws a DrizzleQueryError whose message is the query and its
 * parameters, with the database's answer as its `cause`; pino's serializer
 * only appends the cause's text to the end of the parameter list and drops its
 * SQLSTATE, hint and position, so a failed query in the logs said what was run
 * and, for every practical reader, not why it failed. Every logger here
 * (`rootLogger` and its children) uses it.
 */
function serializeErr(err: unknown): unknown {
  const base = pino.stdSerializers.err(err as Error) as unknown
  if (!(err instanceof Error) || err.cause === undefined) return base
  const cause = serializeCause(err.cause, new Set<unknown>([err]), 1)
  return cause === undefined ? base : { ...(base as Record<string, unknown>), cause }
}

export const LOG_SERIALIZERS = { err: serializeErr }

// Diagnostic logs go to STDERR (fd 2), not STDOUT. STDOUT is reserved for
// program output — most importantly the provisioning CLI's `config apply`, whose
// stdout must be ONLY the machine-readable report (JSON / `KEY="VALUE"` lines)
// per the I/O discipline. Pino's default destination is stdout (fd 1); pin it to
// fd 2 so a stray log line can never pollute a parseable stdout. (The dev
// pino-pretty transport owns its own destination — also pinned to fd 2 above.)
//
// Sync vs async: the server must NOT block its event loop on every log write, so
// the fd-2 destination is ASYNC by default. The ONLY context that needs a
// synchronous flush is the provisioning CLI — it ends with a hard `process.exit()`
// that can drop the async buffer's tail. `LIAISON_CLI` is set to "1" by the CLI
// entrypoints (`bin/liaison` shim + the top of `cli/index.ts`, before this module
// is imported), so a CLI run flushes its trailing log lines while the server
// stays non-blocking.
const cliSync = process.env.LIAISON_CLI === "1"
/**
 * LOG_LEVEL, else "info" in production and "debug" elsewhere (lib/env.ts).
 * A CLI run logs at "warn" (LIAISON_CLI_LOG_LEVEL overrides): it shares the
 * server's env file, so the server's LOG_LEVEL would otherwise print every
 * "Redis connected" and "App registered" line before the command's answer, and
 * `docker compose exec` (a TTY) shows stderr mixed into the output.
 */
export const logLevel = cliSync
  ? (env.LIAISON_CLI_LOG_LEVEL ?? "warn")
  : (env.LOG_LEVEL ?? (env.NODE_ENV === "production" ? "info" : "debug"))
export const rootLogger = transport
  ? pino({ level: logLevel, redact: REDACT_PATHS, serializers: LOG_SERIALIZERS, transport })
  : pino(
      { level: logLevel, redact: REDACT_PATHS, serializers: LOG_SERIALIZERS },
      pino.destination({ fd: 2, sync: cliSync }),
    )

// Service-scoped child loggers
export const authLogger = rootLogger.child({ service: "auth" })
export const appsLogger = rootLogger.child({ service: "apps" })
export const eventsLogger = rootLogger.child({ service: "events" })
export const jobsLogger = rootLogger.child({ service: "jobs" })
export const contactsLogger = rootLogger.child({ service: "contacts" })
export const timelineLogger = rootLogger.child({ service: "timeline" })
export const webhooksLogger = rootLogger.child({ service: "webhooks" })
export const auditLogger = rootLogger.child({ service: "audit" })
export const searchLogger = rootLogger.child({ service: "search" })
export const filesLogger = rootLogger.child({ service: "files" })
export const knowledgeLogger = rootLogger.child({ service: "knowledge" })
export const pdfLogger = rootLogger.child({ service: "pdf" })
export const monitorLogger = rootLogger.child({ service: "monitor" })
