// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison files purge-deleted-message-attachments [--org <uuid>] [--dry-run]`
//
// Deleting a message now deletes its attachments. Messages deleted before that
// left their files behind (rows, objects, still listed and served). This
// removes them: every `kernel:message` file whose message is soft deleted, in
// one org or in every org. Rows are deleted with one kernel.file.delete event
// each; once committed, the server's files-delete-object consumer deletes the
// objects, as for any file deletion. Idempotent: a rerun finds nothing.
// `--dry-run` only counts.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import {
  type PurgeDeletedReport,
  purgeDeletedMessageAttachments,
} from "~/modules/files/message-attachments"

export const FILES_PURGE_USAGE =
  "usage: liaison files purge-deleted-message-attachments [--org <uuid>] [--dry-run]"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ParsedPurgeArgs =
  | { ok: true; orgId: string | null; dryRun: boolean }
  | { ok: false; error: string }

export function parsePurgeArgv(argv: string[]): ParsedPurgeArgs {
  let orgId: string | null = null
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === "--dry-run") {
      dryRun = true
    } else if (flag === "--org") {
      const value = argv[++i]
      if (!value || !UUID.test(value)) {
        return { ok: false, error: `--org requires an org uuid\n${FILES_PURGE_USAGE}` }
      }
      orgId = value
    } else {
      return { ok: false, error: `unknown argument ${flag}\n${FILES_PURGE_USAGE}` }
    }
  }
  return { ok: true, orgId, dryRun }
}

export async function runPurgeDeletedMessageAttachmentsCli(
  argv: string[],
  deps: {
    purge?: typeof purgeDeletedMessageAttachments
    listOrgIds?: () => Promise<string[]>
  } = {},
): Promise<number> {
  const parsed = parsePurgeArgv(argv)
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`)
    return 2
  }
  const purge = deps.purge ?? purgeDeletedMessageAttachments
  const listOrgIds =
    deps.listOrgIds ??
    (async () => {
      const K = drizzleSql.raw(`"${schemaRef("kernel")}"`)
      return withSystemDb("cli:files-purge:list-orgs", async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`SELECT id::text AS id FROM ${K}.organizations ORDER BY id`),
        ).map((r) => r.id),
      )
    })
  const orgIds = parsed.orgId ? [parsed.orgId] : await listOrgIds()
  const reports: PurgeDeletedReport[] = []
  for (const orgId of orgIds) {
    const report = await purge({ orgId, dryRun: parsed.dryRun })
    if (report.files > 0) reports.push(report)
  }
  const total = reports.reduce((n, r) => n + r.files, 0)
  process.stdout.write(
    `${JSON.stringify({ dryRun: parsed.dryRun, files: total, orgs: reports })}\n`,
  )
  return 0
}
