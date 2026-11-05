// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readStreamCapped } from "~/lib/read-capped-body"

/** A stream of `chunks` that records whether it was cancelled and how many chunks were pulled. */
function chunkStream(chunks: Uint8Array[], onCancel?: () => void) {
  const state = { pulled: 0, cancelled: false }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[state.pulled]
      if (next) {
        state.pulled++
        controller.enqueue(next)
      } else controller.close()
    },
    cancel() {
      state.cancelled = true
      onCancel?.()
    },
  })
  return { stream, state }
}

const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill)

describe("readStreamCapped", () => {
  it("returns every chunk concatenated when the body is under the cap", async () => {
    const { stream, state } = chunkStream([bytes(3), bytes(4, 0x62)])
    const out = await readStreamCapped(stream, 100)
    expect(out?.toString("utf8")).toBe("aaabbbb")
    expect(state.cancelled).toBe(false)
  })

  it("keeps a body of exactly the cap", async () => {
    const { stream } = chunkStream([bytes(5), bytes(5)])
    expect((await readStreamCapped(stream, 10))?.byteLength).toBe(10)
  })

  it("returns null and cancels the stream one byte past the cap, without reading further", async () => {
    const { stream, state } = chunkStream([bytes(5), bytes(6), bytes(5)])
    expect(await readStreamCapped(stream, 10)).toBeNull()
    expect(state.cancelled).toBe(true)
    expect(state.pulled).toBe(2)
  })

  it("still returns null when the cancel itself fails", async () => {
    const { stream } = chunkStream([bytes(20)], () => {
      throw new Error("cancel failed")
    })
    expect(await readStreamCapped(stream, 10)).toBeNull()
  })

  it("returns an empty buffer for an empty stream and releases the lock", async () => {
    const { stream } = chunkStream([])
    expect((await readStreamCapped(stream, 10))?.byteLength).toBe(0)
    expect(stream.locked).toBe(false)
  })

  it("propagates a read error and releases the lock", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket reset"))
      },
    })
    await expect(readStreamCapped(stream, 10)).rejects.toThrow("socket reset")
    expect(stream.locked).toBe(false)
  })
})
