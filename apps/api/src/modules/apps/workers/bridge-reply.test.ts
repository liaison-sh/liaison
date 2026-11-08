// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bridge call module the fake loader shares byte for byte with the app
// loader (__fixtures__/bridge-reply.ts), against the same vectors.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BRIDGE_REPLY_VERSION, bridgeCall } from "./__fixtures__/bridge-reply"

const V = JSON.parse(
  readFileSync(join(import.meta.dir, "__fixtures__", "bridge-reply-vectors.json"), "utf8"),
)

describe("bridge-reply vectors", () => {
  test("version", () => expect(BRIDGE_REPLY_VERSION).toBe(V.version))
  test("request shape", async () => {
    const sent: { url: string; init: RequestInit }[] = []
    const stats = { calls: 0, ms: 0 }
    await bridgeCall(V.props, V.request.method, V.request.args, {
      callId: () => V.request.callId,
      stats,
      fetch: async (url, init) => {
        sent.push({ url, init })
        return Response.json({ data: 1 })
      },
    })
    expect(sent).toEqual([{ url: V.request.url, init: V.request.init }])
    expect(stats.calls).toBe(1)
  })
  for (const c of V.unknownMethod) {
    test(`unknown method ${c.method}: refused, no request, not counted`, async () => {
      const stats = { calls: 0, ms: 0 }
      let fetched = false
      const r = await bridgeCall(V.props, c.method, [], {
        stats,
        fetch: async () => {
          fetched = true
          return Response.json({})
        },
      })
      expect(r).toEqual(c.reply)
      expect(fetched).toBe(false)
      expect(stats.calls).toBe(0)
    })
  }
  for (const c of V.replies) {
    test(`reply ${c.case}`, async () => {
      const texts: string[] = []
      const r = await bridgeCall(V.props, "emit", [], {
        onResponseText: (t) => texts.push(t),
        fetch: async () => new Response(c.body, { status: c.status }),
      })
      if (c.dataUndefined) {
        expect(Object.keys(r)).toEqual(["data"])
        expect((r as { data: unknown }).data).toBeUndefined()
      } else expect(r).toEqual(c.reply)
      expect(texts).toEqual([c.body])
    })
  }
  test("unreachable", async () => {
    const stats = { calls: 0, ms: 0 }
    const r = await bridgeCall(V.props, "emit", [], {
      stats,
      fetch: async () => {
        throw new Error(V.unreachable.throw)
      },
    })
    expect(r).toEqual(V.unreachable.reply)
    expect(stats.calls).toBe(1)
  })
})
