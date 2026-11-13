// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Read-tool tests — calls_segments_since (incremental read + lastSegmentTs
// staleness signal per spec §3.7's failure-mode line), calls_list (recent call
// docs), webhook_info (operator setup read, monitoring convention).
import { describe, expect, it } from "bun:test"
import { parseCallDoc } from "./doc-format"
import { makeCtx } from "./test-ctx"
import {
  callsListHandler,
  callsSegmentsSinceHandler,
  callsSetLinksHandler,
  webhookInfoHandler,
} from "./tools"
import { segmentWebhookHandler } from "./webhooks"

function callsOf(spy: ReturnType<typeof makeCtx>["spy"], target: string): number {
  return spy.calls.filter((c) => c.target === target).length
}

const CALL = "meet-2026-07-06-abc"

async function seed(ctx: Parameters<typeof segmentWebhookHandler>[1]) {
  await segmentWebhookHandler(
    { callRef: CALL, segmentId: "s1", ts: "2026-07-06T10:00:00Z", speaker: "Alice", text: "un" },
    ctx,
  )
  await segmentWebhookHandler(
    { callRef: CALL, segmentId: "s2", ts: "2026-07-06T10:00:20Z", speaker: "Bob", text: "deux" },
    ctx,
  )
  await segmentWebhookHandler(
    { callRef: CALL, segmentId: "s3", ts: "2026-07-06T10:00:40Z", speaker: "Alice", text: "trois" },
    ctx,
  )
}

describe("calls_segments_since", () => {
  it("returns all segments plus lastSegmentTs when since is omitted", async () => {
    const { ctx } = makeCtx()
    await seed(ctx)
    const out = await callsSegmentsSinceHandler({ callRef: CALL }, ctx)
    expect(out.data.segments.map((s) => s.segmentId)).toEqual(["s1", "s2", "s3"])
    expect(out.data.lastSegmentTs).toBe("2026-07-06T10:00:40.000Z")
    expect(out.data.segments[0]).toMatchObject({ speaker: "Alice", text: "un" })
  })

  it("returns only segments STRICTLY after since (document boundary semantics)", async () => {
    const { ctx } = makeCtx()
    await seed(ctx)
    const out = await callsSegmentsSinceHandler(
      { callRef: CALL, since: "2026-07-06T10:00:20Z" },
      ctx,
    )
    expect(out.data.segments.map((s) => s.segmentId)).toEqual(["s3"])
    // lastSegmentTs reports the DOC's last segment, not the filtered window —
    // that is the staleness signal ("MCP tool reports last-segment ts").
    expect(out.data.lastSegmentTs).toBe("2026-07-06T10:00:40.000Z")
  })

  it("applies the limit to the OLDEST-first window after the since filter", async () => {
    const { ctx } = makeCtx()
    await seed(ctx)
    const out = await callsSegmentsSinceHandler({ callRef: CALL, limit: 2 }, ctx)
    expect(out.data.segments.map((s) => s.segmentId)).toEqual(["s1", "s2"])
    expect(out.data.truncated).toBe(true)
  })

  it("includes the summary section when present", async () => {
    const { ctx } = makeCtx()
    await seed(ctx)
    await segmentWebhookHandler(
      {
        callRef: CALL,
        kind: "summary",
        ts: "2026-07-06T10:10:00Z",
        text: "résumé",
        isFinal: false,
      },
      ctx,
    )
    const out = await callsSegmentsSinceHandler({ callRef: CALL }, ctx)
    expect(out.data.summary).toMatchObject({ text: "résumé", isFinal: false })
  })

  it("throws call_not_found for an unknown callRef", async () => {
    const { ctx } = makeCtx()
    await expect(callsSegmentsSinceHandler({ callRef: "nope" }, ctx)).rejects.toThrow(
      /call_not_found/,
    )
  })

  // U5.8: resolves callRef→doc via knowledge:find_by_title FIRST (DB-backed, never lags), never
  // even trying knowledge:search when find_by_title already resolves the doc — this is the fix for
  // U5.7's root-caused (c) failure (51x call_not_found under replay load while the doc existed in PG,
  // because resolution rode ONLY the Meilisearch index).
  it("resolves callRef -> doc via knowledge:find_by_title and never calls knowledge:search when it succeeds", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    spy.calls.length = 0 // ignore the seed webhook's own create/update calls
    const out = await callsSegmentsSinceHandler({ callRef: CALL }, ctx)
    expect(out.data.segments.map((s) => s.segmentId)).toEqual(["s1", "s2", "s3"])
    expect(callsOf(spy, "knowledge:find_by_title")).toBe(1)
    expect(callsOf(spy, "knowledge:search")).toBe(0)
  })

  // U5.8 fallback: when find_by_title itself errors (tool unavailable / transient), resolution
  // falls back to knowledge:search rather than failing outright — search is the pre-U5.8 behavior,
  // kept as a safety net, not the primary path.
  it("falls back to knowledge:search when find_by_title errors", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    spy.findByTitleErrors = true
    spy.calls.length = 0
    const out = await callsSegmentsSinceHandler({ callRef: CALL }, ctx)
    expect(out.data.segments.map((s) => s.segmentId)).toEqual(["s1", "s2", "s3"])
    expect(callsOf(spy, "knowledge:find_by_title")).toBe(1)
    expect(callsOf(spy, "knowledge:search")).toBe(1)
  })

  // U5.8: this is the EXACT regression the gate hit — under replay load the Meili index has not
  // caught up (searchReturnsNothing simulates it), but the doc DOES exist in Postgres. find_by_title
  // resolves it DB-fresh and the read succeeds instead of a false call_not_found.
  it("resolves via find_by_title even when knowledge:search would return nothing (index-lag simulation)", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    spy.searchReturnsNothing = true
    const out = await callsSegmentsSinceHandler({ callRef: CALL }, ctx)
    expect(out.data.segments.map((s) => s.segmentId)).toEqual(["s1", "s2", "s3"])
  })

  it("still throws call_not_found when BOTH find_by_title (no match) and search (index-lag) miss", async () => {
    const { ctx, spy } = makeCtx()
    spy.searchReturnsNothing = true
    await expect(callsSegmentsSinceHandler({ callRef: "nope" }, ctx)).rejects.toThrow(
      /call_not_found/,
    )
  })
})

describe("calls_set_links: contact/deal-task metadata", () => {
  it("writes a contactId + dealTaskId pair and reports the honest link state back", async () => {
    const { ctx } = makeCtx()
    await seed(ctx)
    const out = await callsSetLinksHandler(
      { callRef: CALL, contactId: "contact-123", dealTaskId: "task-456" },
      ctx,
    )
    expect(out.data.links).toEqual({ contactId: "contact-123", dealTaskId: "task-456" })
    const read = await callsSegmentsSinceHandler({ callRef: CALL }, ctx)
    expect(read.data.links).toEqual({ contactId: "contact-123", dealTaskId: "task-456" })
  })

  it("preserves the existing dealTaskId when only contactId is passed (read-modify-write, never drops the other link)", async () => {
    const { ctx } = makeCtx()
    await seed(ctx)
    await callsSetLinksHandler({ callRef: CALL, dealTaskId: "task-456" }, ctx)
    await callsSetLinksHandler({ callRef: CALL, contactId: "contact-123" }, ctx)
    const out = await callsSegmentsSinceHandler({ callRef: CALL }, ctx)
    expect(out.data.links).toEqual({ contactId: "contact-123", dealTaskId: "task-456" })
  })

  it("clears a link when explicitly passed null (deal task reassigned away)", async () => {
    const { ctx } = makeCtx()
    await seed(ctx)
    await callsSetLinksHandler(
      { callRef: CALL, contactId: "contact-123", dealTaskId: "task-456" },
      ctx,
    )
    await callsSetLinksHandler({ callRef: CALL, dealTaskId: null }, ctx)
    const out = await callsSegmentsSinceHandler({ callRef: CALL }, ctx)
    expect(out.data.links).toEqual({ contactId: "contact-123", dealTaskId: null })
  })

  it("throws call_not_found for an unknown callRef — never silently creates a doc from a links write", async () => {
    const { ctx } = makeCtx()
    await expect(callsSetLinksHandler({ callRef: "nope", contactId: "c1" }, ctx)).rejects.toThrow(
      /call_not_found/,
    )
  })

  it("retries on REVISION_CONFLICT (same CAS discipline as the segment webhook)", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    let fired = false
    spy.onBeforeFirstUpdate = async () => {
      if (fired) return
      fired = true
      // Race a competing write in behind our read — forces exactly one
      // REVISION_CONFLICT on our first knowledge:update attempt.
      await segmentWebhookHandler(
        {
          callRef: CALL,
          segmentId: "s4",
          ts: "2026-07-06T10:01:00Z",
          speaker: "Bob",
          text: "quatre",
        },
        ctx,
      )
    }
    const out = await callsSetLinksHandler({ callRef: CALL, contactId: "contact-123" }, ctx)
    expect(out.data.links).toEqual({ contactId: "contact-123", dealTaskId: null })
    const read = await callsSegmentsSinceHandler({ callRef: CALL }, ctx)
    expect(read.data.segments.map((s) => s.segmentId)).toEqual(["s1", "s2", "s3", "s4"]) // racing segment not lost
    expect(read.data.links).toEqual({ contactId: "contact-123", dealTaskId: null })
  })

  it("reports links:null on a fresh call with no links written yet — never invents a link", async () => {
    const { ctx } = makeCtx()
    await seed(ctx)
    const out = await callsSegmentsSinceHandler({ callRef: CALL }, ctx)
    expect(out.data.links).toBeNull()
  })
})

describe("calls_list", () => {
  it("lists call docs with callRef and documentId", async () => {
    const { ctx } = makeCtx()
    await seed(ctx)
    await segmentWebhookHandler(
      {
        callRef: "other-call",
        segmentId: "x1",
        ts: "2026-07-06T11:00:00Z",
        speaker: "C",
        text: "y",
      },
      ctx,
    )
    const out = await callsListHandler({}, ctx)
    const refs = out.data.calls.map((c) => c.callRef).sort()
    expect(refs).toEqual([CALL, "other-call"])
    expect(out.data.calls[0]!.documentId).toBeTruthy()
  })

  // Call documents created before the title lost its dash punctuation still
  // carry "Appel <em dash> <ref>". calls_list must keep finding them and must
  // strip the LEGACY prefix, not the new one, when deriving the callRef.
  it("lists a legacy-titled call doc and strips its legacy prefix", async () => {
    const { ctx } = makeCtx()
    const created = await ctx.executeTool("knowledge:create", {
      title: "Appel \u2014 legacy-call-1",
      body: "## Transcription\n",
    })
    expect(created.status).toBe("completed")
    const out = await callsListHandler({}, ctx)
    expect(out.data.calls.map((c) => c.callRef)).toEqual(["legacy-call-1"])
  })

  it("returns an empty list when no call docs exist", async () => {
    const { ctx } = makeCtx()
    const out = await callsListHandler({}, ctx)
    expect(out.data.calls).toEqual([])
  })
})

describe("webhook_info", () => {
  it("reports the minted secret and signing contract (admin setup read)", async () => {
    const { ctx } = makeCtx({ config: { callsWebhookSecret: "sekret" } })
    const out = await webhookInfoHandler({}, ctx)
    expect(out.data.configured).toBe(true)
    // The host writes the secret in where the marker stands (revealsSecrets): the app never reads it.
    expect(out.data.secret).toEqual({ $configSecret: "callsWebhookSecret" })
    expect(out.data.signatureHeader).toBe("x-calls-signature")
  })

  it("reports configured:false before the transcript-source connection minted a secret", async () => {
    const { ctx } = makeCtx()
    const out = await webhookInfoHandler({}, ctx)
    expect(out.data.configured).toBe(false)
    expect(out.data.secret).toBeNull()
  })
})

// Liaison main renamed the call document title from "Appel <em dash> <ref>" to
// "Appel : <ref>". Deployments already hold documents under the legacy title:
// every lookup must still find them, and the segment webhook must append to
// the legacy document instead of opening a second one for the same call.
describe("legacy-titled call documents (pre-rename title)", () => {
  // copy-lint: exempt legacy stored document title, test fixture
  const LEGACY_TITLE = `Appel — ${CALL}`

  async function seedLegacy() {
    const made = makeCtx()
    await seed(made.ctx)
    // Retitle the seeded doc to the legacy title, as it is stored in production.
    const doc = [...made.spy.docs.values()][0]!
    doc.title = LEGACY_TITLE
    return { ...made, docId: doc.id }
  }

  it("calls_segments_since reads the legacy document", async () => {
    const { ctx } = await seedLegacy()
    const read = await callsSegmentsSinceHandler({ callRef: CALL }, ctx)
    expect(read.data.segments.map((s) => s.segmentId)).toEqual(["s1", "s2", "s3"])
  })

  it("calls_set_links writes onto the legacy document", async () => {
    const { ctx, spy, docId } = await seedLegacy()
    const linked = await callsSetLinksHandler({ callRef: CALL, contactId: "contact-9" }, ctx)
    expect(linked.data.documentId).toBe(docId)
    expect(spy.docs.size).toBe(1)
  })

  it("the segment webhook appends to the legacy document instead of creating a second one", async () => {
    const { ctx, spy, docId } = await seedLegacy()
    const res = await segmentWebhookHandler(
      {
        callRef: CALL,
        segmentId: "s4",
        ts: "2026-07-06T10:01:00Z",
        speaker: "Bob",
        text: "quatre",
      },
      ctx,
    )
    expect(res.status).toBe(200)
    expect(spy.docs.size).toBe(1)
    const doc = spy.docs.get(docId)!
    expect(doc.title).toBe(LEGACY_TITLE)
    expect(parseCallDoc(doc.body).segments.map((s) => s.segmentId)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
    ])
  })

  it("resolves the legacy document through the search fallback when find_by_title is unavailable", async () => {
    const { ctx, spy, docId } = await seedLegacy()
    spy.findByTitleErrors = true
    const linked = await callsSetLinksHandler({ callRef: CALL, dealTaskId: "task-1" }, ctx)
    expect(linked.data.documentId).toBe(docId)
    await segmentWebhookHandler(
      { callRef: CALL, segmentId: "s5", ts: "2026-07-06T10:02:00Z", speaker: "Bob", text: "cinq" },
      ctx,
    )
    expect(spy.docs.size).toBe(1)
  })

  it("a brand-new call still gets the new title", async () => {
    const { ctx, spy } = makeCtx()
    await seed(ctx)
    expect([...spy.docs.values()].map((d) => d.title)).toEqual([`Appel : ${CALL}`])
  })
})
