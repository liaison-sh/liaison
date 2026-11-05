// SPDX-License-Identifier: FSL-1.1-ALv2
// api-connector: sandboxed manifest handler bundle.
//
// Headless connector: each agent tool is a thin delegator to a host-side
// bridge method (`connector_*`, bridge.ts), where the adapter, the
// credentials and the HTTP call live. Nothing here touches the network.
//
// biome-ignore-all lint/correctness/noUnusedVariables: handlers resolved by manifest export name

import type {} from "node:buffer"

interface ApiConnectorSandboxCtx {
  connector_list_operations: (paramsJson: string) => Promise<string>
  connector_read: (paramsJson: string) => Promise<string>
  connector_write: (paramsJson: string) => Promise<string>
  connector_write_validate: (paramsJson: string) => Promise<string>
  connector_adapter_get: (paramsJson: string) => Promise<string>
  connector_adapter_versions: (paramsJson: string) => Promise<string>
  connector_adapter_reference: (paramsJson: string) => Promise<string>
  connector_adapter_test: (paramsJson: string) => Promise<string>
}

async function connectorListOperations(
  params: unknown,
  ctx: ApiConnectorSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.connector_list_operations(JSON.stringify(params ?? {})))
}

async function connectorRead(params: unknown, ctx: ApiConnectorSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.connector_read(JSON.stringify(params ?? {})))
}

async function connectorWrite(params: unknown, ctx: ApiConnectorSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.connector_write(JSON.stringify(params ?? {})))
}

// --- Adapter authoring reads (the save and restore are host tools: authoring-tools.ts) ---

async function connectorAdapterGet(params: unknown, ctx: ApiConnectorSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.connector_adapter_get(JSON.stringify(params ?? {})))
}

async function connectorAdapterVersions(
  params: unknown,
  ctx: ApiConnectorSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.connector_adapter_versions(JSON.stringify(params ?? {})))
}

async function connectorAdapterReference(
  params: unknown,
  ctx: ApiConnectorSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.connector_adapter_reference(JSON.stringify(params ?? {})))
}

async function connectorAdapterTest(
  params: unknown,
  ctx: ApiConnectorSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.connector_adapter_test(JSON.stringify(params ?? {})))
}

/** Stage-time check of `connector_write` (no network): refuses before an approval is parked. */
async function connectorWritePreflight(
  params: unknown,
  ctx: ApiConnectorSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.connector_write_validate(JSON.stringify(params ?? {})))
}

// --- Approval summarizer (runs in the sandbox with an empty bridge: pure) ---

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
async function summarizeConnectorWrite(params: unknown): Promise<ConnectorWriteSummary> {
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
