// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Knowledge source kind `folder`: the text files under one folder of a project
// branch, with their folders. Config `{ ref: "<project>:<branch>:<path>" }`
// (an empty path is the whole branch).
//
// Identities are the ones this connector always used, so a source synced by an
// earlier release keeps its documents and folders in place:
//   - a file is `<project>:<branch>:<file path>`, a folder `<project>:<branch>:<dir path>`;
//   - the configured folder itself is the source's root (no folder of its own);
//   - a document's title is the file name, its revision the blob id.
//
// A pass reads one snapshot: the branch head when it starts. Pages walk the
// recursive tree (keyset, 100 entries a page) and read at most FILES_PER_RUN
// file bodies per run; the cursor says where the walk stands (the tree page
// URL and how many of its entries are done). The final page prunes what the
// pass did not see and keeps `{ head }`: the next pass ends at once when the
// branch has not moved.

import type { KnowledgeSyncInput, KnowledgeSyncResult } from "@liaison/app-sdk"
import {
  encodeId,
  type GitlabCtx,
  GitlabHttpError,
  getJson,
  gitlabGet,
  nextLink,
  readFile,
  redactSecrets,
  WEB_BASE,
} from "./client"

/** File bodies one run reads. */
export const FILES_PER_RUN = 25
/** A document body's ceiling (the platform's page contract). */
const MAX_BODY_CHARS = 1_000_000

const TEXT_EXT: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
}
/** The file's type when the knowledge base keeps it as a document; null: it stays in GitLab. */
export function documentType(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  return TEXT_EXT[ext] ?? null
}

export interface FolderRef {
  project: string
  branch: string
  path: string
}

export function parseFolderRef(ref: unknown): FolderRef {
  if (typeof ref !== "string") throw new Error('GitLab source: config.ref is required ("<project>:<branch>:<path>")')
  const a = ref.indexOf(":")
  const b = ref.indexOf(":", a + 1)
  if (a <= 0 || b <= a + 1) {
    throw new Error(`Invalid GitLab folder "${ref}": expected "<project>:<branch>:<path>"`)
  }
  return {
    project: ref.slice(0, a),
    branch: ref.slice(a + 1, b),
    path: ref.slice(b + 1).replace(/^\/+|\/+$/g, ""),
  }
}

export interface GitlabCursor {
  /** The branch head this pass reads (or the last finished pass read). */
  head: string
  /** Set while a pass is open. */
  pass?: {
    namespace: string
    /** The tree page in progress; null: the first page. */
    page: string | null
    /** Entries of that page already handled. */
    done: number
  }
}

function isCursor(v: unknown): v is GitlabCursor {
  return !!v && typeof v === "object" && typeof (v as GitlabCursor).head === "string"
}

interface TreeEntry {
  id: string
  name: string
  type: "blob" | "tree" | "commit"
  path: string
}

function parentDir(path: string): string {
  const i = path.lastIndexOf("/")
  return i < 0 ? "" : path.slice(0, i)
}

export async function syncGitlabFolder(
  input: KnowledgeSyncInput<GitlabCursor>,
  ctx: GitlabCtx,
): Promise<KnowledgeSyncResult<GitlabCursor>> {
  const ref = parseFolderRef(input.config?.ref)
  const project = encodeId(ref.project)
  const idOf = (path: string) => `${ref.project}:${ref.branch}:${path}`
  const prior = isCursor(input.cursor) ? input.cursor : null

  let cursor: GitlabCursor
  if (prior?.pass) {
    cursor = prior
  } else {
    const branch = await getJson<{ commit: { id: string } }>(
      ctx,
      `/projects/${project}/repository/branches/${encodeURIComponent(ref.branch)}`,
    )
    const head = branch.commit.id
    // Nothing moved since the last full pass: nothing to read.
    if (prior && prior.head === head) return { done: true, nextCursor: prior }
    const info = await getJson<{ path_with_namespace: string }>(ctx, `/projects/${project}`)
    cursor = { head, pass: { namespace: info.path_with_namespace, page: null, done: 0 } }
  }
  const pass = cursor.pass!

  const firstPage =
    `/projects/${project}/repository/tree?ref=${encodeURIComponent(cursor.head)}` +
    `&recursive=true&per_page=100&pagination=keyset` +
    (ref.path ? `&path=${encodeURIComponent(ref.path)}` : "")
  const answer = await gitlabGet(ctx, pass.page ?? firstPage)
  const entries = JSON.parse(answer.body) as TreeEntry[]

  // A folder below the root, with every folder above it up to the root.
  const folders = new Map<string, { externalId: string; name: string; parentExternalId: string | null }>()
  const folderOf = (dir: string): string | undefined => {
    if (dir === ref.path || (ref.path && !dir.startsWith(`${ref.path}/`)) || dir === "") {
      return undefined
    }
    const id = idOf(dir)
    if (!folders.has(id)) {
      const parent = folderOf(parentDir(dir))
      folders.set(id, { externalId: id, name: dir.slice(dir.lastIndexOf("/") + 1), parentExternalId: parent ?? null })
    }
    return id
  }

  const upsert: NonNullable<NonNullable<KnowledgeSyncResult["documents"]>["upsert"]> = []
  let read = 0
  let handled = pass.done
  for (; handled < entries.length; handled++) {
    const entry = entries[handled]!
    if (entry.type === "tree") {
      folderOf(entry.path)
      continue
    }
    if (entry.type !== "blob") continue
    const parent = folderOf(parentDir(entry.path))
    const mimeType = documentType(entry.path)
    if (!mimeType) continue
    if (read >= FILES_PER_RUN) break
    read++
    let file: Awaited<ReturnType<typeof readFile>>
    try {
      file = await readFile(ctx, ref.project, entry.path, cursor.head)
    } catch (err) {
      // Gone since the listing: the prune of this pass archives it.
      if (err instanceof GitlabHttpError && err.status === 404) continue
      throw err
    }
    upsert.push({
      externalId: idOf(entry.path),
      title: entry.name,
      body: redactSecrets(file.text).slice(0, MAX_BODY_CHARS),
      mimeType,
      rev: file.blobId,
      url: `${WEB_BASE}/${pass.namespace}/-/blob/${file.lastCommitId}/${entry.path}`,
      ...(parent ? { folderId: parent } : {}),
    })
  }

  const page = { documents: { upsert }, folders: { upsert: [...folders.values()] } }
  if (handled < entries.length) {
    return { ...page, done: false, nextCursor: { head: cursor.head, pass: { ...pass, done: handled } } }
  }
  const next = nextLink(answer)
  if (next) {
    return { ...page, done: false, nextCursor: { head: cursor.head, pass: { ...pass, page: next, done: 0 } } }
  }
  return { ...page, done: true, prune: true, nextCursor: { head: cursor.head } }
}
