// SPDX-License-Identifier: FSL-1.1-ALv2
//
// incidents_comment tests: comment by UUID and by ref, in any status, with body validation,
// the author rule and the incident:commented event (which has no attention translation).
import { describe, expect, it } from "bun:test"
import { incidentsCommentHandler } from "./comments"
import { incidentsAckHandler, incidentsResolveHandler } from "./incidents"
import { incidents, makeCtx, setActor, USER } from "./test-ctx"
import { alertWebhookHandler } from "./webhooks"

const ALERT = {
  source: "grafana-prod",
  severity: "critical" as const,
  title: "API p99 latency > 5s",
  dedupKey: "api-p99",
  ts: "2026-07-05T03:12:00Z",
}

async function seeded() {
  const made = makeCtx()
  await alertWebhookHandler(ALERT, made.ctx)
  return { ...made, row: incidents(made.spy)[0]! }
}
const comments = (spy: ReturnType<typeof makeCtx>["spy"]) => spy.rows.get("incident_comments") ?? []

describe("incidentsCommentHandler", () => {
  it("comments by UUID and by ref (any case, trimmed): row, view and commented event", async () => {
    const { ctx, spy, row } = await seeded()
    for (const input of [String(row.id), " inc-1 "]) {
      const before = comments(spy).length
      const res = await incidentsCommentHandler({ incidentId: input, body: "  vendor ticket 4821  " }, ctx)
      expect(comments(spy).length).toBe(before + 1)
      const stored = comments(spy).at(-1)!
      expect(stored.incident_id).toBe(row.id)
      expect(stored.kind).toBe("comment")
      expect(stored.body).toBe("vendor ticket 4821")
      expect(stored.author_id).toBe(USER)
      expect(res.data).toEqual({
        id: stored.id,
        kind: "comment",
        body: "vendor ticket 4821",
        authorId: USER,
        createdAt: stored.created_at as string,
        episodeTitle: null,
        episodeResolvedAt: null,
        episodeResolutionNote: null,
      })
      const ev = spy.emits.at(-1)!
      expect(ev.action).toBe("commented")
      expect(ev.entityId).toBe(row.id)
      expect(ev.data).toEqual({
        id: row.id,
        ref: "INC-1",
        refLabel: "[INC-1] ",
        source: row.source,
        title: row.title,
        commentId: stored.id,
      })
      expect(ev.metadata).toEqual({ source: row.source, severity: row.severity })
    }
  })

  it("works on a resolved incident", async () => {
    const { ctx, spy, row } = await seeded()
    await incidentsResolveHandler({ incidentId: String(row.id) }, ctx)
    await incidentsCommentHandler({ incidentId: "INC-1", body: "post mortem written" }, ctx)
    expect(comments(spy).length).toBe(1)
  })

  it("rejects an empty or non-string body without writing or emitting", async () => {
    for (const body of ["", "   ", undefined, 42]) {
      const { ctx, spy } = await seeded()
      const emits = spy.emits.length
      await expect(incidentsCommentHandler({ incidentId: "INC-1", body: body as never }, ctx)).rejects.toThrow(
        /empty_comment/,
      )
      expect(comments(spy).length).toBe(0)
      expect(spy.emits.length).toBe(emits)
    }
  })

  it("rejects a body over 4000 characters, measured after trimming", async () => {
    const { ctx, spy } = await seeded()
    const emits = spy.emits.length
    await expect(incidentsCommentHandler({ incidentId: "INC-1", body: "a".repeat(4001) }, ctx)).rejects.toThrow(
      /comment_too_long/,
    )
    expect(comments(spy).length).toBe(0)
    expect(spy.emits.length).toBe(emits)

    await incidentsCommentHandler({ incidentId: "INC-1", body: "a".repeat(4000) }, ctx)
    await incidentsCommentHandler({ incidentId: "INC-1", body: ` ${"b".repeat(4000)} ` }, ctx)
    expect(comments(spy).map((c) => String(c.body).length)).toEqual([4000, 4000])
    expect(comments(spy)[1]!.body).toBe("b".repeat(4000))
  })

  it("rejects an unknown incident and inserts nothing", async () => {
    const { ctx, spy } = await seeded()
    await expect(incidentsCommentHandler({ incidentId: "INC-99", body: "hello" }, ctx)).rejects.toThrow(
      /incident_not_found/,
    )
    await expect(incidentsCommentHandler({ incidentId: "nope", body: "hello" }, ctx)).rejects.toThrow(
      /incident_not_found/,
    )
    expect(comments(spy).length).toBe(0)
  })

  it("stores the acting user from ctx.getUserId() as author_id (the sandbox exposes no ctx.userId)", async () => {
    const { ctx, spy } = await seeded()
    expect((ctx as unknown as { userId?: string }).userId).toBeUndefined()
    await incidentsCommentHandler({ incidentId: "INC-1", body: "who am I" }, ctx)
    expect(comments(spy).at(-1)!.author_id).toBe(USER)
  })

  it("falls back to ctx.userId when the context has no getUserId (host-side context)", async () => {
    const { ctx, spy } = await seeded()
    const host = { ...ctx, getUserId: undefined, userId: "aaaaaaaa-0000-0000-0000-00000000000a" }
    await incidentsCommentHandler({ incidentId: "INC-1", body: "host side" }, host as typeof ctx)
    expect(comments(spy).at(-1)!.author_id).toBe("aaaaaaaa-0000-0000-0000-00000000000a")
  })

  it("stores author_id null for a non-UUID user id and for an uppercase UUID", async () => {
    const { ctx, spy } = await seeded()
    ;setActor(ctx, "system")
    await incidentsCommentHandler({ incidentId: "INC-1", body: "from a system actor" }, ctx)
    // TEST_USER_ID is all digits (upper case equals itself): use an id with letters.
    ;setActor(ctx, "AAAAAAAA-0000-0000-0000-00000000000A")
    await incidentsCommentHandler({ incidentId: "INC-1", body: "from an uppercase id" }, ctx)
    expect(comments(spy).map((c) => c.author_id ?? null)).toEqual([null, null])
    ;setActor(ctx, "aaaaaaaa-0000-0000-0000-00000000000a")
    await incidentsCommentHandler({ incidentId: "INC-1", body: "from a lowercase id" }, ctx)
    expect(comments(spy).at(-1)!.author_id).toBe("aaaaaaaa-0000-0000-0000-00000000000a")
  })

  it("ignores caller-supplied author, kind and timestamps: the author is always the acting user", async () => {
    const { ctx, spy } = await seeded()
    const OTHER = "bbbbbbbb-0000-0000-0000-00000000000b"
    const spoof = {
      incidentId: "INC-1",
      body: "spoof attempt",
      author_id: OTHER,
      authorId: OTHER,
      kind: "episode",
      createdAt: "2020-01-01T00:00:00.000Z",
    }
    await incidentsCommentHandler(spoof as never, ctx)
    await incidentsAckHandler({ ...spoof, note: "ack spoof attempt" } as never, ctx)
    expect(comments(spy).map((c) => ({ kind: c.kind, author_id: c.author_id, body: c.body }))).toEqual([
      { kind: "comment", author_id: USER, body: "spoof attempt" },
      { kind: "comment", author_id: USER, body: "ack spoof attempt" },
    ])
    expect(comments(spy).every((c) => c.created_at !== "2020-01-01T00:00:00.000Z")).toBe(true)
  })

  it("a failed commented emit is logged and the stored comment is still returned (no error inviting a duplicate)", async () => {
    const { ctx, spy } = await seeded()
    spy.failNextEmit = true
    const res = await incidentsCommentHandler({ incidentId: "INC-1", body: "vendor ticket 4821" }, ctx)
    expect(comments(spy).length).toBe(1)
    expect(res.data.id).toBe(comments(spy)[0]!.id)
    expect(spy.emits.some((e) => e.action === "commented")).toBe(false)
    expect(spy.errors.map((e) => e.data)).toEqual([
      { incidentId: comments(spy)[0]!.incident_id, commentId: res.data.id, err: "emit failed (test)" },
    ])
  })

  it("strips U+0000 from a comment body", async () => {
    const { ctx, spy } = await seeded()
    await incidentsCommentHandler({ incidentId: "INC-1", body: "a\u0000b" }, ctx)
    expect(comments(spy)[0]!.body).toBe("ab")
    await expect(incidentsCommentHandler({ incidentId: "INC-1", body: "\u0000" }, ctx)).rejects.toThrow(/empty_comment/)
  })
})
