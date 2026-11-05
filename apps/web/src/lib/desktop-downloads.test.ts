// SPDX-License-Identifier: FSL-1.1-ALv2
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  DESKTOP_DOWNLOADS,
  DESKTOP_DOWNLOADS_BASE,
  desktopDownloadUrl,
  detectDesktopOs,
  orderedDesktopDownloads,
} from "~/lib/desktop-downloads"

const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
const LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0"
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"

describe("detectDesktopOs", () => {
  it("names the three desktop families", () => {
    expect(detectDesktopOs({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 0 })).toBe(
      "macos",
    )
    expect(detectDesktopOs({ userAgent: WINDOWS, platform: "Win32" })).toBe("windows")
    expect(detectDesktopOs({ userAgent: LINUX, platform: "Linux x86_64" })).toBe("linux")
  })

  it("an iPad announces itself as a Mac and is not one", () => {
    expect(detectDesktopOs({ userAgent: MAC, platform: "MacIntel", maxTouchPoints: 5 })).toBeNull()
  })

  it("a phone whose agent says Linux gets no recommendation", () => {
    expect(detectDesktopOs({ userAgent: ANDROID, platform: "Linux armv81" })).toBeNull()
  })

  it("an unknown agent gets no recommendation", () => {
    expect(detectDesktopOs({ userAgent: "curl/8.0" })).toBeNull()
  })
})

describe("orderedDesktopDownloads", () => {
  it("puts the visitor's family first and keeps everything else", () => {
    expect(orderedDesktopDownloads("linux").map((d) => d.id)).toEqual([
      "linuxAppImage",
      "linuxDeb",
      "macos",
      "windows",
    ])
    expect(orderedDesktopDownloads(null).map((d) => d.id)).toEqual(
      DESKTOP_DOWNLOADS.map((d) => d.id),
    )
  })
})

describe("the stable installer names", () => {
  it("are the four the release mirror publishes", () => {
    expect(DESKTOP_DOWNLOADS.map(desktopDownloadUrl)).toEqual([
      "https://downloads.liaison.sh/desktop/latest/Liaison-macos.dmg",
      "https://downloads.liaison.sh/desktop/latest/Liaison-windows-setup.exe",
      "https://downloads.liaison.sh/desktop/latest/Liaison-linux.AppImage",
      "https://downloads.liaison.sh/desktop/latest/Liaison-linux.deb",
    ])
  })

  it("each one is an alias the mirror really writes", () => {
    // The mirror owns the names (apps/desktop/ci/downloads.ts). It is read as
    // text because the web app must not import release tooling.
    const mirror = readFileSync(path.resolve(process.cwd(), "../desktop/ci/downloads.ts"), "utf8")
    expect(mirror).toContain('DOWNLOADS_HOST = "downloads.liaison.sh"')
    // The directory too: the names alone would stay green over four dead links.
    expect(mirror).toContain('DESKTOP_PREFIX = "desktop"')
    expect(mirror).toMatch(/ALIAS_PREFIX = `\$\{DESKTOP_PREFIX\}\/latest`/)
    expect(DESKTOP_DOWNLOADS_BASE).toBe("https://downloads.liaison.sh/desktop/latest")
    for (const download of DESKTOP_DOWNLOADS) {
      expect(mirror).toContain(`alias: "${download.file}"`)
    }
  })
})
