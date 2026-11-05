// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WAS ANYTHING SAID? A speech model given silence or room noise does not
// return nothing: it hallucinates ("No, no, no...", a stray syllable). So the
// browser decides before uploading, from the level meter it already runs: the
// stream's RMS is read every SPEECH_FRAME_MS while recording, and a take (or
// one segment of a long take) without enough frames clearly above the room's
// own level is not sent.
//
// The room's level (the ambient estimate) starts as the mean of the first
// AMBIENT_WINDOW frames and is lowered to the quietest such window seen since,
// so a take that starts mid-word still finds the room in its first pause, and a
// one-frame dropout does not drag it to zero. A frame is speech when its RMS is
// SPEECH_OVER_AMBIENT times the ambient, held between SPEECH_RMS_FLOOR (digital
// silence, hiss) and SPEECH_RMS_CEILING (a voice this loud counts in any room).

/** How often the level is read while recording. */
export const SPEECH_FRAME_MS = 50
/** Consecutive frames averaged into one ambient reading (200 ms). */
export const AMBIENT_WINDOW = 4
/** A speech frame is at least this many times the ambient RMS (about +10 dB). */
export const SPEECH_OVER_AMBIENT = 3
/** The threshold never goes below this RMS (about -40 dBFS). */
export const SPEECH_RMS_FLOOR = 0.01
/** The threshold never goes above this RMS (about -26 dBFS). */
export const SPEECH_RMS_CEILING = 0.05
/**
 * Speech frames a take or segment needs to be sent: 200 ms of voice, or half
 * its frames when it is shorter than twice that.
 */
export const MIN_SPEECH_FRAMES = 4

/** The room's level over these readings, or null when there are none. */
export function ambientOf(levels: readonly number[]): number | null {
  if (levels.length === 0) return null
  if (levels.length <= AMBIENT_WINDOW) {
    return levels.reduce((sum, l) => sum + l, 0) / levels.length
  }
  let quietest = Number.POSITIVE_INFINITY
  let sum = 0
  for (let i = 0; i < levels.length; i++) {
    sum += levels[i] ?? 0
    if (i >= AMBIENT_WINDOW) sum -= levels[i - AMBIENT_WINDOW] ?? 0
    if (i >= AMBIENT_WINDOW - 1) quietest = Math.min(quietest, sum / AMBIENT_WINDOW)
  }
  return quietest
}

/** The RMS a frame must pass to count as speech, in a room at `ambient`. */
export function speechThreshold(ambient: number): number {
  return Math.min(SPEECH_RMS_CEILING, Math.max(SPEECH_RMS_FLOOR, ambient * SPEECH_OVER_AMBIENT))
}

/** Do these readings hold speech, in a room at `ambient`? */
export function heardSpeech(levels: readonly number[], ambient: number): boolean {
  const threshold = speechThreshold(ambient)
  const needed = Math.min(MIN_SPEECH_FRAMES, Math.ceil(levels.length / 2))
  let speech = 0
  for (const level of levels) if (level > threshold) speech += 1
  return levels.length > 0 && speech >= needed
}

/**
 * Each segment's verdict against the whole take's ambient: true (speech),
 * false (none: not sent), or null (no readings, the engine has no Web Audio:
 * sent, as before).
 */
export function segmentsWithSpeech(perSegment: readonly (readonly number[])[]): (boolean | null)[] {
  const ambient = ambientOf(perSegment.flat())
  return perSegment.map((levels) =>
    levels.length === 0 || ambient === null ? null : heardSpeech(levels, ambient),
  )
}
