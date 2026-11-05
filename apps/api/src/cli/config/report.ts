// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Report builder + output formatter (Task 13). PURE — no DB, no I/O.
 *
 * `buildReport` assembles the aggregated provisioner results into the spec §4
 * JSON report shape, and owns the centralized ECHO POLICY for API keys:
 * - `apiKeys[].key` is ABSENT for a SUPPLIED key regardless of flags (the
 *   operator already holds it); it is present once for a GENERATED key.
 * - `env.LIAISON_API_KEY` carries a SUPPLIED value ONLY with `echoSupplied`,
 *   and ALWAYS carries a GENERATED value (emitted once).
 * - Precedence (correction #15): the FIRST `apiKeys[]` entry that yields an
 *   emittable value wins; otherwise `LIAISON_API_KEY` is omitted.
 *
 * `formatJson` pretty-prints. `formatEnv` emits ONLY the `env` map, one
 * `KEY="VALUE"` per line, with values double-quoted and `"`/`\`/`$` escaped so a
 * value containing a space or shell metachar survives `eval "$(…)"`.
 */

import type { DriftEntry } from "~/cli/config/drift"

/** A provisioned API key as seen by the report builder. `key` is the plaintext —
 *  present only for a freshly generated key; `suppliedKey` is the operator's
 *  supplied plaintext, carried separately and emitted to env ONLY under
 *  `echoSupplied` (never into the JSON `apiKeys[].key`). */
export interface ReportApiKeyInput {
  label: string
  created: boolean
  keyPrefix: string
  /** Plaintext for a GENERATED key (emitted once). Absent for supplied keys. */
  key?: string
  /** The operator-supplied plaintext (supplied entries only). Reaches env only
   *  with `echoSupplied`; never the JSON output. */
  suppliedKey?: string
}

/** The structured input the driver assembles for the report builder. Every
 *  section is optional — a config that omits a section omits its report key. */
export interface ReportInput {
  org?: { id: string; slug: string; created: boolean }
  admin?: { id: string; email: string; created: boolean }
  users?: unknown[]
  byok?: Record<string, { set: boolean; validated: boolean }>
  apiKeys?: ReportApiKeyInput[]
  email?: { from?: string; replyTo?: string; set: boolean }
  mail?: { mailboxes: unknown[] }
  tickets?: { inboxes: unknown[] }
  apps?: unknown[]
  knowledge?: { collections: number; documents: number; sources: number; skipped?: unknown[] }
  agents?: unknown[]
  invoicing?: { issuerProfiles: unknown[]; taxRegimes: unknown[]; hsCodes: unknown[] }
  pending?: unknown[]
  changed?: string[]
  unchanged?: string[]
  /** Drift safety: per tracked path, the action and file/server summaries. */
  drift?: DriftEntry[]
}

/** The spec §4 output report object. */
export interface ReportObject {
  ok: boolean
  org?: ReportInput["org"]
  admin?: ReportInput["admin"]
  users?: unknown[]
  byok?: ReportInput["byok"]
  apiKeys?: Array<{ label: string; created: boolean; keyPrefix: string; key?: string }>
  email?: ReportInput["email"]
  mail?: ReportInput["mail"]
  tickets?: ReportInput["tickets"]
  apps?: unknown[]
  knowledge?: ReportInput["knowledge"]
  agents?: unknown[]
  invoicing?: ReportInput["invoicing"]
  pending: unknown[]
  env: Record<string, string>
  changed: string[]
  unchanged: string[]
  drift?: DriftEntry[]
  /** Paths left unwritten because the server changed them since the last apply. */
  conflicts?: string[]
}

export interface BuildReportOptions {
  /** Whether a SUPPLIED key's plaintext may be echoed into `env.LIAISON_API_KEY`. */
  echoSupplied: boolean
}

/**
 * Resolve `env.LIAISON_API_KEY` by the precedence rule (correction #15): the
 * first apiKeys entry that yields an emittable value wins — a generated key
 * always emits its plaintext; a supplied key emits only with `echoSupplied`.
 */
function resolveApiKeyEnv(
  apiKeys: ReportApiKeyInput[] | undefined,
  echoSupplied: boolean,
): string | undefined {
  if (!apiKeys) return undefined
  for (const entry of apiKeys) {
    if (entry.key !== undefined) return entry.key // generated — always emittable
    if (echoSupplied && entry.suppliedKey !== undefined) return entry.suppliedKey
  }
  return undefined
}

export function buildReport(input: ReportInput, opts: BuildReportOptions): ReportObject {
  const env: Record<string, string> = {}
  if (input.org) env.LIAISON_ORG_ID = input.org.id
  const apiKeyEnv = resolveApiKeyEnv(input.apiKeys, opts.echoSupplied)
  if (apiKeyEnv !== undefined) env.LIAISON_API_KEY = apiKeyEnv

  // Project apiKeys to the JSON shape: supplied keys NEVER carry plaintext;
  // generated keys carry it once. `suppliedKey` never reaches the JSON output.
  const apiKeys = input.apiKeys?.map((entry) => ({
    label: entry.label,
    created: entry.created,
    keyPrefix: entry.keyPrefix,
    ...(entry.key !== undefined ? { key: entry.key } : {}),
  }))

  const conflicts = (input.drift ?? []).filter((d) => d.action === "conflict").map((d) => d.path)
  const report: ReportObject = {
    ok: conflicts.length === 0,
    ...(input.org ? { org: input.org } : {}),
    ...(input.admin ? { admin: input.admin } : {}),
    ...(input.users ? { users: input.users } : {}),
    ...(input.byok ? { byok: input.byok } : {}),
    ...(apiKeys ? { apiKeys } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.mail ? { mail: input.mail } : {}),
    ...(input.tickets ? { tickets: input.tickets } : {}),
    ...(input.apps ? { apps: input.apps } : {}),
    ...(input.knowledge ? { knowledge: input.knowledge } : {}),
    ...(input.agents ? { agents: input.agents } : {}),
    ...(input.invoicing ? { invoicing: input.invoicing } : {}),
    pending: input.pending ?? [],
    env,
    changed: input.changed ?? [],
    unchanged: input.unchanged ?? [],
    ...(input.drift ? { drift: input.drift } : {}),
    ...(conflicts.length > 0 ? { conflicts } : {}),
  }
  return report
}

export function formatJson(report: ReportObject): string {
  return JSON.stringify(report, null, 2)
}

/**
 * Escape a value so it survives `eval "$(…)"` inside double quotes. In a
 * double-quoted shell string, the metacharacters that retain special meaning are
 * `"` (closes the string), `\` (escape), `$` (expansion) and backtick (command
 * substitution) — escape each with a leading backslash. Everything else
 * (spaces, `=`, `:`, etc.) is literal inside double quotes.
 */
function shellEscapeDoubleQuoted(value: string): string {
  return value.replace(/[\\"$`]/g, (ch) => `\\${ch}`)
}

/**
 * Emit ONLY the `env` map as sourceable `KEY="VALUE"` lines (double-quoted,
 * escaped). A value with a space (e.g. an org name "Acme Support <…>")
 * survives `eval "$(…)"` unbroken.
 */
export function formatEnv(report: ReportObject): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(report.env)) {
    lines.push(`${key}="${shellEscapeDoubleQuoted(value)}"`)
  }
  return lines.join("\n")
}
