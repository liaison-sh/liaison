// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The source transfer agent: drives one org's move from this instance to a
// target instance (plans R1.1, R1.2; D33, D34, D37). Long-lived (started
// detached by the operator's `cell:move`, survives the operator going away),
// it holds its database and Redis connections for the whole move, so nothing
// cold-starts inside the write gap.
//
// Phases, each reported to the control plane by the heartbeat (every 2 s; the
// lease lasts MOVE_LEASE_SECONDS):
//   precopy   (org live) pass 1: the closure into the target, org `incoming`
//             there; the org's custom apps installed there; the org's objects
//             copied; pass 1b: the rows and objects changed since;
//   draining  writes still accepted; no new agent turn, job or event starts.
//             Waits (at most `drainTimeoutMs`, 30 s) for the org's live turns,
//             jobs, claimed events and pending control-plane messages to run
//             down (the latter flushed to the control plane, which accepts the
//             source until the commit, P4P-15). Not drained: aborted, no gap;
//   frozen    the write gap, every step under its ceiling (ceilings.ts):
//             freeze + acks, quiesce, pass 2 scan + jobs export, apply on the
//             target (one transaction), fingerprint re-check + the delta's
//             objects, then the control plane's commit (compare-and-set);
//   committed the target serves the org, this copy is `moved`; then, outside
//             the gap: the target re-adds the jobs, revokes MCP connections
//             (one attention item), watches Gmail again; this side removes the
//             carried jobs, the search catch-up runs, residue is verified.
// Abort (any failure before the commit): the control plane is told first;
// only once it says `aborted` (or it never froze the move) does this copy
// serve writes again, and the target purges its incoming copy. When the
// control plane cannot be reached about a frozen move, the org STAYS frozen
// and the freeze-deadline resolver on each side settles it from the control
// plane's decision (D34): never two writers.
import type { MoveAgentPhase } from "@liaison/control-plane-contract"
import {
  exportOrgJobs,
  removeTransferredJobs,
  type TransferredJob,
  type TransferredScheduler,
} from "~/infra/jobs/jobs"
import { getObjectBuffer, headObject, listOrgPrefixIter } from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import {
  awaitOrgQuiesced,
  awaitOrgTransferAcks,
  type OrgTransferState,
  orgQuiesceReport,
  setOrgTransferState,
} from "~/modules/org/transfer-state/state"
import { cancelCarriedOutbox, pendingOutboxMessages } from "./after-commit"
import type { TargetChannel } from "./agent-target"
import {
  GAP_STEPS,
  type GapStep,
  StepCeilingExceeded,
  type StepTiming,
  underCeiling,
} from "./ceilings"
import { loadClosure } from "./closure"
import { isAborted, isCommitted, type MoveControl, type MoveDecision } from "./control"
import { readCustomAppPackages } from "./custom-apps"
import {
  type ExportOptions,
  exportOrg,
  type Fingerprint,
  fingerprintDiff,
  orgCustomApps,
  scanFingerprint,
} from "./export"
import type { MoveFaultPoint } from "./faults"
import { countOrgClosure, type ImportResult } from "./import"
import { type FamilyKeys, generateTransferKeys } from "./rekey"
import { exportSearchDocuments, searchCatchUp } from "./search"
import {
  probeVisibleHere,
  recordPeerStorage,
  type StorageIdentity,
  type StorageProbe,
  sharedStorage,
  storageIdentity,
} from "./storage-identity"

const log = rootLogger.child({ module: "org-transfer-agent-source" })

export const HEARTBEAT_MS = 2_000
export const DRAIN_TIMEOUT_MS = 30_000
/** The commit is not attempted with less lease left than this. */
export const LEASE_MARGIN_MS = 3_000
/** An unknown commit outcome is asked again for at most this long before the org is left to the resolver. */
export const DECISION_ASK_MS = 10_000
/** Objects per `put-objects` call, by bytes. */
const OBJECT_BATCH_BYTES = 8 * 1024 * 1024

export interface ObjectOps {
  list(orgId: string): AsyncIterable<{ key: string; modified: number }>
  get(key: string): Promise<{ body: Buffer; contentType: string }>
}

export const defaultObjectOps: ObjectOps = {
  async *list(orgId) {
    for await (const o of listOrgPrefixIter({ orgId })) {
      yield { key: o.Key, modified: o.LastModified.getTime() }
    }
  },
  async get(key) {
    const [body, head] = await Promise.all([getObjectBuffer(key), headObject(key)])
    return { body, contentType: head.contentType }
  },
}

/** How long the router's KV entry can stay stale at an edge (about 60 s), with a margin. */
export const ROUTING_SETTLE_MS = 65_000

export interface SourceMoveOptions {
  /** How long after the agent's start the freeze may begin (tests only; default ROUTING_SETTLE_MS). */
  routingSettleMs?: number
  sql: ExportOptions["sql"]
  orgId: string
  transferId: string
  target: TargetChannel
  control: MoveControl
  instanceKeys: FamilyKeys
  objects?: ObjectOps
  /** This cell's storage identity (tests only; default: from the environment). */
  storageIdentity?: () => StorageIdentity
  /** What of the target's storage probe this cell sees (tests only; default: look). */
  probeVisible?: (probe: StorageProbe) => Promise<string[]>
  /** Instances that must ack (default: the cell's live instances). */
  ackInstances?: string[]
  heartbeatMs?: number
  drainTimeoutMs?: number
  /** How long an unknown commit outcome is asked again (default DECISION_ASK_MS). */
  decisionAskMs?: number
  /** Multiplies every step ceiling (tests only). */
  ceilingScale?: number
  /** Progress lines (phase changes, step timings) for whoever watches the agent. */
  progress?: (event: Record<string, unknown>) => void
  /**
   * Fault injection for rehearsals on test servers: the agent stops on the
   * spot when it reaches this step (no abort, no more heartbeats), as a crash
   * would, and the resolvers and the control plane's lease settle the org.
   */
  failAt?: MoveFaultPoint
  /** Test seams, awaited at the named points. */
  hooks?: Partial<
    Record<"afterFreeze" | "beforeApply" | "beforeVerify" | "beforeCommit", () => Promise<void>>
  >
}

export type MoveOutcome = "committed" | "aborted" | "unresolved"

export interface MoveReport {
  outcome: MoveOutcome
  orgId: string
  transferId: string
  /** The last phase reached. */
  phase: MoveAgentPhase | "committed"
  reason: string | null
  /** Steps inside the gap, measured. */
  timings: StepTiming[]
  /** Freeze start to the target serving (ms), when the gap opened. */
  writeGapMs: number | null
  pass: { full: number; pass1b: number; delta: number }
  objects: { copied: number; deleted: number }
  jobs: { carried: number; schedulers: number }
  afterCommit: unknown
  residue: { ok: boolean; problems: string[] } | null
}

/**
 * Thrown by a test hook to stand for the agent process dying on the spot: the
 * run stops (heartbeats too) without any abort, as a crash would, and the
 * freeze-deadline resolvers settle the org.
 */
export class AgentKilled extends Error {
  constructor() {
    super("org move agent killed")
    this.name = "AgentKilled"
  }
}

export class MoveAborted extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(`org move aborted at ${step}: ${message}`)
    this.name = "MoveAborted"
  }
}

function sumRows(r: ImportResult): number {
  return (
    Object.values(r.rows).reduce((s, n) => s + n, 0) +
    Object.values(r.deleted).reduce((s, n) => s + n, 0)
  )
}

/** Object keys of the org named by rows of a bundle (file rows' storage and thumbnail keys). */
export function objectKeysOf(lines: readonly string[], orgId: string): string[] {
  const out = new Set<string>()
  let inRows = false
  for (const line of lines) {
    if (line.startsWith('{"k":"begin"')) {
      inRows = line.includes('"section":"rows:')
      continue
    }
    if (line.startsWith('{"k":"end"')) {
      inRows = false
      continue
    }
    if (!inRows || (!line.includes("storage_key") && !line.includes("thumbnail_key"))) continue
    const row = JSON.parse(line) as Record<string, unknown>
    for (const k of ["storage_key", "thumbnail_key"]) {
      const v = row[k]
      if (typeof v === "string" && v.startsWith(`orgs/${orgId}/`)) out.add(v)
    }
  }
  return [...out]
}

export async function runSourceMove(opts: SourceMoveOptions): Promise<MoveReport> {
  const startedAt = Date.now()
  const { sql, orgId, transferId, target, control } = opts
  const objects = opts.objects ?? defaultObjectOps
  const progress = opts.progress ?? (() => {})
  const timings: StepTiming[] = []
  const report: MoveReport = {
    outcome: "aborted",
    orgId,
    transferId,
    phase: "planned",
    reason: null,
    timings,
    writeGapMs: null,
    pass: { full: 0, pass1b: 0, delta: 0 },
    objects: { copied: 0, deleted: 0 },
    jobs: { carried: 0, schedulers: 0 },
    afterCommit: null,
    residue: null,
  }
  let phase: MoveAgentPhase = "planned"
  let leaseUntil = 0
  let controlAborted: string | null = null
  let controlFrozen = false
  let localState: OrgTransferState | null = null
  let gapStart: number | null = null
  const sent = new Map<string, number>()
  let carried: { jobs: TransferredJob[]; schedulers: TransferredScheduler[] } = {
    jobs: [],
    schedulers: [],
  }
  const scale = { scale: opts.ceilingScale ?? 1 }

  const setPhase = (p: MoveAgentPhase) => {
    phase = p
    report.phase = p
    progress({ event: "phase", phase: p, at: Date.now() })
  }
  const onBeat = (d: MoveDecision) => {
    if (d.ok && d.leaseUntil) leaseUntil = Date.parse(d.leaseUntil)
    if (isAborted(d)) controlAborted = d.ok ? d.state : d.code
  }
  const beat = async () => {
    const d = await control.heartbeat(phase)
    onBeat(d)
    return d
  }
  const check = (step: string) => {
    if (controlAborted)
      throw new MoveAborted(step, `the control plane aborted the move (${controlAborted})`)
  }
  let beating = true
  let beatInFlight = false
  const timer = setInterval(() => {
    if (!beating || beatInFlight) return
    beatInFlight = true
    void beat()
      .catch(() => {})
      .finally(() => {
        beatInFlight = false
      })
  }, opts.heartbeatMs ?? HEARTBEAT_MS)
  const stopBeating = () => {
    beating = false
    clearInterval(timer)
  }

  const setLocal = async (state: OrgTransferState | null) => {
    await setOrgTransferState(orgId, state, transferId)
    localState = state
  }

  const copyObjects = async (keys: Iterable<{ key: string; modified: number }>) => {
    let batch: Array<{ key: string; contentType: string; b64: string }> = []
    let bytes = 0
    const flush = async () => {
      if (batch.length === 0) return
      await target.call("put-objects", { objects: batch })
      report.objects.copied += batch.length
      batch = []
      bytes = 0
    }
    for (const o of keys) {
      const got = await objects.get(o.key)
      batch.push({ key: o.key, contentType: got.contentType, b64: got.body.toString("base64") })
      bytes += got.body.length
      sent.set(o.key, o.modified)
      if (bytes >= OBJECT_BATCH_BYTES) await flush()
    }
    await flush()
  }
  const listChanged = async () => {
    const out: Array<{ key: string; modified: number }> = []
    for await (const o of objects.list(orgId)) {
      if (sent.get(o.key) !== o.modified) out.push(o)
    }
    return out
  }

  // Fault injection runs only on a server marked as a test one (the CLI refuses
  // first; this keeps any other caller from reaching it).
  if (opts.failAt !== undefined && !env.LIAISON_TEST_CELL) {
    throw new Error("org transfer: --fail-at is refused on a server without LIAISON_TEST_CELL=1")
  }
  const faultAt = (point: MoveFaultPoint) => {
    if (opts.failAt !== point) return
    progress({ event: "fault", at: point, time: Date.now() })
    throw new AgentKilled()
  }

  const finishCommitted = async (): Promise<MoveReport> => {
    report.outcome = "committed"
    report.phase = "committed"
    stopBeating()
    progress({ event: "phase", phase: "committed", at: Date.now() })
    // The target serves the org from here on; this copy refuses everything.
    await underCeiling(
      "unfreeze-acks",
      async () => {
        const acks = (await target.call("activate")) as { ok: boolean; missing: string[] }
        if (!acks.ok)
          log.warn(
            { orgId, transferId, missing: acks.missing },
            "target unfreeze not acked by every instance",
          )
      },
      timings,
      { ...scale, enforce: false },
    ).catch((err) =>
      log.error(
        { err, orgId, transferId },
        "target activation failed; its resolver serves the org",
      ),
    )
    await setLocal("moved").catch((err) =>
      log.error(
        { err, orgId, transferId },
        "marking the source copy moved failed; its resolver does it",
      ),
    )
    if (gapStart !== null) report.writeGapMs = Date.now() - gapStart
    progress({ event: "gap", writeGapMs: report.writeGapMs, timings })
    await afterCommit()
    return report
  }

  const afterCommit = async () => {
    const problems: string[] = []
    // Row counts first: the after-commit steps add rows of their own there
    // (the reconnect notice's event).
    try {
      const here = await countOrgClosure(sql, await loadClosure(sql), orgId)
      const there = (await target.call("counts")) as Record<string, number>
      for (const [t, n] of Object.entries(here)) {
        if ((there[t] ?? 0) !== n) problems.push(`${t} ${there[t] ?? 0} there, ${n} here`)
      }
    } catch (err) {
      problems.push(`row counts failed: ${String((err as Error).message)}`)
    }
    try {
      report.afterCommit = await target.call("after-commit")
    } catch (err) {
      log.error({ err, orgId, transferId }, "org move: the target's after-commit steps failed")
      report.afterCommit = { error: String((err as Error).message) }
    }
    try {
      // Control-plane messages of the org enqueued here after the drain: the
      // target sends them now (P4P-15); the control plane dedups by message id.
      const pending = await pendingOutboxMessages(orgId)
      if (pending.length > 0) {
        await target.call("adopt-outbox", {
          messages: pending.map(({ id: _id, ...m }) => m),
        })
        await cancelCarriedOutbox(
          pending.map((m) => m.id),
          transferId,
        )
      }
    } catch (err) {
      log.error(
        { err, orgId, transferId },
        "org move: carrying the pending control-plane messages failed",
      )
    }
    try {
      await removeTransferredJobs(orgId, carried)
    } catch (err) {
      log.error(
        { err, orgId, transferId },
        "org move: removing the carried jobs here failed (they stay held)",
      )
    }

    try {
      const docs = await exportSearchDocuments(orgId)
      const hashes = (await target.call("search-hashes")) as Record<string, string>
      const cu = searchCatchUp(docs, hashes)
      if (cu.docs.length > 0 || cu.deleteIds.length > 0) {
        await target.call("search-write", { deleteIds: cu.deleteIds }, cu.docs)
      }
      const after = (await target.call("search-hashes")) as Record<string, string>
      if (Object.keys(after).length !== docs.length) {
        problems.push(`search documents ${Object.keys(after).length} there, ${docs.length} here`)
      }
    } catch (err) {
      problems.push(`search catch-up failed: ${String((err as Error).message)}`)
    }
    try {
      const live = new Set<string>()
      for await (const o of objects.list(orgId)) live.add(o.key)
      const gone = [...sent.keys()].filter((k) => !live.has(k))
      if (gone.length > 0) {
        await target.call("delete-objects", { keys: gone })
        report.objects.deleted = gone.length
      }
      const missing = [...live].filter((k) => !sent.has(k))
      if (missing.length > 0) problems.push(`${missing.length} object(s) never copied`)
    } catch (err) {
      problems.push(`objects check failed: ${String((err as Error).message)}`)
    }
    report.residue = { ok: problems.length === 0, problems }
    if (problems.length > 0) {
      // Not a rollback: the org is live on the target; this copy is intact for the hold.
      log.error(
        { alert: "org_move_residue", orgId, transferId, problems },
        "org moved, but the target's copy differs from the source's",
      )
    }
  }

  /** The control plane's word on a commit whose outcome is unknown. */
  const askDecision = async (): Promise<"committed" | "aborted" | null> => {
    const until = Date.now() + (opts.decisionAskMs ?? DECISION_ASK_MS)
    while (Date.now() < until) {
      const d = await control.status()
      if (isCommitted(d)) return "committed"
      if (isAborted(d)) return "aborted"
      if (d.ok && d.state === "frozen") {
        // Not decided yet: a commit while the lease holds settles it.
        const again = await control.commit(gapStart ? Date.now() - gapStart : 0)
        if (isCommitted(again)) return "committed"
        if (isAborted(again)) return "aborted"
      }
      await Bun.sleep(500)
    }
    return null
  }

  const abort = async (step: string, reason: string): Promise<MoveReport> => {
    report.reason = reason
    progress({ event: "abort", step, reason, at: Date.now() })
    stopBeating()
    if (controlFrozen || controlAborted) {
      let d: MoveDecision = { ok: false, code: "unreachable", error: "not asked" }
      for (let i = 0; i < 3; i++) {
        d = await control.abort(`${step}: ${reason}`.slice(0, 200))
        if (d.ok || d.code !== "unreachable") break
        await Bun.sleep(500)
      }
      if (isCommitted(d)) return finishCommitted()
      if (!isAborted(d)) {
        // The control plane froze this move and cannot be asked: stay as is.
        report.outcome = "unresolved"
        log.error(
          { alert: "org_move_unresolved", orgId, transferId, step, reason },
          "org move aborted locally but the control plane could not confirm; the org stays frozen until its resolver hears the decision",
        )
        return report
      }
    } else {
      // Never frozen in the control plane: no commit can happen; tell it anyway.
      await control.abort(`${step}: ${reason}`.slice(0, 200)).catch(() => null)
    }
    await target
      .call("abort")
      .catch((err) =>
        log.warn(
          { err, orgId, transferId },
          "target abort failed; its resolver purges the incoming copy",
        ),
      )
    if (localState !== null) {
      await setLocal(null).catch((err) =>
        log.error({ err, orgId, transferId }, "unfreezing the source failed; its resolver does it"),
      )
    }
    report.outcome = "aborted"
    return report
  }

  try {
    // ── precopy ──────────────────────────────────────────────────────────
    setPhase("precopy")
    const first = await beat()
    if (!first.ok)
      throw new MoveAborted("precopy", `the control plane refused the heartbeat (${first.code})`)
    check("precopy")
    const transferKeys = generateTransferKeys()
    const hello = (await target.call("hello", { orgId, transferId, keys: transferKeys })) as {
      storage?: StorageIdentity
      probe?: StorageProbe
    }
    // Two cells on one object store or search index copy nothing, and the purge
    // of the moved copy would delete the live copy's files: refuse now. Config
    // names prove nothing either way: different spellings can name one store,
    // and one name can be many stores (each cell reaches its own search service
    // as `http://meilisearch:7700`, which refused every move live). The probe
    // decides: the target's probe visible here means shared.
    if (!hello.storage || !hello.probe) {
      throw new MoveAborted("precopy", "the target did not name its storage or write its probe")
    }
    const sameNames = sharedStorage((opts.storageIdentity ?? storageIdentity)(), hello.storage)
    const shared = await (opts.probeVisible ?? probeVisibleHere)(hello.probe).catch((err) => {
      throw new MoveAborted(
        "precopy",
        `the target's storage probe could not be checked here (${String((err as Error)?.message ?? err)})`,
      )
    })
    if (shared.length > 0 && sameNames.length > 0)
      shared.push(`(same names: ${sameNames.join(", ")})`)
    await target.call("storage-checked", { distinct: shared.length === 0 })
    if (shared.length > 0) {
      throw new MoveAborted("precopy", `the two cells share ${shared.join(" and ")}`)
    }
    await recordPeerStorage(transferId, { ...hello.storage, proven: true })
    const custom = await orgCustomApps(sql, orgId)
    const skipSchemas = custom.map((a) => a.schema)
    const base = { sql, orgId, transferId, instanceKeys: opts.instanceKeys, transferKeys }
    const p1 = await exportOrg({ ...base, skipSchemas, search: true })
    report.pass.full = sumRows((await target.call("import", {}, p1.lines)) as ImportResult)
    faultAt("precopy")
    let fingerprint: Fingerprint = p1.fingerprint
    if (custom.length > 0) {
      await target.call("install-apps", { packages: await readCustomAppPackages(sql, orgId) })
    }
    await copyObjects(await listChanged())
    check("precopy")
    // Control wrote the router's `moving` entry just before this agent started. KV takes up to a
    // minute to reach an edge that read it recently, and until then that edge ignores the pin: past
    // the commit it keeps sending clients here, and they wait out the rest of that minute on 503s.
    // A small org copies far faster than that, so the freeze waits for the entry to be everywhere.
    const settled = startedAt + (opts.routingSettleMs ?? ROUTING_SETTLE_MS)
    while (Date.now() < settled) {
      await Bun.sleep(Math.min(1000, settled - Date.now()))
      check("precopy")
    }
    // Pass 1b: what changed meanwhile (and the custom apps' rows, now that their tables exist there).
    const p1b = await exportOrg({ ...base, since: fingerprint, search: false })
    report.pass.pass1b = sumRows((await target.call("import", {}, p1b.lines)) as ImportResult)
    fingerprint = p1b.fingerprint
    await copyObjects(await listChanged())
    check("precopy")

    // ── draining ─────────────────────────────────────────────────────────
    setPhase("draining")
    await setLocal("draining")
    await beat()
    faultAt("draining")
    check("draining")
    const drainUntil = Date.now() + (opts.drainTimeoutMs ?? DRAIN_TIMEOUT_MS)
    for (;;) {
      const r = await orgQuiesceReport(orgId, "draining", transferId, {
        ...(opts.ackInstances ? { instances: opts.ackInstances } : {}),
      })
      // Writes are still accepted while draining: only work that must finish here counts.
      const drained =
        r.missing.length === 0 &&
        r.jobs === 0 &&
        r.turns === 0 &&
        r.claimedEvents === 0 &&
        r.pendingControlPlane === 0
      if (drained) break
      if (Date.now() >= drainUntil) {
        throw new MoveAborted(
          "draining",
          `not drained in time (turns ${r.turns}, jobs ${r.jobs}, events ${r.claimedEvents}, control-plane messages ${r.pendingControlPlane}, missing ${r.missing.length})`,
        )
      }
      await Bun.sleep(200)
      check("draining")
    }
    const frozenReply = await control.freeze()
    if (!frozenReply.ok) {
      if (frozenReply.code !== "unreachable") controlFrozen = false
      else controlFrozen = true // unknown: the abort asks it
      throw new MoveAborted(
        "control-freeze",
        `the control plane did not freeze the move (${frozenReply.code})`,
      )
    }
    controlFrozen = true

    // ── frozen: the write gap ────────────────────────────────────────────
    setPhase("frozen")
    gapStart = Date.now()
    const ceilingOf = (s: GapStep) => Math.round(GAP_STEPS[s].ceilingMs * (opts.ceilingScale ?? 1))
    await underCeiling(
      "freeze-acks",
      async () => {
        await setLocal("frozen")
        const acks = await awaitOrgTransferAcks(orgId, "frozen", transferId, {
          since: gapStart as number,
          timeoutMs: ceilingOf("freeze-acks"),
          ...(opts.ackInstances ? { instances: opts.ackInstances } : {}),
        })
        if (!acks.ok) throw new MoveAborted("freeze-acks", `no ack from ${acks.missing.join(", ")}`)
      },
      timings,
      scale,
    )
    void beat().catch(() => {})
    await opts.hooks?.afterFreeze?.()
    faultAt("frozen")
    check("freeze-acks")
    await underCeiling(
      "quiesce",
      async () => {
        const r = await awaitOrgQuiesced(orgId, "frozen", transferId, {
          since: gapStart as number,
          timeoutMs: ceilingOf("quiesce"),
          ...(opts.ackInstances ? { instances: opts.ackInstances } : {}),
        })
        if (!r.quiet) throw new MoveAborted("quiesce", `still busy: ${JSON.stringify(r)}`)
      },
      timings,
      scale,
    )
    const pass2 = await underCeiling(
      "scan-diff",
      async () => ({
        bundle: await exportOrg({ ...base, since: fingerprint, search: false }),
        jobs: await exportOrgJobs(orgId),
      }),
      timings,
      scale,
    )
    carried = pass2.jobs
    report.jobs = { carried: carried.jobs.length, schedulers: carried.schedulers.length }
    await opts.hooks?.beforeApply?.()
    report.pass.delta = sumRows(
      await underCeiling(
        "apply",
        async () => {
          const imported = (await target.call("import", {}, pass2.bundle.lines)) as ImportResult
          // Kept on the target before the commit: a source agent that dies
          // after it leaves the jobs and schedulers recoverable there.
          await target.call("stage-carry", {
            jobs: carried.jobs,
            schedulers: carried.schedulers,
          })
          return imported
        },
        timings,
        scale,
      ),
    )
    await opts.hooks?.beforeVerify?.()
    await underCeiling(
      "verify",
      async () => {
        const again = await scanFingerprint(sql, orgId)
        const diff = fingerprintDiff(again, pass2.bundle.fingerprint)
        if (diff.length > 0) {
          throw new MoveAborted("verify", `rows changed during the freeze: ${diff.join("; ")}`)
        }
        const keys = objectKeysOf(pass2.bundle.lines, orgId).filter((k) => !sent.has(k))
        await copyObjects(keys.map((key) => ({ key, modified: 0 })))
      },
      timings,
      scale,
    )
    await opts.hooks?.beforeCommit?.()
    check("verify")
    if (leaseUntil - Date.now() < LEASE_MARGIN_MS) {
      const d = await beat()
      check("commit")
      if (!d.ok || leaseUntil - Date.now() < LEASE_MARGIN_MS) {
        throw new MoveAborted("commit", "the lease is about to lapse")
      }
    }

    // ── the decision ─────────────────────────────────────────────────────
    let decided: "committed" | "aborted" | null
    try {
      const d = await underCeiling(
        "commit",
        () => control.commit(Date.now() - (gapStart as number)),
        timings,
        scale,
      )
      decided = isCommitted(d)
        ? "committed"
        : isAborted(d)
          ? "aborted"
          : d.ok
            ? null
            : d.code === "unreachable"
              ? null
              : "aborted"
      if (decided === "aborted")
        report.reason = `the control plane refused the commit (${d.ok ? d.state : d.code})`
    } catch (err) {
      if (!(err instanceof StepCeilingExceeded)) throw err
      decided = null
    }
    if (decided === null) decided = await askDecision()
    if (decided === "committed") faultAt("after-cas")
    if (decided === "committed") return await finishCommitted()
    if (decided === "aborted") {
      controlAborted = controlAborted ?? "commit refused"
      return await abort("commit", report.reason ?? "the control plane aborted the move")
    }
    stopBeating()
    report.outcome = "unresolved"
    report.reason = "the control plane could not be reached for the decision"
    log.error(
      { alert: "org_move_unresolved", orgId, transferId },
      "org move: no decision from the control plane; the org stays frozen until its resolver hears it",
    )
    return report
  } catch (err) {
    if (err instanceof AgentKilled) {
      stopBeating()
      report.outcome = "unresolved"
      report.reason = "killed"
      return report
    }
    const step =
      err instanceof MoveAborted ? err.step : err instanceof StepCeilingExceeded ? err.step : phase
    log.warn({ err, orgId, transferId, step }, "org move aborting")
    return await abort(step, String((err as Error).message ?? err))
  } finally {
    stopBeating()
  }
}
