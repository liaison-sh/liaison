// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Test-only zip writer for reader fixtures built at test time: stored or
 * deflate entries, a data descriptor, forced ZIP64 records and fields, the
 * encryption flag, and archives with more than 65,535 entries. It writes what
 * the reader must accept or refuse; it is not a general-purpose zip library.
 */
import { deflateSync } from "fflate"

export interface FixtureEntry {
  name: string
  data?: Uint8Array | string
  method?: 0 | 8 | number
  /** Write sizes in a data descriptor after the data (flag bit 3), zeros in the local header. */
  dataDescriptor?: boolean
  /** Set the encryption flag (bit 0); the data is written as given. */
  encrypted?: boolean
  /** Write the data as already compressed bytes with these declared sizes (bomb fixtures). */
  raw?: { compressed: Uint8Array; uncompressedSize: number }
}

export interface FixtureOptions {
  forceZip64?: boolean
}

const enc = new TextEncoder()

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff]
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
}
function u64(n: number): number[] {
  const lo = n % 2 ** 32
  const hi = Math.floor(n / 2 ** 32)
  return [...u32(lo), ...u32(hi)]
}

export function buildZip(entries: FixtureEntry[], opts: FixtureOptions = {}): Uint8Array {
  const parts: Uint8Array[] = []
  let offset = 0
  const central: Uint8Array[] = []
  const zip64 = opts.forceZip64 === true || entries.length > 0xffff
  const push = (b: Uint8Array) => {
    parts.push(b)
    offset += b.byteLength
  }
  for (const e of entries) {
    const name = enc.encode(e.name)
    const plain = typeof e.data === "string" ? enc.encode(e.data) : (e.data ?? new Uint8Array(0))
    const method = e.raw ? 8 : (e.method ?? 8)
    const body = e.raw ? e.raw.compressed : method === 8 ? deflateSync(plain) : plain
    const uncompressedSize = e.raw ? e.raw.uncompressedSize : plain.byteLength
    let flags = 0x0800
    if (e.dataDescriptor) flags |= 0x0008
    if (e.encrypted) flags |= 0x0001
    const localOffset = offset
    const z64 = zip64
    const localExtra = z64
      ? [...u16(0x0001), ...u16(16), ...u64(uncompressedSize), ...u64(body.byteLength)]
      : []
    const local = [
      ...u32(0x04034b50),
      ...u16(z64 ? 45 : 20),
      ...u16(flags),
      ...u16(method),
      ...u16(0),
      ...u16(0x21),
      ...u32(0),
      ...u32(e.dataDescriptor ? 0 : z64 ? 0xffffffff : body.byteLength),
      ...u32(e.dataDescriptor ? 0 : z64 ? 0xffffffff : uncompressedSize),
      ...u16(name.byteLength),
      ...u16(localExtra.length),
    ]
    push(new Uint8Array(local))
    push(name)
    if (localExtra.length > 0) push(new Uint8Array(localExtra))
    push(body)
    if (e.dataDescriptor) {
      push(
        new Uint8Array(
          z64
            ? [...u32(0x08074b50), ...u32(0), ...u64(body.byteLength), ...u64(uncompressedSize)]
            : [...u32(0x08074b50), ...u32(0), ...u32(body.byteLength), ...u32(uncompressedSize)],
        ),
      )
    }
    const cdExtra = z64
      ? [
          ...u16(0x0001),
          ...u16(24),
          ...u64(uncompressedSize),
          ...u64(body.byteLength),
          ...u64(localOffset),
        ]
      : []
    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(z64 ? 45 : 20),
        ...u16(z64 ? 45 : 20),
        ...u16(flags),
        ...u16(method),
        ...u16(0),
        ...u16(0x21),
        ...u32(0),
        ...u32(z64 ? 0xffffffff : body.byteLength),
        ...u32(z64 ? 0xffffffff : uncompressedSize),
        ...u16(name.byteLength),
        ...u16(cdExtra.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(z64 ? 0xffffffff : localOffset),
      ]),
    )
    central.push(name)
    if (cdExtra.length > 0) central.push(new Uint8Array(cdExtra))
  }
  const cdOffset = offset
  for (const c of central) push(c)
  const cdSize = offset - cdOffset
  if (zip64) {
    const z64Offset = offset
    push(
      new Uint8Array([
        ...u32(0x06064b50),
        ...u64(44),
        ...u16(45),
        ...u16(45),
        ...u32(0),
        ...u32(0),
        ...u64(entries.length),
        ...u64(entries.length),
        ...u64(cdSize),
        ...u64(cdOffset),
      ]),
    )
    push(new Uint8Array([...u32(0x07064b50), ...u32(0), ...u64(z64Offset), ...u32(1)]))
  }
  push(
    new Uint8Array([
      ...u32(0x06054b50),
      ...u16(0),
      ...u16(0),
      ...u16(zip64 ? 0xffff : entries.length),
      ...u16(zip64 ? 0xffff : entries.length),
      ...u32(zip64 ? 0xffffffff : cdSize),
      ...u32(zip64 ? 0xffffffff : cdOffset),
      ...u16(0),
    ]),
  )
  const out = new Uint8Array(offset)
  let p = 0
  for (const b of parts) {
    out.set(b, p)
    p += b.byteLength
  }
  return out
}
