// SPDX-License-Identifier: FSL-1.1-ALv2
//
// api-connector: the app's handlers over the platform-held API connections
// (`ctx.api.*`). The platform holds each connection's adapter document and
// credentials, renders, signs and sends every call, checks the caller's scopes
// against the connection's `api` block and audits it; nothing here touches the
// network or a credential. What stays here: the tools' shapes, the settings
// screen's and the customer card's reads, the approval card of a write, and the
// provisioning of connections from a config file.

import type { ApiAnswer, AppContext, ProvisionParams, ProvisionResult } from "@liaison/app-sdk"

type Ctx = Pick<AppContext, "api">

function args(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {}
}

// --- Agent tools ---------------------------------------------------------------

export async function connectorListOperations(params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  return ctx.api.listOperations(args(params))
}

export async function connectorRead(params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  return ctx.api.read(args(params))
}

export async function connectorWrite(params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  return ctx.api.write(args(params))
}

/** Stage-time check of `connector_write` (no network): refuses before an approval is parked. */
export async function connectorWritePreflight(params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  return ctx.api.writeValidate(args(params))
}

// --- Adapter authoring reads (the save and restore are the platform's tools) ---

export async function connectorAdapterGet(params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  return ctx.api.adapterGet(args(params) as { identifier: string })
}

export async function connectorAdapterVersions(params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  return ctx.api.adapterVersions(args(params) as { identifier: string })
}

export async function connectorAdapterReference(params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  return ctx.api.adapterReference(args(params))
}

export async function connectorAdapterTest(params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  const { raw: _raw, ...rest } = args(params)
  return ctx.api.adapterTest(rest)
}

// --- The settings screen and the customer card (UI-only tools) ------------------

export async function settingsConnections(_params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  return ctx.api.connections()
}

export async function settingsAdapterSave(params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  const p = args(params)
  return ctx.api.adapterPut({
    identifier: p.identifier,
    document: p.document,
    confirmCredentialWipe: p.confirmCredentialWipe === true,
  })
}

export async function settingsAdapterRestore(params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  const p = args(params)
  return ctx.api.adapterRestore({
    identifier: p.identifier,
    versionId: p.versionId,
    confirmCredentialWipe: p.confirmCredentialWipe === true,
  })
}

export async function settingsAdapterDelete(params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  return ctx.api.adapterDelete({ identifier: String(args(params).identifier ?? "") })
}

/** One page of a READ operation, the items as the API answered them (the Test panel). */
export async function settingsAdapterTest(params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  const p = args(params)
  return ctx.api.adapterTest({
    identifier: p.identifier,
    operation: p.operation,
    params: args(p.params),
    raw: true,
  })
}

/** The customer card: by the ticket's or conversation's participant, or an address. */
export async function customerLookup(params: unknown, ctx: Ctx): Promise<ApiAnswer> {
  const p = args(params)
  const pick = (k: string) => (typeof p[k] === "string" && p[k] !== "" ? { [k]: p[k] } : {})
  return ctx.api.customer({
    ...pick("ticketId"),
    ...pick("mailConversationId"),
    ...pick("email"),
    ...pick("phone"),
    ...pick("domain"),
  })
}

// --- Provisioning (`apps[].provision` of a config file) -------------------------

interface ConnectorEntry {
  identifier: string
  /** The adapter document: an object, or its JSON or YAML text. */
  adapter: unknown
}

interface ProvisionConfig {
  connectors?: ConnectorEntry[]
}

function failure(answer: ApiAnswer): string | null {
  const err = answer.error as { message?: string } | undefined
  if (err) return err.message ?? "refused"
  if (answer.ok === false) {
    const issues = (answer.issues as Array<{ path?: string; message?: string }> | undefined) ?? []
    return `invalid adapter: ${issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ")}`
  }
  return null
}

/**
 * Ensure each declared connection's adapter. A dry run reports what a save
 * would do; an apply writes only what differs. A change of the API's address
 * or auth deletes the stored credentials (they were entered for the old
 * target): the line says so, and the config's `connections` re-enter them.
 */
export async function provisionApiConnector(
  params: ProvisionParams<ProvisionConfig>,
  ctx: Ctx,
): Promise<ProvisionResult> {
  const entries = params.config?.connectors ?? []
  const seen = new Set<string>()
  const changed: string[] = []
  for (const entry of entries) {
    if (seen.has(entry.identifier)) {
      throw new Error(`connectors: '${entry.identifier}' is declared twice`)
    }
    seen.add(entry.identifier)
    const plan = await ctx.api.adapterPlan({
      identifier: entry.identifier,
      document: entry.adapter,
    })
    const refused = failure(plan)
    if (refused) throw new Error(`connectors[${entry.identifier}]: ${refused}`)
    if (plan.unchanged === true) continue
    const wipe =
      plan.wipesCredentials === true
        ? " (its API address or auth changed: stored credentials deleted)"
        : ""
    const line = `connection '${entry.identifier}': adapter ${plan.created === true ? "created" : "updated"}${wipe}`
    if (!params.dryRun) {
      const saved = await ctx.api.adapterPut({
        identifier: entry.identifier,
        document: entry.adapter,
        confirmCredentialWipe: true,
        skipUnchanged: true,
      })
      const err = failure(saved)
      if (err) throw new Error(`connectors[${entry.identifier}]: ${err}`)
    }
    changed.push(line)
  }
  return { changed }
}

/**
 * `config verify`: one authenticated read per connection with credentials (a
 * parameterless read the platform picks), and what failed.
 */
export async function verifyApiConnector(
  _params: unknown,
  ctx: Ctx,
): Promise<{ ok: boolean; problems?: string[]; identity?: string }> {
  const answer = await ctx.api.verify()
  const err = failure(answer)
  if (err) return { ok: false, problems: [err] }
  const results =
    (answer.results as Array<{
      connection: string
      status: string
      identity?: string
      error?: string
      reason?: string
      httpStatus?: number
    }>) ?? []
  const problems = results
    .filter((r) => r.status === "FAIL")
    .map(
      (r) =>
        `connection '${r.connection}': ${r.error ?? "failed"}${r.httpStatus ? ` (HTTP ${r.httpStatus})` : ""}`,
    )
  const passed = results
    .filter((r) => r.status === "PASS")
    .map((r) => `${r.connection} (${r.identity ?? "ok"})`)
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, ...(passed.length > 0 ? { identity: passed.join(", ") } : {}) }
}

// --- Approval summarizer (runs in the sandbox with an empty bridge: pure) -------

interface ConnectorWriteSummary {
  kind: string
  title: string
  subtitle?: string
  lines: string[]
}

function summaryText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}

/** The request line the server pinned at staging (`target`), or null. */
function targetLine(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null
  const t = value as Record<string, unknown>
  if (typeof t.method !== "string" || typeof t.host !== "string" || typeof t.path !== "string") {
    return null
  }
  return summaryText(`${t.method} ${t.host}${t.path}`)
}

/** `create_contact` / `createContact` → "Create contact". */
function operationWords(operation: string): string {
  const words = operation
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : operation
}

/** A short all-letter connection name is an acronym ("crm" → "CRM"); others stay as written. */
function connectionLabel(connection: string): string {
  return /^[a-z]{2,3}$/.test(connection) ? connection.toUpperCase() : connection
}

/** Who or what the write is about, from the params a person would recognise. */
function writeSubject(args: Record<string, unknown>): string | null {
  const text = (k: string): string | null => {
    const v = args[k]
    return typeof v === "string" && v.trim() ? v.trim() : null
  }
  const person = [text("firstName") ?? text("first_name"), text("lastName") ?? text("last_name")]
    .filter((v): v is string => v !== null)
    .join(" ")
  const subject =
    text("name") ??
    text("fullName") ??
    text("full_name") ??
    (person || null) ??
    text("title") ??
    text("subject") ??
    text("email") ??
    text("companyName") ??
    text("company_name")
  return subject ? summaryText(subject) : null
}

/**
 * The approval card of `connector_write`: which connection and operation,
 * the request it sends (method, host and path, pinned by the server at
 * staging), and the params.
 */
export async function summarizeConnectorWrite(params: unknown): Promise<ConnectorWriteSummary> {
  const p = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {}
  const connection = typeof p.connection === "string" ? p.connection : "(no connection)"
  const operation = typeof p.operation === "string" ? p.operation : "(no operation)"
  const args =
    typeof p.params === "object" && p.params !== null ? (p.params as Record<string, unknown>) : {}
  const entries = Object.entries(args)
  const request = targetLine(p.target)
  const lines = request ? [request] : []
  for (const [k, v] of entries.slice(0, 20)) lines.push(`${k}: ${summaryText(v)}`)
  if (entries.length > 20) lines.push(`… and ${entries.length - 20} more`)
  if (entries.length === 0) lines.push("(no parameters)")
  return {
    kind: "api-connector.write",
    // Reads as what happens ("Create contact in CRM: Ines Duarte"), never as
    // tool vocabulary ("Run create_contact on crm").
    title: (() => {
      const action = `${operationWords(operation)} in ${connectionLabel(connection)}`
      const subject = writeSubject(args)
      return subject ? `${action}: ${subject}` : action
    })(),
    subtitle: "Writes to an external system",
    lines,
  }
}
