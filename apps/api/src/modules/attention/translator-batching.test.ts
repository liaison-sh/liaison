// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D2 — attention translator fan-out batching. Before this fix, a single event
// with N recipients opened up to N `withPrivilegedDb` transactions for prefs
// (memoized per-unique-user, so at most N) PLUS N more for the insert (one
// per recipient, never memoized) — an N-recipient event cost roughly 2N
// privileged transactions. This collapses BOTH into ONE transaction each,
// using the PRODUCTION default deps (no injected insertAttentionRow), which
// is the path these tests must exercise — the existing translator.test.ts
// suite injects a per-row double and deliberately keeps the old per-row call
// SHAPE for those tests (see translator.ts's `usingDefaultInsert` split).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import * as privilegedModule from "~/db/privileged"
import type { AppEvent } from "~/infra/events/event-bus"
import { manifestAttentionRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import { resolveChannels } from "~/modules/notifications/router"
import type { UserPrefsSnapshot } from "./translator"
import {
  type AttentionRowInsert,
  buildAttentionRow,
  dedupeAttentionRowsForBatchInsert,
  defaultLoadPreferencesBatch,
  processTranslationEvent,
  routerContextFromPrefs,
} from "./translator"

const ORG = "00000000-0000-0000-0000-0000000000d1"
const KIND = "shopify:order.digest"

function userId(n: number): string {
  return `00000000-0000-0000-0000-0000000000${String(n).padStart(2, "0")}`
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'D2 Batch Org', 'd2-batch-org') ON CONFLICT DO NOTHING`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.attention_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_preferences
    WHERE user_id IN (SELECT id FROM kernel.users WHERE org_id = ${ORG})`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

beforeEach(() => {
  resetAppRegistries()
})

afterEach(async () => {
  resetAppRegistries()
  await sql`DELETE FROM kernel.attention_events WHERE org_id = ${ORG}`
})

function digestEvent(recipientIds: string[], overrides: Partial<AppEvent> = {}): AppEvent {
  return {
    app: "shopify",
    entity: "order",
    action: "digest",
    orgId: ORG,
    actorId: "system:shopify",
    actorType: "system",
    entityId: "digest-1",
    timestamp: "2026-07-10T12:00:00.000Z",
    metadata: { market: "EU" },
    data: { recipientIds },
    ...overrides,
  }
}

function registerFanoutTranslation() {
  manifestAttentionRegistry.set(
    [ORG, "shopify"],
    [
      {
        event: "order:digest",
        kind: KIND,
        urgency: 40,
        summary: "New digest",
        recipients: { kind: "participants", path: "data.recipientIds" },
      } as never,
    ],
  )
}

describe("attention translator D2 batching (production defaults)", () => {
  it("a 10-recipient event opens exactly ONE privileged transaction for prefs and ONE for the insert", async () => {
    registerFanoutTranslation()
    const ids: string[] = []
    for (let i = 1; i <= 10; i++) {
      const id = userId(i)
      ids.push(id)
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${id}, ${ORG}, ${`d2-u${i}@t.com`}, 'U') ON CONFLICT DO NOTHING`
    }

    const reasons: string[] = []
    const realWithPrivilegedDb = privilegedModule.withPrivilegedDb.bind(privilegedModule)
    const spy = spyOn(privilegedModule, "withPrivilegedDb").mockImplementation(
      // biome-ignore lint/suspicious/noExplicitAny: test passthrough wrapper
      (async (orgId: string, reason: string, fn: any, opts?: any) => {
        reasons.push(reason)
        // Delegate to the REAL implementation (not a stub) so the actual SQL
        // runs against the test DB — this test asserts transaction COUNT, not
        // a mocked side effect.
        return realWithPrivilegedDb(orgId, reason, fn, opts)
      }) as never,
    )

    try {
      await processTranslationEvent(digestEvent(ids))
    } finally {
      spy.mockRestore()
    }

    const prefsTx = reasons.filter((r) => r === "translator:load-prefs-batch")
    const insertTx = reasons.filter((r) => r === "translator:insert-attention-batch")
    expect(prefsTx.length).toBe(1)
    expect(insertTx.length).toBe(1)
    // Old per-recipient shape is gone: no `translator:load-prefs` (singular)
    // or `translator:insert-attention` (singular) calls on this path.
    expect(reasons.filter((r) => r === "translator:load-prefs").length).toBe(0)
    expect(reasons.filter((r) => r === "translator:insert-attention").length).toBe(0)

    const rows = extractRows<{ user_id: string }>(
      await sql`SELECT user_id FROM kernel.attention_events WHERE org_id = ${ORG} AND kind = ${KIND}`,
    )
    expect(rows.map((r) => r.user_id).sort()).toEqual([...ids].sort())
  })

  it("zero eligible recipients produces no INSERT (no empty-array SQL error)", async () => {
    registerFanoutTranslation()
    await expect(processTranslationEvent(digestEvent([]))).resolves.toBeUndefined()
  })

  it("two candidate rows sharing the same (userId, targetEntityType, targetEntityId, kind) — e.g. a mention translation and a participants translation both matching the same event and targeting the same user — are deduped last-writer-wins BEFORE the multi-row INSERT, so ON CONFLICT never has to affect the same row twice in one statement", () => {
    function row(overrides: Partial<AttentionRowInsert> = {}): AttentionRowInsert {
      return {
        orgId: ORG,
        userId: userId(1),
        app: "shopify",
        entityType: "order",
        entityId: "e1",
        kind: KIND,
        urgency: 40,
        summary: "first",
        actorId: null,
        actorType: "system",
        metadata: null,
        occurredAt: new Date("2026-07-10T12:00:00.000Z"),
        isUrgent: false,
        digestState: "pending",
        digestEligibleAt: new Date("2026-07-10T12:00:00.000Z"),
        ...overrides,
      }
    }
    const first = row({ summary: "first" })
    const second = row({ summary: "second (later, same conflict key)" })
    const distinct = row({ userId: userId(2), summary: "different user" })

    const deduped = dedupeAttentionRowsForBatchInsert([first, second, distinct])

    expect(deduped.length).toBe(2)
    const forUser1 = deduped.find((r) => r.userId === userId(1))
    expect(forUser1?.summary).toBe("second (later, same conflict key)")
    expect(deduped.some((r) => r.userId === userId(2))).toBe(true)
  })

  it("re-processing the same event (retry) is idempotent via ON CONFLICT upsert", async () => {
    registerFanoutTranslation()
    const id = userId(1)
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${id}, ${ORG}, 'd2-dup@t.com', 'U') ON CONFLICT DO NOTHING`

    await processTranslationEvent(digestEvent([id]))
    await processTranslationEvent(digestEvent([id])) // retry, e.g. after an outbox re-delivery

    const rows = extractRows<{ user_id: string }>(
      await sql`SELECT user_id FROM kernel.attention_events WHERE org_id = ${ORG} AND kind = ${KIND} AND user_id = ${id}`,
    )
    expect(rows.length).toBe(1)
  })
})

describe("defaultLoadPreferencesBatch (production prefs loader) — SQL round-trips a uuid list", () => {
  // Regression: the loader bound the JS id array as a single `= ANY(${userIds})`
  // parameter, which postgres.js does not coerce into a Postgres array literal —
  // Postgres rejects it with "malformed array literal", so EVERY batch load
  // threw and was swallowed (translator's try/catch), silently downgrading every
  // recipient to DEFAULT_PREFS (digestCadence 'off'). The D2 transaction-count
  // test above never caught it: the failure is caught and rows still land with
  // defaults. Only asserting that STORED prefs come back proves the query ran.
  const withPrefs = userId(21)
  const alsoQueried = userId(22)
  const noPrefs = userId(23)

  beforeEach(async () => {
    for (const [n, id] of [
      [21, withPrefs],
      [22, alsoQueried],
      [23, noPrefs],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${id}, ${ORG}, ${`d2-prefs-u${n}@t.com`}, 'U') ON CONFLICT DO NOTHING`
    }
    // Store a NON-default cadence: a swallowed-failure fallback (DEFAULT_PREFS =
    // 'off') would be observably different from a real load ('daily').
    await privilegedModule.withPrivilegedDb(ORG, "test-seed-prefs", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_preferences (user_id, digest_cadence, timezone)
        VALUES (${withPrefs}, 'daily', 'Europe/Paris')
        ON CONFLICT (user_id) DO UPDATE SET digest_cadence = 'daily', timezone = 'Europe/Paris'`)
    })
  })

  afterEach(async () => {
    await privilegedModule.withPrivilegedDb(ORG, "test-clear-prefs", async (tx) => {
      await tx.execute(
        drizzleSql`DELETE FROM kernel.user_preferences WHERE user_id IN (${withPrefs}, ${alsoQueried}, ${noPrefs})`,
      )
    })
  })

  it("returns stored preferences for a multi-id list without a 'malformed array literal' error", async () => {
    // Old bug: this call threw for any non-empty list. New: resolves.
    const prefs = await defaultLoadPreferencesBatch([withPrefs, alsoQueried, noPrefs], ORG)
    // The user WITH a row comes back with the stored cadence — proving the row
    // matched. A swallowed failure would omit it and the caller default to 'off'.
    expect(prefs.get(withPrefs)?.digestCadence).toBe("daily")
    expect(prefs.get(withPrefs)?.timezone).toBe("Europe/Paris")
    // Users without a preferences row are simply absent (caller applies defaults).
    expect(prefs.has(alsoQueried)).toBe(false)
    expect(prefs.has(noPrefs)).toBe(false)
  })

  it("round-trips a single-id list — the exact prod failure shape (one recipient)", async () => {
    const prefs = await defaultLoadPreferencesBatch([withPrefs], ORG)
    expect(prefs.get(withPrefs)?.digestCadence).toBe("daily")
  })

  it("returns an empty map for an empty id list (no DB round-trip)", async () => {
    const prefs = await defaultLoadPreferencesBatch([], ORG)
    expect(prefs.size).toBe(0)
  })
})

describe("buildAttentionRow (pure helper) — equivalence with the old per-recipient computation", () => {
  function prefs(overrides: Partial<UserPrefsSnapshot> = {}): UserPrefsSnapshot {
    return {
      digestCadence: "daily",
      workHoursStart: "09:00",
      workHoursEnd: "17:00",
      workDays: [1, 2, 3, 4, 5],
      timezone: "UTC",
      ...overrides,
    }
  }

  // The digest enqueue now reads the router's decision (S2); the decision is
  // built from the same prefs through the translator's own context builder.
  function decisionFor(
    p: UserPrefsSnapshot,
    userId: string,
    kind: string,
    isUrgent: boolean,
    now: Date,
  ) {
    return resolveChannels(
      { userId, orgId: ORG },
      { kind, app: "kernel", isUrgent },
      {
        now,
        loadContext: async () => routerContextFromPrefs(p, false),
      },
    )
  }

  const baseEvent: AppEvent = {
    app: "kernel",
    entity: "thread",
    action: "create",
    orgId: ORG,
    actorId: "00000000-0000-0000-0000-000000000aaa",
    actorType: "user",
    entityId: "e1",
    timestamp: "2026-05-12T23:00:00.000Z",
  }

  it("produces the same row shape the old per-recipient inline computation did", async () => {
    const occurredAt = new Date("2026-05-12T23:00:00.000Z")
    const row = buildAttentionRow({
      event: baseEvent,
      userId: "00000000-0000-0000-0000-000000000bbb",
      targetEntityType: "thread",
      targetEntityId: "e1",
      kind: "thread_reply",
      urgency: 30,
      summary: "hey",
      isUrgent: false,
      metadata: null,
      occurredAt,
      decision: await decisionFor(
        prefs({
          workHoursStart: "09:00",
          workHoursEnd: "17:00",
          workDays: [1, 2, 3, 4, 5],
        }),
        "00000000-0000-0000-0000-000000000bbb",
        "thread_reply",
        false,
        occurredAt,
      ),
    })
    expect(row.orgId).toBe(ORG)
    expect(row.userId).toBe("00000000-0000-0000-0000-000000000bbb")
    expect(row.kind).toBe("thread_reply")
    expect(row.urgency).toBe(30)
    expect(row.digestState).toBe("pending")
    // Outside 09:00-17:00 work window on a Tuesday evening -> deferred to next
    // work window open, same formula the old inline computeDigestEligibleAt used.
    expect(row.digestEligibleAt.toISOString()).toBe("2026-05-13T09:00:00.000Z")
  })

  it("urgent rows have digestEligibleAt = occurredAt regardless of work hours (equivalence with old isUrgent branch)", async () => {
    const occurredAt = new Date("2026-05-12T23:00:00.000Z")
    const row = buildAttentionRow({
      event: baseEvent,
      userId: "00000000-0000-0000-0000-000000000ccc",
      targetEntityType: "thread",
      targetEntityId: "e1",
      kind: "mention",
      urgency: 80,
      summary: "you were mentioned",
      isUrgent: true,
      metadata: null,
      occurredAt,
      decision: await decisionFor(
        prefs(),
        "00000000-0000-0000-0000-000000000ccc",
        "mention",
        true,
        occurredAt,
      ),
    })
    expect(row.digestEligibleAt).toEqual(occurredAt)
    expect(row.digestState).toBe("pending")
  })

  it("digestCadence='off' maps to suppressed even for urgent rows (equivalence with old computeDigestState)", async () => {
    const occurredAt = new Date("2026-05-12T12:00:00.000Z")
    const row = buildAttentionRow({
      event: baseEvent,
      userId: "00000000-0000-0000-0000-000000000ddd",
      targetEntityType: "thread",
      targetEntityId: "e1",
      kind: "mention",
      urgency: 90,
      summary: "urgent but opted out",
      isUrgent: true,
      metadata: null,
      occurredAt,
      decision: await decisionFor(
        prefs({ digestCadence: "off" }),
        "00000000-0000-0000-0000-000000000ddd",
        "mention",
        true,
        occurredAt,
      ),
    })
    expect(row.digestState).toBe("suppressed")
  })

  it("actorId normalizes a non-UUID sentinel (e.g. 'system') to null, matching the old inline toUuidOrNull", async () => {
    const occurredAt = new Date("2026-05-12T12:00:00.000Z")
    const row = buildAttentionRow({
      event: { ...baseEvent, actorId: "system" },
      userId: "00000000-0000-0000-0000-000000000eee",
      targetEntityType: "thread",
      targetEntityId: "e1",
      kind: "thread_reply",
      urgency: 30,
      summary: "hey",
      isUrgent: false,
      metadata: null,
      occurredAt,
      decision: await decisionFor(
        prefs(),
        "00000000-0000-0000-0000-000000000eee",
        "thread_reply",
        false,
        occurredAt,
      ),
    })
    expect(row.actorId).toBeNull()
  })
})
