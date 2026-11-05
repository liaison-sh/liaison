// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The publish request, built from what the three build jobs actually uploaded.
//
// The failure this module exists to produce is "a platform is missing", loudly.
// A manifest that quietly names two platforms instead of three does not fail
// anything: the release page looks right, the pipeline is green, and every
// installed copy on the third platform simply stops being offered updates, for
// as long as nobody notices. So a platform the workflow builds and did not
// upload is a refusal here, by name.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildRequest, JOB_PLATFORMS, REQUIRED_PLATFORM_KEYS } from "./build-publish-request"
import { DOWNLOADS_BASE, versionPrefix } from "./downloads"

const VERSION = "9.9.9"

/** The files each build job uploads, as the download lays them out: one
 *  directory per artifact name. `thin-x86_64` is a thin Intel build no job
 *  produces today, for the preference test. */
const UPLOADS: Record<string, string[]> = {
  "build-macos": [
    `Liaison_${VERSION}_universal.app.tar.gz`,
    `Liaison_${VERSION}_universal.app.tar.gz.sig`,
    `Liaison_${VERSION}_universal.dmg`,
  ],
  "thin-x86_64": [
    `Liaison_${VERSION}_x86_64.app.tar.gz`,
    `Liaison_${VERSION}_x86_64.app.tar.gz.sig`,
    `Liaison_${VERSION}_x86_64.dmg`,
  ],
  "build-windows": [
    `Liaison_${VERSION}_x86_64.exe`,
    `Liaison_${VERSION}_x86_64.exe.sig`,
    "windows-signing.json",
  ],
  "build-linux": [`Liaison_${VERSION}_x86_64.AppImage`, `Liaison_${VERSION}_x86_64.AppImage.sig`],
}

const JOBS = Object.keys(JOB_PLATFORMS)

function artifactsDir(keys: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), "liaison-publish-request-"))
  for (const key of keys) {
    for (const name of UPLOADS[key] ?? []) {
      const file = path.join(root, name)
      writeFileSync(
        file,
        name === "windows-signing.json"
          ? `${JSON.stringify({ signed: true, reason: "signtool verified", publisher: "Mathieu Frohlich" })}\n`
          : `${key} ${name}\n`,
      )
    }
  }
  return root
}

function request(keys: string[]) {
  return buildRequest({
    artifactsDir: artifactsDir(keys),
    tag: `desktop-v${VERSION}`,
    notes: "## What's new\n\n- A thing.\n",
  })
}

describe("the publish request", () => {
  it("names the platforms each build job in the release workflow produces", () => {
    // The set is one constant, read here and by the workflow's own test. A
    // fourth job added to the workflow with no entry here would build a
    // platform the gate never asks for. The macOS job answers two keys.
    expect(REQUIRED_PLATFORM_KEYS.slice().sort()).toEqual(
      Object.values(JOB_PLATFORMS).flat().sort(),
    )
    expect(REQUIRED_PLATFORM_KEYS.slice().sort()).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-x86_64",
      "windows-x86_64",
    ])
  })

  it("carries every platform the workflow builds", () => {
    const built = request(JOBS)
    expect(built.platforms.map((entry) => entry.key).sort()).toEqual(
      REQUIRED_PLATFORM_KEYS.slice().sort(),
    )
  })

  it("points every platform at the public downloads host, under this build's version", () => {
    // The GitHub repository is private, so a release asset url answers 404 to
    // every anonymous client: an installed copy asking for its next version
    // gets nothing, and there is no token it could be handed. The public
    // surface is downloads.liaison.sh, and no caller may name another one.
    const built = request(JOBS)
    const base = `${DOWNLOADS_BASE}/${versionPrefix(built.version)}/`
    for (const entry of built.platforms) {
      expect(entry.url.startsWith(base), `${entry.key}: ${entry.url}`).toBe(true)
      expect(entry.url).not.toContain("github.com")
      expect(entry.url.endsWith(entry.archive.split("/").at(-1) ?? "")).toBe(true)
    }
  })

  it("refuses when a platform the workflow builds is missing, and names it", () => {
    // The whole point: a shorter manifest rather than a failure is an update
    // channel that silently goes dead for one operating system.
    expect(() => request(["build-macos", "build-windows"])).toThrow("linux-x86_64")
  })

  it("refuses when every platform is missing", () => {
    expect(() => request([])).toThrow("darwin-aarch64")
  })

  it("answers both macOS keys with the one universal build", () => {
    // The updater asks by the running Mac's arch. An Intel Mac with no
    // darwin-x86_64 key is never offered an update, so the universal archive
    // and its disk image stand behind both.
    const built = request(JOBS)
    for (const key of ["darwin-aarch64", "darwin-x86_64"]) {
      const entry = built.platforms.find((platform) => platform.key === key)
      expect(path.basename(entry?.archive ?? "")).toBe(`Liaison_${VERSION}_universal.app.tar.gz`)
      expect(path.basename(entry?.installer ?? "")).toBe(`Liaison_${VERSION}_universal.dmg`)
    }
  })

  it("prefers a thin archive for the key's own arch over the universal one", () => {
    const built = request([...JOBS, "thin-x86_64"])
    const byKey = new Map(built.platforms.map((entry) => [entry.key, entry]))
    expect(path.basename(byKey.get("darwin-x86_64")?.archive ?? "")).toBe(
      `Liaison_${VERSION}_x86_64.app.tar.gz`,
    )
    expect(path.basename(byKey.get("darwin-x86_64")?.installer ?? "")).toBe(
      `Liaison_${VERSION}_x86_64.dmg`,
    )
    expect(path.basename(byKey.get("darwin-aarch64")?.archive ?? "")).toBe(
      `Liaison_${VERSION}_universal.app.tar.gz`,
    )
  })

  it("refuses an archive uploaded without its updater signature", () => {
    const root = artifactsDir(JOBS)
    const stripped = mkdtempSync(path.join(tmpdir(), "liaison-publish-request-"))
    for (const key of JOBS) {
      for (const name of UPLOADS[key] ?? []) {
        if (name.endsWith(".AppImage.sig")) continue
        writeFileSync(
          path.join(stripped, name),
          name === "windows-signing.json"
            ? `${JSON.stringify({ signed: true, reason: "signtool verified", publisher: "Mathieu Frohlich" })}\n`
            : `${key} ${name}\n`,
        )
      }
    }
    expect(root).not.toBe(stripped)
    expect(() =>
      buildRequest({
        artifactsDir: stripped,
        tag: `desktop-v${VERSION}`,
        notes: "notes",
      }),
    ).toThrow("without its updater signature")
  })
})
