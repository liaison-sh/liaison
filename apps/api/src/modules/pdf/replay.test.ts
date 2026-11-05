// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { DrawCommand } from "@liaison/shared" // barrel, not a subpath (C3)
import { PDFDocument } from "pdf-lib"
import { fitContain, type ResolvedImage, replayDrawCommands } from "./replay"

// A minimal valid 2x1 PNG (red, blue pixel), used as embed-image test fixture.
// Generated once and inlined — avoids a filesystem fixture for a 70-byte PNG.
const TINY_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4nGP8z8DwnwEIGGCAAQAB8QIBHDo0wgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
)

const program: DrawCommand[] = [
  {
    op: "setMetadata",
    title: "Invoice 42",
    producer: "Liaison Invoicing",
    creator: "Liaison Invoicing",
  },
  { op: "embedFont", ref: "f1", standardFont: "Helvetica" },
  { op: "addPage", width: 595, height: 842 },
  { op: "addPage", width: 595, height: 842 },
  { op: "drawText", page: 1, text: "Page two", x: 40, y: 800, size: 11, font: "f1" },
  { op: "drawLine", page: 0, start: { x: 40, y: 700 }, end: { x: 555, y: 700 }, thickness: 0.5 },
]

describe("replayDrawCommands", () => {
  it("renders a valid multi-page PDF from commands", async () => {
    const bytes = await replayDrawCommands(program)
    expect(bytes).toBeInstanceOf(Uint8Array)
    // pdf-lib re-applies its own default Producer in the `load` constructor when
    // `updateMetadata` is true (the save-side default); the persisted bytes
    // carry the producer we set, so load with `updateMetadata: false` to read
    // the document's own metadata back.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    expect(doc.getPageCount()).toBe(2)
    expect(doc.getTitle()).toBe("Invoice 42")
    // H2 — setMetadata must map to setTitle + setProducer + setCreator (the
    // invoicing parity test asserts info.Producer is defined; shared.ts sets
    // all three). Cover producer here so the replayer can't silently drop it.
    expect(doc.getProducer()).toBe("Liaison Invoicing")
  })

  it("rejects a schema-invalid program (unknown op) without touching pdf-lib", async () => {
    await expect(
      replayDrawCommands([{ op: "exec", cmd: "x" } as unknown as DrawCommand]),
    ).rejects.toMatchObject({ code: "invalid_commands" })
  })

  it("rejects drawText referencing an unembedded font ref", async () => {
    await expect(
      replayDrawCommands([
        { op: "addPage", width: 595, height: 842 },
        { op: "drawText", page: 0, text: "x", x: 1, y: 1, size: 10, font: "ghost" },
      ]),
    ).rejects.toMatchObject({ code: "invalid_commands" })
  })

  it("rejects drawText referencing an out-of-range page index", async () => {
    await expect(
      replayDrawCommands([
        { op: "embedFont", ref: "f1", standardFont: "Helvetica" },
        { op: "drawText", page: 5, text: "x", x: 1, y: 1, size: 10, font: "f1" },
      ]),
    ).rejects.toMatchObject({ code: "invalid_commands" })
  })

  it("enforces the max-pages cap", async () => {
    const many: DrawCommand[] = Array.from({ length: 2001 }, () => ({
      op: "addPage" as const,
      width: 1,
      height: 1,
    }))
    await expect(replayDrawCommands(many)).rejects.toMatchObject({ code: "too_many_pages" })
  })

  const fileId = "5b9f6e1e-9d1c-4a3a-8f0e-9c1a2b3c4d5e"

  it("draws a resolved image without throwing and produces a valid PDF", async () => {
    const program2: DrawCommand[] = [
      { op: "embedImage", ref: "logo", fileId },
      { op: "addPage", width: 595, height: 842 },
      { op: "drawImage", page: 0, ref: "logo", x: 50, y: 800, maxWidth: 4, maxHeight: 4 },
    ]
    const bytes = await replayDrawCommands(program2, {
      resolveImage: async (id) =>
        id === fileId ? ({ bytes: TINY_PNG, mime: "image/png" } satisfies ResolvedImage) : null,
    })
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    // Bytes grew meaningfully vs. a bare page — the image XObject was embedded.
    expect(bytes.byteLength).toBeGreaterThan(300)
  })

  it("skips embedImage silently when no resolveImage is provided (no throw)", async () => {
    const program2: DrawCommand[] = [
      { op: "embedImage", ref: "logo", fileId },
      { op: "addPage", width: 595, height: 842 },
      { op: "drawImage", page: 0, ref: "logo", x: 50, y: 800, maxWidth: 100, maxHeight: 100 },
    ]
    const bytes = await replayDrawCommands(program2)
    expect(bytes).toBeInstanceOf(Uint8Array)
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
  })

  it("skips embedImage silently when resolveImage returns null (missing/cross-org file)", async () => {
    const program2: DrawCommand[] = [
      { op: "embedImage", ref: "logo", fileId },
      { op: "addPage", width: 595, height: 842 },
      { op: "drawImage", page: 0, ref: "logo", x: 50, y: 800, maxWidth: 100, maxHeight: 100 },
    ]
    const bytes = await replayDrawCommands(program2, { resolveImage: async () => null })
    expect(bytes).toBeInstanceOf(Uint8Array)
  })

  it("skips embedImage silently when resolveImage rejects", async () => {
    const program2: DrawCommand[] = [
      { op: "embedImage", ref: "logo", fileId },
      { op: "addPage", width: 595, height: 842 },
      { op: "drawImage", page: 0, ref: "logo", x: 50, y: 800, maxWidth: 100, maxHeight: 100 },
    ]
    const bytes = await replayDrawCommands(program2, {
      resolveImage: async () => {
        throw new Error("boom")
      },
    })
    expect(bytes).toBeInstanceOf(Uint8Array)
  })

  it("skips an oversized image (over MAX_IMAGE_BYTES) without throwing", async () => {
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1)
    const program2: DrawCommand[] = [
      { op: "embedImage", ref: "logo", fileId },
      { op: "addPage", width: 595, height: 842 },
      { op: "drawImage", page: 0, ref: "logo", x: 50, y: 800, maxWidth: 100, maxHeight: 100 },
    ]
    const bytes = await replayDrawCommands(program2, {
      resolveImage: async () => ({ bytes: oversized, mime: "image/png" }),
    })
    expect(bytes).toBeInstanceOf(Uint8Array)
  })

  it("skips an unsupported mime type without throwing", async () => {
    const program2: DrawCommand[] = [
      { op: "embedImage", ref: "logo", fileId },
      { op: "addPage", width: 595, height: 842 },
      { op: "drawImage", page: 0, ref: "logo", x: 50, y: 800, maxWidth: 100, maxHeight: 100 },
    ]
    const bytes = await replayDrawCommands(program2, {
      resolveImage: async () => ({ bytes: TINY_PNG, mime: "image/svg+xml" }),
    })
    expect(bytes).toBeInstanceOf(Uint8Array)
  })

  it("enforces the max-embedImage-per-program cap (skips embeds past the cap)", async () => {
    const cmds: DrawCommand[] = []
    for (let i = 0; i < 10; i++) {
      cmds.push({ op: "embedImage", ref: `logo${i}`, fileId })
    }
    cmds.push({ op: "addPage", width: 595, height: 842 })
    let resolveCalls = 0
    await replayDrawCommands(cmds, {
      resolveImage: async () => {
        resolveCalls += 1
        return { bytes: TINY_PNG, mime: "image/png" }
      },
    })
    expect(resolveCalls).toBe(8) // MAX_EMBED_IMAGES
  })
})

describe("fitContain", () => {
  it("scales down a wide image to fit maxWidth, preserving aspect ratio", () => {
    const { width, height } = fitContain(200, 100, 100, 100)
    expect(width).toBe(100)
    expect(height).toBe(50)
  })

  it("scales down a tall image to fit maxHeight, preserving aspect ratio", () => {
    const { width, height } = fitContain(100, 200, 100, 100)
    expect(width).toBe(50)
    expect(height).toBe(100)
  })

  it("scales up a small image to fill the box (contain, not just shrink)", () => {
    const { width, height } = fitContain(10, 10, 140, 48)
    expect(width).toBe(48)
    expect(height).toBe(48)
  })

  it("returns 0x0 for degenerate (non-positive) inputs", () => {
    expect(fitContain(0, 10, 100, 100)).toEqual({ width: 0, height: 0 })
    expect(fitContain(10, 10, 0, 100)).toEqual({ width: 0, height: 0 })
  })
})
