// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Windows installer format is a decision, not a default. `targets: "all"`
// makes tauri's bundler emit BOTH an NSIS setup .exe and an MSI, and then
// every later step in this pipeline has to guess which of the two it is meant
// to sign, register and publish: the signing step signs one of them, the
// updater manifest points at the other, and nothing says so until a customer
// updates. So the target list is explicit, the choice is recorded in prose
// next to it, and both are pinned here.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { PLATFORM_KEYS } from "./ci/build-publish-request"
import { BUNDLE_TYPE_WARNING_MARKER, bundleTypeWarningNote, relay } from "./ci/tauri-build"

const DESKTOP = import.meta.dir
const DECISION = path.join(DESKTOP, "ci", "windows-installer.md")
const decision = readFileSync(DECISION, "utf8")
const config = JSON.parse(
  readFileSync(path.join(DESKTOP, "src-tauri", "tauri.conf.json"), "utf8"),
) as {
  bundle: {
    targets: string[]
    windows?: { nsis?: { installMode?: string; installerHooks?: string } }
  }
}

describe("the Windows installer decision", () => {
  it("names NSIS, and says why not MSI", () => {
    expect(decision).toContain("NSIS")
    expect(decision).toContain("MSI")
    expect(decision.toLowerCase()).toContain("per-user")
  })

  it("pins the bundler to an explicit target list that carries nsis and not msi", () => {
    expect(Array.isArray(config.bundle.targets)).toBe(true)
    expect(config.bundle.targets).toContain("nsis")
    expect(config.bundle.targets).not.toContain("msi")
  })

  it("installs for the current user, which is what makes an unelevated update possible", () => {
    expect(config.bundle.windows?.nsis?.installMode).toBe("currentUser")
  })

  it("records what tauri.conf.json actually sets, so the prose cannot drift", () => {
    for (const setting of config.bundle.targets) {
      expect(decision).toContain(setting)
    }
    expect(decision).toContain("currentUser")
  })
})

describe("the bundle type the Windows and Linux shells do not carry", () => {
  // Every Windows and Linux build logs "Failed to add bundler type to the
  // binary: __TAURI_BUNDLE_TYPE variable not found in binary", and macOS does
  // not. It is expected: tauri-utils declares the placeholder with #[used],
  // which is llvm.used and does not survive the linker on ELF or PE, while
  // Mach O keeps it and tauri-bundler skips patching macOS bundles anyway.
  //
  // It is harmless ONLY because of what this repo publishes, so the property
  // that makes it harmless is pinned here rather than left in prose.
  it("publishes generic manifest keys, which is what makes the missing symbol harmless", () => {
    // tauri-plugin-updater reads bundle_type() in get_urls to try
    // `{os}-{arch}-{installer}` before `{os}-{arch}`. With no bundle type the
    // generic key is the only candidate, so every key we publish has to BE the
    // generic one. An installer suffix here and a customer's update stops
    // resolving.
    const INSTALLER_SUFFIX = /-(nsis|msi|appimage|deb|rpm|app)$/
    for (const key of Object.keys(PLATFORM_KEYS)) {
      expect(key, `${key} carries an installer suffix`).not.toMatch(INSTALLER_SUFFIX)
    }
  })

  it("says in the build log that the warning is expected, and why", () => {
    // A log::warn that scrolls past inside several thousand lines is a warning
    // nobody reads. The wrapper answers it where it happens.
    const note = bundleTypeWarningNote(
      `        Warn [tauri_bundler::bundle] Failed to add bundler type to the binary: ${BUNDLE_TYPE_WARNING_MARKER}. Make sure tauri crate and tauri-cli are up to date`,
    )
    expect(note).not.toBeNull()
    expect(note).toContain("expected")
    expect(note).toContain("windows-x86_64")
    expect(note).toContain("windows-installer.md")
  })

  it("says nothing about any other line", () => {
    expect(bundleTypeWarningNote("Compiling liaison-desktop v0.1.0")).toBeNull()
    expect(bundleTypeWarningNote("")).toBeNull()
  })

  it("records the decision with its source citations", () => {
    expect(decision).toContain("#[used]")
    expect(decision).toContain("patch_binary")
    expect(decision).toContain("extract_exe")
    expect(decision).toContain("install_appimage")
    expect(decision).toContain("get_urls")
  })
})

describe("the build wrapper's own relay", () => {
  // The wrapper had to stop inheriting the bundler's streams in order to read
  // them, and a relay that dropped a line would hide the whole build log
  // behind a green tick. So it is run over a real stream.
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(text)
        // Split mid line on purpose: a chunk boundary is where a naive
        // line splitter loses a character.
        controller.enqueue(bytes.slice(0, 7))
        controller.enqueue(bytes.slice(7))
        controller.close()
      },
    })

  it("passes every byte through, trailing line without a newline included", async () => {
    const seen: string[] = []
    await relay(stream("alpha\nbeta\ngamma"), (text) => seen.push(text))
    expect(seen.join("")).toBe("alpha\nbeta\ngamma")
  })

  it("collects the bundle type note once per warning line", async () => {
    const line = `Warn Failed to add bundler type: ${BUNDLE_TYPE_WARNING_MARKER}.`
    const notes = await relay(stream(`compiling\n${line}\ndone\n`), () => {})
    expect(notes.length).toBe(1)
    expect(notes[0]).toContain("windows-x86_64")
  })
})
