// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where a browser visitor gets the desktop app, and the only place the web app
// spells those addresses. The release mirror (apps/desktop/ci/downloads.ts)
// keeps a copy of the newest installer under each of these stable names, so a
// link here never needs a version in it. The two lists are pinned against each
// other by desktop-downloads.test.ts: a rename on one side fails there instead
// of turning this menu into four dead links.

export const DESKTOP_DOWNLOADS_BASE = "https://downloads.liaison.sh/desktop/latest"

export type DesktopOs = "macos" | "windows" | "linux"

export interface DesktopDownload {
  id: "macos" | "windows" | "linuxAppImage" | "linuxDeb"
  os: DesktopOs
  file: string
  /** Key under `kernel.desktopApp`. */
  labelKey: string
}

export const DESKTOP_DOWNLOADS: readonly DesktopDownload[] = [
  { id: "macos", os: "macos", file: "Liaison-macos.dmg", labelKey: "kernel.desktopApp.macos" },
  {
    id: "windows",
    os: "windows",
    file: "Liaison-windows-setup.exe",
    labelKey: "kernel.desktopApp.windows",
  },
  {
    id: "linuxAppImage",
    os: "linux",
    file: "Liaison-linux.AppImage",
    labelKey: "kernel.desktopApp.linuxAppImage",
  },
  {
    id: "linuxDeb",
    os: "linux",
    file: "Liaison-linux.deb",
    labelKey: "kernel.desktopApp.linuxDeb",
  },
]

export function desktopDownloadUrl(download: DesktopDownload): string {
  return `${DESKTOP_DOWNLOADS_BASE}/${download.file}`
}

/** Which installer family fits the visitor, or null when it cannot be told
 *  (a phone, a tablet, an unknown agent). Phones and tablets are excluded on
 *  purpose: iPadOS reports itself as a Mac, and a dmg is no use there, so a
 *  "Macintosh" agent with touch points is not a Mac. */
export function detectDesktopOs(nav: {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
}): DesktopOs | null {
  const agent = `${nav.userAgent} ${nav.platform ?? ""}`
  if (/Android|iPhone|iPad|iPod/i.test(agent)) return null
  if (/Windows|Win32|Win64/i.test(agent)) return "windows"
  if (/Macintosh|MacIntel|Mac OS X/i.test(agent)) {
    return (nav.maxTouchPoints ?? 0) > 1 ? null : "macos"
  }
  if (/Linux|X11|CrOS/i.test(agent)) return "linux"
  return null
}

/** The installers with the visitor's own family first, order otherwise kept. */
export function orderedDesktopDownloads(os: DesktopOs | null): DesktopDownload[] {
  const mine = DESKTOP_DOWNLOADS.filter((d) => d.os === os)
  const rest = DESKTOP_DOWNLOADS.filter((d) => d.os !== os)
  return [...mine, ...rest]
}
