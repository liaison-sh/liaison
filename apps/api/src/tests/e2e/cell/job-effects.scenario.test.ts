// SPDX-License-Identifier: FSL-1.1-ALv2
// Outside effects happen once when a job is cut (S11), across real
// `src/index.ts` processes: A is an `api` process (it enqueues), the job hosts
// are `all` processes, one at a time, each replaced by the next once cut. The
// job (`test-effects:run`, test-support/harness/job-effects-routes.ts) runs the
// door its kind's production job runs:
//
//   digest-mail    sendEmailOnce, the digest jobs' door (in a load org: the
//                  effect sink, the measure a stress run reads)
//   webhook-retry  processWebhookRetry, the kernel `retry-webhook` job
//   app-effect     the sandbox bridge's ctx.effects steps, as the invoicing
//                  jobs (`einvoicing-transmit`, `deferred-retry`) run them
//
// - SIGKILL after the effect and before the job completed: the queue's stalled
//   check re-runs the job on the next host, which replays the stored outcome.
//   Each effect counted once (on the base: twice).
// - SIGKILL inside the effect (claimed, not stored): the re-run finds the
//   claim of a dead process. The mail and the app effect are unknown and not
//   repeated (the host logs `effect_unknown`). The webhook retry's handler
//   writes in one transaction, which the kill rolled back: nothing was
//   applied, so the re-run applies it (attempted twice, committed once).
// - SIGTERM inside the effect (the drain hands the job back): the next host
//   finishes it without repeating the effect.
//
// Covered by their own tests instead (no job seam here): the push fanout
// consumer's per-device claim (modules/push/fanout-consumer.test.ts, the crash
// before the marks), the Web Push fallback's claim before the send
// (modules/notifications/desktop-emitter), and the e-invoice deposit's unknown
// policy that asks the platform (bundled-apps/invoicing transmit.test.ts).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  api,
  bootstrap,
  createRoleCell,
  jsonLogLines,
  type RoleCell,
  type RoleProcess,
} from "@liaison/test-helpers"

// Clear of the lanes (0-3), the helper tests (50-61, 99) and the other cell
// scenarios (70-76).
const CELL_WORKER = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : 77

const KINDS = ["digest-mail", "webhook-retry", "app-effect"] as const
type Kind = (typeof KINDS)[number]

/** Faster instance liveness, so a killed process is seen gone in seconds. */
const CELL_ENV = {
  LIAISON_VERSION: "p3-cell-effects",
  LIVE_INSTANCE_TTL_MS: "6000",
  LIVE_INSTANCE_HEARTBEAT_MS: "2000",
  LOAD_HARNESS_KEY: "cell-load-harness-key-".padEnd(48, "x"),
}

/** A stalled job is re-run after up to two stalled checks (30 s each). */
const RECOVERY_MS = 120_000

interface State {
  /** The effect's count; for the webhook retry, its handler's committed writes. */
  count: number
  /** Every attempt, committed or not. */
  attempts: number
  sink: number
  outcomes: string[]
}

async function until<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 250,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined)
    if (v !== undefined) return v
    await Bun.sleep(everyMs)
  }
  return undefined
}

describe("S11: an outside effect happens once when its job is cut", () => {
  let cell: RoleCell
  let apiA: RoleProcess
  let host: RoleProcess
  let orgId: string
  let loadOrgId: string

  async function register(proc: RoleProcess): Promise<void> {
    const res = await api(proc.url, "/api/_test/job-effects/register", { method: "POST" })
    expect(res.status).toBe(200)
  }

  async function nextHost(env?: Record<string, string>): Promise<RoleProcess> {
    const p = await cell.spawn("all", env)
    await register(p)
    return p
  }

  async function enqueue(
    kind: Kind,
    org: string,
    key: string,
    phase: "mid" | "after",
    waitMs: number,
  ) {
    const res = await api(apiA.url, "/api/_test/job-effects/enqueue", {
      method: "POST",
      body: { kind, org, key, phase, waitMs },
    })
    expect(res.status).toBe(200)
  }

  async function state(kind: Kind, key: string, org: string): Promise<State> {
    const q = new URLSearchParams({ kind, key, org })
    const res = await api(apiA.url, `/api/_test/job-effects/state?${q}`)
    return res.body.data as State
  }

  /** Wait until every run's state satisfies `ok`; the states, or a timeout error. */
  async function waitAll(
    runs: Array<{ kind: Kind; key: string; org: string }>,
    ok: (s: State) => boolean,
    timeoutMs: number,
  ): Promise<State[]> {
    const got = await until(async () => {
      const all = await Promise.all(runs.map((r) => state(r.kind, r.key, r.org)))
      return all.every(ok) ? all : undefined
    }, timeoutMs)
    if (!got) {
      const now = await Promise.all(runs.map((r) => state(r.kind, r.key, r.org)))
      throw new Error(`timed out; states: ${JSON.stringify(now)}`)
    }
    return got
  }

  beforeAll(async () => {
    cell = await createRoleCell(CELL_WORKER, ["api", "all"], { serverEnv: CELL_ENV })
    ;[apiA, host] = cell.processes as [RoleProcess, RoleProcess]
    const boot = await bootstrap(host.url)
    orgId = boot.orgId
    // A second org, flagged as a load org: its mail goes to the effect sink.
    loadOrgId = crypto.randomUUID()
    await cell.db.sql.unsafe(
      `INSERT INTO "${cell.schemaPrefix}kernel".organizations (id, name, slug) VALUES ($1, 'Load', $2)`,
      [loadOrgId, `load-${loadOrgId.slice(0, 8)}`],
    )
    const flagged = await api(host.url, "/api/_test/job-effects/load-org", {
      method: "POST",
      body: { org: loadOrgId },
    })
    expect(flagged.status).toBe(200)
    await register(apiA)
    await register(host)
  }, 240_000)

  afterAll(async () => {
    await cell?.teardown()
  }, 60_000)

  it(
    "SIGKILL after the effect, before the job completed: the re-run replays it, each effect once",
    async () => {
      const tag = crypto.randomUUID().slice(0, 8)
      const runs = [
        { kind: "digest-mail" as const, key: `after-mail-${tag}`, org: loadOrgId },
        { kind: "webhook-retry" as const, key: crypto.randomUUID(), org: orgId },
        { kind: "app-effect" as const, key: `after-app-${tag}`, org: orgId },
      ]
      for (const r of runs) await enqueue(r.kind, r.org, r.key, "after", 30_000)
      // Every door returned on the host; the jobs are still running.
      const first = await waitAll(runs, (s) => s.outcomes.length === 1, 60_000)
      expect(first.map((s) => s.outcomes[0])).toEqual(["sunk", "returned", "ran"])

      host.proc.kill("SIGKILL")
      await host.proc.exited
      host = await nextHost()

      const after = await waitAll(runs, (s) => s.outcomes.length >= 2, RECOVERY_MS)
      // The mail went to the sink once; the handler and the app effect ran once.
      expect(after[0]).toMatchObject({ sink: 1 })
      expect(after[1]?.count).toBe(1)
      expect(after[1]?.attempts).toBe(1)
      expect(after[2]?.count).toBe(1)
      expect(after[0]?.outcomes[1]).toBe("replayed")
      expect(after[2]?.outcomes[1]).toBe("done")
    },
    RECOVERY_MS + 90_000,
  )

  it(
    "SIGKILL inside the effect: the claim of a dead process is unknown and never repeated, a rolled-back webhook handler is re-run",
    async () => {
      const tag = crypto.randomUUID().slice(0, 8)
      const runs = [
        { kind: "digest-mail" as const, key: `mid-mail-${tag}`, org: orgId },
        { kind: "webhook-retry" as const, key: crypto.randomUUID(), org: orgId },
        { kind: "app-effect" as const, key: `mid-app-${tag}`, org: orgId },
      ]
      for (const r of runs) await enqueue(r.kind, r.org, r.key, "mid", 90_000)
      // Each effect was attempted; none was stored (the run waits inside it),
      // and the webhook handler's transaction has not committed.
      await waitAll(runs, (s) => s.attempts === 1 && s.outcomes.length === 0, 60_000)
      expect((await state("webhook-retry", runs[1]!.key, orgId)).count).toBe(0)

      host.proc.kill("SIGKILL")
      await host.proc.exited
      host = await nextHost()

      const after = await waitAll(runs, (s) => s.outcomes.length >= 1, RECOVERY_MS)
      // The mail and the app effect: unknown, not repeated.
      expect(after.map((s) => s.count)).toEqual([1, 1, 1])
      expect(after[0]?.attempts).toBe(1)
      expect(after[2]?.attempts).toBe(1)
      expect(after[0]?.outcomes[0]).toBe("unknown")
      expect(after[2]?.outcomes[0]).toBe("unknown")
      // The webhook retry: its rolled-back handler ran again and committed once.
      expect(after[1]?.attempts).toBe(2)
      expect(after[1]?.outcomes[0]).toBe("returned")
      const unknown = jsonLogLines(host).filter((l) => l.msg === "effect_unknown")
      expect(unknown.length).toBeGreaterThanOrEqual(2)
    },
    RECOVERY_MS + 90_000,
  )

  it(
    "SIGTERM inside the effect: the job is handed back and the next host finishes it without repeating it",
    async () => {
      // This host drains jobs for one second, then hands them back.
      const old = host
      old.proc.kill("SIGKILL")
      await old.proc.exited
      host = await nextHost({ SHUTDOWN_JOB_DRAIN_MS: "1000" })

      const tag = crypto.randomUUID().slice(0, 8)
      const runs = [
        { kind: "digest-mail" as const, key: `term-mail-${tag}`, org: orgId },
        { kind: "webhook-retry" as const, key: crypto.randomUUID(), org: orgId },
        { kind: "app-effect" as const, key: `term-app-${tag}`, org: orgId },
      ]
      for (const r of runs) await enqueue(r.kind, r.org, r.key, "mid", 4_000)
      await waitAll(runs, (s) => s.attempts === 1, 60_000)

      const next = await nextHost()
      host.proc.kill("SIGTERM")
      expect(await host.proc.exited).toBe(0)
      host = next

      const after = await waitAll(runs, (s) => s.outcomes.length >= 1, RECOVERY_MS)
      expect(after.map((s) => s.count)).toEqual([1, 1, 1])
    },
    RECOVERY_MS + 120_000,
  )
})
