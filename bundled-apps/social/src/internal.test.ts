// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B7 — internal (ungated, no-external-effect) mutations. set_triage writes the
// verdict and advances status only from new/triaged; it NEVER downgrades a
// handled / awaiting_approval / drafted finding (§8 skip-handled). watch_object
// backfill-links existing findings on the same parent. correct_triage is the
// deliberate-override path with no status guard.

import { describe, expect, test } from "bun:test"
import type { SocialToolCtx } from "./ctx"
import {
  addMonitorTerm,
  correctTriage,
  dismissFinding,
  removeMonitorTerm,
  setTriage,
  unwatchObject,
  watchObject,
} from "./internal"
import { createMockDb, type MockDb } from "./test-db"

function makeCtx(db: MockDb = createMockDb()): SocialToolCtx {
  return {
    orgId: "org-1",
    db,
    fetch: (async () => ({
      status: 200,
      ok: true,
      json: async () => ({}),
      text: async () => "",
    })) as never,
    connections: {},
    config: { get: async () => null },
    async emit() {},
  } as SocialToolCtx
}

describe("setTriage (B7)", () => {
  test("writes triage_category/urgency/should_reply and flips a new finding to triaged", async () => {
    const db = createMockDb()
    await db.insert("finding", {
      id: "f1",
      platform: "youtube",
      external_id: "y1",
      relation: "keyword_match",
      status: "new",
    })
    await setTriage(makeCtx(db), {
      finding_id: "f1",
      triage_category: "lead_question",
      urgency: 80,
      should_reply: true,
      triage_reason: "asks price",
    })
    const [row] = (await db.findMany("finding", { where: { id: "f1" } })) as Array<{
      triage_category: string
      urgency: number
      should_reply: boolean
      status: string
    }>
    expect(row).toMatchObject({
      triage_category: "lead_question",
      urgency: 80,
      should_reply: true,
      status: "triaged",
    })
  })

  test("on an already-handled finding does NOT downgrade status (skip-handled)", async () => {
    const db = createMockDb()
    await db.insert("finding", {
      id: "f1",
      platform: "youtube",
      external_id: "y1",
      relation: "keyword_match",
      status: "handled",
    })
    const res = await setTriage(makeCtx(db), {
      finding_id: "f1",
      triage_category: "lead_question",
      urgency: 80,
      should_reply: true,
    })
    const row = (await db.findMany("finding", { where: { id: "f1" } }))[0] as { status: string }
    expect(row.status).toBe("handled")
    expect(res).toMatchObject({ status: "skipped", reason: "already_handled" })
  })

  test("on an awaiting_approval finding does NOT reset it to triaged", async () => {
    const db = createMockDb()
    await db.insert("finding", {
      id: "f2",
      platform: "youtube",
      external_id: "y2",
      relation: "keyword_match",
      status: "awaiting_approval",
    })
    const res = await setTriage(makeCtx(db), {
      finding_id: "f2",
      triage_category: "lead_question",
      urgency: 50,
      should_reply: true,
    })
    const row = (await db.findMany("finding", { where: { id: "f2" } }))[0] as { status: string }
    expect(row.status).toBe("awaiting_approval")
    expect(res).toMatchObject({ status: "skipped", reason: "in_progress" })
  })
})

describe("correctTriage (B7 deliberate override)", () => {
  test("overwrites triage fields on a handled finding without the status guard", async () => {
    const db = createMockDb()
    await db.insert("finding", {
      id: "f1",
      platform: "youtube",
      external_id: "y1",
      relation: "keyword_match",
      status: "handled",
      triage_category: "spam",
    })
    const res = await correctTriage(makeCtx(db), {
      finding_id: "f1",
      triage_category: "lead_question",
      urgency: 90,
      should_reply: true,
    })
    expect(res).toMatchObject({ status: "corrected" })
    const row = (await db.findMany("finding", { where: { id: "f1" } }))[0] as {
      triage_category: string
      status: string
    }
    expect(row.triage_category).toBe("lead_question")
    expect(row.status).toBe("handled") // correction does not move the lifecycle status
  })
})

describe("dismissFinding (B7)", () => {
  test("flips status to dismissed", async () => {
    const db = createMockDb()
    await db.insert("finding", {
      id: "f1",
      platform: "youtube",
      external_id: "y1",
      relation: "keyword_match",
      status: "new",
    })
    await dismissFinding(makeCtx(db), { finding_id: "f1" })
    const row = (await db.findMany("finding", { where: { id: "f1" } }))[0] as { status: string }
    expect(row.status).toBe("dismissed")
  })
})

describe("watchObject / unwatchObject (B7 backfill-link)", () => {
  test("watch_object creates a watch and backfill-LINKS findings on the same parent (writes watched_object_id)", async () => {
    const db = createMockDb()
    // two findings already exist whose parent is the post we are about to watch
    await db.insert("finding", {
      id: "f1",
      platform: "facebook",
      external_id: "c1",
      relation: "comment_on_our_content",
      parent_external_id: "P1",
      status: "new",
    })
    await db.insert("finding", {
      id: "f2",
      platform: "facebook",
      external_id: "c2",
      relation: "comment_on_our_content",
      parent_external_id: "P1",
      status: "new",
    })
    const res = await watchObject(makeCtx(db), {
      platform: "facebook",
      external_id: "P1",
      object_type: "facebook_post",
    })
    expect(res).toMatchObject({ status: "watching", backfilled: 2 })
    const watch = (await db.findMany("watched_object", { where: { external_id: "P1" } }))[0] as {
      id: string
    }
    expect(watch).toBeTruthy()
    // §8 / §12 Surface-3: the siblings now carry the watched_object_id (the
    // pre-fix code only COUNTED them, leaving nothing for the findings stream).
    const findings = (await db.findMany("finding", {
      where: { parent_external_id: "P1" },
    })) as Array<{ watched_object_id: string }>
    expect(findings.every((f) => f.watched_object_id === watch.id)).toBe(true)
  })

  test("watch_object commits the watch with its backfilled links: a failing link leaves no watch", async () => {
    const db = createMockDb()
    await db.insert("finding", {
      id: "f1",
      platform: "facebook",
      external_id: "c1",
      relation: "comment_on_our_content",
      parent_external_id: "P1",
      status: "new",
    })
    await db.insert("finding", {
      id: "f2",
      platform: "facebook",
      external_id: "c2",
      relation: "comment_on_our_content",
      parent_external_id: "P1",
      status: "new",
    })
    const update = db.update.bind(db)
    db.update = async (entity, id, data) => {
      if (entity === "finding" && id === "f2") throw new Error("link refused")
      return update(entity, id, data)
    }
    await expect(
      watchObject(makeCtx(db), {
        platform: "facebook",
        external_id: "P1",
        object_type: "facebook_post",
      }),
    ).rejects.toThrow("link refused")
    expect(await db.count("watched_object", { where: { external_id: "P1" } })).toBe(0)
    const f1 = (await db.findMany("finding", { where: { id: "f1" } }))[0] as {
      watched_object_id?: string | null
    }
    expect(f1.watched_object_id ?? null).toBeNull()
  })

  test("watch_object is idempotent on the [platform, external_id] key", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await watchObject(ctx, {
      platform: "facebook",
      external_id: "P1",
      object_type: "facebook_post",
    })
    await watchObject(ctx, {
      platform: "facebook",
      external_id: "P1",
      object_type: "facebook_post",
    })
    expect(await db.count("watched_object", { where: { external_id: "P1" } })).toBe(1)
  })

  test("unwatch_object stops a watch", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await watchObject(ctx, {
      platform: "facebook",
      external_id: "P1",
      object_type: "facebook_post",
    })
    await unwatchObject(ctx, { platform: "facebook", external_id: "P1" })
    const w = (await db.findMany("watched_object", { where: { external_id: "P1" } }))[0] as {
      status: string
    }
    expect(w.status).toBe("stopped")
  })
})

describe("addMonitorTerm / removeMonitorTerm (monitor_terms_add / monitor_terms_remove)", () => {
  test("adds a new term (defaults kind=keyword, platform=null/all)", async () => {
    const db = createMockDb()
    const res = await addMonitorTerm(makeCtx(db), { value: "OurBrand" })
    expect(res.status).toBe("created")
    expect(res.term).toMatchObject({
      kind: "keyword",
      value: "OurBrand",
      platform: null,
      enabled: true,
    })
    expect(await db.count("monitor_term", {})).toBe(1)
  })

  test("re-adding an existing ENABLED term is a no-op (unchanged)", async () => {
    const db = createMockDb()
    const ctx = makeCtx(db)
    await addMonitorTerm(ctx, { value: "OurBrand" })
    const res = await addMonitorTerm(ctx, { value: "OurBrand" })
    expect(res.status).toBe("unchanged")
    expect(await db.count("monitor_term", {})).toBe(1)
  })

  test("re-adding a DISABLED term re-enables it instead of erroring (upsert on [platform,kind,value])", async () => {
    const db = createMockDb()
    await db.insert("monitor_term", {
      id: "t1",
      kind: "keyword",
      value: "OurBrand",
      platform: null,
      enabled: false,
    })
    const res = await addMonitorTerm(makeCtx(db), { value: "OurBrand" })
    expect(res.status).toBe("enabled")
    expect(res.term.enabled).toBe(true)
    expect(await db.count("monitor_term", {})).toBe(1)
  })

  test("handle-kind term with an explicit platform is scoped, not global", async () => {
    const db = createMockDb()
    const res = await addMonitorTerm(makeCtx(db), {
      value: "@ourbrand",
      kind: "handle",
      platform: "youtube",
    })
    expect(res.term).toMatchObject({ kind: "handle", value: "@ourbrand", platform: "youtube" })
    // Same value/kind but different (null) platform is a DISTINCT term, not a dup.
    const global = await addMonitorTerm(makeCtx(db), { value: "@ourbrand", kind: "handle" })
    expect(global.status).toBe("created")
    expect(await db.count("monitor_term", {})).toBe(2)
  })

  test("removeMonitorTerm by id", async () => {
    const db = createMockDb()
    const created = await addMonitorTerm(makeCtx(db), { value: "OurBrand" })
    const res = await removeMonitorTerm(makeCtx(db), { id: created.term.id })
    expect(res.status).toBe("removed")
    expect(await db.count("monitor_term", {})).toBe(0)
  })

  test("removeMonitorTerm by [platform,kind,value] key", async () => {
    const db = createMockDb()
    await addMonitorTerm(makeCtx(db), { value: "OurBrand", platform: "youtube" })
    const res = await removeMonitorTerm(makeCtx(db), { value: "OurBrand", platform: "youtube" })
    expect(res.status).toBe("removed")
    expect(await db.count("monitor_term", {})).toBe(0)
  })

  test("removeMonitorTerm on a non-existent term returns skipped/not_found", async () => {
    const db = createMockDb()
    const res = await removeMonitorTerm(makeCtx(db), { id: "does-not-exist" })
    expect(res).toMatchObject({ status: "skipped", reason: "not_found" })
  })
})
