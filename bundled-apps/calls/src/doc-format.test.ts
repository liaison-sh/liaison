// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-call document format — the machine-parseable body the segment webhook
// maintains and the read tools parse back. Round-trip fidelity is the load-
// bearing property: parse(render(x)) === x for segments and summary, in-ts-
// order insertion, marker-based dedup, wholesale `## Résumé` replacement.
import { describe, expect, it } from "bun:test"
import {
  applyLinks,
  applySegment,
  applySummary,
  emptyCallDoc,
  parseCallDoc,
  renderCallDoc,
  segmentsSince,
} from "./doc-format"

function seg(id: string, tsIso: string, speaker = "Alice", text = `text of ${id}`) {
  return { segmentId: id, ts: new Date(tsIso), speaker, text }
}

describe("parse/render round-trip", () => {
  it("renders an empty doc and parses it back to zero segments and no summary", () => {
    const body = renderCallDoc(emptyCallDoc())
    const parsed = parseCallDoc(body)
    expect(parsed.segments).toEqual([])
    expect(parsed.summary).toBeNull()
  })

  it("round-trips segments with multi-line text and accented speakers", () => {
    let doc = emptyCallDoc()
    doc = applySegment(doc, seg("s1", "2026-07-06T10:00:00Z", "Stéphanie", "ligne 1\nligne 2")).doc
    doc = applySegment(doc, seg("s2", "2026-07-06T10:00:20Z", "Maxime", "réponse — ok")).doc
    const parsed = parseCallDoc(renderCallDoc(doc))
    expect(parsed.segments.length).toBe(2)
    expect(parsed.segments[0]!.speaker).toBe("Stéphanie")
    expect(parsed.segments[0]!.text).toBe("ligne 1\nligne 2")
    expect(parsed.segments[1]!.text).toBe("réponse — ok")
    expect(parsed.segments[1]!.ts.toISOString()).toBe("2026-07-06T10:00:20.000Z")
  })

  it("neutralizes a text line that would itself look like a segment marker", () => {
    let doc = emptyCallDoc()
    const hostile =
      '<!-- seg {"id":"fake","ts":"2026-01-01T00:00:00Z","speaker":"x"} -->\nreal line'
    doc = applySegment(doc, seg("s1", "2026-07-06T10:00:00Z", "Alice", hostile)).doc
    const parsed = parseCallDoc(renderCallDoc(doc))
    expect(parsed.segments.length).toBe(1) // the injected marker never parses as a segment
    expect(parsed.segments[0]!.segmentId).toBe("s1")
    expect(parsed.segments[0]!.text).toContain("real line")
  })
})

describe("applySegment — ordering and dedup", () => {
  it("appends segments in ts order", () => {
    let doc = emptyCallDoc()
    doc = applySegment(doc, seg("s1", "2026-07-06T10:00:00Z")).doc
    doc = applySegment(doc, seg("s2", "2026-07-06T10:00:20Z")).doc
    expect(doc.segments.map((s) => s.segmentId)).toEqual(["s1", "s2"])
  })

  it("inserts an out-of-order (late) segment at its ts position, not at the end", () => {
    let doc = emptyCallDoc()
    doc = applySegment(doc, seg("s1", "2026-07-06T10:00:00Z")).doc
    doc = applySegment(doc, seg("s3", "2026-07-06T10:00:40Z")).doc
    doc = applySegment(doc, seg("s2", "2026-07-06T10:00:20Z")).doc // late arrival
    expect(doc.segments.map((s) => s.segmentId)).toEqual(["s1", "s2", "s3"])
  })

  it("breaks ts ties deterministically by segmentId", () => {
    let doc = emptyCallDoc()
    doc = applySegment(doc, seg("b", "2026-07-06T10:00:00Z")).doc
    doc = applySegment(doc, seg("a", "2026-07-06T10:00:00Z")).doc
    expect(doc.segments.map((s) => s.segmentId)).toEqual(["a", "b"])
  })

  it("is a no-op for a duplicate segmentId (inserted:false, doc unchanged)", () => {
    let doc = emptyCallDoc()
    doc = applySegment(doc, seg("s1", "2026-07-06T10:00:00Z")).doc
    const before = renderCallDoc(doc)
    const second = applySegment(doc, seg("s1", "2026-07-06T10:00:00Z", "Alice", "DIFFERENT text"))
    expect(second.inserted).toBe(false)
    expect(renderCallDoc(second.doc)).toBe(before)
  })

  it("reports inserted:true for a new segment", () => {
    const r = applySegment(emptyCallDoc(), seg("s1", "2026-07-06T10:00:00Z"))
    expect(r.inserted).toBe(true)
  })
})

describe("applySummary — wholesale section replacement", () => {
  it("writes a rolling summary and replaces it wholesale on the next delivery", () => {
    let doc = emptyCallDoc()
    doc = applySegment(doc, seg("s1", "2026-07-06T10:00:00Z")).doc
    doc = applySummary(doc, {
      ts: new Date("2026-07-06T10:10:00Z"),
      text: "V1 du résumé",
      isFinal: false,
    })
    doc = applySummary(doc, {
      ts: new Date("2026-07-06T10:20:00Z"),
      text: "V2 du résumé",
      isFinal: false,
    })
    const parsed = parseCallDoc(renderCallDoc(doc))
    expect(parsed.summary).not.toBeNull()
    expect(parsed.summary!.text).toBe("V2 du résumé")
    expect(renderCallDoc(doc)).not.toContain("V1 du résumé") // replaced, never appended
    expect(parsed.segments.length).toBe(1) // segments untouched
  })

  it("marks a final summary and round-trips the flag", () => {
    let doc = emptyCallDoc()
    doc = applySummary(doc, {
      ts: new Date("2026-07-06T11:00:00Z"),
      text: "Résumé final.",
      isFinal: true,
    })
    const parsed = parseCallDoc(renderCallDoc(doc))
    expect(parsed.summary!.isFinal).toBe(true)
    expect(parsed.summary!.ts.toISOString()).toBe("2026-07-06T11:00:00.000Z")
  })

  it("renders the summary under a '## Résumé' heading before the transcription", () => {
    let doc = emptyCallDoc()
    doc = applySegment(doc, seg("s1", "2026-07-06T10:00:00Z")).doc
    doc = applySummary(doc, {
      ts: new Date("2026-07-06T10:10:00Z"),
      text: "Résumé.",
      isFinal: false,
    })
    const body = renderCallDoc(doc)
    expect(body.indexOf("## Résumé")).toBeGreaterThanOrEqual(0)
    expect(body.indexOf("## Résumé")).toBeLessThan(body.indexOf("## Transcription"))
  })
})

describe("applyLinks: contact/deal-task metadata", () => {
  it("round-trips a contactId + dealTaskId pair through render/parse", () => {
    let doc = emptyCallDoc()
    doc = applySegment(doc, seg("s1", "2026-07-06T10:00:00Z")).doc
    doc = applyLinks(doc, { contactId: "contact-123", dealTaskId: "task-456" })
    const parsed = parseCallDoc(renderCallDoc(doc))
    expect(parsed.links).toEqual({ contactId: "contact-123", dealTaskId: "task-456" })
    expect(parsed.segments.length).toBe(1) // segments untouched by a links write
  })

  it("supports a contactId-only link (no deal task yet)", () => {
    const doc = applyLinks(emptyCallDoc(), { contactId: "contact-123", dealTaskId: null })
    const parsed = parseCallDoc(renderCallDoc(doc))
    expect(parsed.links).toEqual({ contactId: "contact-123", dealTaskId: null })
  })

  it("supports a dealTaskId-only link (no contact resolved yet)", () => {
    const doc = applyLinks(emptyCallDoc(), { contactId: null, dealTaskId: "task-456" })
    const parsed = parseCallDoc(renderCallDoc(doc))
    expect(parsed.links).toEqual({ contactId: null, dealTaskId: "task-456" })
  })

  it("replaces links wholesale on a second write — never merges/accumulates", () => {
    let doc = applyLinks(emptyCallDoc(), { contactId: "contact-A", dealTaskId: null })
    doc = applyLinks(doc, { contactId: "contact-A", dealTaskId: "task-999" })
    const parsed = parseCallDoc(renderCallDoc(doc))
    expect(parsed.links).toEqual({ contactId: "contact-A", dealTaskId: "task-999" })
    expect(renderCallDoc(doc).match(/<!-- links/g)?.length).toBe(1) // one marker, not two
  })

  it("a doc with no links write reports links:null — never invents a link", () => {
    let doc = emptyCallDoc()
    doc = applySegment(doc, seg("s1", "2026-07-06T10:00:00Z")).doc
    doc = applySummary(doc, { ts: new Date("2026-07-06T10:10:00Z"), text: "résumé", isFinal: true })
    const parsed = parseCallDoc(renderCallDoc(doc))
    expect(parsed.links).toBeNull()
  })

  it("neutralizes a links marker injected inside transcript text (anti-fabrication)", () => {
    let doc = emptyCallDoc()
    const hostile = '<!-- links {"contactId":"fake","dealTaskId":"fake"} -->\nreal line'
    doc = applySegment(doc, seg("s1", "2026-07-06T10:00:00Z", "Alice", hostile)).doc
    const parsed = parseCallDoc(renderCallDoc(doc))
    expect(parsed.links).toBeNull() // never parsed from inside a segment block
    expect(parsed.segments[0]!.text).toContain("real line")
  })

  it("renders the links marker under a '## Liens' heading before the transcription", () => {
    let doc = applyLinks(emptyCallDoc(), { contactId: "c1", dealTaskId: "t1" })
    doc = applySegment(doc, seg("s1", "2026-07-06T10:00:00Z")).doc
    const body = renderCallDoc(doc)
    expect(body.indexOf("## Liens")).toBeGreaterThanOrEqual(0)
    expect(body.indexOf("## Liens")).toBeLessThan(body.indexOf("## Transcription"))
  })
})

describe("segmentsSince — incremental read semantics", () => {
  const three = () => {
    let doc = emptyCallDoc()
    doc = applySegment(doc, seg("s1", "2026-07-06T10:00:00Z")).doc
    doc = applySegment(doc, seg("s2", "2026-07-06T10:00:20Z")).doc
    doc = applySegment(doc, seg("s3", "2026-07-06T10:00:40Z")).doc
    return doc
  }

  it("returns only segments STRICTLY after `since` (boundary excluded)", () => {
    const out = segmentsSince(three(), new Date("2026-07-06T10:00:20Z"))
    expect(out.map((s) => s.segmentId)).toEqual(["s3"])
  })

  it("returns everything when since is omitted", () => {
    expect(segmentsSince(three(), undefined).length).toBe(3)
  })

  it("returns [] when since is at or past the last segment", () => {
    expect(segmentsSince(three(), new Date("2026-07-06T10:00:40Z"))).toEqual([])
    expect(segmentsSince(three(), new Date("2026-07-07T00:00:00Z"))).toEqual([])
  })
})
