// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Renders the iOS, Android and desktop app icons from the web favicon
// (apps/web/public/favicon.svg), so every shell carries the same mark and a
// change to the mark is one command away from every store asset.
//
//   bun scripts/render-app-icons.ts
//
// Needs `rsvg-convert` (Homebrew: `brew install librsvg`) and, for the desktop
// set, the Tauri CLI already in apps/desktop's dependencies.
// scripts/render-app-icons.test.ts samples every PNG this writes.

import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const FAVICON = path.join(ROOT, "apps/web/public/favicon.svg")

export const BACKGROUND = "#1f2937"
export const MARK = "#f3f4f6"

const IOS_ICON = "apps/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
const IOS_SPLASH_DIR = "apps/mobile/ios/App/App/Assets.xcassets/Splash.imageset"
export const IOS_SPLASH_FILES = [
  "splash-2732x2732.png",
  "splash-2732x2732-1.png",
  "splash-2732x2732-2.png",
]
/** The app's own background (capacitor.config.ts SplashScreen.backgroundColor), so the splash hands over to the first paint without a flash. */
export const SPLASH_BACKGROUND = "#111113"
/** Android splash files: [drawable directory, width, height]. */
export const ANDROID_SPLASHES: ReadonlyArray<readonly [string, number, number]> = [
  ["drawable", 480, 320],
  ["drawable-land-mdpi", 480, 320],
  ["drawable-land-hdpi", 800, 480],
  ["drawable-land-xhdpi", 1280, 720],
  ["drawable-land-xxhdpi", 1600, 960],
  ["drawable-land-xxxhdpi", 1920, 1280],
  ["drawable-port-mdpi", 320, 480],
  ["drawable-port-hdpi", 480, 800],
  ["drawable-port-xhdpi", 720, 1280],
  ["drawable-port-xxhdpi", 960, 1600],
  ["drawable-port-xxxhdpi", 1280, 1920],
]
const ANDROID_RES = "apps/mobile/android/app/src/main/res"
const DESKTOP_ICONS = "apps/desktop/src-tauri/icons"

/** Android launcher densities: legacy icon is 48dp, the adaptive foreground 108dp. */
export const ANDROID_DENSITIES: Record<string, number> = {
  mdpi: 1,
  hdpi: 1.5,
  xhdpi: 2,
  xxhdpi: 3,
  xxxhdpi: 4,
}

/** The desktop files the repo ships (tauri.conf.json lists five, the other two are kept in step). */
export const DESKTOP_FILES = [
  "32x32.png",
  "64x64.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.png",
  "icon.icns",
  "icon.ico",
]

// The mark alone, in the favicon's 32 unit space.
const MARK_SHAPES = `
  <path d="M10 8 V20 H22" stroke="${MARK}" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <circle cx="22" cy="20" r="2.5" fill="${MARK}"/>`

/** iOS: full square, iOS applies its own mask. */
const SQUARE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="${BACKGROUND}"/>${MARK_SHAPES}
</svg>`

/** Android legacy round launcher. */
const ROUND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <circle cx="16" cy="16" r="16" fill="${BACKGROUND}"/>${MARK_SHAPES}
</svg>`

// Android adaptive foreground: 108dp canvas, 72dp visible viewport. The 32 unit
// square maps onto the 72dp viewport, so the canvas is 48 units wide with an
// 8 unit margin. The mark's farthest point sits about 12 units from the
// centre, 27dp, inside the 33dp safe zone radius (66dp circle).
export const FOREGROUND_MARGIN = 8
const FOREGROUND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-FOREGROUND_MARGIN} ${-FOREGROUND_MARGIN} ${32 + 2 * FOREGROUND_MARGIN} ${32 + 2 * FOREGROUND_MARGIN}">${MARK_SHAPES}
</svg>`

function findRsvg(): string {
  for (const candidate of [
    "/opt/homebrew/bin/rsvg-convert",
    "/usr/local/bin/rsvg-convert",
    "/usr/bin/rsvg-convert",
  ]) {
    if (existsSync(candidate)) return candidate
  }
  const which = spawnSync("which", ["rsvg-convert"], { encoding: "utf8" })
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim()
  throw new Error(
    "rsvg-convert not found. Install librsvg (macOS: brew install librsvg) and run again.",
  )
}

function run(cmd: string, args: string[], cwd = ROOT): void {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}`)
}

/**
 * A splash: the app icon (rounded square and mark) centred on the app background.
 * `iconShare` is the icon's side as a share of the canvas's shorter side. The
 * iOS image is a 2732 square shown aspect-fill, so on a phone its height fills
 * the screen and a 12% icon lands around 100 points tall.
 */
export function splashSvg(width: number, height: number, iconShare: number): string {
  const side = Math.min(width, height) * iconShare
  const x = (width - side) / 2
  const y = (height - side) / 2
  const k = side / 32
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="${SPLASH_BACKGROUND}"/>
  <g transform="translate(${x} ${y}) scale(${k})">
    <rect width="32" height="32" rx="7" fill="${BACKGROUND}"/>${MARK_SHAPES}
  </g>
</svg>`
}

function renderRect(rsvg: string, svg: string, width: number, height: number, out: string): void {
  const work = mkdtempSync(path.join(tmpdir(), "app-splash-"))
  try {
    const source = path.join(work, "source.svg")
    writeFileSync(source, svg)
    mkdirSync(path.dirname(out), { recursive: true })
    run(rsvg, [
      "-w",
      String(width),
      "-h",
      String(height),
      "--background-color",
      SPLASH_BACKGROUND,
      source,
      "-o",
      out,
    ])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function render(rsvg: string, svg: string, size: number, out: string, background?: string): void {
  const work = mkdtempSync(path.join(tmpdir(), "app-icon-"))
  try {
    const source = path.join(work, "source.svg")
    writeFileSync(source, svg)
    mkdirSync(path.dirname(out), { recursive: true })
    const args = ["-w", String(size), "-h", String(size)]
    if (background) args.push("--background-color", background)
    run(rsvg, [...args, source, "-o", out])
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function main(): void {
  const rsvg = findRsvg()
  const favicon = readFileSync(FAVICON, "utf8")

  // iOS: opaque (an explicit background makes rsvg write RGB, no alpha).
  render(rsvg, SQUARE_SVG, 1024, path.join(ROOT, IOS_ICON), BACKGROUND)

  // Android: legacy square and round per density, adaptive foreground, background colour.
  for (const [density, scale] of Object.entries(ANDROID_DENSITIES)) {
    const dir = path.join(ROOT, ANDROID_RES, `mipmap-${density}`)
    render(rsvg, favicon, 48 * scale, path.join(dir, "ic_launcher.png"))
    render(rsvg, ROUND_SVG, 48 * scale, path.join(dir, "ic_launcher_round.png"))
    render(rsvg, FOREGROUND_SVG, 108 * scale, path.join(dir, "ic_launcher_foreground.png"))
  }
  writeFileSync(
    path.join(ROOT, ANDROID_RES, "values/ic_launcher_background.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BACKGROUND.toUpperCase()}</color>\n</resources>\n`,
  )

  // Splash screens: the icon on the app background, never the template's logo.
  for (const name of IOS_SPLASH_FILES) {
    renderRect(rsvg, splashSvg(2732, 2732, 0.12), 2732, 2732, path.join(ROOT, IOS_SPLASH_DIR, name))
  }
  for (const [dir, w, h] of ANDROID_SPLASHES) {
    renderRect(rsvg, splashSvg(w, h, 0.25), w, h, path.join(ROOT, ANDROID_RES, dir, "splash.png"))
  }

  // Desktop: `tauri icon` from a 1024 render of the favicon, into a scratch
  // directory, then only the files the repo ships are copied over.
  const work = mkdtempSync(path.join(tmpdir(), "app-icon-desktop-"))
  try {
    const source = path.join(work, "source.png")
    render(rsvg, favicon, 1024, source)
    const out = path.join(work, "icons")
    run("bunx", ["tauri", "icon", source, "--output", out], path.join(ROOT, "apps/desktop"))
    for (const name of DESKTOP_FILES) {
      copyFileSync(path.join(out, name), path.join(ROOT, DESKTOP_ICONS, name))
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }

  console.log("App icons and splash screens rendered from apps/web/public/favicon.svg")
}

if (import.meta.main) main()
