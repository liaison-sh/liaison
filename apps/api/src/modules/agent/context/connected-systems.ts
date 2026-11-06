// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The org's API connections (api-connector adapters) as the agent sees them
 * before it has loaded any connector tool.
 *
 * Without this, an org with a CRM connected looked to the agent like an org
 * without one: the connector tools are deferred, the catalog named them only
 * as `connector_read, connector_write`, and a request such as "add a note to
 * <company>" scored Liaison's own ticket note tool above the connector, so the
 * note landed on a ticket and the agent said it was done. Two surfaces fix it:
 *
 * - `connectedSystemsBlock`: one line per connection in the turn's prompt
 *   (every surface, not only a ticket view), naming the system, its read and
 *   write operations, and that a write needs approval.
 * - `connectorSearchHints`: per connector tool, the keywords (operation names,
 *   the system's name and slug) the tool_search scorer weighs like a tool name,
 *   and a summary that leads the tool's synopsis and catalog line, so "add a
 *   note to a company in the CRM" finds connector_write.
 *
 * Only for a turn whose scopes hold the connector's read scope; writes are
 * named only with the write scope. Every name used is the admin's adapter
 * configuration (schema-checked operation names, the display name normalized by
 * `promptSafeName`), never data read from the upstream system.
 */
import { promptSafeName } from "@liaison/api-connector-core"
import { listAdapterRows } from "~/apps/api-connector/store"
import { rootLogger } from "~/lib/logger"
import { CONNECTOR_APP } from "~/modules/agent/tools/tool-rank"
import { toolRegistry } from "~/modules/apps/app-registries"
import { isAppOffForOrg } from "~/modules/apps/org-apps"
import { hasScope } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "connected-systems" })

export { CONNECTOR_APP }

const READ_SCOPE = "api-connector:read"
const WRITE_SCOPE = "api-connector:write"
export const CONNECTOR_READ_TOOL = "connector_read"
export const CONNECTOR_WRITE_TOOL = "connector_write"
/** Operations a prompt line names before it says "and N more". */
const OPS_LISTED = 6
/** Characters of an operation's description a search synopsis carries. */
const OP_DESCRIPTION_CHARS = 80

export interface ConnectedSystem {
  /** The connection slug (`connection` param of the connector tools). */
  connection: string
  /** The adapter's display name, prompt-safe. */
  system: string
  reads: string[]
  /** Empty when the turn lacks the write scope. */
  writes: { name: string; description: string }[]
}

/**
 * The org's connections this turn may use, or [] (no read scope, the app not
 * installed or Off, no adapter, or the read failed: never throws).
 */
export async function loadConnectedSystems(
  orgId: string,
  turnScopes: readonly string[],
): Promise<ConnectedSystem[]> {
  if (!hasScope(READ_SCOPE, [...turnScopes])) return []
  if (!toolRegistry.get([orgId, CONNECTOR_APP, CONNECTOR_READ_TOOL])) return []
  if (isAppOffForOrg(orgId, CONNECTOR_APP)) return []
  const canWrite = hasScope(WRITE_SCOPE, [...turnScopes])
  try {
    const rows = await listAdapterRows(orgId)
    return rows.map((row) => ({
      connection: row.identifier,
      system: promptSafeName(row.adapter.name),
      reads: row.adapter.operations.filter((o) => o.kind === "read").map((o) => o.name),
      writes: canWrite
        ? row.adapter.operations
            .filter((o) => o.kind === "write")
            .map((o) => ({
              name: o.name,
              description: promptSafeName(o.description ?? "").slice(0, OP_DESCRIPTION_CHARS),
            }))
        : [],
    }))
  } catch (err) {
    log.warn({ err }, "could not list the org's API connections")
    return []
  }
}

function listed(names: string[]): string {
  if (names.length <= OPS_LISTED) return names.join(", ")
  return `${names.slice(0, OPS_LISTED).join(", ")} and ${names.length - OPS_LISTED} more`
}

/** One short line per connection: what is connected, what it reads and writes. */
export function connectedSystemLine(s: ConnectedSystem): string {
  const reads = s.reads.length > 0 ? `reads ${listed(s.reads)}` : "no reads"
  const writes =
    s.writes.length > 0
      ? `; writes ${listed(s.writes.map((w) => w.name))} (connector_write, approval required)`
      : ""
  return `- ${s.system} (connection "${s.connection}") is connected: ${reads}${writes}.`
}

/**
 * The prompt block naming the org's connected systems, or null when there is
 * none. A change asked for "in <system>" or on one of its records (a company,
 * a contact, a deal) goes there, not to a Liaison ticket or contact.
 */
export function connectedSystemsBlock(systems: readonly ConnectedSystem[]): string | null {
  if (systems.length === 0) return null
  return [
    "## Connected business systems",
    "The org's own systems, reached with the api-connector tools (connector_read; connector_write for a change). A note or change for one of their records (a company, contact, deal or order) is a connector_write there, never a Liaison ticket note or contact edit.",
    ...systems.map(connectedSystemLine),
  ].join("\n")
}

export interface ToolSearchHint {
  /** Matched by tool_search at name weight. */
  keywords: string[]
  /** Leads the tool's synopsis, so the search result names the operations. */
  summary: string
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
}

/**
 * Search hints for the connector tools, keyed by tool name. connector_write
 * gets one only when some connection has a write operation the turn may run.
 */
export function connectorSearchHints(
  systems: readonly ConnectedSystem[],
): Map<string, ToolSearchHint> {
  const hints = new Map<string, ToolSearchHint>()
  const withReads = systems.filter((s) => s.reads.length > 0)
  if (withReads.length > 0) {
    hints.set(CONNECTOR_READ_TOOL, {
      keywords: [
        ...new Set(
          withReads.flatMap((s) => [...words(s.system), s.connection, ...s.reads.flatMap(words)]),
        ),
      ],
      summary: `Reads ${withReads.map((s) => `${s.system} ("${s.connection}"): ${listed(s.reads)}`).join("; ")}.`,
    })
  }
  const withWrites = systems.filter((s) => s.writes.length > 0)
  if (withWrites.length > 0) {
    hints.set(CONNECTOR_WRITE_TOOL, {
      keywords: [
        ...new Set([
          "update",
          "change",
          "write",
          ...withWrites.flatMap((s) => [
            ...words(s.system),
            s.connection,
            ...s.writes.flatMap((w) => words(w.name)),
          ]),
        ]),
      ],
      summary: `Writes to ${withWrites
        .map(
          (s) =>
            `${s.system} ("${s.connection}"): ${s.writes
              .map((w) => (w.description ? `${w.name} (${w.description})` : w.name))
              .join(", ")}`,
        )
        .join("; ")}. Approval required.`,
    })
  }
  return hints
}

/**
 * The api-connector line of the deferred-tool catalog: which systems its
 * connector_write reaches, with their write operations. Null without writes.
 */
export function connectorCatalogNote(systems: readonly ConnectedSystem[]): string | null {
  const withWrites = systems.filter((s) => s.writes.length > 0)
  if (withWrites.length === 0) return null
  return `connector_write writes to ${withWrites
    .map((s) => `${s.system}: ${listed(s.writes.map((w) => w.name))}`)
    .join("; ")}`
}
