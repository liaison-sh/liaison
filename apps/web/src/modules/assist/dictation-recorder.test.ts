// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SK8: the next segment's recorder starts about a second BEFORE the previous
// one stops, so a word spoken at the cut is whole in at least one segment.
import { afterEach, describe, expect, it, vi } from "vitest"
import { FakeMediaRecorder, installMic, removeMic } from "./dictation-fakes"
import { recordSegments, SEGMENT_OVERLAP_MS } from "./dictation-recorder"
import { SPEECH_FRAME_MS } from "./dictation-speech"

afterEach(() => {
  vi.useRealTimers()
  removeMic()
})

describe("recordSegments", () => {
  it("starts the next recorder a second before stopping the previous one", async () => {
    vi.useFakeTimers()
    installMic()
    expect(SEGMENT_OVERLAP_MS).toBe(1_000)
    const stream = {} as MediaStream
    const rec = recordSegments(stream, "audio/webm", 10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeMediaRecorder.instances).toHaveLength(2)
    expect(FakeMediaRecorder.instances[0]?.state).toBe("recording")
    expect(FakeMediaRecorder.instances[1]?.state).toBe("recording")
    await vi.advanceTimersByTimeAsync(SEGMENT_OVERLAP_MS)
    expect(FakeMediaRecorder.instances[0]?.state).toBe("inactive")
    const segments = rec.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(await segments).toHaveLength(2)
  })

  // V1: the level is read every SPEECH_FRAME_MS into each segment still
  // recording, so a segment's speech is judged on its own readings (the
  // overlap's readings count for both segments).
  it("reads the level every 50 ms into each recording segment", async () => {
    vi.useFakeTimers()
    installMic()
    expect(SPEECH_FRAME_MS).toBe(50)
    let reading = 0
    const rec = recordSegments({} as MediaStream, "audio/webm", 1_000, () => {
      reading += 1
      return reading
    })
    // Stopped at 1.5 s, inside the overlap: both segments read until then.
    await vi.advanceTimersByTimeAsync(1_500)
    const pending = rec.stop()
    await vi.advanceTimersByTimeAsync(0)
    const [first, second] = await pending
    expect(first?.audio).toBeInstanceOf(Blob)
    expect(first?.levels).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    // The second segment starts at 1 s: readings 21 to 30.
    expect(second?.levels).toEqual(Array.from({ length: 10 }, (_, i) => i + 21))
  })

  it("without a level to read, the segments carry no readings", async () => {
    vi.useFakeTimers()
    installMic()
    const rec = recordSegments({} as MediaStream, "audio/webm", 10_000)
    await vi.advanceTimersByTimeAsync(500)
    const pending = rec.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect((await pending).map((s) => s.levels)).toEqual([[]])
  })

  it("stop during the overlap closes both recorders and keeps both segments", async () => {
    vi.useFakeTimers()
    installMic()
    const rec = recordSegments({} as MediaStream, "audio/webm", 10_000)
    await vi.advanceTimersByTimeAsync(10_200)
    const segments = rec.stop()
    await vi.advanceTimersByTimeAsync(0)
    const out = await segments
    expect(out).toHaveLength(2)
    expect(FakeMediaRecorder.instances.every((r) => r.state === "inactive")).toBe(true)
    // No stray stop fires later.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(FakeMediaRecorder.instances).toHaveLength(2)
  })
})
