// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The target transfer agent: one long-lived process on the target
// instance that receives the source agent's commands and runs them, ONE AT A
// TIME, in arrival order (so an abort queues behind a late apply and always
// sees what that apply left). It holds no decision of its own: the source
// drives, the control plane decides, and this side's freeze-deadline resolver
// (transfer-state/resolver.ts) purges or serves an `incoming` copy past its
// deadline when the source agent is gone.
//
// Wire (the private-network ssh channel; this process's stdin/stdout): every
// protocol line starts with `PROTOCOL_MARK` (any other stdout line, a log,
// is ignored by the reader). A command is `{id, cmd, args, lines}` followed by
// `lines` raw lines (a bundle), each also marked; a reply is
// `{id, ok: true, result}` or `{id, ok: false, error, code}`.
import type { MoveState } from "@liaison/control-plane-contract"
import { INSTANCE_ID } from "~/infra/instance-id"
import type { TransferredJob, TransferredScheduler } from "~/infra/jobs/jobs"
import { deleteObjects, putObject } from "~/infra/storage/object-storage"
import { isManagedEdition } from "~/lib/edition"
import { rootLogger } from "~/lib/logger"
import { BillingUnavailableError } from "~/modules/billing-managed/control-client"
import { askControlPlane } from "~/modules/org/transfer-state/resolver"
import {
  awaitOrgTransferAcks,
  orgTransferStateOf,
  readMovingOrgs,
  setOrgTransferState,
} from "~/modules/org/transfer-state/state"
import {
  adoptOutboxMessages,
  type CarriedMessage,
  readStagedCarry,
  runAfterCommit,
  stageCarry,
} from "./after-commit"
import { assertUuid, loadClosure, type TransferSql } from "./closure"
import { type CustomAppPackage, installCustomAppPackages } from "./custom-apps"
import { countOrgClosure, ImportRefused, importOrg } from "./import"
import { purgeTransferCopy } from "./purge"
import { type FamilyKeys, parseTransferKeys, type TransferKeys } from "./rekey"
import { applySearchCatchUp, searchDocHashes } from "./search"
import {
  assertIncomingPurgeSafe,
  clearStorageProbe,
  recordStorageProof,
  type StorageProbe,
  storageIdentity,
  writeStorageProbe,
} from "./storage-identity"

const log = rootLogger.child({ module: "org-transfer-agent-target" })

export const PROTOCOL_MARK = "@@xfer "

export type TargetCommand =
  | "hello"
  | "storage-checked"
  | "import"
  | "install-apps"
  | "put-objects"
  | "delete-objects"
  | "search-hashes"
  | "search-write"
  | "activate"
  | "stage-carry"
  | "after-commit"
  | "counts"
  | "adopt-outbox"
  | "abort"
  | "bye"

export interface CommandFrame {
  id: number
  cmd: TargetCommand
  args: Record<string, unknown>
  lines: number
}

export type ReplyFrame =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; code: string | null }

export interface TargetAgentDeps {
  sql: TransferSql & { begin: <T>(fn: (tx: TransferSql) => Promise<T>) => Promise<T> }
  ownKeys: FamilyKeys
  /** Instances that must ack the unfreeze (default: the live instances). */
  ackInstances?: string[]
  /**
   * What the control plane decided for this move (`move.status`); throws when
   * it cannot be asked. Default: ask it. A self-hosted instance with no
   * control plane configured (no endpoint or no registered identity) reads as
   * committed: there is nobody to arbitrate. A managed one refuses.
   */
  moveState?: (orgId: string, transferId: string) => Promise<MoveState>
}

/** Only the control plane decides a move is committed; the source's word is not enough. */
async function assertCommitted(
  deps: TargetAgentDeps,
  orgId: string,
  transferId: string,
): Promise<void> {
  let state: MoveState
  try {
    state = await (
      deps.moveState ?? (async (o: string, t: string) => (await askControlPlane(o, t)).state)
    )(orgId, transferId)
  } catch (err) {
    // A self-hosted instance has nobody to arbitrate. A managed one always
    // asks: a missing identity or endpoint there is a broken cell, and serving
    // on the source's word alone could give the org two writers.
    if (
      !isManagedEdition() &&
      err instanceof BillingUnavailableError &&
      /^no (control plane endpoint|registered identity)/.test(err.message)
    ) {
      return
    }
    throw new Error(
      `org transfer target: the control plane could not confirm the commit (${String((err as Error)?.message ?? err)})`,
    )
  }
  if (state !== "committed" && state !== "finalized") {
    throw new Error(`org transfer target: the control plane has the move ${state}, not committed`)
  }
}

export class TargetAgent {
  private orgId: string | null = null
  private transferId: string | null = null
  private keys: TransferKeys | null = null
  private probe: StorageProbe | null = null
  private queue: Promise<unknown> = Promise.resolve()
  closed = false

  constructor(private readonly deps: TargetAgentDeps) {}

  /** Run one command after every earlier one finished. */
  handle(
    cmd: TargetCommand,
    args: Record<string, unknown>,
    lines: string[] = [],
  ): Promise<unknown> {
    const run = this.queue.then(() => this.run(cmd, args, lines))
    this.queue = run.catch(() => {})
    return run
  }

  private need(): { orgId: string; transferId: string; keys: TransferKeys } {
    if (!this.orgId || !this.transferId || !this.keys) {
      throw new Error("org transfer target: hello first")
    }
    return { orgId: this.orgId, transferId: this.transferId, keys: this.keys }
  }

  private async run(
    cmd: TargetCommand,
    args: Record<string, unknown>,
    lines: string[],
  ): Promise<unknown> {
    switch (cmd) {
      case "hello": {
        // One org per session: a second hello would switch the org mid-move.
        if (this.orgId !== null) throw new Error("org transfer target: hello already received")
        this.orgId = assertUuid(String(args.orgId), "target hello")
        this.transferId = assertUuid(String(args.transferId), "target hello transfer")
        this.keys = parseTransferKeys(JSON.stringify(args.keys ?? {}))
        this.probe = await writeStorageProbe(this.orgId, this.transferId)
        return { instanceId: INSTANCE_ID, storage: storageIdentity(), probe: this.probe }
      }
      case "storage-checked": {
        // The source looked for the probe in its own stores. Only "distinct"
        // records the proof every later purge of the incoming copy requires.
        const { transferId } = this.need()
        if (this.probe) await clearStorageProbe(this.probe)
        this.probe = null
        if (args.distinct === true) await recordStorageProof(transferId)
        return { recorded: args.distinct === true }
      }
      case "import": {
        const { orgId, transferId, keys } = this.need()
        const r = await importOrg({
          sql: this.deps.sql,
          lines,
          transferKeys: keys,
          ownKeys: this.deps.ownKeys,
        })
        if (r.orgId !== orgId || r.transferId !== transferId) {
          throw new Error("org transfer target: the bundle is another org's or another move's")
        }
        return r
      }
      case "install-apps": {
        const { orgId, transferId } = this.need()
        return installCustomAppPackages(
          orgId,
          transferId,
          (args.packages ?? []) as CustomAppPackage[],
        )
      }
      case "put-objects": {
        const { orgId } = this.need()
        const objects = (args.objects ?? []) as Array<{
          key: string
          contentType: string
          b64: string
        }>
        for (const o of objects) {
          if (!o.key.startsWith(`orgs/${orgId}/`)) {
            throw new Error(`org transfer target: object ${o.key} is outside the org's prefix`)
          }
        }
        await Promise.all(
          objects.map((o) =>
            putObject({
              key: o.key,
              body: Buffer.from(o.b64, "base64"),
              contentType: o.contentType,
            }),
          ),
        )
        return { n: objects.length }
      }
      case "delete-objects": {
        const { orgId } = this.need()
        const keys = ((args.keys ?? []) as string[]).filter((k) => k.startsWith(`orgs/${orgId}/`))
        await deleteObjects(keys)
        return { n: keys.length }
      }
      case "search-hashes":
        return searchDocHashes(this.need().orgId)
      case "search-write":
        return applySearchCatchUp(this.need().orgId, {
          docs: lines,
          deleteIds: (args.deleteIds ?? []) as string[],
        })
      case "activate": {
        // Only after the control plane committed (the source sends it then).
        const { orgId, transferId } = this.need()
        await assertCommitted(this.deps, orgId, transferId)
        const started = Date.now()
        await setOrgTransferState(orgId, null, transferId)
        const acks = await awaitOrgTransferAcks(orgId, null, transferId, {
          since: started,
          ...(this.deps.ackInstances ? { instances: this.deps.ackInstances } : {}),
        })
        return acks
      }
      case "after-commit": {
        const { orgId, transferId } = this.need()
        const state = await orgTransferStateOf(orgId)
        if (state !== null) {
          throw new Error("org transfer target: after-commit while the org is not served here")
        }
        // What the source staged before the commit (it survives the source
        // agent); the command's own payload only when nothing was staged.
        const staged = await readStagedCarry(transferId)
        return runAfterCommit({
          orgId,
          transferId,
          jobs: staged?.jobs ?? ((args.jobs ?? []) as TransferredJob[]),
          schedulers: staged?.schedulers ?? ((args.schedulers ?? []) as TransferredScheduler[]),
        })
      }
      case "stage-carry": {
        // Before the commit: keep the carried jobs and schedulers here, so a
        // source agent that dies after the commit leaves them recoverable.
        const { orgId, transferId } = this.need()
        await stageCarry({
          orgId,
          transferId,
          jobs: (args.jobs ?? []) as TransferredJob[],
          schedulers: (args.schedulers ?? []) as TransferredScheduler[],
        })
        return { staged: true }
      }
      case "adopt-outbox": {
        const { orgId } = this.need()
        return adoptOutboxMessages(orgId, (args.messages ?? []) as CarriedMessage[])
      }
      case "counts": {
        const { orgId } = this.need()
        return countOrgClosure(this.deps.sql, await loadClosure(this.deps.sql), orgId)
      }
      case "abort": {
        if (!this.orgId || !this.transferId) return { purged: false }
        // The row itself, not this process's view: the import wrote `incoming`
        // straight to the database, and a view refreshed just before it still
        // reads the org as not moving for up to a second.
        const orgId = this.orgId
        const state = (await readMovingOrgs()).find((r) => r.orgId === orgId) ?? null
        if (state?.state !== "incoming" || state.transferId !== this.transferId) {
          return { purged: false, state: state?.state ?? null }
        }
        if (this.probe) await clearStorageProbe(this.probe).catch(() => {})
        await assertIncomingPurgeSafe(this.transferId)
        await purgeTransferCopy(this.orgId, this.transferId, "incoming")
        return { purged: true }
      }
      case "bye":
        this.closed = true
        return { bye: true }
    }
  }
}

function errorCode(err: unknown): string | null {
  if (err instanceof ImportRefused) return err.code
  const name = (err as Error)?.name
  return typeof name === "string" ? name : null
}

/**
 * Serve the target agent on a line stream (stdin) until `bye` or the end of
 * the input. Replies go to `output` (stdout), marked.
 */
export async function serveTargetAgent(
  input: AsyncIterable<string>,
  output: (line: string) => void,
  agent: TargetAgent,
): Promise<void> {
  let pending: { frame: CommandFrame; lines: string[] } | null = null
  const inflight: Promise<void>[] = []
  const dispatch = (frame: CommandFrame, lines: string[]) => {
    inflight.push(
      agent.handle(frame.cmd, frame.args, lines).then(
        (result) => output(PROTOCOL_MARK + JSON.stringify({ id: frame.id, ok: true, result })),
        (err) => {
          log.warn({ err, cmd: frame.cmd }, "org transfer target: command failed")
          output(
            PROTOCOL_MARK +
              JSON.stringify({
                id: frame.id,
                ok: false,
                error: String((err as Error)?.message ?? err),
                code: errorCode(err),
              }),
          )
        },
      ),
    )
  }
  for await (const raw of input) {
    if (!raw.startsWith(PROTOCOL_MARK)) continue
    const line = raw.slice(PROTOCOL_MARK.length)
    if (pending) {
      pending.lines.push(line)
      if (pending.lines.length === pending.frame.lines) {
        dispatch(pending.frame, pending.lines)
        pending = null
      }
      continue
    }
    const frame = JSON.parse(line) as CommandFrame
    if (frame.lines > 0) pending = { frame, lines: [] }
    else dispatch(frame, [])
    if (frame.cmd === "bye") break
  }
  await Promise.all(inflight)
}

/** The source's handle on the target: one call per command. */
export interface TargetChannel {
  call<T = unknown>(
    cmd: TargetCommand,
    args?: Record<string, unknown>,
    lines?: string[],
  ): Promise<T>
  close(): Promise<void>
}

export class TargetCommandFailed extends Error {
  constructor(
    readonly cmd: TargetCommand,
    message: string,
    readonly code: string | null,
  ) {
    super(`org transfer target ${cmd}: ${message}`)
    this.name = "TargetCommandFailed"
  }
}

/**
 * A channel over a line stream pair (the target agent's stdin and stdout,
 * e.g. through ssh). Replies are matched by id; the end of the target's
 * output fails every call still waiting.
 */
export function lineTargetChannel(
  write: (line: string) => void,
  replies: AsyncIterable<string>,
  onClose?: () => Promise<void>,
): TargetChannel {
  let next = 1
  const waiting = new Map<
    number,
    { cmd: TargetCommand; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  let ended: Error | null = null
  void (async () => {
    try {
      for await (const raw of replies) {
        if (!raw.startsWith(PROTOCOL_MARK)) continue
        const r = JSON.parse(raw.slice(PROTOCOL_MARK.length)) as ReplyFrame
        const w = waiting.get(r.id)
        if (!w) continue
        waiting.delete(r.id)
        if (r.ok) w.resolve(r.result)
        else w.reject(new TargetCommandFailed(w.cmd, r.error, r.code))
      }
      ended = new Error("org transfer target: the channel closed")
    } catch (err) {
      ended = err as Error
    }
    for (const w of waiting.values()) w.reject(ended)
    waiting.clear()
  })()
  return {
    call<T>(cmd: TargetCommand, args: Record<string, unknown> = {}, lines: string[] = []) {
      if (ended) return Promise.reject(ended)
      const id = next++
      const p = new Promise<T>((resolve, reject) => {
        waiting.set(id, { cmd, resolve: resolve as (v: unknown) => void, reject })
      })
      const frame: CommandFrame = { id, cmd, args, lines: lines.length }
      write(PROTOCOL_MARK + JSON.stringify(frame))
      for (const l of lines) write(PROTOCOL_MARK + l)
      return p
    },
    close: async () => {
      await onClose?.()
    },
  }
}

/** A channel straight onto an agent in this process (tests, a same-host move). */
export function localTargetChannel(agent: TargetAgent): TargetChannel {
  return {
    call: async <T>(
      cmd: TargetCommand,
      args: Record<string, unknown> = {},
      lines: string[] = [],
    ) => {
      try {
        return (await agent.handle(cmd, args, lines)) as T
      } catch (err) {
        throw new TargetCommandFailed(cmd, String((err as Error)?.message ?? err), errorCode(err))
      }
    },
    close: async () => {},
  }
}
