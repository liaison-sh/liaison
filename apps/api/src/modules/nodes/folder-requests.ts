// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE NODE'S FOLDERS, FROM ANY CLIENT (owner-only, fenced to one node).
 *
 * The owner, from the web, the phone or the desktop, or the owner's own agent
 * through an approved tool, asks one of their nodes about its folders: list
 * the shared roots and search roots, look a folder up by name inside the
 * search roots, share or stop sharing a folder, add or remove a search root.
 *
 * The channel copies "Show full output" (routes-full-output.ts): the request
 * is kept in Redis (10 minutes), the node's live connections get a
 * `node_folder_request` frame carrying only its id, the node pulls the
 * request with its credential (only its own node's), runs it on its own
 * settings (node_folders.rs) and puts the answer back. The asker waits a few
 * seconds for it; an offline node is said at once.
 *
 * A lookup's folders get opaque candidate ids (1 hour, bound to the owner and
 * the node), each holding the node's own single-use proof: sharing names a
 * candidate, the node verifies and consumes its proof and checks the folder
 * again (node_folders.rs `share_at`). The server never names a path to share,
 * and the agent sees `~/…` display paths only.
 */
import {
  cleanFolderName,
  type NodeFolderCandidate,
  type NodeFolderLookup,
  type NodeFolderOp,
  type NodeFolderRefusal,
  type NodeFolderResult,
  type NodeRemoteRepo,
  type NodeRemotes,
  nodeFolderCode,
  parseNodeFolderLookup,
  parseNodeFolderScan,
  parseNodeRemotes,
} from "@liaison/shared"
import { redis } from "~/lib/redis"
import { sendConnectionFrame } from "~/modules/node-sessions/commands"
import { liveNodeTargets } from "./jobs"

export const FOLDER_REQUEST_TTL_SECONDS = 10 * 60
export const FOLDER_CANDIDATE_TTL_SECONDS = 60 * 60
/** How long an asker waits for the node's answer by default. */
export const FOLDER_REQUEST_WAIT_MS = 8_000
const POLL_MS = 120

const requestKey = (id: string) => `nfr:${id}`
/** Who claimed a request: exactly one pull gets it (several connections of one node may be woken). */
const claimKey = (id: string) => `nfr:${id}:claim`
const candidateKey = (id: string) => `nfc:${id}`

interface StoredRequest {
  orgId: string
  ownerUserId: string
  nodeId: string
  op: NodeFolderOp
  result: NodeFolderResult | null
}

export interface FolderAskInput {
  orgId: string
  ownerUserId: string
  nodeId: string
  op: NodeFolderOp
  waitMs?: number
}

export type FolderAsk =
  | { status: "done"; result: NodeFolderResult }
  | { status: "offline" }
  | { status: "timeout"; requestId: string }

/**
 * Ask one of the owner's nodes, and wait up to `waitMs` for its answer. The
 * node is woken only on its own connections (`liveNodeTargets` fences the
 * owner and the node): none live is `offline`.
 */
export async function askNodeFolders(input: FolderAskInput): Promise<FolderAsk> {
  const targets = await liveNodeTargets(input.orgId, input.ownerUserId, input.nodeId)
  if (targets.length === 0) return { status: "offline" }
  const requestId = crypto.randomUUID()
  const stored: StoredRequest = {
    orgId: input.orgId,
    ownerUserId: input.ownerUserId,
    nodeId: input.nodeId,
    op: input.op,
    result: null,
  }
  await redis.set(requestKey(requestId), JSON.stringify(stored), "EX", FOLDER_REQUEST_TTL_SECONDS)
  const sent = await sendConnectionFrame(targets, { type: "node_folder_request", requestId })
  if (sent === 0) {
    await redis.del(requestKey(requestId))
    return { status: "offline" }
  }
  const deadline = Date.now() + (input.waitMs ?? FOLDER_REQUEST_WAIT_MS)
  for (;;) {
    const row = await readRequest(requestId)
    if (row?.result) return { status: "done", result: row.result }
    if (Date.now() >= deadline) return { status: "timeout", requestId }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

async function readRequest(requestId: string): Promise<StoredRequest | null> {
  const raw = await redis.get(requestKey(requestId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredRequest
  } catch {
    return null
  }
}

/**
 * A request as its owner follows it (a clone runs for minutes): `pending`
 * until the node answers, then its answer. Null when gone or not theirs.
 */
export async function readFolderRequestForOwner(
  requestId: string,
  owner: { orgId: string; ownerUserId: string; nodeId: string },
): Promise<{ state: "pending" } | { state: "done"; result: NodeFolderResult } | null> {
  const row = await readRequest(requestId)
  if (
    !row ||
    row.orgId !== owner.orgId ||
    row.ownerUserId !== owner.ownerUserId ||
    row.nodeId !== owner.nodeId
  ) {
    return null
  }
  return row.result ? { state: "done", result: row.result } : { state: "pending" }
}

/**
 * The request for this node to run, claimed atomically by this pull, or null
 * (gone, answered, another node's, or already claimed by another connection).
 * The answer must carry the claim.
 */
export async function pullFolderRequest(
  requestId: string,
  node: { id: string; orgId: string; ownerUserId: string },
): Promise<{ op: NodeFolderOp; claim: string } | null> {
  const row = await readRequest(requestId)
  if (!row || row.result) return null
  if (row.nodeId !== node.id || row.orgId !== node.orgId || row.ownerUserId !== node.ownerUserId) {
    return null
  }
  const claim = crypto.randomUUID()
  const won = await redis.set(claimKey(requestId), claim, "EX", FOLDER_REQUEST_TTL_SECONDS, "NX")
  return won === "OK" ? { op: row.op, claim } : null
}

/**
 * Stores the node's answer once, from the pull that claimed it; false when the
 * request is not this node's, not claimed by that pull, or already answered.
 */
export async function answerFolderRequest(
  requestId: string,
  node: { id: string; orgId: string; ownerUserId: string },
  claim: string,
  result: NodeFolderResult,
): Promise<boolean> {
  const row = await readRequest(requestId)
  if (!row || row.result) return false
  if (row.nodeId !== node.id || row.orgId !== node.orgId || row.ownerUserId !== node.ownerUserId) {
    return false
  }
  if ((await redis.get(claimKey(requestId))) !== claim) return false
  const clean: NodeFolderResult = result.ok
    ? { ok: true, data: result.data }
    : { ok: false, code: nodeFolderCode(result.code) }
  await redis.set(
    requestKey(requestId),
    JSON.stringify({ ...row, result: clean }),
    "EX",
    FOLDER_REQUEST_TTL_SECONDS,
  )
  return true
}

// ── candidates ──────────────────────────────────────────────────────────────

interface StoredCandidate {
  orgId: string
  ownerUserId: string
  nodeId: string
  /** The node's own proof for this folder: the node shares only what it issued. */
  token: string
  name: string
  display: string
}

/** A lookup's folder as the asker sees it: an id to share it by, never its path. */
export interface FolderCandidateView {
  id: string
  name: string
  display: string
  isRepo: boolean
  shared: boolean
  shareable: boolean
}

/**
 * Gives each found folder an id the owner (or their approved tool) can share
 * it by: a lookup's, a scan's, a remote's local clone, an unshared group of
 * the import listing. Only the token, the name and the display are kept.
 */
export async function rememberCandidates(
  owner: { orgId: string; ownerUserId: string; nodeId: string },
  candidates: ReadonlyArray<
    Pick<NodeFolderCandidate, "name" | "token" | "display" | "isRepo" | "shared" | "shareable">
  >,
): Promise<FolderCandidateView[]> {
  const out: FolderCandidateView[] = []
  for (const c of candidates) {
    const id = crypto.randomUUID()
    const name = cleanFolderName(c.name)
    const display = cleanFolderName(c.display)
    const stored: StoredCandidate = { ...owner, token: c.token, name, display }
    await redis.set(candidateKey(id), JSON.stringify(stored), "EX", FOLDER_CANDIDATE_TTL_SECONDS)
    out.push({
      id,
      name,
      display,
      isRepo: c.isRepo,
      shared: c.shared,
      shareable: c.shareable,
    })
  }
  return out
}

/** A remembered candidate of this owner (any of their nodes, or the one named), or null. */
export async function readCandidate(
  id: string,
  owner: { orgId: string; ownerUserId: string; nodeId?: string },
): Promise<(StoredCandidate & { id: string }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const raw = await redis.get(candidateKey(id))
  if (!raw) return null
  try {
    const c = JSON.parse(raw) as StoredCandidate
    if (c.orgId !== owner.orgId || c.ownerUserId !== owner.ownerUserId) return null
    if (owner.nodeId && c.nodeId !== owner.nodeId) return null
    return { ...c, id }
  } catch {
    return null
  }
}

/** A lookup on one node, its folders given ids; null data when the node did not answer. */
export async function lookupOnNode(
  input: Omit<FolderAskInput, "op"> & { query: string },
): Promise<
  | { status: "done"; lookup: NodeFolderLookup; candidates: FolderCandidateView[] }
  | { status: "offline" | "timeout" | "failed" }
> {
  const asked = await askNodeFolders({ ...input, op: { kind: "lookup", query: input.query } })
  if (asked.status !== "done") return { status: asked.status }
  if (!asked.result.ok) return { status: "failed" }
  const lookup = parseNodeFolderLookup(asked.result.data)
  const candidates = await rememberCandidates(
    { orgId: input.orgId, ownerUserId: input.ownerUserId, nodeId: input.nodeId },
    lookup.candidates,
  )
  return { status: "done", lookup, candidates }
}

/** A scan walks every search root on its own 8 s budget. */
export const FOLDER_SCAN_WAIT_MS = 20_000
/** Remotes runs gh and glab on the node within its own 35 s deadline. */
export const FOLDER_REMOTES_WAIT_MS = 45_000

/** A scan's repository as the asker sees it: an id to share it by when it can be, never its path. */
export interface FolderScanRowView {
  candidateId: string | null
  name: string
  display: string
  shared: boolean
  shareable: boolean
  refusal: NodeFolderRefusal | null
}

export interface FolderScanView {
  searchRoots: number
  partial: boolean
  denied: string[]
  skippedProtected: boolean
  candidates: FolderScanRowView[]
}

/** A remote repository as the asker sees it: its local clone by id, never its token. */
export type RemoteRepoView = Omit<NodeRemoteRepo, "local"> & {
  local: { display: string; shared: boolean; candidateId: string | null } | null
}

export interface RemotesView {
  repos: RemoteRepoView[]
  sources: NodeRemotes["sources"]
  dropped: number
}

type Owner = { orgId: string; ownerUserId: string; nodeId: string }

/** The node's answer read by `read`, or what it was instead (offline, timeout, a refusal). */
type Asked<T> = { ok: true; view: T } | { ok: false; asked: FolderAsk }

/**
 * Every git repository in the node's search roots (S1). Each one that can be
 * shared and is not yet gets a candidate id; the token and the path stay here.
 */
export async function scanOnNode(
  owner: Owner,
  waitMs = FOLDER_SCAN_WAIT_MS,
): Promise<Asked<FolderScanView>> {
  const asked = await askNodeFolders({ ...owner, op: { kind: "scan" }, waitMs })
  if (asked.status !== "done" || !asked.result.ok) return { ok: false, asked }
  const scan = parseNodeFolderScan(asked.result.data)
  const tokened = scan.candidates.filter((x) => x.token !== null)
  const views = await rememberCandidates(
    owner,
    tokened.map((x) => ({ ...x, token: x.token as string, isRepo: true })),
  )
  const ids = new Map(tokened.map((x, i) => [x, views[i]?.id ?? null]))
  return {
    ok: true,
    view: {
      searchRoots: scan.searchRoots,
      partial: scan.partial === true,
      denied: scan.denied ?? [],
      skippedProtected: scan.skippedProtected === true,
      candidates: scan.candidates.map((x) => ({
        candidateId: ids.get(x) ?? null,
        name: x.name,
        display: x.display,
        shared: x.shared,
        shareable: x.shareable,
        refusal: x.refusal,
      })),
    },
  }
}

/**
 * The repositories the node's signed-in gh and glab list (S3), each local
 * clone that can be shared given a candidate id.
 */
export async function remotesOnNode(
  owner: Owner,
  waitMs = FOLDER_REMOTES_WAIT_MS,
): Promise<Asked<RemotesView>> {
  const asked = await askNodeFolders({ ...owner, op: { kind: "remotes" }, waitMs })
  if (asked.status !== "done" || !asked.result.ok) return { ok: false, asked }
  const remotes = parseNodeRemotes(asked.result.data)
  const repos: RemoteRepoView[] = []
  for (const repo of remotes.repos) {
    const { local, ...rest } = repo
    let candidateId: string | null = null
    if (local?.token) {
      const [view] = await rememberCandidates(owner, [
        {
          name: repo.fullName.split("/").pop() || repo.fullName,
          token: local.token,
          display: local.display,
          isRepo: true,
          shared: false,
          shareable: true,
        },
      ])
      candidateId = view?.id ?? null
    }
    repos.push({
      ...rest,
      local: local ? { display: local.display, shared: local.shared, candidateId } : null,
    })
  }
  return { ok: true, view: { repos, sources: remotes.sources, dropped: remotes.dropped } }
}
