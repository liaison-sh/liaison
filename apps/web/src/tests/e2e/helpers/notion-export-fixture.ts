// SPDX-License-Identifier: FSL-1.1-ALv2
// The Notion export fixture of the import's server tests (both export
// generations), zipped at test time for the browser: every 32-hex Notion id and
// the top page's name given a suffix, so each run imports pages of its own.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const FIXTURES = join(
  __dirname,
  "../../../../../api/src/modules/imports/builtin/__fixtures__/notion",
)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A zip of stored (uncompressed) entries. */
export function storedZip(entries: Array<{ name: string; data: Uint8Array }>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8")
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, Buffer.from(e.data))
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(e.data.length, 20)
    cen.writeUInt32LE(e.data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, name)
    offset += 30 + name.length + e.data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}

/** The fixture export as a zip; `suffix` (hex digits) renames every page id, `tag` the top page. */
export function notionExportZip(suffix: string, tag: string): Buffer {
  const swap = (s: string) =>
    s
      .replace(/[0-9a-f]{32}/g, (hex) => hex.slice(0, 32 - suffix.length) + suffix)
      .replaceAll("Harbor Handbook", `Harbor Handbook ${tag}`)
  const entries: Array<{ name: string; data: Uint8Array }> = []
  for (const generation of ["current", "older"]) {
    const root = join(FIXTURES, generation)
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) walk(p)
        else {
          const raw = readFileSync(p)
          const text = /\.(md|csv)$/.test(name)
          entries.push({
            name: swap(relative(root, p)),
            data: text ? Buffer.from(swap(raw.toString("utf8")), "utf8") : raw,
          })
        }
      }
    }
    walk(root)
  }
  return storedZip(entries)
}
