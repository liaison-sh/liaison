// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-FX7 (SK-9): a debug build cannot be shipped by the release workflow, and
// until this file nothing refused one. Two halves, because the defect has two:
// the BUILD refuses to be asked for a debug profile, and the CHECK reads the
// produced bytes rather than the source that claims what they contain.

import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  DEBUG_HOOK_MARKERS,
  debugHooksIn,
  reportDebugHooks,
  scanForDebugHooks,
} from "./check-bundle-no-debug-hooks"
import { buildRustflagsEnv, DEBUG_ASSERTIONS_ENV, releaseBuildRefusal } from "./tauri-build"

const scratch = mkdtempSync(path.join(tmpdir(), "liaison-debug-hooks-"))

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A stand-in binary: the markers live in it exactly as a compiled string
 *  table holds them, one run ASCII and one run UTF-16LE. */
function fixture(name: string, markers: readonly string[]): string {
  const file = path.join(scratch, name)
  const parts: Buffer[] = [Buffer.from(" some other bytes ", "latin1")]
  for (const marker of markers) {
    parts.push(Buffer.from(` ${marker} `, "latin1"))
    parts.push(Buffer.from(marker, "utf16le"))
  }
  parts.push(Buffer.from("trailing", "latin1"))
  writeFileSync(file, Buffer.concat(parts))
  return file
}

describe("a release build refuses to be a debug build", () => {
  it("refuses the flag that produces one", () => {
    expect(releaseBuildRefusal(["--bundles", "app"], {})).toBeNull()
    expect(releaseBuildRefusal(["--debug"], {})).toContain("--debug")
    expect(releaseBuildRefusal(["--bundles", "nsis", "-d"], {})).toContain("-d")
  })

  it("refuses the environment variable that produces one with no flag in sight", () => {
    expect(releaseBuildRefusal([], { [DEBUG_ASSERTIONS_ENV]: "true" })).toContain(
      DEBUG_ASSERTIONS_ENV,
    )
    // Even "false": a build that states it is not doing this is a build that
    // was reaching for the switch, and the switch is not the caller's.
    expect(releaseBuildRefusal([], { [DEBUG_ASSERTIONS_ENV]: "false" })).toContain(
      DEBUG_ASSERTIONS_ENV,
    )
  })

  it("pins the assertions off in the environment the build actually runs with", () => {
    const added = buildRustflagsEnv({ HOME: "/Users/someone" }, "/repo")
    expect(added[DEBUG_ASSERTIONS_ENV]).toBe("false")
  })
})

describe("the shipped bundle carries no debug only hook", () => {
  it("finds a marker in either encoding a binary stores strings in", () => {
    const found = debugHooksIn(
      Buffer.from(
        `x${Buffer.from("LIAISON_DEBUG_DRIVER", "utf16le").toString("latin1")}y`,
        "latin1",
      ),
    )
    expect(found.map((hit) => hit.marker)).toEqual(["LIAISON_DEBUG_DRIVER"])
  })

  it("refuses a bundle built with the debug hooks compiled in", () => {
    const debugBinary = fixture("liaison-debug", DEBUG_HOOK_MARKERS)
    const findings = scanForDebugHooks([debugBinary])
    expect(findings.map((finding) => finding.marker).sort()).toEqual([...DEBUG_HOOK_MARKERS].sort())
    // Each one twice: once ASCII, once UTF-16LE, which is what a Windows
    // binary carrying it looks like.
    expect(findings.every((finding) => finding.count === 2)).toBe(true)
    expect(reportDebugHooks(findings, scratch)).toBe(true)
  })

  it("passes a release binary, which carries none of them", () => {
    const releaseBinary = fixture("liaison-release", [])
    expect(scanForDebugHooks([releaseBinary])).toEqual([])
    expect(reportDebugHooks([], scratch)).toBe(false)
  })

  it("says nothing about the page side command names, which every build carries", () => {
    // `driver-bridge.ts` and `diagnostics.ts` compile their command names into
    // overlay.js on every build and are inert without the Rust half. Refusing
    // those strings would refuse every bundle we ship.
    const overlay = path.join(scratch, "overlay.js")
    writeFileSync(overlay, 'const a = "report_driver_result", b = "report_webview_diagnostic"')
    expect(scanForDebugHooks([overlay])).toEqual([])
  })
})
