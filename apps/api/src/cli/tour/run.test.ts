// SPDX-License-Identifier: FSL-1.1-ALv2
// `liaison tour start | list`: in process with a scripted clock and sleep (the
// member's moves happen "during" a poll), plus the real CLI entrypoint spawned
// as a child process for argv, the deep link, exit codes and the outbox row.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { findTour, type Tour } from "@liaison/shared"
import { runTourCli, type TourCliIo, tourDeepLink } from "~/cli/tour/run"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { loadTourOrgContext, readProgressRow, tourBeats, updateTour } from "~/modules/tours/service"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const API_DIR = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..")
const TOUR = findTour("kernel.sample", { includeTestTours: true }) as Tour

let orgId: string
let slug: string
let email: string
let userId: string

interface Script {
  io: TourCliIo
  out: string[]
  err: string[]
}

/** An io whose sleep runs the next scripted step (a move by the member) and advances the clock. */
function scripted(steps: Array<() => Promise<void>>, opts: { openClient?: boolean } = {}): Script {
  const out: string[] = []
  const err: string[] = []
  let clock = 0
  return {
    out,
    err,
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
        const step = steps.shift()
        if (step) await step()
      },
      hasOpenClient: async () => opts.openClient ?? false,
      pollMs: 2000,
    },
  }
}

/** The member's own move, as the web would make it. */
async function move(request: Parameters<typeof updateTour>[1]["request"]): Promise<void> {
  const ctx = await loadTourOrgContext(orgId)
  await withPrivilegedDb(orgId, "cli-tour-test-move", (tx) =>
    updateTour(tx, {
      orgId,
      userId,
      tour: TOUR,
      beats: tourBeats(TOUR, ctx),
      request,
      actor: { userId, actorType: "user" },
    }),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  const [org] = await sql`SELECT slug FROM kernel.organizations WHERE id = ${orgId}`
  slug = org!.slug as string
  userId = crypto.randomUUID()
  email = `tour-cli-${userId}@test.com`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status)
    VALUES (${userId}, ${orgId}, ${email}, 'Tour Member', 'active')`
})

afterAll(releaseTestLock)

beforeEach(async () => {
  await sql`DELETE FROM kernel.tour_progress WHERE org_id = ${orgId}`
  await sql`UPDATE kernel.users SET locale = NULL WHERE id = ${userId}`
})

const start = (s: Script, extra: string[] = []) =>
  runTourCli(["start", TOUR.id, "--user", email, "--org", slug, ...extra], s.io)

describe("liaison tour start (in process)", () => {
  it("starts the tour, queues kernel/tour:start, always prints the deep link, follows the beats and exits 0", async () => {
    const s = scripted([
      () => move({ advance: true }),
      () => move({ skip: true }),
      () => move({ advance: true }),
    ])
    expect(await start(s)).toBe(0)
    expect(s.out).toEqual([
      `tour ${TOUR.id} started for ${email}: Sample tour`,
      `deep link: ${tourDeepLink(TOUR.id)}`,
      "beat 1/3 Your apps",
      "beat 2/3 Post a message",
      "beat 3/3 Your tickets",
      "completed, skipped 1",
    ])
    expect(tourDeepLink(TOUR.id)).toEndWith("/?tour=kernel.sample")
    const row = await withPrivilegedDb(orgId, "t", (tx) =>
      readProgressRow(tx, { orgId, userId, tourId: TOUR.id }),
    )
    expect(row).toMatchObject({ source: "cli", status: "completed" })
    const [startEvent] = await sql`SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entity' = 'tour' AND payload->>'action' = 'start'`
    expect(startEvent!.payload.data).toMatchObject({
      ownerUserId: userId,
      tourId: TOUR.id,
      status: "active",
      beatId: "welcome",
    })
  })

  it("says so when the member has a tab open, and still prints the link", async () => {
    const s = scripted([() => move({ status: "abandoned" })], { openClient: true })
    expect(await start(s)).toBe(3)
    expect(s.out).toContain("open tab detected: the tour opens there now")
    expect(s.out).toContain(`deep link: ${tourDeepLink(TOUR.id)}`)
    expect(s.out.at(-1)).toBe("abandoned at beat 1/3")
  })

  it("times out with exit 4, reporting a pause on the way", async () => {
    const s = scripted([() => move({ status: "paused" })])
    expect(await start(s, ["--timeout", "5"])).toBe(4)
    expect(s.out).toContain("paused at beat 1/3")
    expect(s.out.at(-1)).toBe("timed out after 5s at beat 1/3")
  })

  it("restarts a finished tour from the first beat, in the member's language", async () => {
    await sql`UPDATE kernel.users SET locale = 'fr' WHERE id = ${userId}`
    const done = scripted([() => move({ status: "abandoned" })])
    await start(done)
    const again = scripted([() => move({ status: "abandoned" })])
    expect(await start(again)).toBe(3)
    expect(again.out).toContain("beat 1/3 Vos applications")
    expect(again.out[0]).toContain("Visite d'exemple")
  })

  it("refuses an unknown tour, an unknown member and bad usage with exit 2", async () => {
    const s = scripted([])
    expect(await runTourCli(["start", "kernel.nope", "--user", email, "--org", slug], s.io)).toBe(2)
    expect(
      await runTourCli(["start", TOUR.id, "--user", "nobody@x.test", "--org", slug], s.io),
    ).toBe(2)
    expect(await runTourCli(["start", TOUR.id], s.io)).toBe(2)
    expect(await runTourCli(["start", TOUR.id, "--user", email, "--timeout", "0"], s.io)).toBe(2)
    expect(await runTourCli(["dance"], s.io)).toBe(2)
    expect(s.err.join("\n")).toContain("unknown tour 'kernel.nope'")
    expect(s.err.join("\n")).toContain("no active member 'nobody@x.test'")
  })

  it("tour list prints the org's tours", async () => {
    const s = scripted([])
    expect(await runTourCli(["list", "--org", slug], s.io)).toBe(0)
    expect(s.out).toContain(`${TOUR.id}\t3 beats\tSample tour`)
  })
})

describe("liaison tour (real CLI process)", () => {
  function runCli(args: string[]) {
    const r = spawnSync("bun", ["run", "src/cli/index.ts", ...args], {
      cwd: API_DIR,
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "test", LOG_LEVEL: "fatal" },
      timeout: 60_000,
    })
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
  }

  it("start prints the deep link and times out with exit 4; list and a bad id answer", () => {
    const r = runCli(["tour", "start", TOUR.id, "--user", email, "--org", slug, "--timeout", "1"])
    expect(r.stderr).not.toContain("tour start:")
    expect(r.status).toBe(4)
    expect(r.stdout).toContain("/?tour=kernel.sample")
    expect(r.stdout).toContain("beat 1/3 Your apps")
    expect(r.stdout).toContain("timed out after 1s")

    const list = runCli(["tour", "list", "--org", slug])
    expect(list.status).toBe(0)
    expect(list.stdout).toContain(`${TOUR.id}\t3 beats`)

    const bad = runCli(["tour", "start", "kernel.nope", "--user", email, "--org", slug])
    expect(bad.status).toBe(2)
    expect(bad.stderr).toContain("unknown tour")
  }, 90_000)
})
