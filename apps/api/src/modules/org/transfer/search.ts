// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org's search documents on a move: copied with their vectors, so nothing
// is embedded again (that costs money), and written on the target through the
// index writer (`sendIndexWrite`) like every other write.
//
// The vectors are only usable when both indexes declare the same embedder
// (name, source, dimensions): the import compares the signatures before
// anything is written. A rebuild running on the target meanwhile rebuilds from
// the database, which already holds the org's rows, so the copy needs no
// replay entry. An aborted import's documents go with the org's purge (delete
// by the org filter).
import { createHash } from "node:crypto"
import { effectiveIndexName, ensureMeiliVectorStore, getMeili } from "~/infra/search/client"
import { orgSearchFilter } from "~/modules/org/purge/external"
import { writeIndexAndWait } from "~/modules/search/index-writer"
import { waitForMeiliTask } from "~/modules/search/meili-task"
import { MEMORY_EMBEDDER_NAME } from "~/modules/search/vector-opt-out"

const PAGE = 1000

/** The live index's embedder for memory vectors, as one comparable string. */
export async function embedderSignature(): Promise<string> {
  const settings = (await getMeili().index(effectiveIndexName()).getSettings()) as {
    embedders?: Record<string, { source?: string; dimensions?: number }> | null
  }
  const e = settings.embedders?.[MEMORY_EMBEDDER_NAME]
  return e ? `${MEMORY_EMBEDDER_NAME}:${e.source ?? ""}:${e.dimensions ?? ""}` : "none"
}

/** The vector width of a `memory:userProvided:<n>` signature, else null (another embedder kind). */
export function userProvidedDimensions(signature: string): number | null {
  const m = new RegExp(`^${MEMORY_EMBEDDER_NAME}:userProvided:(\\d+)$`).exec(signature)
  const n = m ? Number(m[1]) : Number.NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Whether this index can take vectors of `signature`: the same embedder, or none declared yet. A
 * fresh index (a new cell, no org embedded anything yet) declares the embedder on its first vector
 * write; that is not a skew, so a move to a fresh cell is not refused. A source that
 * declares none carries no vector (every document's `_vectors.memory` is null): any index takes
 * its documents, keyword only, and the embedding backfill embeds them there as it does any
 * document written without a vector.
 */
export async function embedderAdoptable(signature: string): Promise<"same" | "adopt" | "skew"> {
  if (signature === "none") return "same"
  const ours = await embedderSignature()
  if (ours === signature) return "same"
  return ours === "none" && userProvidedDimensions(signature) !== null ? "adopt" : "skew"
}

/**
 * Declares the source's embedder on this index, then checks it took. Only over an index that
 * still declares none: an embedder another org declared since the check is never overwritten (its
 * vectors would stop being usable), and a declaration Meili refuses fails the import instead of
 * asking for an index rebuild in the middle of a move.
 */
export async function adoptEmbedder(signature: string): Promise<void> {
  const dims = userProvidedDimensions(signature)
  if (dims === null) throw new Error(`org transfer: embedder ${signature} cannot be declared here`)
  const before = await embedderSignature()
  if (before === signature) return
  if (before !== "none") {
    throw new Error(
      `org transfer: the index declares ${before} now; ${signature} is not adopted over it`,
    )
  }
  await ensureMeiliVectorStore().catch(() => {})
  const meili = getMeili()
  const index = meili.index(effectiveIndexName())
  const settings = (await index.getSettings()) as { embedders?: Record<string, unknown> | null }
  if (settings.embedders?.[MEMORY_EMBEDDER_NAME]) {
    throw new Error("org transfer: an embedder was declared here meanwhile; not adopted over it")
  }
  const task = await index.updateEmbedders({
    ...(settings.embedders ?? {}),
    [MEMORY_EMBEDDER_NAME]: { source: "userProvided", dimensions: dims },
  } as never)
  await waitForMeiliTask(meili, (task as { taskUid?: number }).taskUid)
  const now = await embedderSignature()
  if (now !== signature)
    throw new Error(`org transfer: the index declares ${now} after adopting ${signature}`)
}

/** Meili returns `{ embeddings: [[...]], regenerate }`; the writer takes the vector itself. */
function plainVectors(doc: Record<string, unknown>): Record<string, unknown> {
  const vectors = doc._vectors as Record<string, unknown> | undefined
  const memory = vectors?.[MEMORY_EMBEDDER_NAME] as
    | { embeddings?: unknown }
    | unknown[]
    | null
    | undefined
  let vector: unknown = null
  if (Array.isArray(memory)) vector = memory
  else if (memory && typeof memory === "object" && Array.isArray(memory.embeddings)) {
    const first = memory.embeddings[0]
    vector = Array.isArray(first) ? first : memory.embeddings.length > 0 ? memory.embeddings : null
  }
  return { ...doc, _vectors: { ...(vectors ?? {}), [MEMORY_EMBEDDER_NAME]: vector } }
}

/** Every search document of the org, vectors included, as bundle lines (sorted by id). */
export async function exportSearchDocuments(orgId: string): Promise<string[]> {
  const index = getMeili().index(effectiveIndexName())
  const out: Array<{ id: string; line: string }> = []
  for (let offset = 0; ; offset += PAGE) {
    const page = (await index.getDocuments({
      filter: orgSearchFilter(orgId),
      retrieveVectors: true,
      limit: PAGE,
      offset,
    })) as { results: Record<string, unknown>[] }
    for (const doc of page.results) {
      out.push({ id: String(doc.id), line: JSON.stringify(plainVectors(doc)) })
    }
    if (page.results.length < PAGE) break
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((d) => d.line)
}

/**
 * Refuse a document whose id another org already holds on this index: Meili
 * adds by id, so writing it would overwrite that org's document.
 */
export async function assertNoForeignDocuments(
  orgId: string,
  docs: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  const index = getMeili().index(effectiveIndexName())
  const ids = docs.map((d) => String(d.id))
  // The index declares no filterable id and this Meilisearch has no bulk get
  // by ids: one read per id, 16 at a time.
  for (let i = 0; i < ids.length; i += FOREIGN_CHECK_PARALLEL) {
    await Promise.all(
      ids.slice(i, i + FOREIGN_CHECK_PARALLEL).map(async (id) => {
        let held: { org_id?: unknown }
        try {
          held = (await index.getDocument(id, { fields: ["id", "org_id"] })) as {
            org_id?: unknown
          }
        } catch (err) {
          if ((err as { cause?: { code?: string } })?.cause?.code === "document_not_found") return
          if ((err as { code?: string })?.code === "document_not_found") return
          throw err
        }
        if (held.org_id !== orgId) {
          throw new Error(
            `org transfer: search document ${id} belongs to another org on this instance`,
          )
        }
      }),
    )
  }
}

const FOREIGN_CHECK_PARALLEL = 16

/** Replace the org's documents on this index with the bundle's (waits for Meili). */
export async function importSearchDocuments(
  orgId: string,
  lines: readonly string[],
): Promise<number> {
  const docs = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
  for (const d of docs) {
    if (d.org_id !== orgId)
      throw new Error("org transfer: a search document of another org in the bundle")
  }
  await assertNoForeignDocuments(orgId, docs)
  await writeIndexAndWait({ deleteFilters: [orgSearchFilter(orgId)], docs })
  return docs.length
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    )
  }
  return v
}

/** A document's content hash (vectors left out: they follow the content). */
export function searchDocHash(doc: Record<string, unknown>): string {
  const { _vectors: _v, ...rest } = doc
  return createHash("sha256")
    .update(JSON.stringify(canonical(rest)))
    .digest("hex")
}

/** `id -> content hash` of every document of the org on this index. */
export async function searchDocHashes(orgId: string): Promise<Record<string, string>> {
  const index = getMeili().index(effectiveIndexName())
  const out: Record<string, string> = {}
  for (let offset = 0; ; offset += PAGE) {
    const page = (await index.getDocuments({
      filter: orgSearchFilter(orgId),
      limit: PAGE,
      offset,
    })) as { results: Record<string, unknown>[] }
    for (const doc of page.results) out[String(doc.id)] = searchDocHash(doc)
    if (page.results.length < PAGE) break
  }
  return out
}

/**
 * The catch-up after a commit: what the target must write so its
 * documents of the org equal the source's, from the source's documents (bundle
 * lines) and the target's hashes. Ids only on the target are deleted.
 */
export function searchCatchUp(
  sourceLines: readonly string[],
  targetHashes: Record<string, string>,
): { docs: string[]; deleteIds: string[] } {
  const docs: string[] = []
  const seen = new Set<string>()
  for (const line of sourceLines) {
    const doc = JSON.parse(line) as Record<string, unknown>
    const id = String(doc.id)
    seen.add(id)
    if (targetHashes[id] !== searchDocHash(doc)) docs.push(line)
  }
  return { docs, deleteIds: Object.keys(targetHashes).filter((id) => !seen.has(id)) }
}

/** Write the catch-up's documents and deletes of the org here (waits for Meili). */
export async function applySearchCatchUp(
  orgId: string,
  write: { docs: readonly string[]; deleteIds: readonly string[] },
): Promise<number> {
  const docs = write.docs.map((l) => JSON.parse(l) as Record<string, unknown>)
  for (const d of docs) {
    if (d.org_id !== orgId) throw new Error("org transfer: a search document of another org")
  }
  if (docs.length === 0 && write.deleteIds.length === 0) return 0
  await assertNoForeignDocuments(orgId, docs)
  const own = await searchDocHashes(orgId)
  // Only ids of this org's documents are ever deleted.
  const deleteIds = write.deleteIds.filter((id) => id in own)
  await writeIndexAndWait({ docs, deleteIds })
  return docs.length + deleteIds.length
}
