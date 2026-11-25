// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The files a page's text names, made the page's own on every save (edge 8, K-R17).
 *
 * A file token holds a file id and nothing else (`![](liaison-file:<id>)`). When a
 * writer saves a text naming a file of another page (pasted from that page's editor or
 * reader, typed, or written by an agent), the file is copied onto this page and the
 * stored text names the copy, so this page's readers can read it, and it outlives the
 * other page. The copy is made under the writer's row security: a file the writer
 * cannot read is never copied, and its token is kept byte for byte (a reader then sees
 * "Image not available"). Only a file of another Knowledge page, or an upload not yet
 * placed anywhere, is copied: a mail or ticket attachment, a template's file or a sealed
 * (encrypted) file keeps its token and is reported `not_allowed`, so a page never turns
 * a file meant for a narrower audience into one its readers can open. A copy refused for
 * room or storage leaves the token as it was and is reported; the next save tries again.
 * One mechanism for people and agents, create and update; nothing else in the text is
 * touched.
 */
import { fileIdsOf, replaceFileIds } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { kernelRel } from "~/apps/knowledge/schema-refs"
import type { KnowledgeActor } from "~/apps/knowledge/service"
import { extractRows, type RlsClient } from "~/db"
import { privilegedFrom } from "~/db/privileged"
import type { copyObject } from "~/infra/storage/object-storage"
import { knowledgeLogger as log } from "~/lib/logger"
import { attachFileToParent } from "~/modules/files/attach"
import { FileServiceError } from "~/modules/files/service"

/** Copies one save makes at most; the rest are reported and made by the next saves. */
export const MAX_FILE_COPIES_PER_SAVE = 50

/**
 * Why a named file was left as it was:
 * - `unavailable`: no such file for this writer (gone, or one they cannot read);
 * - `quota`: the organization's storage is full;
 * - `not_allowed`: the file is not a Knowledge page's file or a fresh upload, it is sealed,
 *   its type is never attached, or the writer may not add files here;
 * - `storage`: the storage did not answer;
 * - `too_many`: over the copies one save makes.
 */
export type NotCopiedReason = "unavailable" | "quota" | "not_allowed" | "storage" | "too_many"

export interface FileAdoption {
  /** Each copied file id (as the text named it) and the id of this page's copy. */
  fileIdMap: Record<string, string>
  notCopied: Array<{ id: string; reason: NotCopiedReason }>
}

let copyOverride: typeof copyObject | null = null

/** Test seam: the storage copy (tests run without object storage). */
export const KnowledgeFileAdoptionTestAccess = {
  setCopyObject(fn: ((args: { sourceKey: string; destKey: string }) => Promise<void>) | null) {
    copyOverride = fn as typeof copyObject | null
  },
}

function reasonOf(err: unknown): NotCopiedReason {
  if (!(err instanceof FileServiceError)) return "storage"
  switch (err.code) {
    case "STORAGE_QUOTA_EXCEEDED":
      return "quota"
    case "PARENT_NOT_FOUND":
      return "unavailable"
    case "UNSAFE_FILE_TYPE":
    case "FORBIDDEN":
      return "not_allowed"
    default:
      return "storage"
  }
}

/**
 * A file a page may take a copy of: another Knowledge page's file, or an upload still
 * in its upload session (pasted into the editor before the page took it), never sealed.
 */
function adoptable(file: { app: string; entity_type: string; enc_version: number }): boolean {
  if (Number(file.enc_version ?? 0) !== 0) return false
  if (file.app === "knowledge" && file.entity_type === "document") return true
  return file.app === "kernel" && file.entity_type === "file_upload_session"
}

/**
 * The text with every file of another page that the writer can read replaced by this
 * page's copy of it, and what was copied or left. `tx` is the writer's RLS transaction;
 * the page `docId` must already exist in it (a create calls this after its insert).
 */
export async function adoptForeignFiles(
  tx: RlsClient,
  docId: string,
  body: string,
  actor: KnowledgeActor,
): Promise<{ body: string } & FileAdoption> {
  const named = fileIdsOf(body)
  const adoption: FileAdoption = { fileIdMap: {}, notCopied: [] }
  if (named.length === 0) return { body, ...adoption }

  // Where each named file lives, as the writer sees it (files_select applies).
  const rows = extractRows<{
    id: string
    app: string
    entity_type: string
    entity_id: string
    enc_version: number
  }>(
    await tx.execute(sql`
      SELECT id::text AS id, app, entity_type, entity_id, enc_version
        FROM ${kernelRel("files")}
       WHERE org_id = ${actor.orgId}::uuid
         AND id = ANY(${`{${named.join(",")}}`}::uuid[])`),
  )
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), r]))
  const target = { app: "knowledge", entityType: "document", entityId: docId }
  let copied = 0
  for (const id of named) {
    const file = byId.get(id.toLowerCase())
    if (!file) {
      adoption.notCopied.push({ id, reason: "unavailable" })
      continue
    }
    const own =
      file.app === "knowledge" &&
      file.entity_type === "document" &&
      file.entity_id.toLowerCase() === docId.toLowerCase()
    if (own) continue
    if (!adoptable(file)) {
      adoption.notCopied.push({ id, reason: "not_allowed" })
      continue
    }
    if (copied >= MAX_FILE_COPIES_PER_SAVE) {
      adoption.notCopied.push({ id, reason: "too_many" })
      continue
    }
    copied++
    try {
      const copy = await attachFileToParent(
        { sourceFileId: file.id, target },
        {
          rlsTx: tx,
          // In the writer's transaction when its login can (a create that rolls back
          // then takes its copies with it), else on the privileged pool.
          privileged: (reason, fn) => privilegedFrom(tx, actor.orgId, reason, fn),
          orgId: actor.orgId,
          userId: actor.userId,
          actorType: actor.author?.type === "agent" ? "agent" : "user",
          scopes: actor.scopes,
          ...(copyOverride ? { copyObject: copyOverride } : {}),
        },
      )
      adoption.fileIdMap[id] = copy.id
    } catch (err) {
      const reason = reasonOf(err)
      if (reason === "storage") {
        log.error({ err, orgId: actor.orgId, docId, fileId: id }, "knowledge: a file copy failed")
      }
      adoption.notCopied.push({ id, reason })
    }
  }
  return { body: replaceFileIds(body, adoption.fileIdMap), ...adoption }
}

/** The answer's extra fields: present only when the save named another page's file. */
export function adoptionFields(adoption: FileAdoption): Partial<FileAdoption> {
  const copiedAny = Object.keys(adoption.fileIdMap).length > 0
  if (!copiedAny && adoption.notCopied.length === 0) return {}
  return { fileIdMap: adoption.fileIdMap, notCopied: adoption.notCopied }
}
