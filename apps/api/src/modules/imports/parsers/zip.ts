// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Zip reading by ranges: the central directory is read from the end of the
 * stored object (EOCD, and the ZIP64 EOCD when a count, size or offset
 * overflows 32 bits), then each entry is read on demand: its local header
 * first, then its compressed bytes in 64 KiB slices, inflated as they arrive
 * (fflate `Inflate`) or passed through for stored entries. The archive is
 * never downloaded whole and never fully decompressed in memory.
 *
 * Caps, checked after every slice so a bomb stops early:
 *   - at most 200,000 entries;
 *   - an entry's output at most 100 times its compressed size (once past
 *     1 MiB, so small, highly compressible text files are not refused) and
 *     never more than it declared;
 *   - everything decompressed from one upload at most 20 times the upload
 *     (never below a 64 MiB floor) and at most 50 GB.
 * Encrypted entries and compression methods other than stored (0) and
 * deflate (8) are refused with the entry names.
 *
 * If a store's ranged reads misbehave, `fileRangeSource` over a temporary
 * download of the object is the fallback (same reader, local ranges).
 */
import { Inflate } from "fflate"
import { getObjectRange, headObject, type ObjectStorageDeps } from "~/infra/storage/object-storage"
import { ParserError } from "./common"

// ---------------------------------------------------------------------------
// Range sources
// ---------------------------------------------------------------------------

/** Random access to the bytes of one stored file. */
export interface RangeSource {
  readonly size: number
  /** `length` bytes from `offset` (fewer only at the end of the file). */
  read(offset: number, length: number): Promise<Uint8Array>
}

export function bufferRangeSource(bytes: Uint8Array): RangeSource {
  return {
    size: bytes.byteLength,
    read: async (offset, length) =>
      bytes.subarray(offset, Math.min(bytes.byteLength, offset + length)),
  }
}

export function fileRangeSource(path: string, size: number): RangeSource {
  const file = Bun.file(path)
  return {
    size,
    read: async (offset, length) =>
      new Uint8Array(await file.slice(offset, Math.min(size, offset + length)).arrayBuffer()),
  }
}

/** A stored object, read with ranged GETs (`getObjectRange`). */
export async function objectRangeSource(
  key: string,
  deps?: ObjectStorageDeps,
): Promise<RangeSource> {
  const head = await headObject(key, deps)
  const size = head.contentLength
  return {
    size,
    read: async (offset, length) => {
      const end = Math.min(size, offset + length) - 1
      if (end < offset) return new Uint8Array(0)
      const r = await getObjectRange(key, { start: offset, end }, deps)
      return new Uint8Array(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength)
    },
  }
}

/**
 * One cached window in front of a source: a small read fetches a whole
 * window, so the local headers and data of adjacent small entries come from
 * one ranged GET instead of one each.
 */
export function windowedRangeSource(
  src: RangeSource,
  windowBytes = 256 * 1024,
): RangeSource & { reads: () => number } {
  let start = -1
  let data: Uint8Array = new Uint8Array(0)
  let reads = 0
  return {
    size: src.size,
    reads: () => reads,
    read: async (offset, length) => {
      if (start >= 0 && offset >= start && offset + length <= start + data.byteLength) {
        return data.subarray(offset - start, offset - start + length)
      }
      if (length >= windowBytes) {
        reads++
        return src.read(offset, length)
      }
      reads++
      data = await src.read(offset, windowBytes)
      start = offset
      return data.subarray(0, Math.min(length, data.byteLength))
    },
  }
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

export interface ZipCaps {
  maxEntries: number
  /** Per-entry output / compressed size, applied once the output passes `ratioFloorBytes`. */
  maxEntryRatio: number
  ratioFloorBytes: number
  /** Total output as a multiple of the upload size... */
  maxTotalRatio: number
  /** ...never below this floor... */
  totalFloorBytes: number
  /** ...and never above this. */
  maxTotalBytes: number
}

export const DEFAULT_ZIP_CAPS: ZipCaps = {
  maxEntries: 200_000,
  maxEntryRatio: 100,
  ratioFloorBytes: 1024 * 1024,
  maxTotalRatio: 20,
  totalFloorBytes: 64 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024 * 1024,
}

/** Decompressed bytes counted across every entry read from one upload. */
export class ZipBudget {
  private used = 0
  readonly limit: number
  constructor(uploadBytes: number, caps: ZipCaps = DEFAULT_ZIP_CAPS) {
    this.limit = Math.min(
      caps.maxTotalBytes,
      Math.max(caps.totalFloorBytes, uploadBytes * caps.maxTotalRatio),
    )
  }
  spend(bytes: number, entry: string): void {
    this.used += bytes
    if (this.used > this.limit) {
      throw new ParserError(
        "zip_decompressed_too_large",
        `Reading ${entry} took the archive past ${this.limit} decompressed bytes (20 times the upload, at most 50 GB); refused as a possible zip bomb.`,
      )
    }
  }
  get spent(): number {
    return this.used
  }
}

// ---------------------------------------------------------------------------
// Central directory
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string
  method: number
  flags: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
  isDirectory: boolean
}

const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff
const SLICE_BYTES = 64 * 1024
const PUSH_BYTES = 4 * 1024

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength)
}

function u64(dv: DataView, at: number): number {
  const v = dv.getBigUint64(at, true)
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("a ZIP64 field is out of range")
  return Number(v)
}

function invalid(why: string): ParserError {
  return new ParserError("invalid_zip", `Not a readable zip archive: ${why}.`)
}

function decodeName(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes)
}

async function readExact(
  src: RangeSource,
  offset: number,
  length: number,
  what: string,
): Promise<Uint8Array> {
  if (offset < 0 || offset + length > src.size) throw invalid(`${what} lies outside the file`)
  const b = await src.read(offset, length)
  if (b.byteLength !== length) throw invalid(`${what} is truncated`)
  return b
}

interface Directory {
  entries: number
  cdSize: number
  cdOffset: number
}

async function findDirectory(src: RangeSource): Promise<Directory> {
  if (src.size < 22) throw invalid("the file is too short")
  const tailLen = Math.min(src.size, 22 + 65_535 + 20)
  const tailStart = src.size - tailLen
  const tail = await readExact(src, tailStart, tailLen, "the end of central directory")
  const dv = view(tail)
  let at = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) {
      at = i
      break
    }
  }
  if (at < 0) throw invalid("no end of central directory record")
  let entries = dv.getUint16(at + 10, true)
  let cdSize = dv.getUint32(at + 12, true)
  let cdOffset = dv.getUint32(at + 16, true)
  if (entries === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    const loc = at - 20
    if (loc < 0 || dv.getUint32(loc, true) !== SIG_ZIP64_LOCATOR) {
      throw invalid("a ZIP64 archive without its ZIP64 locator")
    }
    const z64Offset = u64(dv, loc + 8)
    const z = view(await readExact(src, z64Offset, 56, "the ZIP64 end of central directory"))
    if (z.getUint32(0, true) !== SIG_ZIP64_EOCD)
      throw invalid("a bad ZIP64 end of central directory")
    entries = u64(z, 32)
    cdSize = u64(z, 40)
    cdOffset = u64(z, 48)
  }
  if (cdOffset + cdSize > src.size) throw invalid("the central directory lies outside the file")
  return { entries, cdSize, cdOffset }
}

function zip64Extra(
  extra: Uint8Array,
  need: { uncompressed: boolean; compressed: boolean; offset: boolean },
): { uncompressed?: number; compressed?: number; offset?: number } {
  const dv = view(extra)
  let i = 0
  while (i + 4 <= extra.byteLength) {
    const id = dv.getUint16(i, true)
    const len = dv.getUint16(i + 2, true)
    if (id === 0x0001) {
      const out: { uncompressed?: number; compressed?: number; offset?: number } = {}
      let p = i + 4
      const end = i + 4 + len
      if (need.uncompressed && p + 8 <= end) {
        out.uncompressed = u64(dv, p)
        p += 8
      }
      if (need.compressed && p + 8 <= end) {
        out.compressed = u64(dv, p)
        p += 8
      }
      if (need.offset && p + 8 <= end) out.offset = u64(dv, p)
      return out
    }
    i += 4 + len
  }
  return {}
}

const METHOD_NAMES: Record<number, string> = {
  1: "shrink",
  6: "implode",
  9: "deflate64",
  12: "bzip2",
  14: "lzma",
  93: "zstandard",
  95: "xz",
  99: "AES encryption",
}

function listNames(names: string[]): string {
  const shown = names.slice(0, 5).join(", ")
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown
}

/** The archive's entries, read from its central directory, after the format and count checks. */
export async function readZipDirectory(
  src: RangeSource,
  caps: ZipCaps = DEFAULT_ZIP_CAPS,
): Promise<ZipEntry[]> {
  const dir = await findDirectory(src)
  if (dir.entries > caps.maxEntries) {
    throw new ParserError(
      "zip_too_many_entries",
      `The archive has ${dir.entries} entries; an import reads at most ${caps.maxEntries}.`,
    )
  }
  // 46 bytes per entry at the least: a directory claiming more entries than fit is corrupt.
  if (dir.entries * 46 > dir.cdSize)
    throw invalid("the central directory is shorter than its entry count")
  // Read whole below, so bounded: about 1 KiB per entry (name, extra field,
  // comment) plus 1 MiB of slack, never more than 256 MiB.
  const maxCd = Math.min(256 * 1024 * 1024, dir.entries * 1024 + 1024 * 1024)
  if (dir.cdSize > maxCd) {
    throw invalid(
      `the central directory is larger (${dir.cdSize} bytes) than ${dir.entries} entries can need`,
    )
  }
  const cd = await readExact(src, dir.cdOffset, dir.cdSize, "the central directory")
  const dv = view(cd)
  const entries: ZipEntry[] = []
  const encrypted: string[] = []
  const unsupported: string[] = []
  let p = 0
  for (let n = 0; n < dir.entries; n++) {
    if (p + 46 > cd.byteLength || dv.getUint32(p, true) !== SIG_CENTRAL) {
      throw invalid(`central directory entry ${n + 1} is malformed`)
    }
    const flags = dv.getUint16(p + 8, true)
    const method = dv.getUint16(p + 10, true)
    let compressedSize = dv.getUint32(p + 20, true)
    let uncompressedSize = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    let localHeaderOffset = dv.getUint32(p + 42, true)
    const nameStart = p + 46
    if (nameStart + nameLen + extraLen + commentLen > cd.byteLength) {
      throw invalid(`central directory entry ${n + 1} runs past the directory`)
    }
    const name = decodeName(cd.subarray(nameStart, nameStart + nameLen))
    if (
      compressedSize === U32_MAX ||
      uncompressedSize === U32_MAX ||
      localHeaderOffset === U32_MAX
    ) {
      const z = zip64Extra(cd.subarray(nameStart + nameLen, nameStart + nameLen + extraLen), {
        uncompressed: uncompressedSize === U32_MAX,
        compressed: compressedSize === U32_MAX,
        offset: localHeaderOffset === U32_MAX,
      })
      if (uncompressedSize === U32_MAX) {
        if (z.uncompressed === undefined) throw invalid(`${name} lacks its ZIP64 sizes`)
        uncompressedSize = z.uncompressed
      }
      if (compressedSize === U32_MAX) {
        if (z.compressed === undefined) throw invalid(`${name} lacks its ZIP64 sizes`)
        compressedSize = z.compressed
      }
      if (localHeaderOffset === U32_MAX) {
        if (z.offset === undefined) throw invalid(`${name} lacks its ZIP64 offset`)
        localHeaderOffset = z.offset
      }
    }
    const isDirectory = name.endsWith("/")
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || method === 99) encrypted.push(name)
    else if (method !== 0 && method !== 8 && !isDirectory)
      unsupported.push(`${name} (${METHOD_NAMES[method] ?? `method ${method}`})`)
    entries.push({
      name,
      method,
      flags,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory,
    })
    p = nameStart + nameLen + extraLen + commentLen
  }
  if (encrypted.length > 0) {
    throw new ParserError(
      "zip_encrypted",
      `The archive is password-protected (encrypted entries: ${listNames(encrypted)}); export it without a password.`,
    )
  }
  if (unsupported.length > 0) {
    throw new ParserError(
      "zip_unsupported_method",
      `The archive uses a compression method imports cannot read: ${listNames(unsupported)}. Re-zip it with standard deflate compression.`,
    )
  }
  return entries
}

// ---------------------------------------------------------------------------
// Entry data
// ---------------------------------------------------------------------------

async function dataOffset(src: RangeSource, entry: ZipEntry): Promise<number> {
  const h = await readExact(src, entry.localHeaderOffset, 30, `the local header of ${entry.name}`)
  const dv = view(h)
  if (dv.getUint32(0, true) !== SIG_LOCAL) throw invalid(`${entry.name} has no local header`)
  const nameLen = dv.getUint16(26, true)
  const extraLen = dv.getUint16(28, true)
  const start = entry.localHeaderOffset + 30 + nameLen + extraLen
  if (start + entry.compressedSize > src.size)
    throw invalid(`the data of ${entry.name} lies outside the file`)
  return start
}

/**
 * The decompressed bytes of one entry, in order, read slice by slice. Every
 * cap is checked after each slice; `budget` is shared by all entries of one
 * upload.
 */
export async function* readZipEntry(
  src: RangeSource,
  entry: ZipEntry,
  budget: ZipBudget,
  caps: ZipCaps = DEFAULT_ZIP_CAPS,
): AsyncGenerator<Uint8Array> {
  if (entry.isDirectory) return
  const start = await dataOffset(src, entry)
  let produced = 0
  const check = (bytes: number) => {
    produced += bytes
    budget.spend(bytes, entry.name)
    if (produced > entry.uncompressedSize) {
      throw new ParserError(
        "zip_ratio_exceeded",
        `${entry.name} decompresses to more than the ${entry.uncompressedSize} bytes it declares; refused.`,
      )
    }
    if (
      produced > caps.ratioFloorBytes &&
      produced > Math.max(1, entry.compressedSize) * caps.maxEntryRatio
    ) {
      throw new ParserError(
        "zip_ratio_exceeded",
        `${entry.name} expands more than ${caps.maxEntryRatio} times its compressed size; refused as a possible zip bomb.`,
      )
    }
  }
  const out: Uint8Array[] = []
  // Caps are checked as the inflater produces output, so a bomb throws from
  // inside the push before its output is kept. Pushes are 4 KiB, which bounds
  // one push's output (deflate expands at most ~1032 times) to about 4 MiB.
  const inflater =
    entry.method === 8
      ? new Inflate((chunk) => {
          check(chunk.byteLength)
          out.push(chunk)
        })
      : null
  const push = (data: Uint8Array, final: boolean) => {
    if (!inflater) return
    try {
      inflater.push(data, final)
    } catch (err) {
      if (err instanceof ParserError) throw err
      throw invalid(
        `${entry.name} is corrupt (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  }
  let read = 0
  while (read < entry.compressedSize) {
    const len = Math.min(SLICE_BYTES, entry.compressedSize - read)
    const slice = await readExact(src, start + read, len, `the data of ${entry.name}`)
    read += len
    if (!inflater) {
      check(slice.byteLength)
      yield slice
      continue
    }
    for (let i = 0; i < slice.byteLength; i += PUSH_BYTES) {
      const end = Math.min(slice.byteLength, i + PUSH_BYTES)
      push(slice.subarray(i, end), read >= entry.compressedSize && end === slice.byteLength)
      while (out.length > 0) yield out.shift() as Uint8Array
    }
  }
  if (entry.compressedSize === 0) push(new Uint8Array(0), true)
  while (out.length > 0) yield out.shift() as Uint8Array
}
