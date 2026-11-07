// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org transfer bundle: a stream of lines, framed in sections.
//
//   {"k":"begin","section":"<name>","count":<n>,"meta":{...}}
//   <n> data lines (each one JSON value on one line)
//   {"k":"end","section":"<name>","sha256":"<hex of the n lines joined by \n>"}
//   ...
//   {"k":"manifest","sections":[{"name","count","sha256"}...],"counts":{...},"sha256":"<hex>"}
//
// The reader verifies each section's sha256 as it ends and the manifest last
// (every section listed, in order, nothing more): the import runs inside one
// transaction and throws on the first mismatch, so a corrupted or cut stream
// leaves nothing on the target.
import { createHash } from "node:crypto"

export const BUNDLE_FORMAT = 1

export interface SectionSummary {
  name: string
  count: number
  sha256: string
}

export interface Manifest {
  k: "manifest"
  sections: SectionSummary[]
  /** Rows of the org per closure table on the source, at the export's snapshot. */
  counts: Record<string, number>
  sha256: string
}

export class BundleError extends Error {
  constructor(message: string) {
    super(`org transfer bundle: ${message}`)
    this.name = "BundleError"
  }
}

function sha(lines: readonly string[]): string {
  const h = createHash("sha256")
  lines.forEach((l, i) => {
    if (i > 0) h.update("\n")
    h.update(l)
  })
  return h.digest("hex")
}

function manifestSha(sections: readonly SectionSummary[], counts: Record<string, number>): string {
  const h = createHash("sha256")
  for (const s of sections) h.update(`${s.name}\0${s.count}\0${s.sha256}\n`)
  for (const k of Object.keys(counts).sort()) h.update(`${k}=${counts[k]}\n`)
  return h.digest("hex")
}

/** Builds a bundle in memory, section by section. */
export class BundleWriter {
  readonly lines: string[] = []
  private readonly sections: SectionSummary[] = []

  section(name: string, data: readonly string[], meta: Record<string, unknown> = {}): void {
    for (const d of data) {
      if (d.includes("\n")) throw new BundleError(`section ${name}: a data line holds a newline`)
    }
    const digest = sha(data)
    this.lines.push(JSON.stringify({ k: "begin", section: name, count: data.length, meta }))
    for (const d of data) this.lines.push(d)
    this.lines.push(JSON.stringify({ k: "end", section: name, sha256: digest }))
    this.sections.push({ name, count: data.length, sha256: digest })
  }

  finish(counts: Record<string, number>): string[] {
    const manifest: Manifest = {
      k: "manifest",
      sections: this.sections,
      counts,
      sha256: manifestSha(this.sections, counts),
    }
    this.lines.push(JSON.stringify(manifest))
    return this.lines
  }
}

export interface Section {
  name: string
  meta: Record<string, unknown>
  data: string[]
}

/**
 * Read a bundle: yields each section once its sha256 checked, and returns the
 * verified manifest. Throws `BundleError` on any framing, digest or manifest
 * mismatch, and when the stream ends before the manifest.
 */
export async function* readBundle(
  lines: AsyncIterable<string> | Iterable<string>,
): AsyncGenerator<Section, Manifest> {
  const seen: SectionSummary[] = []
  let current: {
    name: string
    count: number
    meta: Record<string, unknown>
    data: string[]
  } | null = null
  let manifest: Manifest | null = null
  for await (const raw of lines as AsyncIterable<string>) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (manifest) {
      if (line === "") continue
      throw new BundleError("data after the manifest")
    }
    if (current && current.data.length < current.count) {
      current.data.push(line)
      continue
    }
    if (line === "") continue
    let frame: { k?: string; section?: string; count?: number; meta?: unknown; sha256?: string }
    try {
      frame = JSON.parse(line) as typeof frame
    } catch {
      throw new BundleError("a frame line is not JSON")
    }
    if (current) {
      if (frame.k !== "end" || frame.section !== current.name) {
        throw new BundleError(`section ${current.name} is not closed where it should be`)
      }
      const digest = sha(current.data)
      if (digest !== frame.sha256) {
        throw new BundleError(`section ${current.name}: sha256 mismatch`)
      }
      seen.push({ name: current.name, count: current.count, sha256: digest })
      yield { name: current.name, meta: current.meta, data: current.data }
      current = null
      continue
    }
    if (frame.k === "begin" && typeof frame.section === "string" && Number.isInteger(frame.count)) {
      current = {
        name: frame.section,
        count: frame.count as number,
        meta: (frame.meta ?? {}) as Record<string, unknown>,
        data: [],
      }
      continue
    }
    if (frame.k === "manifest") {
      const m = frame as unknown as Manifest
      const listed = JSON.stringify(m.sections ?? [])
      if (listed !== JSON.stringify(seen)) {
        throw new BundleError("the manifest does not list the sections received")
      }
      if (m.sha256 !== manifestSha(seen, m.counts ?? {})) {
        throw new BundleError("manifest sha256 mismatch")
      }
      manifest = m
      continue
    }
    throw new BundleError(`unexpected frame ${String(frame.k)}`)
  }
  if (current) throw new BundleError(`the stream ended inside section ${current.name}`)
  if (!manifest) throw new BundleError("the stream ended before the manifest")
  return manifest
}
