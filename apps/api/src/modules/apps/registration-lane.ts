// SPDX-License-Identifier: FSL-1.1-ALv2
import { AsyncLocalStorage } from "node:async_hooks"

/**
 * A FIFO lane running `concurrency` tasks at once. An app schema change in an
 * org's setup runs DDL on the app tables all orgs share (policies are dropped
 * and recreated), and two orgs doing it at the same time have deadlocked, so
 * that lane runs 1 unless the operator raises it.
 */
interface LaneEntry {
  key: string
  start: () => void
}

/** Set while a lane task runs: what it awaits must not queue behind itself. */
interface LaneFrame {
  done: boolean
}

export class RegistrationLane {
  private readonly queue: LaneEntry[] = []
  private active = 0
  private readonly frame = new AsyncLocalStorage<LaneFrame>()

  constructor(readonly concurrency = 1) {}

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    // A registration that needs another org registered runs that one inline:
    // queued, it would wait for the slot its caller holds, forever.
    if (this.frame.getStore()?.done === false) return task()
    return new Promise<T>((resolve, reject) => {
      const entry: LaneEntry = {
        key,
        start: () => {
          this.active++
          const frame: LaneFrame = { done: false }
          Promise.resolve()
            .then(() => this.frame.run(frame, task))
            .then(resolve, reject)
            .finally(() => {
              frame.done = true
              this.active--
              this.pump()
            })
        },
      }
      this.queue.push(entry)
      this.pump()
    })
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      this.queue.shift()?.start()
    }
  }
}

/** Runs a task in the serial lane for the app schema changes of an org's setup. */
export type SerializePersistent = <T>(task: () => Promise<T>) => Promise<T>

export interface OrgRegistrationDeps<O> {
  /** Orgs whose apps are registered in this process. */
  registered: ReadonlySet<string>
  /** Registrations in flight, shared by every caller. */
  inFlight: Map<string, Promise<void>>
  /**
   * Register the org's apps. Adds it to `registered` when it succeeds. Its
   * registration transactions that may change an app schema go through
   * `serialize`; the rest (the in-memory half, and the row writes of an org
   * whose stamp is stale when the app schemas are current) runs beside other
   * orgs'.
   */
  registerOrgApps: (
    orgId: string,
    opts: O | undefined,
    serialize: SerializePersistent,
  ) => Promise<void>
  /** App schema changes at once (the DDL on shared app tables): 1 by default. */
  concurrency: number
  /** In-memory registrations at once (org first touches in a burst). */
  memoryConcurrency: number
  /**
   * The catalog generation (catalog-generation.ts), and the refresh of an org's
   * apps to the current catalog. An activation switches the orgs already
   * registered; an org whose registration was in flight with the old catalog
   * is refreshed here when the generation moved during it.
   */
  catalog?: {
    generation: () => number
    refreshOrgApps: (orgId: string) => Promise<void>
  }
}

/**
 * Per-org app registration on first touch (S3). Nothing registers at boot: the
 * first request, socket, job or event for an org registers it here and waits.
 * Two lanes (H2): up to `memoryConcurrency` orgs fill their in-memory registries
 * at once, and only the registration transactions that may change an app
 * schema queue in the serial lane, where concurrent DDL on the shared app
 * tables has deadlocked.
 */
export class OrgRegistrationQueue<O> {
  private readonly memory: RegistrationLane
  private readonly persistent: RegistrationLane

  constructor(private readonly deps: OrgRegistrationDeps<O>) {
    this.memory = new RegistrationLane(deps.memoryConcurrency)
    this.persistent = new RegistrationLane(deps.concurrency)
  }

  /**
   * Register the org now and wait for it. Free for a registered org; callers
   * of an org already registering await the same work.
   */
  async ensure(orgId: string, opts?: O): Promise<void> {
    if (this.deps.registered.has(orgId)) return
    const inFlight = this.deps.inFlight.get(orgId)
    if (inFlight) {
      await inFlight
      return
    }
    await this.startRegistration(orgId, opts)
  }

  /**
   * Record the registration as in flight, so every caller awaits the same
   * work. The record goes when it settles: a failed registration is not
   * remembered as done, and the next demand retries it.
   */
  private startRegistration(orgId: string, opts: O | undefined): Promise<void> {
    const promise = this.memory.run(orgId, () => this.registerNow(orgId, opts))
    this.deps.inFlight.set(orgId, promise)
    const forget = () => {
      if (this.deps.inFlight.get(orgId) === promise) this.deps.inFlight.delete(orgId)
    }
    promise.then(forget, forget)
    return promise
  }

  private async registerNow(orgId: string, opts: O | undefined): Promise<void> {
    if (this.deps.registered.has(orgId)) return
    const catalog = this.deps.catalog
    let generation = catalog?.generation()
    await this.deps.registerOrgApps(orgId, opts, (task) => this.persistent.run(orgId, task))
    // The catalog changed while the org registered with the version it read
    // first: bring it to the current one (bounded; each round re-reads).
    for (let round = 0; catalog && round < 3 && catalog.generation() !== generation; round++) {
      generation = catalog.generation()
      await catalog.refreshOrgApps(orgId)
    }
  }
}
