// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
//
// V1: a silent or near-silent take is never sent (a speech model transcribes
// silence into "No, no, no..." or a stray syllable). The take's 50 ms level
// readings decide, against the room's own ambient level.
import { describe, expect, it } from "vitest"
import {
  ambientOf,
  heardSpeech,
  MIN_SPEECH_FRAMES,
  SPEECH_RMS_CEILING,
  SPEECH_RMS_FLOOR,
  segmentsWithSpeech,
  speechThreshold,
} from "./dictation-speech"

const frames = (n: number, rms: number) => Array.from({ length: n }, () => rms)
/** Steady room noise: about `rms`, wobbling ±20 % frame to frame. */
const noise = (n: number, rms: number) =>
  Array.from({ length: n }, (_, i) => rms * (1 + 0.2 * Math.sin(i * 1.7)))

describe("speech activity of a take", () => {
  it("digital silence is no speech", () => {
    const levels = frames(100, 0)
    expect(heardSpeech(levels, ambientOf(levels) ?? 0)).toBe(false)
  })

  it("low steady room noise is no speech", () => {
    const levels = noise(100, 0.02)
    expect(heardSpeech(levels, ambientOf(levels) ?? 0)).toBe(false)
  })

  it("noise just above the absolute floor, with a dropout, is still no speech", () => {
    const levels = noise(100, 0.012)
    levels[40] = 0
    expect(heardSpeech(levels, ambientOf(levels) ?? 0)).toBe(false)
  })

  it("a burst of voice over room noise is speech", () => {
    const levels = [...noise(40, 0.02), ...noise(8, 0.15), ...noise(40, 0.02)]
    expect(heardSpeech(levels, ambientOf(levels) ?? 0)).toBe(true)
  })

  it("voice from the very first frame is speech (the ambient comes from the pause after)", () => {
    const levels = [...noise(30, 0.15), ...noise(20, 0.01)]
    expect(heardSpeech(levels, ambientOf(levels) ?? 0)).toBe(true)
  })

  it("a single click is not speech", () => {
    const levels = noise(100, 0.01)
    levels[50] = 0.4
    levels[51] = 0.4
    expect(heardSpeech(levels, ambientOf(levels) ?? 0)).toBe(false)
  })

  it("a very short take needs half its frames to be voice", () => {
    expect(MIN_SPEECH_FRAMES).toBeGreaterThan(2)
    expect(heardSpeech([0.2, 0.2], 0)).toBe(true)
    expect(heardSpeech([0, 0], 0)).toBe(false)
  })

  it("the threshold sits above the ambient, between a floor and a ceiling", () => {
    expect(speechThreshold(0)).toBe(SPEECH_RMS_FLOOR)
    expect(speechThreshold(1)).toBe(SPEECH_RMS_CEILING)
    const mid = speechThreshold(0.01)
    expect(mid).toBeGreaterThan(0.01)
    expect(mid).toBeLessThan(SPEECH_RMS_CEILING)
  })

  it("judges each segment against the whole take's ambient; no readings is unknown", () => {
    const quiet = noise(200, 0.02)
    const talking = [...noise(100, 0.15), ...noise(5, 0.03)]
    expect(segmentsWithSpeech([quiet, talking, []])).toEqual([false, true, null])
    expect(ambientOf([])).toBeNull()
  })
})
