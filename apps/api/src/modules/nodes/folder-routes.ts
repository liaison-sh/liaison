// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A node's folders from any client (folder-requests.ts).
 *
 * Owner, under /api/nodes (session only: a node credential is refused, and the
 * REST auth refuses MCP connection tokens, so no agent reaches these; a
 * restricted device session may read the list, nothing else):
 *   GET  /:id/folders                         the shared roots and search roots
 *   POST /:id/folders/lookup        {query}   folders named like it inside the
 *                                             search roots, each with an id
 *   POST /:id/folders/share         {candidateId}  share a folder a lookup found
 *   POST /:id/folders/unshare       {path}    stop sharing one (missing ones too)
 *   POST /:id/folders/search-roots  {path}    add a search root (`~` allowed)
 *   POST /:id/folders/search-roots/remove {path}
 *   POST /:id/folders/clone         {url, name?}  clone a repository onto the node
 *                                   with ITS git login, into <node root>/repos/<name>,
 *                                   then share it: 200 (done) or 202 {requestId}
 *   GET  /:id/folders/requests/:requestId  202 {state: cloning} | 200 | 422 {code}
 *   POST /:id/folders/scan                    every git repository in the search
 *                                   roots: {searchRoots, partial, denied, skippedProtected,
 *                                   candidates: [{candidateId | null, name, display,
 *                                   shared, shareable, refusal}]}
 *   POST /:id/folders/share-many    {candidateIds}  share up to 100 a scan found, in
 *                                   one write: the list plus {refused: [{candidateId, code}]}
 *   POST /:id/folders/remotes                 the repositories the computer's signed-in
 *                                   gh and glab list: {repos: [{source, fullName, host,
 *                                   cloneUrl, private, pushedAt, local: {display, shared,
 *                                   candidateId | null} | null}], sources, dropped}
 * Each answers the node's answer (200), its refusal code (422), `node_offline`
 * (409) or `timeout` (504); `not_found` (404) for a node that is not yours.
 *
 * Node, under /api/node/folder-requests (session + node credential, its own
 * requests only):
 *   GET /:id    {op, claim} | 404 (claimed by exactly one pull)
 *   PUT /:id    {claim, ok, data} | {claim, ok: false, code}  -> 204 | 404
 */
import type { NodeFolderOp, NodeFolderResult } from "@liaison/shared"
import {
  NODE_SHARE_MANY_MAX,
  nodeCloneNameOk,
  nodeCloneUrlOk,
  nodeFolderQueryOk,
  parseNodeFolderList,
  parseNodeFolderShareMany,
} from "@liaison/shared"
import { and, eq, isNull } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { nodes } from "~/db/schema/kernel"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import { NODE_CREDENTIAL_HEADER, requireNodeCredential } from "./credentials"
import {
  answerFolderRequest,
  askNodeFolders,
  type FolderAsk,
  lookupOnNode,
  pullFolderRequest,
  readCandidate,
  readFolderRequestForOwner,
  remotesOnNode,
  scanOnNode,
} from "./folder-requests"
import { answerImportRequest, pullImportRequest } from "./import-requests"

const err = (code: string, message: string) => ({ error: { code, message } })
const idParam = z.object({ id: z.string().uuid() })
const pathBody = z.object({ path: z.string().trim().min(1).max(4096) }).strict()
const queryBody = z
  .object({ query: z.string().trim().min(1).max(100).refine(nodeFolderQueryOk, "a folder name") })
  .strict()
const shareBody = z.object({ candidateId: z.string().uuid() }).strict()
const cloneBody = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine(nodeCloneUrlOk, "an https, ssh or user@host:path URL"),
    name: z.string().trim().max(100).refine(nodeCloneNameOk, "a plain folder name").optional(),
  })
  .strict()
/** How long the clone route waits before answering 202 (the owner then follows the request). */
const CLONE_WAIT_MS = 8_000
const shareManyBody = z
  .object({ candidateIds: z.array(z.string().uuid()).min(1).max(NODE_SHARE_MANY_MAX) })
  .strict()

// ── owner ───────────────────────────────────────────────────────────────────

export const nodeFolderRoutes = new Hono<AppEnv>()

nodeFolderRoutes.use("/:id/folders/*", refuseNodeCredential)
nodeFolderRoutes.use("/:id/folders", refuseNodeCredential)

async function refuseNodeCredential(c: Context<AppEnv>, next: () => Promise<void>) {
  if (c.req.header(NODE_CREDENTIAL_HEADER) !== undefined) {
    return c.json(err("node_credential_refused", "A node's folders are changed in the app."), 403)
  }
  await next()
}

/** The caller's own live node, or null. */
async function ownNode(c: Context<AppEnv>, id: string): Promise<{ id: string } | null> {
  const [row] = await withRequestRls(c, (tx) =>
    tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.id, id),
          eq(nodes.orgId, c.get("orgId")),
          eq(nodes.ownerUserId, c.get("userId")),
          isNull(nodes.revokedAt),
        ),
      )
      .limit(1),
  )
  return row ?? null
}

/** The node's answer as a response: data, its refusal code, offline or timeout. */
function answer(c: Context<AppEnv>, asked: FolderAsk, read: (data: unknown) => unknown) {
  if (asked.status === "offline") {
    return c.json(err("node_offline", "That computer is offline."), 409)
  }
  if (asked.status === "timeout") {
    return c.json(err("timeout", "That computer did not answer in time."), 504)
  }
  if (!asked.result.ok) {
    return c.json(err(asked.result.code, "That computer refused the change."), 422)
  }
  return success(c, read(asked.result.data))
}

async function ask(c: Context<AppEnv>, op: NodeFolderOp) {
  const id = c.req.param("id") as string
  if (!(await ownNode(c, id))) return c.json(err("not_found", "No such node."), 404)
  const asked = await askNodeFolders({
    orgId: c.get("orgId"),
    ownerUserId: c.get("userId"),
    nodeId: id,
    op,
  })
  return answer(c, asked, parseNodeFolderList)
}

nodeFolderRoutes.get("/:id/folders", zValidator("param", idParam), (c) => ask(c, { kind: "list" }))

nodeFolderRoutes.post(
  "/:id/folders/lookup",
  zValidator("param", idParam),
  zValidator("json", queryBody),
  async (c) => {
    assertUnrestrictedSession(c, "search the folders of your computer")
    const id = c.req.valid("param").id
    if (!(await ownNode(c, id))) return c.json(err("not_found", "No such node."), 404)
    const found = await lookupOnNode({
      orgId: c.get("orgId"),
      ownerUserId: c.get("userId"),
      nodeId: id,
      query: c.req.valid("json").query,
    })
    if (found.status !== "done") {
      if (found.status === "offline") {
        return c.json(err("node_offline", "That computer is offline."), 409)
      }
      if (found.status === "timeout") {
        return c.json(err("timeout", "That computer did not answer in time."), 504)
      }
      return c.json(err("failed", "That computer could not search."), 422)
    }
    return success(c, {
      searchRoots: found.lookup.searchRoots,
      candidates: found.candidates,
      partial: found.lookup.partial === true,
      denied: found.lookup.denied ?? [],
      skippedProtected: found.lookup.skippedProtected === true,
    })
  },
)

nodeFolderRoutes.post(
  "/:id/folders/share",
  zValidator("param", idParam),
  zValidator("json", shareBody),
  async (c) => {
    assertUnrestrictedSession(c, "share a folder of your computer")
    const id = c.req.valid("param").id
    const candidate = await readCandidate(c.req.valid("json").candidateId, {
      orgId: c.get("orgId"),
      ownerUserId: c.get("userId"),
      nodeId: id,
    })
    if (!candidate) {
      return c.json(err("candidate_unknown", "Search for the folder again, then share it."), 404)
    }
    return ask(c, { kind: "share", token: candidate.token })
  },
)

nodeFolderRoutes.post(
  "/:id/folders/unshare",
  zValidator("param", idParam),
  zValidator("json", pathBody),
  (c) => {
    assertUnrestrictedSession(c, "stop sharing a folder of your computer")
    return ask(c, { kind: "unshare", path: c.req.valid("json").path })
  },
)

nodeFolderRoutes.post(
  "/:id/folders/search-roots",
  zValidator("param", idParam),
  zValidator("json", pathBody),
  (c) => {
    assertUnrestrictedSession(c, "let Liaison search a folder of your computer")
    return ask(c, { kind: "addSearchRoot", path: c.req.valid("json").path })
  },
)

nodeFolderRoutes.post(
  "/:id/folders/search-roots/remove",
  zValidator("param", idParam),
  zValidator("json", pathBody),
  (c) => {
    assertUnrestrictedSession(c, "change where Liaison searches your computer")
    return ask(c, { kind: "removeSearchRoot", path: c.req.valid("json").path })
  },
)

nodeFolderRoutes.post(
  "/:id/folders/clone",
  zValidator("param", idParam),
  zValidator("json", cloneBody),
  async (c) => {
    assertUnrestrictedSession(c, "clone a repository onto your computer")
    const id = c.req.valid("param").id
    if (!(await ownNode(c, id))) return c.json(err("not_found", "No such node."), 404)
    const { url, name } = c.req.valid("json")
    const asked = await askNodeFolders({
      orgId: c.get("orgId"),
      ownerUserId: c.get("userId"),
      nodeId: id,
      op: { kind: "clone", url, ...(name ? { name } : {}) },
      waitMs: CLONE_WAIT_MS,
    })
    if (asked.status === "timeout") {
      return success(c, { state: "cloning", requestId: asked.requestId }, undefined, 202)
    }
    return answer(c, asked, parseNodeFolderList)
  },
)

nodeFolderRoutes.get(
  "/:id/folders/requests/:requestId",
  zValidator("param", z.object({ id: z.string().uuid(), requestId: z.string().uuid() })),
  async (c) => {
    const { id, requestId } = c.req.valid("param")
    const row = await readFolderRequestForOwner(requestId, {
      orgId: c.get("orgId"),
      ownerUserId: c.get("userId"),
      nodeId: id,
    })
    if (!row) return c.json(err("not_found", "No such request."), 404)
    if (row.state === "pending") return success(c, { state: "cloning" }, undefined, 202)
    return answer(c, { status: "done", result: row.result }, parseNodeFolderList)
  },
)

type Owner = { orgId: string; ownerUserId: string; nodeId: string }

/** The caller as the owner of the node in the path, or null when it is not theirs. */
async function ownerOf(c: Context<AppEnv>): Promise<Owner | null> {
  const id = c.req.param("id") as string
  if (!(await ownNode(c, id))) return null
  return { orgId: c.get("orgId"), ownerUserId: c.get("userId"), nodeId: id }
}

/** Asks the caller's own node, or answers not found; the refusals as `answer` says them. */
async function askOwn(
  c: Context<AppEnv>,
  op: NodeFolderOp,
): Promise<Response | { data: unknown; owner: Owner }> {
  const owner = await ownerOf(c)
  if (!owner) return c.json(err("not_found", "No such node."), 404)
  const asked = await askNodeFolders({ ...owner, op })
  if (asked.status !== "done" || !asked.result.ok) return answer(c, asked, (d) => d)
  return { data: asked.result.data, owner }
}

nodeFolderRoutes.post("/:id/folders/scan", zValidator("param", idParam), async (c) => {
  assertUnrestrictedSession(c, "search the folders of your computer")
  const owner = await ownerOf(c)
  if (!owner) return c.json(err("not_found", "No such node."), 404)
  // Each shareable repository gets an id to share it by; the token and the path stay here.
  const scanned = await scanOnNode(owner)
  return scanned.ok ? success(c, scanned.view) : answer(c, scanned.asked, (d) => d)
})

nodeFolderRoutes.post(
  "/:id/folders/share-many",
  zValidator("param", idParam),
  zValidator("json", shareManyBody),
  async (c) => {
    assertUnrestrictedSession(c, "share folders of your computer")
    const id = c.req.valid("param").id
    if (!(await ownNode(c, id))) return c.json(err("not_found", "No such node."), 404)
    const owner = { orgId: c.get("orgId"), ownerUserId: c.get("userId"), nodeId: id }
    const byToken = new Map<string, string[]>()
    const unknown: string[] = []
    for (const candidateId of new Set(c.req.valid("json").candidateIds)) {
      const candidate = await readCandidate(candidateId, owner)
      if (!candidate) {
        unknown.push(candidateId)
        continue
      }
      byToken.set(candidate.token, [...(byToken.get(candidate.token) ?? []), candidateId])
    }
    if (byToken.size === 0) {
      return c.json(err("candidate_unknown", "Search for the folders again, then share them."), 404)
    }
    const asked = await askOwn(c, { kind: "shareMany", tokens: [...byToken.keys()] })
    if (asked instanceof Response) return asked
    const { refused, ...list } = parseNodeFolderShareMany(asked.data)
    return success(c, {
      ...list,
      refused: [
        ...unknown.map((candidateId) => ({ candidateId, code: "not_found" })),
        // Back to the ids the owner named; a token the server never handed out is dropped.
        ...refused.flatMap((r) =>
          (byToken.get(r.token) ?? []).map((candidateId) => ({ candidateId, code: r.code })),
        ),
      ],
    })
  },
)

nodeFolderRoutes.post("/:id/folders/remotes", zValidator("param", idParam), async (c) => {
  assertUnrestrictedSession(c, "list the repositories your computer can reach")
  const owner = await ownerOf(c)
  if (!owner) return c.json(err("not_found", "No such node."), 404)
  const listed = await remotesOnNode(owner)
  return listed.ok ? success(c, listed.view) : answer(c, listed.asked, (d) => d)
})

// ── node ────────────────────────────────────────────────────────────────────

export const nodeFolderRequestRoutes = new Hono<AppEnv>()

/** A node's answer: its data (bounded by the body limit) or a refusal code. */
const claim = z.string().uuid()
const resultBody = z.union([
  z.object({ claim, ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ claim, ok: z.literal(false), code: z.string().max(64) }).strict(),
])

nodeFolderRequestRoutes.get("/:id", zValidator("param", idParam), async (c) => {
  const node = await requireNodeCredential(c)
  const pulled = await pullFolderRequest(c.req.valid("param").id, node)
  if (!pulled) return c.json(err("not_found", "No such request for this node."), 404)
  return success(c, pulled)
})

nodeFolderRequestRoutes.put(
  "/:id",
  zValidator("param", idParam),
  zValidator("json", resultBody),
  async (c) => {
    const node = await requireNodeCredential(c)
    const { claim: by, ...result } = c.req.valid("json")
    const stored = await answerFolderRequest(
      c.req.valid("param").id,
      node,
      by,
      result as NodeFolderResult,
    )
    if (!stored) return c.json(err("not_found", "No such request for this node."), 404)
    return c.body(null, 204)
  },
)

// ── node: session import requests (import-requests.ts) ─────────────────────
//
// Under /api/node/import-requests (session + node credential, its own
// requests only):
//   GET /:id    {op, claim} | 404 (claimed by exactly one pull)
//   PUT /:id    {claim, ok, data} | {claim, ok: false, code}
//               -> 204 | 404 | 422 invalid_answer (data failing its op's schema:
//                  the asker gets `failed`, nothing is kept)

export const nodeImportRequestRoutes = new Hono<AppEnv>()

const importResultBody = z.union([
  z.object({ claim, ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ claim, ok: z.literal(false), code: z.string().max(64) }).strict(),
])

nodeImportRequestRoutes.get("/:id", zValidator("param", idParam), async (c) => {
  const node = await requireNodeCredential(c)
  const pulled = await pullImportRequest(c.req.valid("param").id, node)
  if (!pulled) return c.json(err("not_found", "No such request for this node."), 404)
  return success(c, pulled)
})

nodeImportRequestRoutes.put(
  "/:id",
  zValidator("param", idParam),
  zValidator("json", importResultBody),
  async (c) => {
    const node = await requireNodeCredential(c)
    const { claim: by, ...answer } = c.req.valid("json")
    const outcome = await answerImportRequest(c.req.valid("param").id, node, by, answer)
    if (outcome === "not_found") {
      return c.json(err("not_found", "No such request for this node."), 404)
    }
    if (outcome === "invalid") {
      return c.json(err("invalid_answer", "The answer does not match the request."), 422)
    }
    return c.body(null, 204)
  },
)
