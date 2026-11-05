// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HOW LONG A RECORDING IS, READ OFF ITS CONTAINER BEFORE ANYTHING IS PAID FOR.
//
// A transcription is billed by the second, and the provider only says how many
// seconds it heard once it has been paid. So the length is read here first,
// from the container's own timing (no decoding): WebM block timecodes (a
// browser's MediaRecorder writes no Duration element and leaves its Segment
// and Clusters of unknown size, so the blocks are what carry the time), Ogg's
// last granule position, MP4's movie, media and fragment durations, a WAV
// data chunk over its byte rate. Null when the container says nothing usable
// (MP3, raw AAC, a malformed file): the caller then bounds the length by the
// bytes at the highest plausible bitrate.

import type { TranscribeAudioType } from "@liaison/shared"

/** The highest bitrate a compressed dictation plausibly has (320 kbit/s), bytes per second. */
export const MAX_PLAUSIBLE_BYTES_PER_SECOND = 40_000

/** The fewest seconds `bytes` of compressed audio can hold (at the highest plausible bitrate). */
export function minimumSecondsOf(bytes: number): number {
  return bytes / MAX_PLAUSIBLE_BYTES_PER_SECOND
}

/**
 * The LOWEST bitrate each accepted container's speech codec runs at, bytes per
 * second: Opus (WebM, Ogg) goes down to 6 kbit/s, AAC (MP4, raw AAC) and MP3
 * to 8 kbit/s; a WAV is taken at the same 8 kbit/s floor (a compressed codec
 * inside it is possible). A file cannot hold more seconds of audio than its
 * bytes at this rate, whatever its header claims.
 */
export const MIN_PLAUSIBLE_BYTES_PER_SECOND: Record<TranscribeAudioType, number> = {
  "audio/webm": 750,
  "audio/ogg": 750,
  "audio/mp4": 1_000,
  "audio/aac": 1_000,
  "audio/mpeg": 1_000,
  "audio/wav": 1_000,
}

/** The most seconds `bytes` of `contentType` can hold (at the codec's lowest bitrate). */
export function maximumSecondsOf(bytes: number, contentType: TranscribeAudioType): number {
  return bytes / MIN_PLAUSIBLE_BYTES_PER_SECOND[contentType]
}

/** The recording's length in seconds as its container states it, or null. */
export function containerDurationSeconds(
  audio: Uint8Array,
  contentType: TranscribeAudioType,
): number | null {
  try {
    const seconds = (() => {
      switch (contentType) {
        case "audio/webm":
          return webmSeconds(audio)
        case "audio/ogg":
          return oggSeconds(audio)
        case "audio/mp4":
          return mp4Seconds(audio)
        case "audio/wav":
          return wavSeconds(audio)
        default:
          return null
      }
    })()
    return seconds !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds : null
  } catch {
    return null
  }
}

// ── WebM (EBML) ────────────────────────────────────────────────────────────

const EBML = {
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  blockGroup: 0xa0,
  block: 0xa1,
  simpleBlock: 0xa3,
} as const

/** Elements walked INTO (their size may be unknown in a live recording). */
const EBML_CONTAINERS = new Set<number>([EBML.segment, EBML.info, EBML.cluster, EBML.blockGroup])

function vintLength(first: number): number {
  for (let len = 1; len <= 8; len++) if (first & (0x80 >> (len - 1))) return len
  return 0
}

function readUint(bytes: Uint8Array, at: number, len: number): number {
  let v = 0
  for (let i = 0; i < len; i++) v = v * 256 + (bytes[at + i] as number)
  return v
}

function webmSeconds(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let scaleNs = 1_000_000
  let declared: number | null = null
  let clusterTicks = 0
  let maxTicks = -1
  let pos = 0
  while (pos < bytes.length) {
    const idLen = vintLength(bytes[pos] as number)
    if (idLen === 0 || idLen > 4 || pos + idLen >= bytes.length) break
    const id = readUint(bytes, pos, idLen)
    const sizeAt = pos + idLen
    const sizeLen = vintLength(bytes[sizeAt] as number)
    if (sizeLen === 0 || sizeAt + sizeLen > bytes.length) break
    let size = (bytes[sizeAt] as number) & (0xff >> sizeLen)
    let unknown = size === 0xff >> sizeLen
    for (let i = 1; i < sizeLen; i++) {
      const b = bytes[sizeAt + i] as number
      size = size * 256 + b
      if (b !== 0xff) unknown = false
    }
    const data = sizeAt + sizeLen
    if (EBML_CONTAINERS.has(id)) {
      pos = data
      continue
    }
    if (unknown || data + size > bytes.length) break
    if (id === EBML.timecodeScale) scaleNs = readUint(bytes, data, size)
    else if (id === EBML.duration && (size === 4 || size === 8)) {
      declared = size === 4 ? view.getFloat32(data) : view.getFloat64(data)
    } else if (id === EBML.timecode) clusterTicks = readUint(bytes, data, size)
    else if ((id === EBML.simpleBlock || id === EBML.block) && size >= 4) {
      const trackLen = vintLength(bytes[data] as number)
      if (trackLen > 0 && data + trackLen + 2 <= bytes.length) {
        maxTicks = Math.max(maxTicks, clusterTicks + view.getInt16(data + trackLen))
      }
    }
    pos = data + size
  }
  const fromBlocks = maxTicks >= 0 ? (maxTicks * scaleNs) / 1e9 : null
  const fromInfo = declared !== null && declared > 0 ? (declared * scaleNs) / 1e9 : null
  if (fromBlocks === null) return fromInfo
  return fromInfo === null ? fromBlocks : Math.max(fromBlocks, fromInfo)
}

// ── Ogg (Opus, Vorbis) ─────────────────────────────────────────────────────

function isOggPage(bytes: Uint8Array, at: number): boolean {
  return (
    bytes[at] === 0x4f && bytes[at + 1] === 0x67 && bytes[at + 2] === 0x67 && bytes[at + 3] === 0x53
  )
}

function oggSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 28 || !isOggPage(bytes, 0)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const payload = 27 + (bytes[26] as number)
  const head = new TextDecoder().decode(bytes.subarray(payload, payload + 8))
  let rate: number
  let preSkip = 0
  if (head === "OpusHead") {
    rate = 48_000
    preSkip = view.getUint16(payload + 10, true)
  } else if (head.slice(1, 7) === "vorbis") {
    rate = view.getUint32(payload + 12, true)
  } else return null
  if (rate <= 0) return null
  for (let at = bytes.length - 27; at >= 0; at--) {
    if (!isOggPage(bytes, at)) continue
    const granule = Number(view.getBigInt64(at + 6, true))
    if (granule < 0) continue
    return Math.max(0, granule - preSkip) / rate
  }
  return null
}

// ── MP4 / M4A ──────────────────────────────────────────────────────────────

const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "mvex", "moof", "traf"])

function mp4Seconds(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let movieScale = 0
  let movieDuration = 0
  let fragmentDuration = 0
  let mediaScale = 0
  let mediaDuration = 0
  let defaultSample = 0
  let fragmentTicks = 0
  const timed = (at: number): { scale: number; duration: number } => {
    const v1 = bytes[at] === 1
    return v1
      ? { scale: view.getUint32(at + 20), duration: Number(view.getBigUint64(at + 24)) }
      : { scale: view.getUint32(at + 12), duration: view.getUint32(at + 16) }
  }
  const walk = (start: number, end: number): void => {
    let pos = start
    while (pos + 8 <= end) {
      let size = view.getUint32(pos)
      const type = new TextDecoder().decode(bytes.subarray(pos + 4, pos + 8))
      let body = pos + 8
      if (size === 1) {
        if (pos + 16 > end) return
        size = Number(view.getBigUint64(pos + 8))
        body = pos + 16
      } else if (size === 0) size = end - pos
      const boxEnd = Math.min(pos + size, end)
      if (size < 8) return
      if (MP4_CONTAINERS.has(type)) walk(body, boxEnd)
      else if (type === "mvhd") ({ scale: movieScale, duration: movieDuration } = timed(body))
      else if (type === "mdhd") ({ scale: mediaScale, duration: mediaDuration } = timed(body))
      else if (type === "mehd") {
        fragmentDuration =
          bytes[body] === 1 ? Number(view.getBigUint64(body + 4)) : view.getUint32(body + 4)
      } else if (type === "tfhd") {
        const flags = view.getUint32(body) & 0xffffff
        let at = body + 8
        if (flags & 0x01) at += 8
        if (flags & 0x02) at += 4
        defaultSample = flags & 0x08 ? view.getUint32(at) : 0
      } else if (type === "trun") {
        const flags = view.getUint32(body) & 0xffffff
        const count = view.getUint32(body + 4)
        let at = body + 8
        if (flags & 0x01) at += 4
        if (flags & 0x04) at += 4
        const perSample =
          (flags & 0x100 ? 4 : 0) +
          (flags & 0x200 ? 4 : 0) +
          (flags & 0x400 ? 4 : 0) +
          (flags & 0x800 ? 4 : 0)
        if (flags & 0x100) {
          for (let i = 0; i < count && at + 4 <= boxEnd; i++, at += perSample) {
            fragmentTicks += view.getUint32(at)
          }
        } else fragmentTicks += count * defaultSample
      }
      pos = boxEnd
    }
  }
  walk(0, bytes.length)
  const candidates: number[] = []
  if (movieScale > 0) candidates.push(movieDuration / movieScale, fragmentDuration / movieScale)
  if (mediaScale > 0) candidates.push(mediaDuration / mediaScale, fragmentTicks / mediaScale)
  const best = Math.max(0, ...candidates)
  return candidates.length > 0 && best > 0 ? best : null
}

// ── WAV ────────────────────────────────────────────────────────────────────

function wavSeconds(bytes: Uint8Array): number | null {
  const tag = (at: number) => new TextDecoder().decode(bytes.subarray(at, at + 4))
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let byteRate = 0
  let pos = 12
  while (pos + 8 <= bytes.length) {
    const id = tag(pos)
    const size = view.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === "fmt " && body + 12 <= bytes.length) byteRate = view.getUint32(body + 8, true)
    else if (id === "data") {
      if (byteRate <= 0) return null
      return Math.min(size, bytes.length - body) / byteRate
    }
    pos = body + size + (size % 2)
  }
  return null
}
