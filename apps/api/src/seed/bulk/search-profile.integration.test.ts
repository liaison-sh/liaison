// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The realistic search profile on a lively org: every kind gets its rows, the
// index ends up with the profile's document mix (windows derived from the
// messages, as in production), a third of the transcript carries a vector of
// the asked width, and a re-run adopts everything (same counts).
//
// The fraction is small by default (2 % of the heavy workspace) so the file
// runs in minutes; LIAISON_SEARCH_PROFILE_FRACTION=1 seeds the full heavy
// workspace for a local measurement of the index and the database.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { runAsSeed } from "~/modules/notifications/seeded"
import { seedContext } from "~/seed/context"
import { seedLivelyWorld } from "~/seed/tiers/lively/seed-lively"
import { installFromDist } from "../../../test-support/seed/install-dist-apps"
import {
  fakeVector,
  indexMix,
  PROFILE_KINDS,
  parseProfileSize,
  profileSpec,
  type SearchProfileResult,
  seedSearchProfile,
} from "./search-profile"

const DB_URL = process.env.DATABASE_URL ?? ""
const SLUG = `profile-${crypto.randomUUID().slice(0, 8)}`
const CATALOG_DEMO_APPS = ["invoicing", "social", "pennylane", "boxtal", "shopify", "monitoring"]
const FRACTION = Number(process.env.LIAISON_SEARCH_PROFILE_FRACTION ?? "0.02")
const DIMS = Number(process.env.LIAISON_SEARCH_PROFILE_DIMS ?? "768")

let orgId = ""
let ownerId = ""
let before: Record<string, number> = {}
let first: SearchProfileResult

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL))
    throw new Error("refusing to seed a shared database")
  DemoModeTestAccess.set(false)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(mkdtempSync(path.join(tmpdir(), "profile-")), "apps")
  }
  for (const app of CATALOG_DEMO_APPS) await installFromDist(app, crypto.randomUUID())
  const world = await seedLivelyWorld({ orgSlug: SLUG, personaPassword: "Profile-Walk-1!" })
  orgId = world.world.orgId
  ownerId = world.world.org.adminUserId
  before = await indexMix(orgId)
  const t0 = performance.now()
  first = await runAsSeed(() =>
    seedSearchProfile(seedContext({ orgId, now: new Date(Date.now()), log: console.log }), {
      ownerId,
      fraction: FRACTION,
      vectorDims: DIMS,
    }),
  )
  const sizes = await withSystemDb("profile-test-sizes", (tx) =>
    tx.execute(sql`SELECT pg_database_size(current_database())::bigint AS bytes`),
  )
  console.log(
    `[profile-test] fraction ${FRACTION}: ${JSON.stringify({ before, after: first.index, vectors: first.vectors, seconds: Math.round((performance.now() - t0) / 1000), dbBytes: (sizes as unknown as Array<{ bytes: string }>)[0]?.bytes })}`,
  )
}, 3_600_000)

afterAll(() => {
  DemoModeTestAccess.set(null)
})

describe("the realistic search profile", () => {
  it("parses the named sizes and scales every kind", () => {
    expect(parseProfileSize("heavy")).toBe(1)
    expect(parseProfileSize("typical")).toBe(0.25)
    expect(parseProfileSize("0.5")).toBe(0.5)
    expect(parseProfileSize("0")).toBeNull()
    expect(parseProfileSize("lots")).toBeNull()
    expect(profileSpec(1).message).toBe(31025)
    expect(profileSpec(0.25).contact).toBe(3147)
  })

  it("fake vectors are deterministic unit vectors of the asked width", () => {
    const v = fakeVector("doc-1", 64)
    expect(v).toHaveLength(64)
    expect(fakeVector("doc-1", 64)).toEqual(v)
    expect(fakeVector("doc-2", 64)).not.toEqual(v)
    expect(Math.abs(v.reduce((n, x) => n + x * x, 0) - 1)).toBeLessThan(1e-3)
  })

  it("writes every kind and the index holds the profile's mix", () => {
    for (const k of PROFILE_KINDS) {
      expect(first.rows[k]).toBe(first.spec[k])
      expect((first.index[k] ?? 0) - (before[k] ?? 0)).toBeGreaterThanOrEqual(first.spec[k])
    }
    // One window per MESSAGE_WINDOW_EVERY (4) messages, from the messages' ids.
    const windows = (first.index.message_window ?? 0) - (before.message_window ?? 0)
    expect(windows).toBeGreaterThan(first.spec.message / 6)
    expect(windows).toBeLessThan(first.spec.message / 3)
    expect(first.vectorDims).toBe(DIMS)
    const transcript = (first.index.message ?? 0) + (first.index.message_window ?? 0)
    expect(first.vectors).toBeGreaterThan(transcript / 5)
  })

  it("a re-run adopts what the first wrote", async () => {
    const again = await runAsSeed(() =>
      seedSearchProfile(seedContext({ orgId, now: new Date(Date.now()) }), {
        ownerId,
        fraction: FRACTION,
        vectorDims: DIMS,
      }),
    )
    expect(again.rows).toEqual(first.rows)
    expect(again.index).toEqual(first.index)
  }, 3_600_000)
})
