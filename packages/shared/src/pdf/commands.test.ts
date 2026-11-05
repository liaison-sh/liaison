// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
// In-package test imports the leaf file directly. CROSS-package consumers
// (api, app-sdk) import via the barrel `@liaison/shared`.
import { type DrawCommand, DrawCommandsSchema } from "./commands"

describe("DrawCommandsSchema", () => {
  it("accepts a minimal valid program (metadata + page + font + text + line)", () => {
    const cmds: DrawCommand[] = [
      { op: "setMetadata", title: "Invoice", producer: "Liaison", creator: "Liaison" },
      { op: "embedFont", ref: "f1", standardFont: "Helvetica" },
      { op: "addPage", width: 595, height: 842 },
      {
        op: "drawText",
        page: 0,
        text: "Hello",
        x: 40,
        y: 800,
        size: 11,
        font: "f1",
        color: { r: 0, g: 0, b: 0 },
      },
      {
        op: "drawLine",
        page: 0,
        start: { x: 40, y: 700 },
        end: { x: 555, y: 700 },
        thickness: 0.5,
        color: { r: 0.4, g: 0.4, b: 0.4 },
      },
    ]
    expect(DrawCommandsSchema.safeParse(cmds).success).toBe(true)
  })

  it("rejects an unknown op", () => {
    expect(DrawCommandsSchema.safeParse([{ op: "execShell", cmd: "rm -rf /" }]).success).toBe(false)
  })

  it("rejects unknown extra keys (.strict — no field smuggling)", () => {
    // Each variant is `.strict()`, so an extra own key (a smuggled field a
    // malicious/buggy template tacks on) must fail the parse — guards against
    // a regression that drops `.strict()`.
    expect(
      DrawCommandsSchema.safeParse([{ op: "addPage", width: 1, height: 1, evil: "x" }]).success,
    ).toBe(false)
    expect(
      DrawCommandsSchema.safeParse([
        { op: "embedFont", ref: "f1", standardFont: "Helvetica", extra: 1 },
      ]).success,
    ).toBe(false)
  })

  it("rejects non-positive page dimensions", () => {
    expect(DrawCommandsSchema.safeParse([{ op: "addPage", width: 0, height: 842 }]).success).toBe(
      false,
    )
    expect(DrawCommandsSchema.safeParse([{ op: "addPage", width: -5, height: 842 }]).success).toBe(
      false,
    )
  })

  it("rejects a non-standard font name", () => {
    expect(
      DrawCommandsSchema.safeParse([{ op: "embedFont", ref: "f1", standardFont: "EvilFont" }])
        .success,
    ).toBe(false)
  })

  it("rejects out-of-range color channels and non-finite coords", () => {
    expect(
      DrawCommandsSchema.safeParse([
        { op: "addPage", width: Number.POSITIVE_INFINITY, height: 842 },
      ]).success,
    ).toBe(false)
    expect(
      DrawCommandsSchema.safeParse([
        {
          op: "drawText",
          page: 0,
          text: "x",
          x: 0,
          y: 0,
          size: 10,
          font: "f1",
          color: { r: 2, g: 0, b: 0 },
        },
      ]).success,
    ).toBe(false)
  })

  it("enforces the program length cap", () => {
    const huge = Array.from({ length: 100_001 }, () => ({ op: "addPage", width: 1, height: 1 }))
    expect(DrawCommandsSchema.safeParse(huge).success).toBe(false)
  })

  it("accepts embedImage + drawImage with a valid uuid fileId", () => {
    const cmds: DrawCommand[] = [
      { op: "embedImage", ref: "logo", fileId: "5b9f6e1e-9d1c-4a3a-8f0e-9c1a2b3c4d5e" },
      { op: "addPage", width: 595, height: 842 },
      { op: "drawImage", page: 0, ref: "logo", x: 50, y: 780, maxWidth: 140, maxHeight: 48 },
    ]
    expect(DrawCommandsSchema.safeParse(cmds).success).toBe(true)
  })

  it("rejects embedImage with a non-uuid fileId", () => {
    expect(
      DrawCommandsSchema.safeParse([{ op: "embedImage", ref: "logo", fileId: "not-a-uuid" }])
        .success,
    ).toBe(false)
  })

  it("rejects embedImage/drawImage with smuggled extra keys (.strict)", () => {
    expect(
      DrawCommandsSchema.safeParse([
        {
          op: "embedImage",
          ref: "logo",
          fileId: "5b9f6e1e-9d1c-4a3a-8f0e-9c1a2b3c4d5e",
          evil: "x",
        },
      ]).success,
    ).toBe(false)
    expect(
      DrawCommandsSchema.safeParse([
        {
          op: "drawImage",
          page: 0,
          ref: "logo",
          x: 0,
          y: 0,
          maxWidth: 10,
          maxHeight: 10,
          evil: "x",
        },
      ]).success,
    ).toBe(false)
  })

  it("rejects drawImage with non-positive maxWidth/maxHeight", () => {
    expect(
      DrawCommandsSchema.safeParse([
        { op: "drawImage", page: 0, ref: "logo", x: 0, y: 0, maxWidth: 0, maxHeight: 10 },
      ]).success,
    ).toBe(false)
    expect(
      DrawCommandsSchema.safeParse([
        { op: "drawImage", page: 0, ref: "logo", x: 0, y: 0, maxWidth: 10, maxHeight: -1 },
      ]).success,
    ).toBe(false)
  })
})
