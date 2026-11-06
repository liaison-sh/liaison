// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An org's transfer state while it moves to another instance (migration 0268):
// the one reader every org entry point consults, the writer the move's driver
// uses, and the confirmations every process gives back.
//
// States (NULL = not moving, nothing changes for the org):
//  - `draining` (source): writes still accepted; no new agent turn starts from
//    a request, the org's jobs and outbox events are not picked up, so its live
//    work runs down;
//  - `frozen` (source): every write refused (503 `org_moving`), reads served,
//    sockets closed, jobs and events held;
//  - `incoming` (target): the copy being filled serves nothing until commit;
//  - `moved` (source, after the commit): every request refused, stragglers only.
//
// Every process keeps a snapshot of the moving orgs (one indexed read of the
// few non-null rows), refreshed at least every second by a ticker and at once
// on the change broadcast. A gate reads it through `orgTransferStateOf`, which
// refreshes a stale snapshot first and refuses (throws) when the state cannot
// be read: an unknown state never reads as "not moving".
//
// Confirmation: each process writes, per moving org, an ack into one Redis hash
// (`org-transfer:ack:{org}`, field = instance id) naming the state it applies
// and its own live work for the org (in-flight writes, running jobs, running
// agent turns). The driver waits until every live instance (infra/instance-
// registry.ts) confirmed the state (`awaitOrgTransferAcks`) and reports no
// live work (`awaitOrgQuiesced`), and gives up (fail closed) past a deadline.

import { and, count, sql as dsql, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { controlPlaneOutbox, organizations, pendingEvents } from "~/db/schema/kernel"
import { INSTANCE_ID } from "~/infra/instance-id"
import { LIVE_INSTANCES_SET, liveInstanceSet } from "~/infra/instance-registry"
import { rootLogger } from "~/lib/logger"
import { publishRedis, REDIS_PREFIX, redis, redisSub } from "~/lib/redis"

const log = rootLogger.child({ module: "org-transfer-state" })

export const ORG_TRANSFER_STATES = ["draining", "frozen", "incoming", "moved"] as const
export type OrgTransferState = (typeof ORG_TRANSFER_STATES)[number]

export function isOrgTransferState(value: unknown): value is OrgTransferState {
  return typeof value === "string" && (ORG_TRANSFER_STATES as readonly string[]).includes(value)
}

export interface OrgTransferRecord {
  orgId: string
  state: OrgTransferState
  transferId: string
  /** When the state was entered (epoch ms). */
  at: number
  /**
   * The row held a state, transfer id or time this release does not know: it
   * gates as `frozen`, and nothing acts on it (the resolver alerts only).
   */
  unknown?: true
}

// ── What each state refuses ──────────────────────────────────────────────────

/** Writes (mutating requests, webhooks, OAuth callbacks) are refused. */
export function refusesWrites(state: OrgTransferState): boolean {
  return state !== "draining"
}

/** Every request is refused, reads included. */
export function refusesReads(state: OrgTransferState): boolean {
  return state === "incoming" || state === "moved"
}

/** Websockets are closed and new ones refused (a socket's frames write). */
export function refusesSockets(state: OrgTransferState): boolean {
  return state !== "draining"
}

/** Moving: no new agent turn, job or outbox event of the org starts here. */
export function holdsWork(_state: OrgTransferState): boolean {
  return true
}

/** Past this, an org still draining, frozen or incoming alerts, and an aborted incoming copy is purged (resolver.ts). */
export const FREEZE_DEADLINE_MS = 45_000
/** A snapshot older than this is refreshed before a gate answers. */
export const SNAPSHOT_MAX_AGE_MS = 1_000
/** A refresh that fails keeps the last snapshot this long, then gates refuse. */
export const SNAPSHOT_FAIL_CLOSED_MS = 10_000
/** How long every live instance has to confirm a state. */
export const ACK_TIMEOUT_MS = 2_000

const CHANGE_CHANNEL = `${REDIS_PREFIX}org-transfer:changed`
const ackKey = (orgId: string) => `org-transfer:ack:${orgId}`
const ACK_TTL_S = 3_600

/** The transfer state could not be read: the gate refuses (fail closed), retryable. */
export class OrgTransferStateUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The organization's move state could not be read; try again.", { cause })
    this.name = "OrgTransferStateUnavailableError"
  }
}

/** One process's confirmation of an org's state, with its live work for the org. */
export interface OrgTransferAck {
  /** The state applied, or `none` once the org is no longer moving. */
  state: OrgTransferState | "none"
  transferId: string | null
  /** Mutating requests of the org still running in this process. */
  writes: number
  /** Jobs of the org still running in this process. */
  jobs: number
  /** Agent turns of the org still running in this process. */
  turns: number
  /** When the ack was written (epoch ms). */
  at: number
}

export type OrgActivityKind = "writes" | "jobs" | "turns"

export interface OrgTransferViewOptions {
  instanceId: string
  read: () => Promise<OrgTransferRecord[]>
  /** Write this process's acks (default: Redis). */
  writeAcks?: (acks: Map<string, OrgTransferAck>, instanceId: string) => Promise<void>
  now?: () => number
}

/**
 * One process's view of the moving orgs. The module keeps one (`view`); tests
 * build more to stand for more processes.
 */
export class OrgTransferView {
  private snapshot = new Map<string, OrgTransferRecord>()
  private loadedAt = 0
  private loadedOnce = false
  private refreshing: Promise<void> | null = null
  private readonly activity = new Map<string, Record<OrgActivityKind, number>>()
  /** Cross-org sweeps running, each with the orgs it leaves alone. */
  private readonly sweeps = new Set<ReadonlySet<string>>()
  private readonly listeners = new Set<
    (orgId: string, record: OrgTransferRecord | null, previous: OrgTransferRecord | null) => void
  >()
  readonly instanceId: string
  private readonly read: () => Promise<OrgTransferRecord[]>
  private readonly writeAcks: (acks: Map<string, OrgTransferAck>, id: string) => Promise<void>
  private readonly now: () => number

  constructor(opts: OrgTransferViewOptions) {
    this.instanceId = opts.instanceId
    this.read = opts.read
    this.writeAcks = opts.writeAcks ?? writeAcksToRedis
    this.now = opts.now ?? Date.now
  }

  /** Re-read the moving orgs now (shared with a refresh already running). */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    const run = (async () => {
      const rows = await this.read()
      const next = new Map(rows.map((r) => [r.orgId, r]))
      const changed: Array<[string, OrgTransferRecord | null, OrgTransferRecord | null]> = []
      for (const [orgId, rec] of next) {
        const prev = this.snapshot.get(orgId) ?? null
        if (!prev || prev.state !== rec.state || prev.transferId !== rec.transferId) {
          changed.push([orgId, rec, prev])
        }
      }
      for (const [orgId, prev] of this.snapshot) {
        if (!next.has(orgId)) changed.push([orgId, null, prev])
      }
      this.snapshot = next
      this.loadedAt = this.now()
      this.loadedOnce = true
      for (const [orgId, rec, prev] of changed) {
        for (const fn of this.listeners) {
          try {
            fn(orgId, rec, prev)
          } catch (err) {
            log.warn({ err, orgId }, "org transfer state listener failed")
          }
        }
      }
      // Every moving org is confirmed on each refresh; an org that just
      // stopped moving is confirmed once as `none`.
      const acks = new Map<string, OrgTransferAck>()
      for (const orgId of next.keys()) acks.set(orgId, this.ackOf(orgId))
      for (const [orgId, rec, prev] of changed) {
        if (rec === null)
          acks.set(orgId, { ...this.ackOf(orgId), transferId: prev?.transferId ?? null })
      }
      if (acks.size > 0) {
        await this.writeAcks(acks, this.instanceId).catch((err) =>
          log.warn({ err }, "org transfer acks not written; the next refresh retries"),
        )
      }
    })().finally(() => {
      this.refreshing = null
    })
    this.refreshing = run
    return run
  }

  /**
   * The org's transfer state, from a snapshot no older than a second. Throws
   * `OrgTransferStateUnavailableError` when it cannot be read and the last
   * snapshot is older than `SNAPSHOT_FAIL_CLOSED_MS` (or there is none).
   */
  async stateOf(orgId: string): Promise<OrgTransferRecord | null> {
    await this.ensureFresh()
    return this.snapshot.get(orgId) ?? null
  }

  /** Every moving org, from a fresh snapshot (fail closed like `stateOf`). */
  async current(): Promise<OrgTransferRecord[]> {
    await this.ensureFresh()
    return this.moving()
  }

  private async ensureFresh(): Promise<void> {
    if (!this.loadedOnce || this.now() - this.loadedAt >= SNAPSHOT_MAX_AGE_MS) {
      try {
        await this.refresh()
      } catch (err) {
        if (!this.loadedOnce || this.now() - this.loadedAt >= SNAPSHOT_FAIL_CLOSED_MS) {
          throw new OrgTransferStateUnavailableError(err)
        }
        log.warn({ err }, "org transfer state refresh failed; keeping the last snapshot")
      }
    }
  }

  /** Synchronous read of the last snapshot (no refresh). */
  peek(orgId: string): OrgTransferRecord | null {
    return this.snapshot.get(orgId) ?? null
  }

  /** The orgs moving now, per the last snapshot. */
  moving(): OrgTransferRecord[] {
    return [...this.snapshot.values()]
  }

  /** Be told when an org's state changes in this view. Returns the unsubscribe. */
  onChange(
    fn: (
      orgId: string,
      record: OrgTransferRecord | null,
      previous: OrgTransferRecord | null,
    ) => void,
  ): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /**
   * Count one piece of the org's live work (a mutating request, a job, an agent
   * turn) until the returned function is called. Process-local, every org: a
   * Map increment. When a moving org's work reaches zero the ack is rewritten
   * at once, so the driver's quiesce wait does not wait for the next tick.
   */
  begin(orgId: string, kind: OrgActivityKind): () => void {
    let counts = this.activity.get(orgId)
    if (!counts) {
      counts = { writes: 0, jobs: 0, turns: 0 }
      this.activity.set(orgId, counts)
    }
    counts[kind]++
    let ended = false
    return () => {
      if (ended) return
      ended = true
      const c = this.activity.get(orgId)
      if (!c) return
      c[kind] = Math.max(0, c[kind] - 1)
      const idle = c.writes === 0 && c.jobs === 0 && c.turns === 0
      if (idle) this.activity.delete(orgId)
      const a = this.activityOf(orgId)
      if (idle && a.writes === 0 && this.snapshot.has(orgId)) {
        void this.writeAcks(new Map([[orgId, this.ackOf(orgId)]]), this.instanceId).catch((err) =>
          log.warn({ err, orgId }, "org transfer ack after idle not written"),
        )
      }
    }
  }

  /**
   * Count a cross-org sweep (skip-moving.ts) until the returned function is
   * called. It read the moving set once, as `skipped`, and may write any other
   * org: every org outside `skipped` counts it as one write in flight, so a
   * freeze landing after that read waits for it in the quiesce.
   */
  beginSweep(skipped: Iterable<string>): () => void {
    const entry: ReadonlySet<string> = new Set(skipped)
    this.sweeps.add(entry)
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.sweeps.delete(entry)
      const idle = new Map<string, OrgTransferAck>()
      for (const orgId of this.snapshot.keys()) {
        if (entry.has(orgId)) continue
        const a = this.activityOf(orgId)
        if (a.writes === 0 && a.jobs === 0 && a.turns === 0) idle.set(orgId, this.ackOf(orgId))
      }
      if (idle.size > 0) {
        void this.writeAcks(idle, this.instanceId).catch((err) =>
          log.warn({ err }, "org transfer ack after a sweep not written"),
        )
      }
    }
  }

  /** The org has a write, job or agent turn of its own running in this process (sweeps aside). */
  hasOwnActivity(orgId: string): boolean {
    return this.activity.has(orgId)
  }

  /** This process's live work for the org (a sweep that may write it counts as a write). */
  activityOf(orgId: string): Record<OrgActivityKind, number> {
    const c = this.activity.get(orgId)
    let sweeps = 0
    for (const skipped of this.sweeps) if (!skipped.has(orgId)) sweeps++
    return { writes: (c?.writes ?? 0) + sweeps, jobs: c?.jobs ?? 0, turns: c?.turns ?? 0 }
  }

  private ackOf(orgId: string): OrgTransferAck {
    const rec = this.snapshot.get(orgId)
    return {
      state: rec?.state ?? "none",
      transferId: rec?.transferId ?? null,
      ...this.activityOf(orgId),
      at: this.now(),
    }
  }
}

async function writeAcksToRedis(acks: Map<string, OrgTransferAck>, id: string): Promise<void> {
  const pipe = redis.pipeline()
  for (const [orgId, ack] of acks) {
    pipe.hset(ackKey(orgId), id, JSON.stringify(ack))
    pipe.expire(ackKey(orgId), ACK_TTL_S)
  }
  await pipe.exec()
}

/** Read every moving org (privileged, cross-org: a handful of rows by a partial index). */
export async function readMovingOrgs(): Promise<OrgTransferRecord[]> {
  const rows = await withSystemDb("org-transfer-state-read", (db) =>
    db
      .select({
        id: organizations.id,
        state: organizations.transferState,
        transferId: organizations.transferId,
        at: organizations.transferAt,
      })
      .from(organizations)
      .where(isNotNull(organizations.transferState)),
  )
  const out: OrgTransferRecord[] = []
  for (const r of rows) {
    // A state a newer release wrote that this one does not know (or a record
    // missing its transfer id or time) is read as `frozen`: for a gate, unknown
    // means refuse writes, never accept them.
    const known = isOrgTransferState(r.state) && r.transferId !== null && r.at !== null
    out.push({
      orgId: r.id,
      state: isOrgTransferState(r.state) ? r.state : "frozen",
      transferId: r.transferId ?? "unknown",
      at: r.at ? r.at.getTime() : 0,
      ...(known ? {} : { unknown: true as const }),
    })
  }
  return out
}

/** This process's view. */
export const orgTransferView = new OrgTransferView({
  instanceId: INSTANCE_ID,
  read: readMovingOrgs,
})

/** The org's transfer state (null: not moving). Fail closed, see `OrgTransferView.stateOf`. */
export function orgTransferStateOf(orgId: string): Promise<OrgTransferRecord | null> {
  return orgTransferView.stateOf(orgId)
}

/**
 * The ids of every moving org, from a snapshot no older than a second (the
 * outbox claim leaves their events where they are). Fail closed like `stateOf`.
 */
export async function movingOrgIds(): Promise<string[]> {
  return (await orgTransferView.current()).map((r) => r.orgId)
}

/** Count a cross-org sweep that leaves `skipped` alone; call the result when it ends. */
export function beginOrgSweep(skipped: Iterable<string>): () => void {
  return orgTransferView.beginSweep(skipped)
}

/** Count one piece of the org's live work in this process; call the result when it ends. */
export function beginOrgActivity(orgId: string, kind: OrgActivityKind): () => void {
  return orgTransferView.begin(orgId, kind)
}

/**
 * Whether the org's runtime must stay set up in this process (the org runtime
 * cap): it is moving (per the last snapshot), or a write, job or agent turn of
 * its own is running here.
 */
export function orgRuntimePinnedByTransfer(orgId: string): boolean {
  return orgTransferView.peek(orgId) !== null || orgTransferView.hasOwnActivity(orgId)
}

let syncStarted = false
let ticker: ReturnType<typeof setInterval> | null = null

/**
 * Keep this process's view current: a refresh every second and at once on the
 * change broadcast. Idempotent; started once per process (app.ts).
 */
export async function initOrgTransferSync(): Promise<void> {
  if (syncStarted) return
  syncStarted = true
  redisSub.on("message", (channel) => {
    if (channel !== CHANGE_CHANNEL) return
    void orgTransferView
      .refresh()
      .catch((err) =>
        log.warn(
          { err },
          "org transfer state refresh after a broadcast failed; the ticker retries",
        ),
      )
  })
  ticker = setInterval(() => {
    void orgTransferView
      .refresh()
      .catch((err) => log.warn({ err }, "org transfer state refresh failed"))
  }, SNAPSHOT_MAX_AGE_MS)
  ticker.unref?.()
  await redisSub.subscribe(CHANGE_CHANNEL)
  await orgTransferView.refresh()
}

/** Stop the ticker (tests). */
export function stopOrgTransferSync(): void {
  if (ticker) clearInterval(ticker)
  ticker = null
}

// ── The writer (the move's driver, the operator CLI, the resolver) ───────────

export class OrgTransferConflictError extends Error {
  constructor(
    readonly orgId: string,
    readonly current: { state: string | null; transferId: string | null } | null,
  ) {
    super(
      current === null
        ? `organization ${orgId} not found`
        : `organization ${orgId} is ${current.state ?? "not moving"}${
            current.transferId ? ` for transfer ${current.transferId}` : ""
          }: the change is refused`,
    )
    this.name = "OrgTransferConflictError"
  }
}

/**
 * Set the org's transfer state for `transferId`, or clear it (`null`). Only
 * the transfer that holds the org may change it: setting a state on an org
 * held by another transfer, or clearing one held by another, throws
 * `OrgTransferConflictError`. Re-setting the same state is a no-op that keeps
 * `transfer_at`. Every process hears the change at once (broadcast) and within
 * a second without it (ticker).
 */
export async function setOrgTransferState(
  orgId: string,
  next: OrgTransferState | null,
  transferId: string,
): Promise<OrgTransferRecord | null> {
  const result = await withSystemDb("org-transfer-state-write", async (db) => {
    const [row] = await db
      .select({
        state: organizations.transferState,
        transferId: organizations.transferId,
        at: organizations.transferAt,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for("update")
    if (!row) throw new OrgTransferConflictError(orgId, null)
    const heldBy = row.transferId
    if (heldBy !== null && heldBy !== transferId) {
      throw new OrgTransferConflictError(orgId, { state: row.state, transferId: heldBy })
    }
    if (next === null) {
      if (heldBy === null) return null
      await db
        .update(organizations)
        .set({ transferState: null, transferId: null, transferAt: null })
        .where(eq(organizations.id, orgId))
      return null
    }
    if (row.state === next && row.at) {
      return { orgId, state: next, transferId, at: row.at.getTime() }
    }
    const [updated] = await db
      .update(organizations)
      .set({ transferState: next, transferId, transferAt: dsql`now()` })
      .where(eq(organizations.id, orgId))
      .returning({ at: organizations.transferAt })
    return { orgId, state: next, transferId, at: updated!.at!.getTime() }
  })
  log.info({ orgId, transferId, state: next ?? "none" }, "org transfer state set")
  await publishRedis(CHANGE_CHANNEL, JSON.stringify({ orgId })).catch((err) =>
    log.warn({ err, orgId }, "org transfer change broadcast failed; peers see it within a second"),
  )
  await orgTransferView
    .refresh()
    .catch((err) => log.warn({ err, orgId }, "own org transfer view refresh failed"))
  return result
}

// ── Confirmations and the quiesce probe (the driver's side) ──────────────────

/** The live instances of the cell (every role), per the instance registry. */
export async function liveInstanceIds(): Promise<string[]> {
  const members = await redis.smembers(LIVE_INSTANCES_SET)
  return [...(await liveInstanceSet(members))]
}

/** Every process's last ack for the org. */
export async function readOrgTransferAcks(orgId: string): Promise<Map<string, OrgTransferAck>> {
  const raw = await redis.hgetall(ackKey(orgId))
  const out = new Map<string, OrgTransferAck>()
  for (const [id, json] of Object.entries(raw)) {
    try {
      const v = JSON.parse(json) as Partial<OrgTransferAck>
      if (v.state !== "none" && !isOrgTransferState(v.state)) continue
      out.set(id, {
        state: v.state,
        transferId: typeof v.transferId === "string" ? v.transferId : null,
        writes: Number(v.writes ?? 0),
        jobs: Number(v.jobs ?? 0),
        turns: Number(v.turns ?? 0),
        at: Number(v.at ?? 0),
      })
    } catch {
      // A malformed ack confirms nothing.
    }
  }
  return out
}

export interface AckWaitOptions {
  /** The instances that must confirm (default: the live instances). */
  instances?: string[]
  timeoutMs?: number
  /** Acks older than this (epoch ms) do not count (default: any; the state and transfer id must match). */
  since?: number
  pollMs?: number
}

export interface AckWaitResult {
  ok: boolean
  /** Instances that did not confirm in time. */
  missing: string[]
}

function ackMatches(
  ack: OrgTransferAck | undefined,
  state: OrgTransferState | null,
  transferId: string,
  since: number,
): boolean {
  if (!ack || ack.at < since) return false
  return ack.state === (state ?? "none") && ack.transferId === transferId
}

/**
 * Wait until every live instance confirmed the org's `state` for `transferId`
 * (`null`: confirmed it is no longer moving). Fail closed: `ok: false` with
 * the instances that did not confirm within `timeoutMs` (default 2 s).
 */
export async function awaitOrgTransferAcks(
  orgId: string,
  state: OrgTransferState | null,
  transferId: string,
  opts: AckWaitOptions = {},
): Promise<AckWaitResult> {
  const timeoutMs = opts.timeoutMs ?? ACK_TIMEOUT_MS
  const pollMs = opts.pollMs ?? 50
  const since = opts.since ?? 0
  const deadline = Date.now() + timeoutMs
  // Ask every process to refresh now instead of on its next tick.
  await publishRedis(CHANGE_CHANNEL, JSON.stringify({ orgId })).catch(() => {})
  for (;;) {
    const instances = opts.instances ?? (await liveInstanceIds())
    const acks = await readOrgTransferAcks(orgId)
    const missing = instances.filter((id) => !ackMatches(acks.get(id), state, transferId, since))
    if (missing.length === 0) return { ok: true, missing }
    if (Date.now() >= deadline) return { ok: false, missing }
    await Bun.sleep(pollMs)
  }
}

export interface OrgQuiesceReport {
  /** True when every count below is 0 and no instance is missing. */
  quiet: boolean
  /** Instances that did not confirm the state. */
  missing: string[]
  /** Per kind, summed over the instances. */
  writes: number
  jobs: number
  turns: number
  /** Outbox events of the org claimed by a worker and not yet processed. */
  claimedEvents: number
  /** Messages of the org to the control plane not yet delivered. */
  pendingControlPlane: number
}

/**
 * The org's live work across the cell while it is `state` for `transferId`:
 * every live instance's ack (state confirmed, its in-flight writes, jobs and
 * turns) plus the claimed-unprocessed outbox rows and the pending control
 * plane messages of the org.
 */
export async function orgQuiesceReport(
  orgId: string,
  state: OrgTransferState,
  transferId: string,
  opts: { instances?: string[]; since?: number } = {},
): Promise<OrgQuiesceReport> {
  const instances = opts.instances ?? (await liveInstanceIds())
  const acks = await readOrgTransferAcks(orgId)
  const since = opts.since ?? 0
  const missing: string[] = []
  let writes = 0
  let jobs = 0
  let turns = 0
  for (const id of instances) {
    const ack = acks.get(id)
    if (!ackMatches(ack, state, transferId, since)) {
      missing.push(id)
      continue
    }
    writes += ack!.writes
    jobs += ack!.jobs
    turns += ack!.turns
  }
  const { claimedEvents, pendingControlPlane } = await withSystemDb(
    "org-transfer-quiesce",
    async (db) => {
      const [claimed] = await db
        .select({ n: count() })
        .from(pendingEvents)
        .where(
          and(
            eq(pendingEvents.orgId, orgId),
            isNull(pendingEvents.processedAt),
            isNull(pendingEvents.failedAt),
            isNotNull(pendingEvents.claimedAt),
          ),
        )
      const [control] = await db
        .select({ n: count() })
        .from(controlPlaneOutbox)
        .where(
          and(
            inArray(controlPlaneOutbox.status, ["pending", "sending"]),
            dsql`${controlPlaneOutbox.data}->>'orgId' = ${orgId}`,
          ),
        )
      return { claimedEvents: claimed?.n ?? 0, pendingControlPlane: control?.n ?? 0 }
    },
  )
  return {
    quiet:
      missing.length === 0 &&
      writes === 0 &&
      jobs === 0 &&
      turns === 0 &&
      claimedEvents === 0 &&
      pendingControlPlane === 0,
    missing,
    writes,
    jobs,
    turns,
    claimedEvents,
    pendingControlPlane,
  }
}

/**
 * Wait until `orgQuiesceReport` says quiet, re-reading every `pollMs`; the last
 * report comes back either way (`quiet: false` past `timeoutMs`).
 */
export async function awaitOrgQuiesced(
  orgId: string,
  state: OrgTransferState,
  transferId: string,
  opts: { instances?: string[]; since?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<OrgQuiesceReport> {
  const deadline = Date.now() + (opts.timeoutMs ?? ACK_TIMEOUT_MS)
  for (;;) {
    const report = await orgQuiesceReport(orgId, state, transferId, opts)
    if (report.quiet || Date.now() >= deadline) return report
    await Bun.sleep(opts.pollMs ?? 50)
  }
}
