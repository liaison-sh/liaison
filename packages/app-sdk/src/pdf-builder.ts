// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sandbox-side PDF builder — a pure recorder. Apps author PDF templates against
// this API; each method pushes a typed draw-command object onto an array. It
// executes NO pdf-lib code (pdf-lib runs only on the host, fed the validated
// command list). The builder is bundled INTO the QuickJS app sandbox, so it
// must stay self-contained: NO runtime import of `@liaison/shared` (the zod
// schema is host-only — pulling it in would bloat the sandbox bundle and risk
// dragging host code in). The command shapes below mirror
// `@liaison/shared`'s `DrawCommand` discriminated union exactly.

/** RGB color, channels in 0..1 (mirrors pdf-lib's `rgb`). */
export interface RgbColor {
  r: number
  g: number
  b: number
}

export interface Point {
  x: number
  y: number
}

/** Allowlisted pdf-lib StandardFonts an app template may embed by name. */
export type StandardFontName =
  | "Helvetica"
  | "HelveticaBold"
  | "HelveticaOblique"
  | "HelveticaBoldOblique"
  | "TimesRoman"
  | "TimesRomanBold"
  | "TimesRomanItalic"
  | "TimesRomanBoldItalic"
  | "Courier"
  | "CourierBold"
  | "CourierOblique"
  | "CourierBoldOblique"

export type DrawCommand =
  | { op: "setMetadata"; title?: string; producer?: string; creator?: string }
  | { op: "embedFont"; ref: string; standardFont: StandardFontName }
  | { op: "addPage"; width: number; height: number }
  | {
      op: "drawText"
      page: number
      text: string
      x: number
      y: number
      size: number
      font: string
      color?: RgbColor
    }
  | {
      op: "drawLine"
      page: number
      start: Point
      end: Point
      thickness?: number
      color?: RgbColor
    }
  | {
      op: "drawRectangle"
      page: number
      x: number
      y: number
      width: number
      height: number
      color?: RgbColor
      borderColor?: RgbColor
      borderWidth?: number
    }
  | { op: "embedImage"; ref: string; fileId: string }
  | {
      op: "drawImage"
      page: number
      ref: string
      x: number
      y: number
      maxWidth: number
      maxHeight: number
    }

/** Build an RGB color (channels 0..1). Mirrors pdf-lib's `rgb`. */
export function rgb(r: number, g: number, b: number): RgbColor {
  return { r, g, b }
}

export interface DrawTextOptions {
  x: number
  y: number
  size: number
  font: string
  color?: RgbColor
}

export interface DrawLineOptions {
  start: Point
  end: Point
  thickness?: number
  color?: RgbColor
}

export interface DrawRectangleOptions {
  x: number
  y: number
  width: number
  height: number
  color?: RgbColor
  borderColor?: RgbColor
  borderWidth?: number
}

/**
 * `x`/`y` is the TOP-LEFT corner of the image's bounding box (note this is
 * the opposite convention from pdf-lib's native `drawImage`, whose `y` is
 * the bottom-left — the host replayer does the y-flip). The image is scaled
 * to CONTAIN within (`maxWidth`, `maxHeight`) preserving aspect ratio.
 */
export interface DrawImageOptions {
  ref: string
  x: number
  y: number
  maxWidth: number
  maxHeight: number
}

/** A page proxy whose draw methods record commands carrying this page's index. */
export class PdfPage {
  constructor(
    private readonly index: number,
    private readonly commands: DrawCommand[],
  ) {}

  drawText(text: string, opts: DrawTextOptions): void {
    this.commands.push({
      op: "drawText",
      page: this.index,
      text,
      x: opts.x,
      y: opts.y,
      size: opts.size,
      font: opts.font,
      ...(opts.color ? { color: opts.color } : {}),
    })
  }

  drawLine(opts: DrawLineOptions): void {
    this.commands.push({
      op: "drawLine",
      page: this.index,
      start: opts.start,
      end: opts.end,
      ...(opts.thickness !== undefined ? { thickness: opts.thickness } : {}),
      ...(opts.color ? { color: opts.color } : {}),
    })
  }

  drawRectangle(opts: DrawRectangleOptions): void {
    this.commands.push({
      op: "drawRectangle",
      page: this.index,
      x: opts.x,
      y: opts.y,
      width: opts.width,
      height: opts.height,
      ...(opts.color ? { color: opts.color } : {}),
      ...(opts.borderColor ? { borderColor: opts.borderColor } : {}),
      ...(opts.borderWidth !== undefined ? { borderWidth: opts.borderWidth } : {}),
    })
  }

  /** `opts.y` is the TOP of the image's bounding box (see `DrawImageOptions`). */
  drawImage(opts: DrawImageOptions): void {
    this.commands.push({
      op: "drawImage",
      page: this.index,
      ref: opts.ref,
      x: opts.x,
      y: opts.y,
      maxWidth: opts.maxWidth,
      maxHeight: opts.maxHeight,
    })
  }
}

/** Pure draw-command recorder. `.build()` returns the accumulated JSON array. */
export class PdfBuilder {
  private readonly commands: DrawCommand[] = []
  private pageCount = 0

  setMetadata(meta: { title?: string; producer?: string; creator?: string }): void {
    this.commands.push({
      op: "setMetadata",
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      ...(meta.producer !== undefined ? { producer: meta.producer } : {}),
      ...(meta.creator !== undefined ? { creator: meta.creator } : {}),
    })
  }

  /** Embed a standard font under `ref`; returns the ref for use in draw calls. */
  embedFont(standardFont: StandardFontName, ref?: string): string {
    const fontRef = ref ?? standardFont
    this.commands.push({ op: "embedFont", ref: fontRef, standardFont })
    return fontRef
  }

  addPage(width: number, height: number): PdfPage {
    const index = this.pageCount
    this.pageCount += 1
    this.commands.push({ op: "addPage", width, height })
    return new PdfPage(index, this.commands)
  }

  /**
   * Embed a kernel.files image (by uuid) under `ref`; returns the ref for use
   * in `PdfPage.drawImage`. The host resolves `fileId` to bytes scoped to the
   * render's org — a missing/inaccessible/oversized/unsupported-mime file is
   * SKIPPED silently by the host replayer (a missing logo must never fail a
   * render), so callers should not assume the ref will always paint.
   */
  embedImage(fileId: string, ref?: string): string {
    const imageRef = ref ?? fileId
    this.commands.push({ op: "embedImage", ref: imageRef, fileId })
    return imageRef
  }

  build(): DrawCommand[] {
    return this.commands
  }
}
