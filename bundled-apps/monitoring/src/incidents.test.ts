// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MCP tool handler tests: list (filters + ordering), get, ack, resolve —
// including the lifecycle guards (ack/resolve of a resolved incident errors,
// unknown ids error) and the audit stamps + events each mutation records.
import { describe, expect, it } from "bun:test"
import { incidentsCommentHandler } from "./comments"
import {
  incidentsAckHandler,
  incidentsGetHandler,
  incidentsListHandler,
  incidentsResolveHandler,
  webhookInfoHandler,
} from "./incidents"
import { incidents, makeCtx, setActor, USER } from "./test-ctx"
import { alertWebhookHandler } from "./webhooks"

const ALERT = {
  source: "grafana-prod",
  severity: "critical" as const,
  title: "API p99 latency > 5s",
  dedupKey: "api-p99",
  ts: "2026-07-05T03:12:00Z",
}

async function seed(ctx: Parameters<typeof alertWebhookHandler>[1]) {
  await alertWebhookHandler(ALERT, ctx)
  await alertWebhookHandler(
    {
      source: "uptime-robot",
      severity: "warning",
      title: "Marketing site slow",
      dedupKey: "mkt",
      ts: "2026-07-05T04:00:00Z",
    },
    ctx,
  )
  await alertWebhookHandler(
    {
      source: "grafana-prod",
      severity: "info",
      title: "Deploy finished",
      ts: "2026-07-05T05:00:00Z",
    },
    ctx,
  )
}

describe("incidentsListHandler", () => {
  it("lists all incidents most recently seen first", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    // Seeding happens within one millisecond — stamp distinct lastSeen values
    // so the recency ordering is observable (a real DB would tie the same way).
    const rows = incidents(spy)
    rows[0]!.last_seen_at = "2026-07-05T03:12:00.000Z"
    rows[1]!.last_seen_at = "2026-07-05T04:00:00.000Z"
    rows[2]!.last_seen_at = "2026-07-05T05:00:00.000Z"
    const res = await incidentsListHandler({}, ctx)
    expect(res.data.length).toBe(3)
    expect(res.data[0]!.title).toBe("Deploy finished")
  })

  it("filters by status / severity / source", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    const critical = await incidentsListHandler({ severity: "critical" }, ctx)
    expect(critical.data.length).toBe(1)
    expect(critical.data[0]!.source).toBe("grafana-prod")

    const bySource = await incidentsListHandler({ source: "grafana-prod" }, ctx)
    expect(bySource.data.length).toBe(2)

    // Resolve one and check status filter.
    const id = String(incidents(spy)[0]!.id)
    await incidentsResolveHandler({ incidentId: id, resolutionNote: "restarted api pods" }, ctx)
    const open = await incidentsListHandler({ status: "open" }, ctx)
    expect(open.data.length).toBe(2)
    const resolved = await incidentsListHandler({ status: "resolved" }, ctx)
    expect(resolved.data.length).toBe(1)
  })
})

describe("incidentsGetHandler", () => {
  it("returns the full incident by id", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    const id = String(incidents(spy)[0]!.id)
    const res = await incidentsGetHandler({ incidentId: id }, ctx)
    expect(res.data.id).toBe(id)
    expect(res.data.title).toBe("API p99 latency > 5s")
  })

  it("errors on an unknown id", async () => {
    const { ctx } = makeCtx()
    await expect(incidentsGetHandler({ incidentId: "nope" }, ctx)).rejects.toThrow(
      /incident_not_found/,
    )
  })
})

describe("incidentsAckHandler", () => {
  it("acknowledges an open incident with an audit stamp and emits incident:acknowledged", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    const id = String(incidents(spy)[0]!.id)
    const res = await incidentsAckHandler({ incidentId: id }, ctx)
    expect(res.data.status).toBe("acknowledged")

    const row = incidents(spy)[0]!
    expect(row.status).toBe("acknowledged")
    expect(row.acknowledged_by).toBe(USER)
    expect(row.acknowledged_at).toBeDefined()
    expect(spy.emits.at(-1)).toMatchObject({
      entity: "incident",
      action: "acknowledged",
      entityId: id,
    })
  })

  it("refuses to ack a resolved incident", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    const id = String(incidents(spy)[0]!.id)
    await incidentsResolveHandler({ incidentId: id }, ctx)
    await expect(incidentsAckHandler({ incidentId: id }, ctx)).rejects.toThrow(/already_resolved/)
  })
})

describe("incidentsResolveHandler", () => {
  it("resolves an incident with note + audit stamp and emits incident:resolved", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    const id = String(incidents(spy)[0]!.id)
    const res = await incidentsResolveHandler(
      { incidentId: id, resolutionNote: "rolled back v2.31" },
      ctx,
    )
    expect(res.data.status).toBe("resolved")

    const row = incidents(spy)[0]!
    expect(row.status).toBe("resolved")
    expect(row.resolved_by).toBe(USER)
    expect(row.resolved_at).toBeDefined()
    expect(row.resolution_note).toBe("rolled back v2.31")
    expect(spy.emits.at(-1)).toMatchObject({ entity: "incident", action: "resolved", entityId: id })
    // The manifest's incident:resolved translations key their resolveWhen on
    // this constant — it is what clears the incident's attention-feed rows.
    expect((spy.emits.at(-1) as { data: { status?: string } }).data.status).toBe("resolved")
  })

  it("resolves an acknowledged incident too", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    const id = String(incidents(spy)[0]!.id)
    await incidentsAckHandler({ incidentId: id }, ctx)
    const res = await incidentsResolveHandler({ incidentId: id }, ctx)
    expect(res.data.status).toBe("resolved")
  })

  it("validates resolutionNote before any write: trimmed, blank means none, at most 4000 characters", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    const row = incidents(spy)[0]!
    const emits = spy.emits.length
    for (const [note, error] of [
      ["a".repeat(4001), /resolution_note_too_long/],
      [42, /invalid_resolution_note/],
    ] as const) {
      await expect(
        incidentsResolveHandler({ incidentId: "INC-1", resolutionNote: note as never }, ctx),
      ).rejects.toThrow(error)
      expect(row.status).toBe("open")
      expect(spy.emits.length).toBe(emits)
    }
    await incidentsResolveHandler(
      { incidentId: "INC-1", resolutionNote: `  ${"n".repeat(4000)}  ` },
      ctx,
    )
    expect(row.resolution_note).toBe("n".repeat(4000))

    const other = incidents(spy)[1]!
    await incidentsResolveHandler({ incidentId: String(other.id), resolutionNote: "   " }, ctx)
    expect(other.resolution_note).toBeNull()
    expect((spy.emits.at(-1)!.data as Record<string, unknown>).resolutionNote).toBeNull()
  })

  it("stamps acknowledged_by and resolved_by with the acting user from ctx.getUserId()", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    await incidentsAckHandler({ incidentId: "INC-1" }, ctx)
    expect(incidents(spy)[0]!.acknowledged_by).toBe(USER)
    await incidentsResolveHandler({ incidentId: "INC-1" }, ctx)
    expect(incidents(spy)[0]!.resolved_by).toBe(USER)
  })

  it("stamps a system actor (non-uuid user id) as null on ack and resolve instead of failing", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    setActor(ctx, "system")
    await incidentsAckHandler({ incidentId: "INC-1" }, ctx)
    await incidentsResolveHandler({ incidentId: "INC-1" }, ctx)
    const row = incidents(spy)[0]!
    expect({ acknowledged_by: row.acknowledged_by, resolved_by: row.resolved_by }).toEqual({
      acknowledged_by: null,
      resolved_by: null,
    })
  })

  it("refuses to resolve twice", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    const id = String(incidents(spy)[0]!.id)
    await incidentsResolveHandler({ incidentId: id }, ctx)
    await expect(incidentsResolveHandler({ incidentId: id }, ctx)).rejects.toThrow(
      /already_resolved/,
    )
  })
})

describe("webhookInfoHandler", () => {
  it("reports the minted secret when the connection exists", async () => {
    const { ctx } = makeCtx({ config: { monitoringWebhookSecret: "s3cret" } })
    const res = await webhookInfoHandler({}, ctx)
    expect(res.data.configured).toBe(true)
    // The host writes the secret in where the marker stands (revealsSecrets): the app never reads it.
    expect(res.data.secret).toEqual({ $configSecret: "monitoringWebhookSecret" })
    expect(res.data.signatureHeader).toBe("x-monitoring-signature")
  })

  it("reports not-configured before any connection is made", async () => {
    const { ctx } = makeCtx()
    const res = await webhookInfoHandler({}, ctx)
    expect(res.data.configured).toBe(false)
    expect(res.data.secret).toBeNull()
  })
})

// incidents are named by their INC-<n> ref; get/ack/resolve take the UUID or the ref
// and every write, emit and re-read uses the resolved row id.
describe("incident refs in the triage tools", () => {
  const UNNUMBERED = {
    id: "row-legacy",
    source: "legacy",
    severity: "warning",
    title: "Old one",
    status: "open",
    count: 1,
    first_seen_at: "2026-06-01T00:00:00.000Z",
    last_seen_at: "2026-06-01T00:00:00.000Z",
  }

  it("incidents_list rows carry ref", async () => {
    const { ctx } = makeCtx()
    await seed(ctx)
    const res = await incidentsListHandler({}, ctx)
    // Seeding is a timestamp tie, so assert by title, not by position.
    expect(Object.fromEntries(res.data.map((r) => [r.title, r.ref]))).toEqual({
      "API p99 latency > 5s": "INC-1",
      "Marketing site slow": "INC-2",
      "Deploy finished": "INC-3",
    })
  })

  it("incidents_get accepts the ref in any case, trimmed, and still the UUID", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    expect((await incidentsGetHandler({ incidentId: "inc-2" }, ctx)).data.title).toBe(
      "Marketing site slow",
    )
    expect((await incidentsGetHandler({ incidentId: "  INC-2 " }, ctx)).data.title).toBe(
      "Marketing site slow",
    )
    const id = String(incidents(spy)[0]!.id)
    expect((await incidentsGetHandler({ incidentId: id }, ctx)).data.ref).toBe("INC-1")
    await expect(incidentsGetHandler({ incidentId: "INC-99" }, ctx)).rejects.toThrow(
      /incident_not_found/,
    )
    await expect(incidentsGetHandler({ incidentId: "nope" }, ctx)).rejects.toThrow(
      /incident_not_found/,
    )
  })

  it("ack by ref acts on the resolved row id and emits ref/refLabel", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    const row = incidents(spy)[0]!
    const res = await incidentsAckHandler({ incidentId: "INC-1" }, ctx)
    expect(res.data.status).toBe("acknowledged")
    expect(res.data.ref).toBe("INC-1")
    expect(row.status).toBe("acknowledged")
    const ev = spy.emits.at(-1)!
    const d = ev.data as Record<string, unknown>
    expect(ev.action).toBe("acknowledged")
    expect(ev.entityId).toBe(row.id)
    expect(d.id).toBe(row.id)
    expect(d.ref).toBe("INC-1")
    expect(d.refLabel).toBe("[INC-1] ")
  })

  it("resolve by ref acts on the resolved row id and emits ref/refLabel with status resolved", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    const row = incidents(spy)[0]!
    const res = await incidentsResolveHandler({ incidentId: "inc-1", resolutionNote: "fixed" }, ctx)
    expect(res.data.status).toBe("resolved")
    expect(row.resolution_note).toBe("fixed")
    const ev = spy.emits.at(-1)!
    const d = ev.data as Record<string, unknown>
    expect(ev.action).toBe("resolved")
    expect(ev.entityId).toBe(row.id)
    expect(d.id).toBe(row.id)
    expect(d.status).toBe("resolved")
    expect(d.ref).toBe("INC-1")
    expect(d.refLabel).toBe("[INC-1] ")
  })

  it("an un-numbered incident has ref null and its events carry an empty label, never INC-null", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [{ ...UNNUMBERED }])
    expect((await incidentsGetHandler({ incidentId: "row-legacy" }, ctx)).data.ref).toBeNull()
    await incidentsAckHandler({ incidentId: "row-legacy" }, ctx)
    let d = spy.emits.at(-1)!.data as Record<string, unknown>
    expect({ ref: d.ref, refLabel: d.refLabel }).toEqual({ ref: null, refLabel: "" })
    await incidentsResolveHandler({ incidentId: "row-legacy" }, ctx)
    d = spy.emits.at(-1)!.data as Record<string, unknown>
    expect({ ref: d.ref, refLabel: d.refLabel }).toEqual({ ref: null, refLabel: "" })
  })

  it("incidents_get stays read-only: it never numbers an un-numbered incident", async () => {
    const { ctx, spy } = makeCtx()
    spy.rows.set("incidents", [{ ...UNNUMBERED }])
    await incidentsGetHandler({ incidentId: "row-legacy" }, ctx)
    expect(incidents(spy)[0]!.ref_number ?? null).toBeNull()
    expect(spy.sequences.has("monitoring:incident_ref")).toBe(false)
  })
})

// incidents_get returns the comments and archived episodes (oldest first, newest 200),
// and incidents_ack takes an optional note saved as a comment after the ack (best effort).
describe("incident comments in incidents_get and the ack note", () => {
  const commentsOf = (spy: ReturnType<typeof makeCtx>["spy"]) =>
    spy.rows.get("incident_comments") ?? []

  async function oneIncident() {
    const made = makeCtx()
    await alertWebhookHandler(ALERT, made.ctx)
    return { ...made, row: incidents(made.spy)[0]! }
  }

  async function insertComments(
    ctx: ReturnType<typeof makeCtx>["ctx"],
    incidentId: string,
    n: number,
  ) {
    for (let i = 1; i <= n; i++) {
      await ctx.db.insert("incident_comments", {
        incident_id: incidentId,
        kind: "comment",
        body: `c-${i}`,
      })
    }
  }

  it("returns comments oldest first, episodes included, with commentsTruncated false", async () => {
    const { ctx, spy, row } = await oneIncident()
    const R0 = "2026-07-05T04:00:00.000Z"
    Object.assign(row, { status: "resolved", resolved_at: R0, resolution_note: "restarted" })
    await alertWebhookHandler(
      { ...ALERT, title: "API p99 latency > 8s", ts: "2026-07-05T05:00:00Z" },
      ctx,
    )
    await incidentsCommentHandler({ incidentId: "INC-1", body: "first" }, ctx)
    await incidentsCommentHandler({ incidentId: "INC-1", body: "second" }, ctx)
    // An update moves updated_at: the view must read created_at.
    const [episodeRow, firstRow, secondRow] = commentsOf(spy)
    await ctx.db.update("incident_comments", firstRow!.id, { body: "first" })

    const res = await incidentsGetHandler({ incidentId: "INC-1" }, ctx)
    expect(res.data.comments).toEqual([
      {
        id: episodeRow!.id,
        kind: "episode",
        body: null,
        authorId: null,
        createdAt: episodeRow!.created_at as string,
        episodeTitle: "API p99 latency > 5s",
        episodeResolvedAt: R0,
        episodeResolutionNote: "restarted",
      },
      ...[firstRow!, secondRow!].map((c) => ({
        id: c.id,
        kind: "comment" as const,
        body: c.body as string,
        authorId: USER,
        createdAt: c.created_at as string,
        episodeTitle: null,
        episodeResolvedAt: null,
        episodeResolutionNote: null,
      })),
    ])
    expect(firstRow!.updated_at).not.toBe(firstRow!.created_at)
    expect(res.data.commentsTruncated).toBe(false)
  })

  it("returns only the incident's own comments and episodes, each in order, with the spec'd read", async () => {
    const { ctx, spy } = makeCtx()
    await alertWebhookHandler(ALERT, ctx)
    await alertWebhookHandler({ ...ALERT, dedupKey: "b", title: "B" }, ctx)
    const [a, b] = incidents(spy)
    for (const row of [a!, b!]) {
      Object.assign(row, {
        status: "resolved",
        resolved_at: "2026-07-05T04:00:00Z",
        resolution_note: `fixed ${row.title}`,
      })
    }
    // Interleave writes on A and B: comment, reopen (episode), comment.
    await incidentsCommentHandler({ incidentId: "INC-1", body: "a1" }, ctx)
    await incidentsCommentHandler({ incidentId: "INC-2", body: "b1" }, ctx)
    await alertWebhookHandler({ ...ALERT, ts: "2026-07-05T05:00:00Z" }, ctx)
    await alertWebhookHandler(
      { ...ALERT, dedupKey: "b", title: "B", ts: "2026-07-05T05:00:00Z" },
      ctx,
    )
    await incidentsCommentHandler({ incidentId: "INC-2", body: "b2" }, ctx)
    await incidentsCommentHandler({ incidentId: "INC-1", body: "a2" }, ctx)

    const reads: unknown[] = []
    const findMany = ctx.db.findMany.bind(ctx.db)
    ctx.db.findMany = (async (entity: string, opts?: unknown) => {
      if (entity === "incident_comments") reads.push(opts)
      return findMany(entity, opts as never)
    }) as typeof ctx.db.findMany

    const label = (c: { kind: string; body: string | null; episodeTitle: string | null }) =>
      c.kind === "episode" ? `episode:${c.episodeTitle}` : String(c.body)
    const resA = await incidentsGetHandler({ incidentId: "INC-1" }, ctx)
    const resB = await incidentsGetHandler({ incidentId: "INC-2" }, ctx)
    expect(resA.data.comments.map(label)).toEqual(["a1", `episode:${ALERT.title}`, "a2"])
    expect(resB.data.comments.map(label)).toEqual(["b1", "episode:B", "b2"])
    expect(reads).toEqual([
      { where: { incident_id: a!.id }, orderBy: { createdAt: "desc", id: "desc" }, limit: 201 },
      { where: { incident_id: b!.id }, orderBy: { createdAt: "desc", id: "desc" }, limit: 201 },
    ])
  })

  it("keeps exactly 200 comments without flagging truncation", async () => {
    const { ctx, row } = await oneIncident()
    await insertComments(ctx, row.id, 200)
    const res = await incidentsGetHandler({ incidentId: row.id }, ctx)
    expect(res.data.comments.length).toBe(200)
    expect(res.data.comments[0]!.body).toBe("c-1")
    expect(res.data.comments.at(-1)!.body).toBe("c-200")
    expect(res.data.commentsTruncated).toBe(false)
  })

  it("keeps the newest 200 of 201 comments and flags truncation", async () => {
    const { ctx, row } = await oneIncident()
    await insertComments(ctx, row.id, 201)
    const res = await incidentsGetHandler({ incidentId: row.id }, ctx)
    expect(res.data.comments.length).toBe(200)
    expect(res.data.comments[0]!.body).toBe("c-2")
    expect(res.data.comments.at(-1)!.body).toBe("c-201")
    expect(res.data.commentsTruncated).toBe(true)
  })

  it("orders comments sharing a created_at by id, ascending in the view", async () => {
    const { ctx, spy, row } = await oneIncident()
    const same = "2026-07-05T06:00:00.000Z"
    spy.rows.set("incident_comments", [
      { id: "c-1", incident_id: row.id, kind: "comment", body: "one", created_at: same },
      { id: "c-2", incident_id: row.id, kind: "comment", body: "two", created_at: same },
    ])
    const res = await incidentsGetHandler({ incidentId: row.id }, ctx)
    expect(res.data.comments.map((c) => c.id)).toEqual(["c-1", "c-2"])
  })

  it("ack with a valid note acknowledges, saves the trimmed note as a comment by the user and emits commented after acknowledged", async () => {
    const { ctx, spy, row } = await oneIncident()
    const res = await incidentsAckHandler({ incidentId: "INC-1", note: "  looking at it  " }, ctx)
    expect(res.data.status).toBe("acknowledged")
    expect(row.status).toBe("acknowledged")
    expect(commentsOf(spy).length).toBe(1)
    expect(commentsOf(spy)[0]).toMatchObject({
      incident_id: row.id,
      kind: "comment",
      body: "looking at it",
      author_id: USER,
    })
    expect(spy.emits.map((e) => e.action).slice(-2)).toEqual(["acknowledged", "commented"])
    const commented = spy.emits.at(-1)!
    expect(commented.entityId).toBe(row.id)
    expect(commented.data).toEqual({
      id: row.id,
      ref: "INC-1",
      refLabel: "[INC-1] ",
      source: row.source,
      title: row.title,
      commentId: commentsOf(spy)[0]!.id,
    })
    expect(commented.metadata).toEqual({ source: row.source, severity: row.severity })
  })

  it("an invalid ack note writes nothing: the incident stays open, no comment, no emit", async () => {
    for (const [note, error] of [
      ["   ", /empty_comment/],
      ["a".repeat(4001), /comment_too_long/],
    ] as const) {
      const { ctx, spy, row } = await oneIncident()
      const emits = spy.emits.length
      await expect(incidentsAckHandler({ incidentId: "INC-1", note }, ctx)).rejects.toThrow(error)
      expect(row.status).toBe("open")
      expect(row.acknowledged_at ?? null).toBeNull()
      expect(commentsOf(spy).length).toBe(0)
      expect(spy.emits.length).toBe(emits)
    }
  })

  it("ack without a note adds no comment and no commented event", async () => {
    const { ctx, spy } = await oneIncident()
    await incidentsAckHandler({ incidentId: "INC-1" }, ctx)
    expect(commentsOf(spy).length).toBe(0)
    expect(spy.emits.some((e) => e.action === "commented")).toBe(false)
  })

  it("a failed note insert leaves the incident acknowledged and a retry saves the note", async () => {
    const { ctx, spy, row } = await oneIncident()
    spy.failNextInsert = "incident_comments"
    await expect(
      incidentsAckHandler({ incidentId: "INC-1", note: "ticket 77" }, ctx),
    ).rejects.toThrow()
    expect(row.status).toBe("acknowledged")
    expect(commentsOf(spy).length).toBe(0)
    expect(spy.emits.at(-1)!.action).toBe("acknowledged")

    await incidentsAckHandler({ incidentId: "INC-1", note: "ticket 77" }, ctx)
    expect(row.status).toBe("acknowledged")
    expect(commentsOf(spy).length).toBe(1)
    expect(spy.emits.map((e) => e.action).slice(-2)).toEqual(["acknowledged", "commented"])
  })
})
