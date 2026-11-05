// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Envelope validation — the discriminated segment/summary shapes the
// transcript adapter POSTs to the `segment` webhook (spec §3.7's literal
// cross-boundary row: `(call-ref, segment-id, ts, speaker, text)` for
// segments, plus the `kind:"summary"` variant for rolling/final summaries).
import { describe, expect, it } from "bun:test"
import { parseCallsEnvelope } from "./envelope"

const SEG = {
  callRef: "meet-2026-07-06-abc",
  segmentId: "seg-0001",
  ts: "2026-07-06T10:00:00Z",
  speaker: "Alice",
  text: "Bonjour, on commence ?",
}

const SUM = {
  callRef: "meet-2026-07-06-abc",
  kind: "summary",
  ts: "2026-07-06T10:15:00Z",
  text: "Point d'avancement — sujets X et Y couverts.",
  isFinal: false,
}

describe("parseCallsEnvelope — segment kind", () => {
  it("accepts a valid segment without an explicit kind (segment is the default shape)", () => {
    const r = parseCallsEnvelope(SEG)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.envelope.kind).toBe("segment")
    if (r.envelope.kind !== "segment") return
    expect(r.envelope.callRef).toBe(SEG.callRef)
    expect(r.envelope.segmentId).toBe("seg-0001")
    expect(r.envelope.speaker).toBe("Alice")
    expect(r.envelope.ts.toISOString()).toBe("2026-07-06T10:00:00.000Z")
  })

  it("accepts an explicit kind:'segment'", () => {
    const r = parseCallsEnvelope({ ...SEG, kind: "segment" })
    expect(r.ok).toBe(true)
  })

  it("accepts a numeric epoch-ms ts", () => {
    const r = parseCallsEnvelope({ ...SEG, ts: 1751796000000 })
    expect(r.ok).toBe(true)
  })

  it("rejects a segment missing segmentId", () => {
    const { segmentId: _omit, ...bad } = SEG
    const r = parseCallsEnvelope(bad)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain("segmentId")
  })

  it("rejects a segment with an unparseable ts", () => {
    const r = parseCallsEnvelope({ ...SEG, ts: "not-a-date" })
    expect(r.ok).toBe(false)
  })

  it("rejects a segment whose segmentId or speaker could break the doc marker format", () => {
    // The per-segment marker is a JSON-in-HTML-comment line; '-->' inside a
    // marker field would terminate the comment early and corrupt the doc.
    expect(parseCallsEnvelope({ ...SEG, segmentId: "x-->y" }).ok).toBe(false)
    expect(parseCallsEnvelope({ ...SEG, speaker: "Bob -->" }).ok).toBe(false)
    expect(parseCallsEnvelope({ ...SEG, speaker: "line1\nline2" }).ok).toBe(false)
  })

  it("rejects an empty callRef and an oversized text", () => {
    expect(parseCallsEnvelope({ ...SEG, callRef: "" }).ok).toBe(false)
    expect(parseCallsEnvelope({ ...SEG, text: "x".repeat(20_001) }).ok).toBe(false)
  })
})

describe("parseCallsEnvelope — summary kind", () => {
  it("accepts a valid rolling summary", () => {
    const r = parseCallsEnvelope(SUM)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.envelope.kind).toBe("summary")
    if (r.envelope.kind !== "summary") return
    expect(r.envelope.isFinal).toBe(false)
    expect(r.envelope.text).toContain("avancement")
  })

  it("accepts a final summary", () => {
    const r = parseCallsEnvelope({ ...SUM, isFinal: true })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    if (r.envelope.kind !== "summary") return
    expect(r.envelope.isFinal).toBe(true)
  })

  it("defaults isFinal to false when omitted", () => {
    const { isFinal: _omit, ...noFlag } = SUM
    const r = parseCallsEnvelope(noFlag)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    if (r.envelope.kind !== "summary") return
    expect(r.envelope.isFinal).toBe(false)
  })

  it("rejects a summary missing text or ts", () => {
    const { text: _t, ...noText } = SUM
    expect(parseCallsEnvelope(noText).ok).toBe(false)
    const { ts: _ts, ...noTs } = SUM
    expect(parseCallsEnvelope(noTs).ok).toBe(false)
  })

  it("rejects an unknown kind and non-object payloads", () => {
    expect(parseCallsEnvelope({ ...SEG, kind: "transcript" }).ok).toBe(false)
    expect(parseCallsEnvelope("just a string").ok).toBe(false)
    expect(parseCallsEnvelope(null).ok).toBe(false)
  })
})
