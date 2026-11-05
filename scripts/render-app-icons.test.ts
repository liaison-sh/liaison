// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app icons are the favicon mark (scripts/render-app-icons.ts renders them).
// Every PNG the script writes, and every PNG embedded in the desktop .icns and
// .ico, is decoded here and sampled at two points: the centre of the dot, which
// must be the light mark colour, and a point of the dark background. The iOS
// icon must carry no alpha channel (App Store Connect rejects one) and must be
// a full square (its corner is background, iOS applies the mask).
//
// The decoder is local and pure (node:zlib), so this runs on any host.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { inflateSync } from "node:zlib"
import {
  ANDROID_DENSITIES,
  ANDROID_SPLASHES,
  BACKGROUND,
  DESKTOP_FILES,
  FOREGROUND_MARGIN,
  IOS_SPLASH_FILES,
  MARK,
  SPLASH_BACKGROUND,
} from "./render-app-icons"

const ROOT = path.resolve(import.meta.dir, "..")
const IOS_ICON = "apps/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
const ANDROID_RES = "apps/mobile/android/app/src/main/res"
const DESKTOP_ICONS = "apps/desktop/src-tauri/icons"
// Channel tolerance. `tauri icon` downsamples the 1024 render with a smoothing
// filter, and at 32 px the 5 px dot comes out 7 levels under the mark colour;
// the two colours are more than 200 levels apart, so 8 still tells them apart.
const TOLERANCE = 8

type Image = {
  width: number
  height: number
  colorType: number
  channels: number
  pixels: Uint8Array
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Decodes an 8 bit, non interlaced PNG (grey, RGB, palette, grey alpha, RGBA) to RGBA. */
function decodePng(data: Buffer): Image {
  if (!data.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG")
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  let palette: Buffer | null = null
  let transparency: Buffer | null = null
  const idat: Buffer[] = []
  while (offset < data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.toString("latin1", offset + 4, offset + 8)
    const body = data.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === "IHDR") {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const bitDepth = body[8]
      colorType = body[9]
      if (bitDepth !== 8 || body[12] !== 0)
        throw new Error(`unsupported PNG: depth ${bitDepth}, interlace ${body[12]}`)
    } else if (type === "PLTE") palette = body
    else if (type === "tRNS") transparency = body
    else if (type === "IDAT") idat.push(body)
    else if (type === "IEND") break
  }
  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const channels = channelsByType[colorType]
  if (!channels) throw new Error(`unsupported colour type ${colorType}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const unfiltered = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? unfiltered[y * stride + x - channels] : 0
      const up = y > 0 ? unfiltered[(y - 1) * stride + x] : 0
      const upLeft = y > 0 && x >= channels ? unfiltered[(y - 1) * stride + x - channels] : 0
      let predictor = 0
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = up
      else if (filter === 3) predictor = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      unfiltered[y * stride + x] = (line[x] + predictor) & 0xff
    }
  }
  const pixels = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const s = unfiltered.subarray(i * channels, (i + 1) * channels)
    let rgba: number[]
    if (colorType === 0) rgba = [s[0], s[0], s[0], 255]
    else if (colorType === 2) rgba = [s[0], s[1], s[2], 255]
    else if (colorType === 4) rgba = [s[0], s[0], s[0], s[1]]
    else if (colorType === 6) rgba = [s[0], s[1], s[2], s[3]]
    else {
      if (!palette) throw new Error("palette PNG without PLTE")
      const index = s[0]
      rgba = [
        palette[index * 3],
        palette[index * 3 + 1],
        palette[index * 3 + 2],
        transparency?.[index] ?? 255,
      ]
    }
    pixels.set(rgba, i * 4)
  }
  return { width, height, colorType, channels, pixels }
}

/** Every PNG stream embedded in a container file (.icns, .ico). */
function embeddedPngs(data: Buffer): Buffer[] {
  const found: Buffer[] = []
  let at = data.indexOf(SIGNATURE)
  while (at !== -1) {
    const end = data.indexOf(Buffer.from("IEND"), at)
    if (end === -1) break
    found.push(data.subarray(at, end + 8))
    at = data.indexOf(SIGNATURE, end)
  }
  return found
}

function hex(colour: string): number[] {
  return [1, 3, 5].map((i) => Number.parseInt(colour.slice(i, i + 2), 16))
}

/** RGBA of the pixel under a point given in the icon's own unit space. */
function sample(image: Image, x: number, y: number, units: number): number[] {
  const px = Math.floor((x / units) * image.width)
  const py = Math.floor((y / units) * image.height)
  const i = (py * image.width + px) * 4
  return Array.from(image.pixels.subarray(i, i + 4))
}

function expectColour(actual: number[], colour: string, label: string): void {
  const expected = hex(colour)
  const off =
    expected.some((c, i) => Math.abs(c - actual[i]) > TOLERANCE) || actual[3] < 255 - TOLERANCE
  expect(off ? `${label}: rgba(${actual.join(",")}) is not ${colour}` : "ok").toBe("ok")
}

// Points in the favicon's 32 unit space: the dot's centre and a background
// point clear of the L, inside the rounded square and the round launcher.
const DOT = [22, 20] as const
const PLAIN = [5, 16] as const

function expectMark(image: Image, label: string): void {
  expect(image.width).toBe(image.height)
  expectColour(sample(image, DOT[0], DOT[1], 32), MARK, `${label} dot`)
  expectColour(sample(image, PLAIN[0], PLAIN[1], 32), BACKGROUND, `${label} background`)
}

function load(repoRelative: string): Image {
  return decodePng(readFileSync(path.join(ROOT, repoRelative)))
}

describe("app icons rendered from the favicon", () => {
  it("iOS: 1024 square, the mark, no alpha channel, square corners", () => {
    const image = load(IOS_ICON)
    expect([image.width, image.height]).toEqual([1024, 1024])
    expect(image.colorType).toBe(2)
    expectMark(image, "iOS")
    expectColour(sample(image, 0, 0, 32), BACKGROUND, "iOS corner")
  })

  for (const [density, scale] of Object.entries(ANDROID_DENSITIES)) {
    it(`Android ${density}: legacy square and round launchers carry the mark`, () => {
      for (const name of ["ic_launcher.png", "ic_launcher_round.png"]) {
        const image = load(`${ANDROID_RES}/mipmap-${density}/${name}`)
        expect(image.width).toBe(48 * scale)
        expectMark(image, `${density}/${name}`)
      }
    })

    it(`Android ${density}: adaptive foreground is the mark on transparent`, () => {
      const image = load(`${ANDROID_RES}/mipmap-${density}/ic_launcher_foreground.png`)
      expect(image.width).toBe(108 * scale)
      const units = 32 + 2 * FOREGROUND_MARGIN
      expectColour(
        sample(image, DOT[0] + FOREGROUND_MARGIN, DOT[1] + FOREGROUND_MARGIN, units),
        MARK,
        `${density} foreground dot`,
      )
      const clear = sample(image, PLAIN[0] + FOREGROUND_MARGIN, PLAIN[1] + FOREGROUND_MARGIN, units)
      expect(clear[3]).toBe(0)
    })
  }

  it("Android adaptive background colour is the favicon's", () => {
    const xml = readFileSync(
      path.join(ROOT, ANDROID_RES, "values/ic_launcher_background.xml"),
      "utf8",
    )
    expect(xml.toLowerCase()).toContain(
      `<color name="ic_launcher_background">${BACKGROUND}</color>`,
    )
    for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
      const adaptive = readFileSync(path.join(ROOT, ANDROID_RES, "mipmap-anydpi-v26", name), "utf8")
      expect(adaptive).toContain('android:drawable="@color/ic_launcher_background"')
      expect(adaptive).toContain('android:drawable="@mipmap/ic_launcher_foreground"')
    }
  })

  for (const name of DESKTOP_FILES) {
    it(`desktop ${name} carries the mark`, () => {
      const data = readFileSync(path.join(ROOT, DESKTOP_ICONS, name))
      const images = name.endsWith(".png") ? [data] : embeddedPngs(data)
      expect(images.length).toBeGreaterThan(0)
      for (const [index, png] of images.entries()) expectMark(decodePng(png), `${name}#${index}`)
    })
  }
})

describe("splash screens rendered from the favicon, not the template logo", () => {
  // The template splash was a small blue logo on white. Each splash is now the
  // app background with the icon's dark square in the middle.
  const pixel = (image: Image, x: number, y: number): number[] => {
    const i = (Math.floor(y) * image.width + Math.floor(x)) * 4
    return Array.from(image.pixels.subarray(i, i + 4))
  }
  const check = (repoRelative: string, label: string) => {
    const image = load(repoRelative)
    expectColour(pixel(image, 2, 2), SPLASH_BACKGROUND, `${label} corner`)
    expectColour(pixel(image, image.width / 2, image.height / 2), BACKGROUND, `${label} centre`)
  }
  for (const name of IOS_SPLASH_FILES) {
    it(`iOS ${name}`, () => {
      check(`apps/mobile/ios/App/App/Assets.xcassets/Splash.imageset/${name}`, name)
    })
  }
  for (const [dir, w, h] of ANDROID_SPLASHES) {
    it(`Android ${dir} ${w}x${h}`, () => {
      const image = load(`${ANDROID_RES}/${dir}/splash.png`)
      expect([image.width, image.height]).toEqual([w, h])
      check(`${ANDROID_RES}/${dir}/splash.png`, dir)
    })
  }
})
