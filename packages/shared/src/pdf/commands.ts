// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sandboxed PDF draw-command DSL — the validated contract between an app's
// sandbox-run template (which emits a JSON command list via `PdfBuilder`) and
// the host replayer (which validates + executes the commands against pdf-lib).
//
// The host NEVER executes template-authored code: it only replays this typed,
// bounds-checked command stream. This schema is the security boundary — every
// field is constrained so a malicious/buggy template cannot smuggle code,
// reference an un-allowlisted font, or trigger pdf-lib abuse / DoS.
//
// The op set is intentionally minimal (exactly invoicing's needs). It is a zod
// discriminated union, trivially extensible when a future app needs images /
// custom fonts / vector paths.

import { z } from "zod"

/** Allowlisted pdf-lib `StandardFonts` an app template may embed by name. */
export const STANDARD_FONTS = [
  "Helvetica",
  "HelveticaBold",
  "HelveticaOblique",
  "HelveticaBoldOblique",
  "TimesRoman",
  "TimesRomanBold",
  "TimesRomanItalic",
  "TimesRomanBoldItalic",
  "Courier",
  "CourierBold",
  "CourierOblique",
  "CourierBoldOblique",
] as const

export type StandardFontName = (typeof STANDARD_FONTS)[number]

const coord = z.number().finite().min(-100_000).max(100_000)
const channel = z.number().min(0).max(1)
const Color = z.object({ r: channel, g: channel, b: channel }).strict()
const Point = z.object({ x: coord, y: coord }).strict()

const SetMetadata = z
  .object({
    op: z.literal("setMetadata"),
    title: z.string().max(300).optional(),
    producer: z.string().max(300).optional(),
    creator: z.string().max(300).optional(),
  })
  .strict()

const EmbedFont = z
  .object({
    op: z.literal("embedFont"),
    ref: z.string().min(1).max(64),
    standardFont: z.enum(STANDARD_FONTS),
  })
  .strict()

const AddPage = z
  .object({
    op: z.literal("addPage"),
    width: coord.positive(),
    height: coord.positive(),
  })
  .strict()

const DrawText = z
  .object({
    op: z.literal("drawText"),
    page: z.number().int().nonnegative(),
    text: z.string().max(20_000),
    x: coord,
    y: coord,
    size: z.number().positive().max(1000),
    font: z.string().min(1).max(64),
    color: Color.optional(),
  })
  .strict()

const DrawLine = z
  .object({
    op: z.literal("drawLine"),
    page: z.number().int().nonnegative(),
    start: Point,
    end: Point,
    thickness: z.number().positive().max(100).optional(),
    color: Color.optional(),
  })
  .strict()

const DrawRectangle = z
  .object({
    op: z.literal("drawRectangle"),
    page: z.number().int().nonnegative(),
    x: coord,
    y: coord,
    width: coord,
    height: coord,
    color: Color.optional(),
    borderColor: Color.optional(),
    borderWidth: z.number().min(0).max(100).optional(),
  })
  .strict()

const uuid = z.string().uuid()

const EmbedImage = z
  .object({
    op: z.literal("embedImage"),
    ref: z.string().min(1).max(64),
    fileId: uuid,
  })
  .strict()

const DrawImage = z
  .object({
    op: z.literal("drawImage"),
    page: z.number().int().nonnegative(),
    ref: z.string().min(1).max(64),
    x: coord,
    y: coord,
    maxWidth: coord.positive(),
    maxHeight: coord.positive(),
  })
  .strict()

export const DrawCommand = z.discriminatedUnion("op", [
  SetMetadata,
  EmbedFont,
  AddPage,
  DrawText,
  DrawLine,
  DrawRectangle,
  EmbedImage,
  DrawImage,
])
export type DrawCommand = z.infer<typeof DrawCommand>

/** DoS bound — max draw commands per render. */
export const MAX_COMMANDS = 100_000

/** DoS bound — max `embedImage` ops per program. */
export const MAX_EMBED_IMAGES = 8

/** DoS bound — max bytes per embedded image (over-cap images are skipped, not rejected). */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

export const DrawCommandsSchema = z.array(DrawCommand).max(MAX_COMMANDS)
