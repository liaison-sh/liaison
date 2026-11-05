// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Read a file already uploaded to the org (`kernel.files`) for a config field
 * that names it by id (`contentFileId`, `logoFileId`). The row is read under
 * the applying person's own RLS context (`files_select`: the file's parent
 * must be visible to them) AND pinned to the context's org, never through a
 * privileged read by id: an id someone pasted cannot reach another person's
 * private upload or another org's file.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisionContext } from "~/cli/provisioners/types"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { getObjectBuffer as defaultGetObjectBuffer } from "~/infra/storage/object-storage"

export interface ActorFile {
  id: string
  filename: string
  mimeType: string
  bytes: Buffer
}

export interface ActorFileDeps {
  getObjectBuffer: (key: string) => Promise<Buffer>
}

const defaultDeps: ActorFileDeps = { getObjectBuffer: defaultGetObjectBuffer }

/** The file's row as the actor sees it (no bytes read): the plan names it. */
export async function statActorFile(
  ctx: ProvisionContext,
  fileId: string,
  what: string,
): Promise<{ id: string; filename: string; sizeBytes: number }> {
  const row = await actorFileRow(ctx, fileId, what)
  return { id: row.id, filename: row.filename, sizeBytes: Number(row.size_bytes) }
}

async function actorFileRow(ctx: ProvisionContext, fileId: string, what: string) {
  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = await ctx.rls((tx) =>
    tx.execute(drizzleSql`
      SELECT id::text AS id, filename, mime_type, size_bytes, storage_key
      FROM ${k}.files
      WHERE id = ${fileId}::uuid AND org_id = ${ctx.orgId}::uuid
      LIMIT 1
    `),
  )
  const row = extractRows<{
    id: string
    filename: string
    mime_type: string
    size_bytes: number | string
    storage_key: string
  }>(rows)[0]
  if (!row) {
    throw new ConfigError(
      `${what}: file '${fileId}' was not found, or you cannot read it (upload it yourself and pass its id)`,
    )
  }
  return row
}

export async function readActorFile(
  ctx: ProvisionContext,
  fileId: string,
  opts: { what: string; maxBytes: number },
  deps: ActorFileDeps = defaultDeps,
): Promise<ActorFile> {
  const row = await actorFileRow(ctx, fileId, opts.what)
  if (Number(row.size_bytes) > opts.maxBytes) {
    throw new ConfigError(
      `${opts.what}: file '${row.filename}' is ${row.size_bytes} bytes, over the ${opts.maxBytes}-byte limit`,
    )
  }
  const bytes = await deps.getObjectBuffer(row.storage_key)
  return { id: row.id, filename: row.filename, mimeType: row.mime_type, bytes }
}
