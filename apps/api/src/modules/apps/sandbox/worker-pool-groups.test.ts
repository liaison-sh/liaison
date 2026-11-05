// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { SandboxWorkerPool } from "~/modules/apps/sandbox/worker-pool"

/**
 * One app's background jobs hold at most half the background workers. The
 * load modelled: 100 mailboxes over 10 orgs syncing at once, each sync a
 * background job of the mail app waiting on a slow IMAP server (latency
 * scaled down 100x from 2-10 s), a few of them hanging. Interactive calls and
 * other apps' jobs must still get a worker at once.
 */
describe("SandboxWorkerPool — background groups", () => {
  it("100 slow mailbox syncs over 10 orgs leave workers for interactive and other apps", async () => {
    const pool = new SandboxWorkerPool({
      size: 2,
      maxSize: 4,
      reservedInteractive: 1,
      timeoutMs: 30_000,
    })
    await pool.init()
    const hung: Array<() => void> = []
    try {
      // Background cap 4 - 1 = 3; one group may hold ceil(3 / 2) = 2.
      expect(pool.stats().backgroundGroupCap).toBe(2)
      const syncBundle = `async function sync(p, ctx) { await ctx.imap_fetch(p.mailbox); return { ok: p.mailbox } }`
      const maxGroupHeld: number[] = []
      const bridge = {
        imap_fetch: (mailbox: string) => {
          maxGroupHeld.push(pool.stats().backgroundGroups["job:mail"] ?? 0)
          const n = Number(mailbox.split("-")[1])
          // Every 25th mailbox's server never answers until the test lets it go.
          if (n % 25 === 0) return new Promise<void>((resolve) => hung.push(resolve))
          return Bun.sleep(20 + (n % 9) * 10)
        },
      }
      const syncs: Promise<unknown>[] = []
      for (let org = 0; org < 10; org++) {
        for (let box = 0; box < 10; box++) {
          syncs.push(
            pool.execute({
              bundleSource: syncBundle,
              exportName: "sync",
              params: { orgId: `org-${org}`, mailbox: `box-${org * 10 + box}` },
              bridge,
              priority: "background",
              backgroundGroup: "job:mail",
            }),
          )
        }
      }
      // The two mail slots are taken by the hanging syncs soon enough.
      const quick = async (exec: Promise<unknown>) =>
        Promise.race([
          exec.then(() => "done" as const),
          new Promise<"late">((r) => setTimeout(() => r("late"), 3_000)),
        ])

      // Another app's job is not parked behind the mail flood.
      const other = pool.execute({
        bundleSource: `function tick() { return { other: true } }`,
        exportName: "tick",
        params: {},
        bridge: {},
        priority: "background",
        backgroundGroup: "job:invoicing",
      })
      expect(await quick(other)).toBe("done")

      // Interactive calls get a worker promptly, several in a row.
      for (let i = 0; i < 5; i++) {
        const started = Date.now()
        const fg = pool.execute({
          bundleSource: `function quick() { return { fg: true } }`,
          exportName: "quick",
          params: {},
          bridge: {},
          priority: "interactive",
        })
        expect(await quick(fg)).toBe("done")
        expect(Date.now() - started).toBeLessThan(3_000)
      }

      expect(Math.max(...maxGroupHeld)).toBeLessThanOrEqual(2)
      expect(pool.stats().backgroundGroups["job:mail"] ?? 0).toBeLessThanOrEqual(2)

      // Let the hung servers answer: every sync completes, none is dropped.
      const release = setInterval(() => {
        for (const resolve of hung.splice(0)) resolve()
      }, 10)
      try {
        const results = await Promise.allSettled(syncs)
        expect(results.filter((r) => r.status === "rejected")).toEqual([])
        expect(results).toHaveLength(100)
      } finally {
        clearInterval(release)
      }
      expect(Math.max(...maxGroupHeld)).toBeLessThanOrEqual(2)
    } finally {
      for (const resolve of hung.splice(0)) resolve()
      await pool.shutdown()
    }
  }, 60_000)
})
