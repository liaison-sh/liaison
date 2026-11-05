// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * WHAT A SESSION ON THE PERSON'S COMPUTER MAY NOT DO THROUGH MCP.
 *
 * A node session reaches Liaison through the agent-bound MCP connection its
 * job was claimed with (`kernel.node_jobs.mcp_connection_id`). Tools that
 * widen what the computer shares or start more work on it
 * (`notForNodeSessions`) are owner gestures or the in-app agent's: a session
 * running on that computer neither lists nor calls them (review m7).
 */
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { toolRegistry } from "~/modules/apps/app-registries"

const K = () => sql.raw(schemaRef("kernel"))

/** Whether this MCP connection is the one a node job runs with. */
export async function connectionRunsNodeSessions(
  orgId: string,
  connectionId: string | undefined,
): Promise<boolean> {
  if (!connectionId || !/^[0-9a-f-]{36}$/i.test(connectionId)) return false
  const rows = await withPrivilegedDb(orgId, "mcp:node-session-connection", async (tx) =>
    extractRows<{ one: number }>(
      await tx.execute(sql`
        SELECT 1 AS one FROM ${K()}.node_jobs
         WHERE org_id = ${orgId} AND mcp_connection_id = ${connectionId}::uuid
         LIMIT 1`),
    ),
  )
  return rows.length > 0
}

/**
 * What the unfinished node jobs on this connection carry from Liaison (A18):
 * the triggering content's scopes and whatever the owner's agent later sent
 * the session (computer_session_send / _answer merge the sending turn's taint
 * into the job). A session's own writes over this connection are judged as
 * already tainted by them, so what reached the session from a scoped read
 * cannot be posted where a reader lacks that scope. Empty for a connection
 * that runs no job.
 */
export async function nodeJobSourceScopes(
  orgId: string,
  connectionId: string | undefined,
): Promise<string[]> {
  if (!connectionId || !/^[0-9a-f-]{36}$/i.test(connectionId)) return []
  const rows = await withPrivilegedDb(orgId, "mcp:node-job-source-scopes", async (tx) =>
    extractRows<{ scopes: unknown }>(
      await tx.execute(sql`
        SELECT source_required_scopes AS scopes FROM ${K()}.node_jobs
         WHERE org_id = ${orgId} AND mcp_connection_id = ${connectionId}::uuid
           AND status IN ('queued', 'offered', 'running')`),
    ),
  )
  const out = new Set<string>()
  for (const r of rows) {
    if (Array.isArray(r.scopes)) for (const s of r.scopes) if (typeof s === "string") out.add(s)
  }
  return [...out].sort()
}

/** SDK names of this org's tools a node session may not use. */
export function notForNodeSessionSdkNames(orgId: string): Set<string> {
  const names = new Set<string>()
  for (const [key, def] of toolRegistry.entriesOf(orgId)) {
    if (key[0] !== orgId || !def.notForNodeSessions) continue
    names.add(`${key[1]}__${key[2].replace(/[^a-zA-Z0-9_-]/g, "_")}`)
  }
  return names
}

export const NOT_FROM_A_SESSION =
  "not_from_a_session: a session running on the person's computer cannot share folders, clone repositories or start sessions there. Tell the person; they can do it in Liaison (Settings > Computers > their computer > Folders) or ask their agent in the app."
