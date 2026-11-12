// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Alert-webhook handler tests:
//   • a valid critical alert creates an incident row AND emits incident:created
//     (the event the manifest's attention translations turn into a home-feed item)
//   • idempotency by (source, dedupKey) — a repeat delivery folds into the same
//     incident (count++, lastSeen bump) and emits incident:repeated, which has NO
//     attention translation → a flapping alert cannot flood the feed
//   • severity escalation (warning → critical) emits incident:escalated
//   • a delivery for a RESOLVED incident reopens it (incident:reopened)
//   • no dedupKey ⇒ every delivery is its own incident
//   • an invalid envelope is rejected 400 with no row and no emit
//   • a downstream emit failure returns 5xx so the sender retries
import { describe, expect, it } from "bun:test"
import { assignRefsJobHandler } from "./jobs"
import { incidents, makeCtx } from "./test-ctx"
import { alertWebhookHandler, CREATE_REF_BATCH, CREATED_LEASE_MS } from "./webhooks"

const BASE = {
  source: "grafana-prod",
  severity: "critical",
  title: "API p99 latency > 5s",
  body: "p99 latency 6.2s over the last 5m",
  dedupKey: "api-p99",
  ts: "2026-07-05T03:12:00Z",
  url: "https://grafana.example.com/alert/42",
}

describe("alertWebhookHandler", () => {
  it("creates an incident and emits incident:created for a valid critical alert", async () => {
    const { ctx, spy } = makeCtx()
    const res = await alertWebhookHandler(BASE, ctx)
    expect(res.status).toBe(200)

    const rows = incidents(spy)
    expect(rows.length).toBe(1)
    const row = rows[0]!
    expect(row.source).toBe("grafana-prod")
    expect(row.severity).toBe("critical")
    expect(row.title).toBe("API p99 latency > 5s")
    expect(row.status).toBe("open")
    expect(row.count).toBe(1)
    expect(row.dedup_key).toBe("api-p99")
    expect(row.url).toBe("https://grafana.example.com/alert/42")

    expect(spy.emits.length).toBe(1)
    const ev = spy.emits[0]!
    expect(ev.entity).toBe("incident")
    expect(ev.action).toBe("created")
    expect(ev.entityId).toBe(String(row.id))
    // The attention translation templates read data.title / data.source and
    // the `when` predicate reads data.severity — all must be on the event.
    const data = ev.data as Record<string, unknown>
    expect(data.title).toBe(BASE.title)
    expect(data.source).toBe(BASE.source)
    expect(data.severity).toBe("critical")
    // Axis metadata for subscription narrowing (filterableAxes).
    expect(ev.metadata).toMatchObject({ source: "grafana-prod", severity: "critical" })
  })

  it("dedups a repeat delivery into the same incident (count++, incident:repeated, no created re-emit)", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    const res = await alertWebhookHandler({ ...BASE, ts: "2026-07-05T03:13:00Z" }, ctx)
    expect(res.status).toBe(200)

    const rows = incidents(spy)
    expect(rows.length).toBe(1)
    expect(rows[0]!.count).toBe(2)

    expect(spy.emits.map((e) => e.action)).toEqual(["created", "repeated"])
  })

  it("emits incident:escalated when the same alert escalates warning → critical", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler({ ...BASE, severity: "warning" }, ctx)
    await alertWebhookHandler({ ...BASE, severity: "critical", ts: "2026-07-05T03:20:00Z" }, ctx)

    const rows = incidents(spy)
    expect(rows.length).toBe(1)
    expect(rows[0]!.severity).toBe("critical")
    expect(rows[0]!.count).toBe(2)
    expect(spy.emits.map((e) => e.action)).toEqual(["created", "escalated"])
  })

  it("does NOT emit escalated when severity goes down (critical → warning stays repeated)", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    await alertWebhookHandler({ ...BASE, severity: "warning", ts: "2026-07-05T03:30:00Z" }, ctx)
    expect(incidents(spy)[0]!.severity).toBe("critical")
    expect(spy.emits.map((e) => e.action)).toEqual(["created", "repeated"])
  })

  it("reopens a resolved incident when the same alert fires again", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    const row = incidents(spy)[0]!
    // Simulate a resolve.
    Object.assign(row, { status: "resolved", resolved_at: "2026-07-05T04:00:00Z" })

    const res = await alertWebhookHandler({ ...BASE, ts: "2026-07-05T05:00:00Z" }, ctx)
    expect(res.status).toBe(200)
    expect(incidents(spy).length).toBe(1)
    expect(row.status).toBe("open")
    expect(row.reopened_at).toBeDefined()
    expect(row.count).toBe(2)
    expect(spy.emits.map((e) => e.action)).toEqual(["created", "reopened"])
  })

  it("creates separate incidents when no dedupKey is sent", async () => {
    const { ctx, spy } = makeCtx()
    const { dedupKey: _omit, ...noKey } = BASE
    await alertWebhookHandler(noKey, ctx)
    await alertWebhookHandler(noKey, ctx)
    expect(incidents(spy).length).toBe(2)
    expect(spy.emits.map((e) => e.action)).toEqual(["created", "created"])
  })

  it("rejects an invalid envelope with 400 and writes/emits nothing", async () => {
    const { ctx, spy } = makeCtx()
    const res = await alertWebhookHandler({ source: "x", severity: "nuclear", title: "" }, ctx)
    expect(res.status).toBe(400)
    expect(incidents(spy).length).toBe(0)
    expect(spy.emits.length).toBe(0)
  })

  it("rejects a non-object payload with 400", async () => {
    const { ctx, spy } = makeCtx()
    const res = await alertWebhookHandler("not json", ctx)
    expect(res.status).toBe(400)
    expect(spy.emits.length).toBe(0)
  })

  it("accepts a numeric epoch-ms ts", async () => {
    const { ctx, spy } = makeCtx()
    const res = await alertWebhookHandler({ ...BASE, ts: 1751684000000 }, ctx)
    expect(res.status).toBe(200)
    expect(incidents(spy).length).toBe(1)
  })

  it("returns 5xx when the emit fails so the sender retries, and the retry recovers", async () => {
    const { ctx, spy } = makeCtx()
    spy.failNextEmit = true
    const res = await alertWebhookHandler(BASE, ctx)
    expect(res.status).toBeGreaterThanOrEqual(500)

    // Retry of the same delivery must converge to exactly one incident with
    // exactly one created emit — never a duplicate incident.
    const retry = await alertWebhookHandler(BASE, ctx)
    expect(retry.status).toBe(200)
    expect(incidents(spy).length).toBe(1)
    expect(spy.emits.filter((e) => e.action === "created").length).toBe(1)
  })

  it("a run killed after its insert: the redelivery answers 503 within the lease, then pages incident:created exactly once", async () => {
    const { ctx, spy } = makeCtx()
    // The first run inserts and numbers the incident, then dies inside its emit: it never
    // returns, never deletes the row, never clears created_pending.
    const emit = ctx.emit.bind(ctx)
    let killFirst = true
    ctx.emit = (async (event: Parameters<typeof emit>[0]) => {
      if (killFirst) {
        killFirst = false
        return new Promise(() => {})
      }
      return emit(event)
    }) as typeof ctx.emit
    void alertWebhookHandler(BASE, ctx)
    await new Promise((r) => setTimeout(r, 10))
    expect(incidents(spy).length).toBe(1)
    expect(incidents(spy)[0]!.created_pending).toBe(true)
    expect(spy.emits.length).toBe(0)

    // The kernel's replay a few seconds later: that run may still be sending, so no fold yet.
    const early = await alertWebhookHandler(BASE, ctx)
    expect(early.status).toBe(503)
    expect(spy.emits.length).toBe(0)
    expect(incidents(spy)[0]!.count).toBe(1)

    // Past the lease the run is dead: the replay pages the incident it created.
    const realNow = Date.now
    Date.now = () => realNow() + CREATED_LEASE_MS + 1_000
    try {
      const late = await alertWebhookHandler(BASE, ctx)
      expect(late.status).toBe(200)
      // A later repeat folds as a plain repeat: the page went out once.
      const again = await alertWebhookHandler({ ...BASE, ts: "2026-07-05T03:13:00Z" }, ctx)
      expect(again.status).toBe(200)
    } finally {
      Date.now = realNow
    }
    expect(spy.emits.map((e) => e.action)).toEqual(["created", "repeated"])
    const created = spy.emits[0]!
    expect(created.entityId).toBe(String(incidents(spy)[0]!.id))
    expect((created.data as Record<string, unknown>).severity).toBe("critical")
    expect(incidents(spy).length).toBe(1)
    expect(incidents(spy)[0]!.created_pending ?? null).toBeNull()
  })

  it("a created incident is not pending: its repeat folds at once", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    expect(incidents(spy)[0]!.created_pending ?? null).toBeNull()
    const res = await alertWebhookHandler({ ...BASE, ts: "2026-07-05T03:13:00Z" }, ctx)
    expect(res.status).toBe(200)
    expect(spy.emits.map((e) => e.action)).toEqual(["created", "repeated"])
  })

  it("survives an insert race on (source, dedupKey) by folding into the winner's incident", async () => {
    const { ctx, spy } = makeCtx()
    // Two concurrent first deliveries of the same alert.
    const [a, b] = await Promise.all([
      alertWebhookHandler(BASE, ctx),
      alertWebhookHandler({ ...BASE, ts: "2026-07-05T03:12:01Z" }, ctx),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(incidents(spy).length).toBe(1)
    expect(spy.emits.filter((e) => e.action === "created").length).toBe(1)
  })
})

// C1 (MON-16): the source clears its own alert. A resolve envelope carries
// `status: "resolved"` or `event: "resolve"`, needs (source, dedupKey, ts) and
// never creates an incident. C8: a folded alert refreshes `url`, and
// a non-http(s) url is refused at the door.
describe("alertWebhookHandler: resolve envelope", () => {
  const RESOLVE = {
    source: BASE.source,
    dedupKey: BASE.dedupKey,
    status: "resolved",
    ts: "2026-07-05T03:40:00Z",
  }

  it("resolves the open incident with the exact note, no resolver, and an auto incident:resolved event", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    const row = incidents(spy)[0]!
    const res = await alertWebhookHandler(RESOLVE, ctx)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body ?? "")).toEqual({ resolved: true, id: row.id })
    expect(row.status).toBe("resolved")
    expect(typeof row.resolved_at).toBe("string")
    expect(row.resolved_by).toBeNull()
    expect(row.resolution_note).toBe("cleared by grafana-prod at 2026-07-05T03:40:00.000Z")
    const ev = spy.emits.at(-1)!
    expect(ev.action).toBe("resolved")
    expect(ev.entityId).toBe(row.id)
    expect(ev.data).toEqual({
      id: row.id,
      status: "resolved",
      source: "grafana-prod",
      title: BASE.title,
      resolutionNote: "cleared by grafana-prod at 2026-07-05T03:40:00.000Z",
      auto: true,
      ref: "INC-1",
      refLabel: "[INC-1] ",
    })
    expect(ev.metadata).toEqual({ source: "grafana-prod", severity: "critical" })
  })

  it('accepts event:"resolve" and resolves an acknowledged incident', async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    const row = incidents(spy)[0]!
    Object.assign(row, { status: "acknowledged", acknowledged_by: "someone" })
    const { status: _s, ...noStatus } = RESOLVE
    const res = await alertWebhookHandler({ ...noStatus, event: "resolve" }, ctx)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body ?? "")).toEqual({ resolved: true, id: row.id })
    expect(row.status).toBe("resolved")
  })

  it("creates nothing when no incident matches", async () => {
    const { ctx, spy } = makeCtx()
    const res = await alertWebhookHandler(RESOLVE, ctx)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body ?? "")).toEqual({ resolved: false })
    expect(incidents(spy).length).toBe(0)
    expect(spy.emits.length).toBe(0)
  })

  it("is a no-op on an already resolved incident", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    const row = incidents(spy)[0]!
    Object.assign(row, {
      status: "resolved",
      resolved_by: "human",
      resolution_note: "fixed by hand",
    })
    const res = await alertWebhookHandler(RESOLVE, ctx)
    expect(JSON.parse(res.body ?? "")).toEqual({ resolved: false })
    expect(row.resolved_by).toBe("human")
    expect(row.resolution_note).toBe("fixed by hand")
    expect(spy.emits.map((e) => e.action)).toEqual(["created"])
  })

  it("refuses a resolve older than the incident's latest alert as stale", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    await alertWebhookHandler({ ...BASE, ts: "2026-07-05T03:50:00Z" }, ctx)
    const res = await alertWebhookHandler({ ...RESOLVE, ts: "2026-07-05T03:45:00Z" }, ctx)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body ?? "")).toEqual({ resolved: false, stale: true })
    expect(incidents(spy)[0]!.status).toBe("open")
    expect(spy.emits.map((e) => e.action)).toEqual(["created", "repeated"])
  })

  it("rejects a resolve without dedupKey with 400", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    const { dedupKey: _d, ...noKey } = RESOLVE
    const res = await alertWebhookHandler(noKey, ctx)
    expect(res.status).toBe(400)
    expect(incidents(spy)[0]!.status).toBe("open")
  })

  it("rejects an unknown status or event with 400", async () => {
    const { ctx, spy } = makeCtx()
    expect((await alertWebhookHandler({ ...BASE, status: "bogus" }, ctx)).status).toBe(400)
    expect((await alertWebhookHandler({ ...BASE, event: "firing" }, ctx)).status).toBe(400)
    expect(incidents(spy).length).toBe(0)
  })

  it("reopens an auto-resolved incident when the alert fires again", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    await alertWebhookHandler(RESOLVE, ctx)
    const res = await alertWebhookHandler({ ...BASE, ts: "2026-07-05T04:00:00Z" }, ctx)
    expect(res.status).toBe(200)
    const row = incidents(spy)[0]!
    expect(incidents(spy).length).toBe(1)
    expect(row.status).toBe("open")
    expect(row.resolution_note).toBeNull()
    expect(spy.emits.map((e) => e.action)).toEqual(["created", "resolved", "reopened"])
  })

  it("restores the incident and answers 503 when the resolved emit fails", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    spy.failNextEmit = true
    const res = await alertWebhookHandler(RESOLVE, ctx)
    expect(res.status).toBe(503)
    expect(incidents(spy)[0]!.status).toBe("open")
    expect(incidents(spy)[0]!.resolution_note ?? null).toBeNull()
  })

  it("a failed resolve emit does not clobber a fold that landed in between", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    Object.assign(incidents(spy)[0]!, {
      status: "acknowledged",
      acknowledged_at: "2026-07-05T03:20:00Z",
    })
    // While the resolve's emit is in flight, the alert fires again: the fold sees the incident
    // resolved and reopens it as a fresh episode. Then the resolve's emit fails.
    spy.duringNextEmit = async () => {
      const refire = await alertWebhookHandler({ ...BASE, ts: "2026-07-05T04:30:00Z" }, ctx)
      expect(refire.status).toBe(200)
      spy.failNextEmit = true
    }
    const res = await alertWebhookHandler(RESOLVE, ctx)
    expect(res.status).toBe(503)
    const row = incidents(spy)[0]!
    expect(row.status).toBe("open")
    expect(row.reopened_at ?? null).not.toBeNull()
    expect(row.resolution_note ?? null).toBeNull()
    expect(spy.emits.map((e) => e.action)).toEqual(["created", "reopened"])
  })
})

describe("alertWebhookHandler: incident url", () => {
  it("refreshes url from a folded alert and keeps it when the repeat carries none", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    await alertWebhookHandler(
      { ...BASE, ts: "2026-07-05T03:13:00Z", url: "https://grafana.example.com/alert/43" },
      ctx,
    )
    expect(incidents(spy)[0]!.url).toBe("https://grafana.example.com/alert/43")
    const { url: _u, ...noUrl } = BASE
    await alertWebhookHandler({ ...noUrl, ts: "2026-07-05T03:14:00Z" }, ctx)
    expect(incidents(spy)[0]!.url).toBe("https://grafana.example.com/alert/43")
  })

  it("refreshes url on reopen", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    Object.assign(incidents(spy)[0]!, { status: "resolved" })
    await alertWebhookHandler(
      { ...BASE, ts: "2026-07-05T05:00:00Z", url: "http://grafana.internal/alert/44" },
      ctx,
    )
    expect(incidents(spy)[0]!.url).toBe("http://grafana.internal/alert/44")
  })

  it("rejects a non-http(s) url with 400", async () => {
    const { ctx, spy } = makeCtx()
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "ftp://x.example/y",
      "grafana.example.com/a",
    ]) {
      expect((await alertWebhookHandler({ ...BASE, url }, ctx)).status).toBe(400)
    }
    expect(incidents(spy).length).toBe(0)
  })

  it("treats an empty or blank url as no url, on an alert and on a resolve", async () => {
    const { ctx, spy } = makeCtx()
    const { url: _u, ...noUrl } = BASE
    for (const url of ["", "   "]) {
      const res = await alertWebhookHandler({ ...noUrl, ts: "2026-07-05T03:12:00Z", url }, ctx)
      expect(res.status).toBe(200)
    }
    expect(incidents(spy).length).toBe(1)
    expect(incidents(spy)[0]!.url ?? null).toBeNull()
    const resolved = await alertWebhookHandler(
      {
        source: BASE.source,
        dedupKey: BASE.dedupKey,
        ts: "2026-07-05T04:00:00Z",
        status: "resolved",
        url: "",
      },
      ctx,
    )
    expect(resolved.status).toBe(200)
    expect(incidents(spy)[0]!.status).toBe("resolved")
  })
})

// every incident carries a short per-org ref (INC-<n>). The insert path numbers the
// new row inside its compensating try, so any failure after the insert deletes the row and
// the sender's retry re-creates it and emits incident:created.
describe("alertWebhookHandler: incident refs on create", () => {
  const OLD_ROW = (i: number) => ({
    id: `seed-${String(i).padStart(3, "0")}`,
    source: "old-source",
    severity: "warning",
    title: `Old incident ${i}`,
    status: "open",
    count: 1,
    dedup_key: `old-${i}`,
    first_seen_at: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
    last_seen_at: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
  })

  it("numbers a new incident and carries ref/refLabel on incident:created", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(BASE, ctx)
    expect(incidents(spy)[0]!.ref_number).toBe(1)
    const d = spy.emits[0]!.data as Record<string, unknown>
    expect({ ref: d.ref, refLabel: d.refLabel }).toEqual({ ref: "INC-1", refLabel: "[INC-1] " })

    await alertWebhookHandler({ ...BASE, dedupKey: "other", title: "Second" }, ctx)
    expect(incidents(spy).find((r) => r.dedup_key === "other")!.ref_number).toBe(2)
  })

  it("numbers older un-numbered incidents first, then the new one", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [OLD_ROW(2), OLD_ROW(1)])
    await alertWebhookHandler(BASE, ctx)
    const byId = Object.fromEntries(incidents(spy).map((r) => [r.id, r.ref_number]))
    expect(byId["seed-001"]).toBe(1)
    expect(byId["seed-002"]).toBe(2)
    expect(incidents(spy).find((r) => r.dedup_key === "api-p99")!.ref_number).toBe(3)
    const d = spy.emits[0]!.data as Record<string, unknown>
    expect(d.ref).toBe("INC-3")
  })

  it("allocation failure on the dedup path: no row, no emit, 503; the retry re-creates and emits created", async () => {
    const { ctx, spy } = makeCtx()
    spy.failNextAllocate = true
    const res = await alertWebhookHandler(BASE, ctx)
    expect(res.status).toBe(503)
    expect(incidents(spy).length).toBe(0)
    expect(spy.emits.length).toBe(0)

    const retry = await alertWebhookHandler(BASE, ctx)
    expect(retry.status).toBe(200)
    expect(incidents(spy).length).toBe(1)
    expect(incidents(spy)[0]!.ref_number).toBe(1)
    expect(spy.emits.map((e) => e.action)).toEqual(["created"])
  })

  it("allocation failure without a dedupKey: no row, 503; the retry re-creates and emits created", async () => {
    const { ctx, spy } = makeCtx()
    const { dedupKey: _omit, ...noKey } = BASE
    spy.failNextAllocate = true
    const res = await alertWebhookHandler(noKey, ctx)
    expect(res.status).toBe(503)
    expect(incidents(spy).length).toBe(0)
    expect(spy.emits.length).toBe(0)

    const retry = await alertWebhookHandler(noKey, ctx)
    expect(retry.status).toBe(200)
    expect(incidents(spy).length).toBe(1)
    expect(spy.emits.map((e) => e.action)).toEqual(["created"])
  })

  it("emit failure after numbering: the new row is deleted, older rows keep their refs, the retry gets the next number", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [OLD_ROW(1)])
    spy.failNextEmit = true
    const res = await alertWebhookHandler(BASE, ctx)
    expect(res.status).toBe(503)
    expect(incidents(spy).length).toBe(1)
    expect(incidents(spy)[0]!.id).toBe("seed-001")
    expect(incidents(spy)[0]!.ref_number).toBe(1)

    const retry = await alertWebhookHandler(BASE, ctx)
    expect(retry.status).toBe(200)
    const created = incidents(spy).find((r) => r.dedup_key === "api-p99")!
    // Value 2 was burned by the failed attempt.
    expect(created.ref_number).toBe(3)
    const d = spy.emits.at(-1)!.data as Record<string, unknown>
    expect(spy.emits.at(-1)!.action).toBe("created")
    expect(d.ref).toBe("INC-3")
  })

  it("re-read failure after numbering: the row is deleted, no emit; the retry re-creates and emits created", async () => {
    const { ctx, spy } = makeCtx()
    spy.failNextFindOne = "incidents"
    const res = await alertWebhookHandler(BASE, ctx)
    expect(res.status).toBe(503)
    expect(incidents(spy).length).toBe(0)
    expect(spy.emits.length).toBe(0)

    const retry = await alertWebhookHandler(BASE, ctx)
    expect(retry.status).toBe(200)
    expect(incidents(spy).length).toBe(1)
    expect(spy.emits.map((e) => e.action)).toEqual(["created"])
  })

  it("a create numbers at most CREATE_REF_BATCH rows: the new one too when every older row fits", async () => {
    expect(CREATE_REF_BATCH).toBe(10)
    const { ctx, spy } = makeCtx()
    // Reverse insertion order: ref order must follow first_seen_at, not insertion.
    spy.rows.set(
      "incidents",
      Array.from({ length: CREATE_REF_BATCH - 1 }, (_, i) => OLD_ROW(CREATE_REF_BATCH - 2 - i)),
    )
    await alertWebhookHandler(BASE, ctx)
    for (const r of incidents(spy).filter((x) => String(x.id).startsWith("seed-"))) {
      expect(r.ref_number).toBe(Number(String(r.id).slice(5)) + 1)
    }
    expect(incidents(spy).find((r) => r.dedup_key === "api-p99")!.ref_number).toBe(CREATE_REF_BATCH)
    expect((spy.emits[0]!.data as Record<string, unknown>).ref).toBe(`INC-${CREATE_REF_BATCH}`)
  })

  it("a backlog beyond CREATE_REF_BATCH: the oldest are numbered, the new one stays null (no ref on the event) until the job", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set(
      "incidents",
      Array.from({ length: CREATE_REF_BATCH + 5 }, (_, i) => OLD_ROW(CREATE_REF_BATCH + 4 - i)),
    )
    const res = await alertWebhookHandler(BASE, ctx)
    expect(res.status).toBe(200)
    const seeds = incidents(spy).filter((x) => String(x.id).startsWith("seed-"))
    for (const r of seeds) {
      const i = Number(String(r.id).slice(5))
      expect(r.ref_number ?? null).toBe(i < CREATE_REF_BATCH ? i + 1 : null)
    }
    const created = incidents(spy).find((r) => r.dedup_key === "api-p99")!
    expect(created.ref_number ?? null).toBeNull()
    expect(spy.sequences.get("monitoring:incident_ref")).toBe(CREATE_REF_BATCH)
    const d = spy.emits[0]!.data as Record<string, unknown>
    expect({ ref: d.ref, refLabel: d.refLabel }).toEqual({ ref: null, refLabel: "" })

    // The job drains the rest, oldest first: the new incident comes last.
    expect(await assignRefsJobHandler({}, ctx)).toEqual({ assigned: 6, remaining: false })
    expect(incidents(spy).find((r) => r.dedup_key === "api-p99")!.ref_number).toBe(
      CREATE_REF_BATCH + 6,
    )
  })

  it("created path and rollback both failing: still 503, and the log carries both errors as one-line summaries", async () => {
    const { ctx, spy } = makeCtx()
    // No dedupKey: the error reaches the outer catch (a dedup delivery would re-read and fold).
    const { dedupKey: _omit, ...noKey } = BASE
    spy.failNextEmit = true
    spy.failNextDelete = "incidents"
    const res = await alertWebhookHandler(noKey, ctx)
    expect(res.status).toBe(503)
    const line = spy.errors.find((e) => e.msg.includes("rollback failed"))
    expect(line?.data).toEqual({
      incidentId: incidents(spy)[0]!.id,
      createErr: "emit failed (test)",
      rollbackErr: "delete failed (test)",
    })
  })
})

// a repeat or reopen refreshes the incident text (title always, body when the
// delivery carries one); a reopen goes through a compare-and-set and archives the previous
// episode AFTER the update; the fold events carry the incident ref.
describe("alertWebhookHandler: fold refresh and episodes", () => {
  const T0 = "Disk almost full"
  const B0 = "disk at 91%"
  const T1 = "Disk full"
  const B1 = "disk at 100%"
  const R0 = "2026-07-05T04:00:00Z"
  const FIRST = { ...BASE, title: T0, body: B0 }

  async function resolvedIncident() {
    const made = makeCtx()
    await alertWebhookHandler(FIRST, made.ctx)
    const stored = incidents(made.spy)[0]!
    Object.assign(stored, { status: "resolved", resolved_at: R0, resolution_note: "restarted" })
    return { ...made, stored }
  }
  const episodes = (spy: ReturnType<typeof makeCtx>["spy"]) =>
    spy.rows.get("incident_comments") ?? []

  it("a repeat refreshes the title and keeps the body when the repeat carries none", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(FIRST, ctx)
    const { body: _b, ...noBody } = FIRST
    await alertWebhookHandler({ ...noBody, title: T1, ts: "2026-07-05T03:13:00Z" }, ctx)
    expect(incidents(spy)[0]!.title).toBe(T1)
    expect(incidents(spy)[0]!.body).toBe(B0)
    const d = spy.emits.at(-1)!.data as Record<string, unknown>
    expect(spy.emits.at(-1)!.action).toBe("repeated")
    expect(d.title).toBe(T1)
  })

  it("a repeat that carries a body replaces it", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(FIRST, ctx)
    await alertWebhookHandler({ ...FIRST, title: T1, body: B1, ts: "2026-07-05T03:13:00Z" }, ctx)
    expect(incidents(spy)[0]!.title).toBe(T1)
    expect(incidents(spy)[0]!.body).toBe(B1)
  })

  it("an escalation refreshes the title", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler({ ...FIRST, severity: "warning" }, ctx)
    await alertWebhookHandler(
      { ...FIRST, severity: "critical", title: T1, ts: "2026-07-05T03:20:00Z" },
      ctx,
    )
    expect(spy.emits.at(-1)!.action).toBe("escalated")
    expect(incidents(spy)[0]!.title).toBe(T1)
  })

  it("a reopen refreshes title and body and keeps the ref", async () => {
    const { ctx, spy, stored } = await resolvedIncident()
    await alertWebhookHandler({ ...FIRST, title: T1, body: B1, ts: "2026-07-05T05:00:00Z" }, ctx)
    expect(stored.status).toBe("open")
    expect(stored.title).toBe(T1)
    expect(stored.body).toBe(B1)
    expect(stored.ref_number).toBe(1)
    expect(spy.emits.at(-1)!.action).toBe("reopened")
  })

  it("the reopen compare-and-set is keyed on source AND dedup_key: other resolved incidents stay untouched", async () => {
    const { ctx, spy, stored } = await resolvedIncident()
    // Same source, other dedup_key; and same dedup_key, other source.
    await alertWebhookHandler({ ...FIRST, dedupKey: "other-key", title: "Other key" }, ctx)
    await alertWebhookHandler({ ...FIRST, source: "uptime-robot", title: "Other source" }, ctx)
    const others = incidents(spy).filter((r) => r.id !== stored.id)
    expect(others.length).toBe(2)
    for (const r of others) {
      Object.assign(r, {
        status: "resolved",
        resolved_at: R0,
        resolution_note: `closed ${r.title}`,
      })
    }
    const before = others.map((r) => ({ ...r }))

    await alertWebhookHandler({ ...FIRST, title: T1, body: B1, ts: "2026-07-05T05:00:00Z" }, ctx)

    expect(stored.status).toBe("open")
    expect(spy.emits.at(-1)!.action).toBe("reopened")
    expect(incidents(spy).filter((r) => r.id !== stored.id)).toEqual(before)
    expect(episodes(spy).map((e) => e.incident_id)).toEqual([stored.id])
  })

  it("a reopen writes the whole fresh-episode block: triage stamps cleared, new severity, timestamps of this delivery", async () => {
    const { ctx, spy, stored } = await resolvedIncident()
    const OLD = "2026-07-05T03:30:00.000Z"
    Object.assign(stored, {
      severity: "critical",
      acknowledged_at: OLD,
      acknowledged_by: "11111111-1111-1111-1111-111111111111",
      resolved_by: "22222222-2222-2222-2222-222222222222",
      last_seen_at: OLD,
      alert_ts: OLD,
      reopened_at: null,
    })
    const startedAt = Date.now()
    await alertWebhookHandler({ ...FIRST, severity: "warning", ts: "2026-07-05T05:00:00Z" }, ctx)

    expect(spy.emits.at(-1)!.action).toBe("reopened")
    expect({
      status: stored.status,
      // A reopen takes the delivery's severity verbatim, even a lower one (fresh episode).
      severity: stored.severity,
      acknowledged_at: stored.acknowledged_at,
      acknowledged_by: stored.acknowledged_by,
      resolved_at: stored.resolved_at,
      resolved_by: stored.resolved_by,
      resolution_note: stored.resolution_note,
      alert_ts: stored.alert_ts,
      count: stored.count,
    }).toEqual({
      status: "open",
      severity: "warning",
      acknowledged_at: null,
      acknowledged_by: null,
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
      alert_ts: "2026-07-05T05:00:00.000Z",
      count: 2,
    })
    // last_seen_at and reopened_at are both this delivery's server time.
    expect(typeof stored.reopened_at).toBe("string")
    expect(stored.last_seen_at).toBe(stored.reopened_at)
    expect(Date.parse(String(stored.reopened_at))).toBeGreaterThanOrEqual(startedAt - 1)
    expect((spy.emits.at(-1)!.data as Record<string, unknown>).severity).toBe("warning")
  })

  it("a reopen without a body keeps the body", async () => {
    const { ctx, stored } = await resolvedIncident()
    const { body: _b, ...noBody } = FIRST
    await alertWebhookHandler({ ...noBody, title: T1, ts: "2026-07-05T05:00:00Z" }, ctx)
    expect(stored.title).toBe(T1)
    expect(stored.body).toBe(B0)
  })

  it("a reopen archives the previous episode exactly once, from the pre-update values", async () => {
    const { ctx, spy, stored } = await resolvedIncident()
    await alertWebhookHandler({ ...FIRST, title: T1, body: B1, ts: "2026-07-05T05:00:00Z" }, ctx)
    const rows = episodes(spy)
    expect(rows.length).toBe(1)
    expect({
      kind: rows[0]!.kind,
      incident_id: rows[0]!.incident_id,
      episode_title: rows[0]!.episode_title,
      body: rows[0]!.body,
      episode_resolution_note: rows[0]!.episode_resolution_note,
      episode_resolved_at: rows[0]!.episode_resolved_at,
      author_id: rows[0]!.author_id,
    }).toEqual({
      kind: "episode",
      incident_id: stored.id,
      episode_title: T0,
      body: B0,
      episode_resolution_note: "restarted",
      episode_resolved_at: R0,
      author_id: null,
    })
    expect(stored.title).toBe(T1)
    expect(stored.body).toBe(B1)
  })

  it("an episode insert failure is logged and the reopened event still emits", async () => {
    const { ctx, spy, stored } = await resolvedIncident()
    spy.failNextInsert = "incident_comments"
    const res = await alertWebhookHandler({ ...FIRST, title: T1, ts: "2026-07-05T05:00:00Z" }, ctx)
    expect(res.status).toBe(200)
    expect(stored.status).toBe("open")
    expect(stored.title).toBe(T1)
    expect(episodes(spy).length).toBe(0)
    expect(spy.errors.filter((e) => e.msg.includes("episode archive failed")).length).toBe(1)
    expect(spy.emits.at(-1)!.action).toBe("reopened")
  })

  it("a second delivery after a reopen folds as a repeat and adds no second episode", async () => {
    const { ctx, spy } = await resolvedIncident()
    await alertWebhookHandler({ ...FIRST, title: T1, ts: "2026-07-05T05:00:00Z" }, ctx)
    await alertWebhookHandler({ ...FIRST, title: T1, ts: "2026-07-05T05:01:00Z" }, ctx)
    expect(spy.emits.map((e) => e.action).slice(-2)).toEqual(["reopened", "repeated"])
    expect(episodes(spy).length).toBe(1)
  })

  it("concurrent reopens: one wins the compare-and-set and archives, the loser folds as a repeat", async () => {
    const { ctx, spy } = await resolvedIncident()
    spy.duringNextUpdateMany = async () => {
      await alertWebhookHandler({ ...FIRST, ts: "2026-07-05T05:00:02Z" }, ctx)
    }
    const res = await alertWebhookHandler({ ...FIRST, ts: "2026-07-05T05:00:01Z" }, ctx)
    expect(res.status).toBe(200)
    expect(episodes(spy).length).toBe(1)
    expect(spy.emits.map((e) => e.action).slice(-2)).toEqual(["reopened", "repeated"])
    expect(incidents(spy)[0]!.count).toBe(3)
    const d = spy.emits.at(-1)!.data as Record<string, unknown>
    expect(d.ref).toBe("INC-1")
  })

  it("answers 503 (reopen_conflict) when the compare-and-set is lost twice", async () => {
    const { ctx, spy, stored } = await resolvedIncident()
    spy.duringNextUpdateMany = async () => {
      stored.status = "open"
      spy.duringNextFindMany = async () => {
        stored.status = "resolved"
        spy.duringNextUpdateMany = async () => {
          stored.status = "open"
        }
      }
    }
    const before = spy.emits.length
    const res = await alertWebhookHandler({ ...FIRST, ts: "2026-07-05T05:00:00Z" }, ctx)
    expect(res.status).toBe(503)
    expect(
      spy.errors.some((e) =>
        String((e.data as { err?: unknown })?.err).includes("reopen_conflict"),
      ),
    ).toBe(true)
    expect(episodes(spy).length).toBe(0)
    expect(spy.emits.length).toBe(before)
  })

  it("answers 503 (incident_not_found) when the row vanished under a lost compare-and-set", async () => {
    const { ctx, spy } = await resolvedIncident()
    spy.duringNextUpdateMany = async () => {
      spy.rows.set("incidents", [])
    }
    const res = await alertWebhookHandler({ ...FIRST, ts: "2026-07-05T05:00:00Z" }, ctx)
    expect(res.status).toBe(503)
    expect(
      spy.errors.some((e) =>
        String((e.data as { err?: unknown })?.err).includes("incident_not_found"),
      ),
    ).toBe(true)
    expect(episodes(spy).length).toBe(0)
  })

  it("a repeat or reopen with an empty body keeps the stored body (same rule as url)", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(FIRST, ctx)
    await alertWebhookHandler({ ...FIRST, body: "", ts: "2026-07-05T03:13:00Z" }, ctx)
    expect(incidents(spy)[0]!.body).toBe(B0)

    const reopened = await resolvedIncident()
    await alertWebhookHandler({ ...FIRST, body: "", ts: "2026-07-05T05:00:00Z" }, reopened.ctx)
    expect(reopened.stored.status).toBe("open")
    expect(reopened.stored.body).toBe(B0)
  })

  it("strips U+0000 from the title and body of a delivery instead of failing it", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(FIRST, ctx)
    const res = await alertWebhookHandler(
      { ...FIRST, title: "Disk\u0000 full", body: "a\u0000b", ts: "2026-07-05T03:13:00Z" },
      ctx,
    )
    expect(res.status).toBe(200)
    expect({ title: incidents(spy)[0]!.title, body: incidents(spy)[0]!.body }).toEqual({
      title: "Disk full",
      body: "ab",
    })
    // A title made only of NULs is empty once stripped: refused like an empty title.
    expect((await alertWebhookHandler({ ...FIRST, title: "\u0000" }, ctx)).status).toBe(400)
  })

  it("an episode insert failure logs a one-line summary, never the row content the error carries", async () => {
    const { ctx, spy } = await resolvedIncident()
    const insert = ctx.db.insert.bind(ctx.db)
    ctx.db.insert = (async (entity: string, data: Record<string, unknown>) => {
      if (entity === "incident_comments") {
        throw new Error(
          `Failed query: insert into "incident_comments" values ($1, $2)\nparams: ${String(data.body)} - pg: 22021`,
        )
      }
      return insert(entity, data)
    }) as typeof ctx.db.insert
    const res = await alertWebhookHandler({ ...FIRST, title: T1, ts: "2026-07-05T05:00:00Z" }, ctx)
    expect(res.status).toBe(200)
    const line = spy.errors.find((e) => e.msg.includes("episode archive failed"))!
    expect(line.data).toEqual({
      incidentId: incidents(spy)[0]!.id,
      err: 'Failed query: insert into "incident_comments" values ($1, $2)',
    })
    expect(JSON.stringify(spy.errors)).not.toContain(B0)
  })

  it("folds into an un-numbered incident carry an empty label and never number it", async () => {
    for (const [status, severity, action] of [
      ["open", "critical", "repeated"],
      ["open", "warning", "escalated"],
      ["resolved", "critical", "reopened"],
    ] as const) {
      const { ctx, spy } = makeCtx()
      spy.rows.set("incidents", [
        {
          id: "row-legacy",
          source: FIRST.source,
          dedup_key: FIRST.dedupKey,
          severity,
          status,
          title: T0,
          count: 1,
          first_seen_at: "2026-06-01T00:00:00.000Z",
          last_seen_at: "2026-06-01T00:00:00.000Z",
        },
      ])
      await alertWebhookHandler({ ...FIRST, ts: "2026-07-05T05:00:00Z" }, ctx)
      const ev = spy.emits.at(-1)!
      expect(ev.action).toBe(action)
      const d = ev.data as Record<string, unknown>
      expect({ ref: d.ref, refLabel: d.refLabel }).toEqual({ ref: null, refLabel: "" })
      expect(incidents(spy)[0]!.ref_number ?? null).toBeNull()
      expect(spy.sequences.has("monitoring:incident_ref")).toBe(false)
    }
  })

  it("every fold event carries ref and refLabel", async () => {
    const repeated = makeCtx()
    await alertWebhookHandler(FIRST, repeated.ctx)
    await alertWebhookHandler({ ...FIRST, ts: "2026-07-05T03:13:00Z" }, repeated.ctx)

    const escalated = makeCtx()
    await alertWebhookHandler({ ...FIRST, severity: "warning" }, escalated.ctx)
    await alertWebhookHandler({ ...FIRST, ts: "2026-07-05T03:13:00Z" }, escalated.ctx)

    const reopened = await resolvedIncident()
    await alertWebhookHandler({ ...FIRST, ts: "2026-07-05T05:00:00Z" }, reopened.ctx)

    for (const [action, spy] of [
      ["repeated", repeated.spy],
      ["escalated", escalated.spy],
      ["reopened", reopened.spy],
    ] as const) {
      const ev = spy.emits.at(-1)!
      expect(ev.action).toBe(action)
      const d = ev.data as Record<string, unknown>
      expect({ ref: d.ref, refLabel: d.refLabel }).toEqual({ ref: "INC-1", refLabel: "[INC-1] " })
    }
  })
})
