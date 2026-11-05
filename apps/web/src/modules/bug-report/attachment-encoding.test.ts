// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import {
  encodeFileBase64,
  formatFileSize,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  mergeSelection,
} from "./attachment-encoding"

function makeFile(name: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: "image/png" })
}

describe("mergeSelection", () => {
  it("appends picked files under the caps", () => {
    const { files, rejections } = mergeSelection([makeFile("a.png", 100)], [makeFile("b.png", 200)])
    expect(files.map((f) => f.name)).toEqual(["a.png", "b.png"])
    expect(rejections).toEqual([])
  })

  it("rejects files beyond the count cap", () => {
    const current = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => makeFile(`f${i}.png`, 10))
    const { files, rejections } = mergeSelection(current, [makeFile("extra.png", 10)])
    expect(files.length).toBe(MAX_ATTACHMENTS)
    expect(rejections).toEqual(["too_many"])
  })

  it("rejects a single file over the per-file cap", () => {
    const { files, rejections } = mergeSelection(
      [],
      [makeFile("big.png", MAX_ATTACHMENT_BYTES + 1)],
    )
    expect(files).toEqual([])
    expect(rejections).toEqual(["file_too_large"])
  })

  it("rejects files that would push the total over the cumulative cap", () => {
    const half = Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES / 2)
    const first = makeFile("first.png", Math.min(half, MAX_ATTACHMENT_BYTES))
    const current = [first, makeFile("second.png", Math.min(half, MAX_ATTACHMENT_BYTES))]
    const { files, rejections } = mergeSelection(current, [
      makeFile("third.png", MAX_ATTACHMENT_BYTES),
    ])
    expect(files.length).toBe(2)
    expect(rejections).toEqual(["total_too_large"])
  })
})

describe("encodeFileBase64", () => {
  it("round-trips bytes through base64", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const encoded = await encodeFileBase64(new File([bytes], "x.bin"))
    expect(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))).toEqual(bytes)
  })

  it("handles payloads larger than one encoding chunk", async () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7).map((_, i) => i % 256)
    const encoded = await encodeFileBase64(new File([bytes], "big.bin"))
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
    expect(decoded.length).toBe(bytes.length)
    expect(decoded[decoded.length - 1]).toBe(bytes[bytes.length - 1])
  })
})

describe("formatFileSize", () => {
  it("formats bytes, kilobytes, and megabytes", () => {
    expect(formatFileSize(512)).toBe("512 B")
    expect(formatFileSize(2048)).toBe("2 KB")
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB")
  })
})
