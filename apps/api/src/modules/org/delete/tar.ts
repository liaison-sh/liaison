// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A minimal streaming tar (POSIX ustar) writer for the legal-retention archive:
// regular files only, each entry's size known before its bytes (a header, the
// bytes, zero padding to 512), two zero blocks at the end. Any `tar` reads it
// (`tar -xf`). Names longer than 100 bytes are split into ustar's prefix and
// name fields; a name that does not fit is refused, the caller keeps names
// short.

const BLOCK = 512
const encoder = new TextEncoder()

/** Thrown when an entry name does not fit the ustar name fields (155 + 100 bytes). */
export class TarNameTooLongError extends Error {
  constructor(readonly entry: string) {
    super(`tar entry name too long: ${entry}`)
    this.name = "TarNameTooLongError"
  }
}

function writeString(buf: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value)
  buf.set(bytes.subarray(0, length), offset)
}

function writeOctal(buf: Uint8Array, offset: number, length: number, value: number): void {
  // length - 1 octal digits, then a NUL.
  writeString(buf, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`)
}

function splitName(name: string): { prefix: string; name: string } {
  const bytes = encoder.encode(name)
  if (bytes.length <= 100) return { prefix: "", name }
  // Split at a slash so that the prefix fits 155 bytes and the rest 100.
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== "/") continue
    const prefix = name.slice(0, i)
    const rest = name.slice(i + 1)
    if (encoder.encode(prefix).length <= 155 && encoder.encode(rest).length <= 100 && rest) {
      return { prefix, name: rest }
    }
  }
  throw new TarNameTooLongError(name)
}

/** True when `name` fits the ustar name fields (so `tarHeader` accepts it). */
export function tarNameFits(name: string): boolean {
  try {
    splitName(name)
    return true
  } catch (err) {
    if (err instanceof TarNameTooLongError) return false
    throw err
  }
}

/** The 512-byte ustar header of a regular file. */
export function tarHeader(name: string, size: number, mtime: Date = new Date()): Uint8Array {
  const h = new Uint8Array(BLOCK)
  const parts = splitName(name)
  writeString(h, 0, 100, parts.name)
  writeOctal(h, 100, 8, 0o644)
  writeOctal(h, 108, 8, 0)
  writeOctal(h, 116, 8, 0)
  writeOctal(h, 124, 12, size)
  writeOctal(h, 136, 12, Math.floor(mtime.getTime() / 1000))
  // The checksum is computed with its own field read as eight spaces.
  h.fill(0x20, 148, 156)
  h[156] = 0x30 // '0': a regular file
  writeString(h, 257, 6, "ustar\0")
  writeString(h, 263, 2, "00")
  writeString(h, 345, 155, parts.prefix)
  let sum = 0
  for (const b of h) sum += b
  writeString(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  return h
}

/** Zero bytes that bring an entry of `size` bytes to a block boundary. */
export function tarPadding(size: number): Uint8Array {
  const rest = size % BLOCK
  return new Uint8Array(rest === 0 ? 0 : BLOCK - rest)
}

/** The end-of-archive marker: two zero blocks. */
export function tarEnd(): Uint8Array {
  return new Uint8Array(BLOCK * 2)
}

/** One whole in-memory entry: header, bytes, padding. */
export function* tarEntry(name: string, bytes: Uint8Array, mtime?: Date): Generator<Uint8Array> {
  yield tarHeader(name, bytes.byteLength, mtime)
  if (bytes.byteLength > 0) yield bytes
  const pad = tarPadding(bytes.byteLength)
  if (pad.byteLength > 0) yield pad
}

/** Read the regular-file entries of a whole tar (tests, and anyone checking an archive). */
export function readTar(tar: Uint8Array): Array<{ name: string; bytes: Uint8Array }> {
  const decoder = new TextDecoder()
  const out: Array<{ name: string; bytes: Uint8Array }> = []
  const field = (h: Uint8Array, offset: number, length: number) =>
    decoder.decode(h.subarray(offset, offset + length)).replace(/\0.*$/s, "")
  let at = 0
  while (at + BLOCK <= tar.byteLength) {
    const h = tar.subarray(at, at + BLOCK)
    if (h.every((b) => b === 0)) break
    const name = field(h, 0, 100)
    const prefix = field(h, 345, 155)
    const size = Number.parseInt(field(h, 124, 12).trim() || "0", 8)
    at += BLOCK
    out.push({ name: prefix ? `${prefix}/${name}` : name, bytes: tar.slice(at, at + size) })
    at += size + tarPadding(size).byteLength
  }
  return out
}
