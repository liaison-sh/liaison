// SPDX-License-Identifier: FSL-1.1-ALv2
// What the control plane's reply may write into this instance: every error
// string the outbox stores (last_error, shown in Settings > System) is bounded,
// the reply body is read up to a byte cap, and the back-off and clock offset a
// reply sets stay within the outbox's own horizon, whatever the control plane
// answers.
import { describe, expect, it } from "bun:test"
import * as outbox from "./outbox"

const { classifyReply } = outbox

const row = { type: "heartbeat", messageId: "00000000-0000-4000-8000-000000000001" }
const ctx = { now: new Date("2026-11-02T12:00:00.000Z"), clockOffsetMs: 0 }
const huge = "x".repeat(1_000_000)
const WEEK_S = 7 * 24 * 3600

describe("control plane reply bounds", () => {
  it("a 4xx error message is capped", () => {
    const o = classifyReply(
      row,
      { status: 400, headers: new Headers(), body: { error: { message: huge } } },
      ctx,
    )
    expect("error" in o && o.error.length).toBeLessThanOrEqual(1000)
  })
  it("a 200 `dropped` value is capped", () => {
    const o = classifyReply(
      row,
      { status: 200, headers: new Headers(), body: { dropped: huge } },
      ctx,
    )
    expect("error" in o && o.error.length).toBeLessThanOrEqual(1000)
  })
  it("a short error code is kept as sent", () => {
    const o = classifyReply(
      row,
      { status: 400, headers: new Headers(), body: { error: { message: "bad_type" } } },
      ctx,
    )
    expect("error" in o && o.error).toBe("400 bad_type")
  })
  it("Retry-After is clamped to the outbox expiry", () => {
    const o = classifyReply(
      row,
      { status: 503, headers: new Headers({ "retry-after": "999999999" }), body: null },
      ctx,
    )
    expect(o.kind).toBe("transient")
    expect(o.kind === "transient" && o.retryAfterSeconds).toBeLessThanOrEqual(WEEK_S)
  })
  it("a 401 Date far away sets a clamped clock offset", () => {
    const o = classifyReply(
      row,
      { status: 401, headers: new Headers({ date: "Tue, 01 Jan 2999 00:00:00 GMT" }), body: null },
      ctx,
    )
    expect(o.kind).toBe("clock")
    expect(o.kind === "clock" && Math.abs(o.offsetMs)).toBeLessThanOrEqual(WEEK_S * 1000)
  })
  it("the reply body is read up to the byte cap, then dropped", async () => {
    const res = new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(64 * 1024).fill(120))
        },
      }),
    )
    expect(typeof outbox.readReplyText).toBe("function")
    expect(await outbox.readReplyText(res)).toBe("")
    expect(await outbox.readReplyText(new Response('{"data":{"type":"ack"}}'))).toBe(
      '{"data":{"type":"ack"}}',
    )
    expect(outbox.REPLY_MAX_BYTES).toBeLessThanOrEqual(64 * 1024)
  })
})
