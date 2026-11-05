// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison org export <org> [--wait] [--timeout <seconds>]`
//
// The operator's whole-org export (the same archive an org admin requests in
// Settings → Organization). The CLI never hosts jobs: it writes the queued
// row and hands the `org-export` job to the server's worker, then, with
// --wait, follows the row until it is completed or failed. The archive lands
// in object storage at `orgs/<org>/exports/<id>.zip` and expires after 7 days.
// STDOUT carries one JSON report.

import { eq } from "drizzle-orm"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { enqueueOrgExport, type OrgExportJobPayload } from "~/modules/export/org-archive/job"
import {
  createOrgExport,
  failOrgExport,
  getOrgExport,
  OrgExportRunningError,
} from "~/modules/export/org-archive/store"

export const ORG_EXPORT_USAGE =
  "usage: liaison org export <org slug or id> [--wait] [--timeout <seconds>]"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface OrgExportCliDeps {
  /** Hand the job to the server (default: the server's queue). */
  enqueue?: (payload: OrgExportJobPayload) => Promise<unknown>
  pollMs?: number
}

export interface OrgExportCliResult {
  exitCode: number
  report: Record<string, unknown> | null
  message?: string
}

async function resolveExportOrgId(ref: string): Promise<string | null> {
  if (UUID.test(ref)) {
    const [row] = await withSystemDb("cli-org-export-org", (tx) =>
      tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, ref)),
    )
    return row?.id ?? null
  }
  const r = await resolveOrgId(ref, "")
  return r.ok ? r.orgId : null
}

export async function runOrgExportCli(
  argv: string[],
  deps: OrgExportCliDeps = {},
): Promise<OrgExportCliResult> {
  const wait = argv.includes("--wait")
  let timeoutSec = 3600
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === "--wait") continue
    if (a === "--timeout") {
      const n = Number(argv[++i])
      if (!Number.isFinite(n) || n <= 0) {
        return { exitCode: 2, report: null, message: ORG_EXPORT_USAGE }
      }
      timeoutSec = n
      continue
    }
    if (a.startsWith("--")) return { exitCode: 2, report: null, message: ORG_EXPORT_USAGE }
    positional.push(a)
  }
  const ref = positional[0]
  if (!ref || positional.length > 1) {
    return { exitCode: 2, report: null, message: ORG_EXPORT_USAGE }
  }
  const orgId = await resolveExportOrgId(ref)
  if (!orgId) return { exitCode: 2, report: null, message: `org '${ref}' not found` }

  let exportId: string
  try {
    exportId = (await createOrgExport(orgId, { userId: null, via: "cli" })).id
  } catch (err) {
    if (err instanceof OrgExportRunningError) {
      return {
        exitCode: 1,
        report: { orgId, status: "refused", runningId: err.runningId },
        message: `${err.message} (${err.runningId})`,
      }
    }
    throw err
  }
  const enqueue = deps.enqueue ?? ((p) => enqueueOrgExport(p, { forServer: true }))
  try {
    await enqueue({ orgId, exportId })
  } catch (err) {
    // Left queued, the row would refuse every later export of the org.
    const detail = err instanceof Error ? err.message : String(err)
    await failOrgExport(orgId, exportId, { code: "QUEUE_FAILED", detail })
    return {
      exitCode: 1,
      report: { orgId, exportId, status: "failed", error: "QUEUE_FAILED" },
      message: `the export could not be queued: ${detail}`,
    }
  }
  if (!wait) return { exitCode: 0, report: { orgId, exportId, status: "queued" } }

  const deadline = Date.now() + timeoutSec * 1000
  const pollMs = deps.pollMs ?? 2000
  for (;;) {
    const row = await getOrgExport(orgId, exportId)
    if (row?.status === "completed") {
      const manifest = (row.manifest ?? {}) as { tables?: unknown[]; files?: { count?: number } }
      return {
        exitCode: 0,
        report: {
          orgId,
          exportId,
          status: "completed",
          objectKey: row.objectKey,
          bytes: row.bytes,
          tables: manifest.tables?.length ?? 0,
          files: manifest.files?.count ?? 0,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        },
      }
    }
    if (!row || row.status === "failed" || row.status === "expired") {
      return {
        exitCode: 1,
        report: { orgId, exportId, status: row?.status ?? "missing", error: row?.error ?? null },
        message: row?.error ?? "the export failed",
      }
    }
    if (Date.now() > deadline) {
      return {
        exitCode: 1,
        report: { orgId, exportId, status: row.status },
        message: `still ${row.status} after ${timeoutSec} s; it keeps running on the server`,
      }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}
