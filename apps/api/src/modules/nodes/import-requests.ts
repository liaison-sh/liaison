// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE NODE'S IMPORTABLE SESSIONS (S40, S42, A42, A47), owner-only, fenced to
 * one node.
 *
 * The owner (the app, or their agent through an approved tool) asks one of
 * their nodes for the Claude Code sessions recorded inside its shared folders,
 * or to check one again before importing it. The channel is the folder
 * relay's (folder-requests.ts): the request waits in Redis (10 minutes), the
 * node's live connections get a `node_import_request` frame carrying only its
 * id, the node pulls it with its credential (only its own, claimed by exactly
 * one pull), runs it in a one-shot sidecar on its own shared folders and puts
 * the answer back. The answer is parsed with the shared schema of its op: one
 * that fails it is `failed`, refused to the node, and never reaches anyone.
 *
 * A node that has not published import protocol 5 with its capabilities
 * cannot answer: `node_outdated`, and no frame is sent.
 *
 * Listed rows become opaque candidates (`nic:<id>`, 1 hour, bound to the
 * org, the owner and the node, single use at start): the CLI session id never
 * travels to a client or an agent as something to name (A47).
 */
import {
  type NodeImportCheckAnswer,
  type NodeImportListAnswer,
  type NodeImportOp,
  type NodeImportRow,
  nodeImportCheckAnswerSchema,
  nodeImportListAnswerSchema,
} from "@liaison/shared"
import { redis } from "~/lib/redis"
import { sendConnectionFrame } from "~/modules/node-sessions/commands"
import { liveNodeTargets, nodeSpeaksImport } from "./jobs"

export const IMPORT_REQUEST_TTL_SECONDS = 10 * 60
export const IMPORT_CANDIDATE_TTL_SECONDS = 60 * 60
/**
 * How long an asker waits for the node by default: longer than the shell's
 * own 30 s bound on the sidecar, so the node's `timeout` arrives as its code.
 */
export const IMPORT_REQUEST_WAIT_MS = 35_000
const POLL_MS = 120

const requestKey = (id: string) => `nir:${id}`
const claimKey = (id: string) => `nir:${id}:claim`
const candidateKey = (id: string) => `nic:${id}`

/** A node's refusal code as kept: a short identifier, else `failed`. */
const CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

type StoredResult =
  | { ok: true; data: NodeImportListAnswer | NodeImportCheckAnswer }
  | { ok: false; code: string }

interface StoredRequest {
  orgId: string
  ownerUserId: string
  nodeId: string
  op: NodeImportOp
  result: StoredResult | null
}

export interface ImportAskInput {
  orgId: string
  ownerUserId: string
  nodeId: string
  op: NodeImportOp
  waitMs?: number
}

export type ImportAskFailure =
  | { status: "offline" }
  | { status: "node_outdated" }
  | { status: "failed" }
  | { status: "timeout"; requestId: string }
  | { status: "refused"; code: string }

export type ImportAsk<A> = { status: "done"; answer: A } | ImportAskFailure

export function askNodeImport(
  input: ImportAskInput & { op: Extract<NodeImportOp, { kind: "list" }> },
): Promise<ImportAsk<NodeImportListAnswer>>
export function askNodeImport(
  input: ImportAskInput & { op: Extract<NodeImportOp, { kind: "check" }> },
): Promise<ImportAsk<NodeImportCheckAnswer>>
export function askNodeImport(
  input: ImportAskInput,
): Promise<ImportAsk<NodeImportListAnswer | NodeImportCheckAnswer>>
/**
 * Ask one of the owner's nodes, and wait up to `waitMs` for its answer. Only
 * that node's live connections are woken (`liveNodeTargets` fences the owner
 * and the node): none live is `offline`.
 */
export async function askNodeImport(
  input: ImportAskInput,
): Promise<ImportAsk<NodeImportListAnswer | NodeImportCheckAnswer>> {
  const targets = await liveNodeTargets(input.orgId, input.ownerUserId, input.nodeId)
  if (targets.length === 0) return { status: "offline" }
  if (!(await nodeSpeaksImport(input.orgId, input.nodeId))) return { status: "node_outdated" }
  const requestId = crypto.randomUUID()
  const stored: StoredRequest = {
    orgId: input.orgId,
    ownerUserId: input.ownerUserId,
    nodeId: input.nodeId,
    op: input.op,
    result: null,
  }
  await redis.set(requestKey(requestId), JSON.stringify(stored), "EX", IMPORT_REQUEST_TTL_SECONDS)
  const sent = await sendConnectionFrame(targets, { type: "node_import_request", requestId })
  if (sent === 0) {
    await redis.del(requestKey(requestId))
    return { status: "offline" }
  }
  const deadline = Date.now() + (input.waitMs ?? IMPORT_REQUEST_WAIT_MS)
  for (;;) {
    const row = await readRequest(requestId)
    if (row?.result) {
      await redis.del(requestKey(requestId), claimKey(requestId))
      if (!row.result.ok) {
        return row.result.code === "failed"
          ? { status: "failed" }
          : { status: "refused", code: row.result.code }
      }
      return { status: "done", answer: row.result.data }
    }
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

type NodeRef = { id: string; orgId: string; ownerUserId: string }

const isNodesRequest = (row: StoredRequest, node: NodeRef) =>
  row.nodeId === node.id && row.orgId === node.orgId && row.ownerUserId === node.ownerUserId

/**
 * The request for this node to run, claimed atomically by this pull, or null
 * (gone, answered, another node's, or already claimed). The answer must carry
 * the claim.
 */
export async function pullImportRequest(
  requestId: string,
  node: NodeRef,
): Promise<{ op: NodeImportOp; claim: string } | null> {
  const row = await readRequest(requestId)
  if (!row || row.result || !isNodesRequest(row, node)) return null
  const claim = crypto.randomUUID()
  const won = await redis.set(claimKey(requestId), claim, "EX", IMPORT_REQUEST_TTL_SECONDS, "NX")
  return won === "OK" ? { op: row.op, claim } : null
}

export type ImportAnswerOutcome = "stored" | "not_found" | "invalid"

/**
 * Stores the node's answer once, from the pull that claimed it. Data that
 * fails its op's schema is stored as `failed` (the asker stops waiting) and
 * answered `invalid`; nothing of it is kept.
 */
export async function answerImportRequest(
  requestId: string,
  node: NodeRef,
  claim: string,
  answer: { ok: true; data: unknown } | { ok: false; code: string },
): Promise<ImportAnswerOutcome> {
  const row = await readRequest(requestId)
  if (!row || row.result || !isNodesRequest(row, node)) return "not_found"
  if ((await redis.get(claimKey(requestId))) !== claim) return "not_found"
  let result: StoredResult
  let outcome: ImportAnswerOutcome = "stored"
  if (answer.ok) {
    const parsed =
      row.op.kind === "list"
        ? nodeImportListAnswerSchema.safeParse(answer.data)
        : nodeImportCheckAnswerSchema.safeParse(answer.data)
    if (parsed.success) {
      result = { ok: true, data: parsed.data }
    } else {
      result = { ok: false, code: "failed" }
      outcome = "invalid"
    }
  } else {
    result = { ok: false, code: CODE_RE.test(answer.code) ? answer.code : "failed" }
  }
  await redis.set(
    requestKey(requestId),
    JSON.stringify({ ...row, result }),
    "EX",
    IMPORT_REQUEST_TTL_SECONDS,
  )
  return outcome
}

// ── candidates ──────────────────────────────────────────────────────────────

/** What a candidate binds: whose it is, which node, and the session it names. */
export interface ImportCandidate {
  orgId: string
  ownerUserId: string
  nodeId: string
  sdkSessionId: string
  folderName: string
  /** D53: the shared repo's worktree outside the folder the row was listed in. */
  worktreePath?: string
  cwdSubdir: string
  title: string
  from: NodeImportRow["from"]
}

/** A listed row as a client or the agent sees it: an id to import it by, never the CLI id. */
export type ImportRowView = Omit<NodeImportRow, "sdkSessionId"> & {
  candidateId: string | null
  inLiaison: string | null
}

type Owner = { orgId: string; ownerUserId: string; nodeId: string }

/**
 * Gives each importable row an id the owner (or their approved tool) imports
 * it by. A Liaison session of the node itself (`from: liaison`) gets none:
 * there is nothing to import (A56).
 */
export async function rememberImportCandidates(
  owner: Owner,
  rows: readonly NodeImportRow[],
  inLiaison: ReadonlyMap<string, string>,
): Promise<ImportRowView[]> {
  const out: ImportRowView[] = []
  for (const row of rows) {
    const { sdkSessionId, ...shown } = row
    let candidateId: string | null = null
    if (row.from !== "liaison") {
      candidateId = crypto.randomUUID()
      const stored: ImportCandidate = {
        ...owner,
        sdkSessionId,
        folderName: row.folderName,
        ...(row.worktreePath !== undefined ? { worktreePath: row.worktreePath } : {}),
        cwdSubdir: row.cwdSubdir,
        title: row.title,
        from: row.from,
      }
      await redis.set(
        candidateKey(candidateId),
        JSON.stringify(stored),
        "EX",
        IMPORT_CANDIDATE_TTL_SECONDS,
      )
    }
    out.push({ ...shown, candidateId, inLiaison: inLiaison.get(sdkSessionId) ?? null })
  }
  return out
}

const CANDIDATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseCandidate(raw: string | null): ImportCandidate | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as ImportCandidate
  } catch {
    return null
  }
}

/** A candidate of this owner, read without consuming it (a card's preflight), or null. */
export async function readImportCandidate(
  id: string,
  owner: { orgId: string; ownerUserId: string },
): Promise<ImportCandidate | null> {
  if (!CANDIDATE_ID.test(id)) return null
  const c = parseCandidate(await redis.get(candidateKey(id)))
  if (!c || c.orgId !== owner.orgId || c.ownerUserId !== owner.ownerUserId) return null
  return c
}

/**
 * Takes a candidate of this owner (single use), or null. Another user's
 * candidate is left as it was: naming it burns nothing.
 */
export async function takeImportCandidate(
  id: string,
  owner: { orgId: string; ownerUserId: string },
): Promise<ImportCandidate | null> {
  if (!CANDIDATE_ID.test(id)) return null
  const raw = await redis.get(candidateKey(id))
  const c = parseCandidate(raw)
  if (!c || c.orgId !== owner.orgId || c.ownerUserId !== owner.ownerUserId) return null
  // Consumed by exactly one taker: the value read must be the one deleted.
  const taken = await redis.getdel(candidateKey(id))
  return taken !== null && taken === raw ? c : null
}
