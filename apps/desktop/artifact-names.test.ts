// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One name shape for every platform, derived in one place.
//
// The bundler names its own outputs, and it names them differently per target
// (`liaison-desktop_0.1.0_amd64.deb`, `Liaison_0.1.0_x64-setup.exe`). Left
// alone, every consumer downstream grows its own glob: the upload step, the
// checksum file, the updater manifest, the download page. Then one of those
// globs stops matching after a bundler upgrade and the release is missing a
// platform, silently, because a glob that matches nothing is not an error
// anywhere except where somebody remembered to write one.
//
// So the names are computed here, the artifacts are renamed to them before
// anything downstream looks, and the updater signature name is derived from
// the artifact name rather than spelled out a second time.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  type Arch,
  artifactGlob,
  artifactName,
  defaultArch,
  KINDS,
  PLATFORM_ARCHES,
  PLATFORMS,
  type Platform,
  signatureName,
} from "./ci/artifact-names"
import { loadDesktopReleaseWorkflow, step } from "./ci/workflow"

describe("artifact names", () => {
  it("derives every name for every platform and arch", () => {
    const derived: string[] = []
    for (const platform of PLATFORMS) {
      for (const arch of PLATFORM_ARCHES[platform]) {
        for (const kind of KINDS[platform]) {
          derived.push(artifactName({ platform, kind, version: "1.2.3", arch }))
        }
      }
    }
    expect(derived.sort()).toEqual(
      [
        "Liaison_1.2.3_aarch64.dmg",
        "Liaison_1.2.3_x86_64.dmg",
        "Liaison_1.2.3_universal.dmg",
        "Liaison_1.2.3_aarch64.exe",
        "Liaison_1.2.3_x86_64.exe",
        "Liaison_1.2.3_aarch64.AppImage",
        "Liaison_1.2.3_x86_64.AppImage",
        "Liaison_1.2.3_aarch64.deb",
        "Liaison_1.2.3_x86_64.deb",
      ].sort(),
    )
  })

  it("refuses a kind that platform does not produce", () => {
    // The MSI is the one that matters: the decision not to produce it lives in
    // ci/windows-installer.md, and a name for it here would quietly revive it.
    expect(() =>
      artifactName({ platform: "windows", kind: "msi" as never, version: "1.2.3", arch: "x86_64" }),
    ).toThrow()
    expect(() =>
      artifactName({ platform: "macos", kind: "deb", version: "1.2.3", arch: "x86_64" }),
    ).toThrow()
  })

  it("refuses a version or an arch it does not recognise", () => {
    expect(() =>
      artifactName({ platform: "macos", kind: "dmg", version: "v1.2.3", arch: "x86_64" }),
    ).toThrow()
    expect(() =>
      artifactName({ platform: "macos", kind: "dmg", version: "1.2.3", arch: "arm64" as Arch }),
    ).toThrow()
  })

  it("builds macOS universal and nothing else universal", () => {
    // One image for every Mac: the name a macOS build defaults to says so,
    // whatever CPU the runner that built it has.
    expect(defaultArch("macos", "arm64")).toBe("universal")
    expect(defaultArch("macos", "x64")).toBe("universal")
    expect(defaultArch("windows", "x64")).toBe("x86_64")
    expect(() =>
      artifactName({ platform: "windows", kind: "exe", version: "1.2.3", arch: "universal" }),
    ).toThrow()
  })

  it("derives the updater signature name from the artifact name", () => {
    // Two spellings of the same name is how a manifest ends up pointing at a
    // signature file that was never uploaded.
    expect(signatureName("Liaison_1.2.3_aarch64.dmg")).toBe("Liaison_1.2.3_aarch64.dmg.sig")
    expect(() => signatureName("Liaison_1.2.3_aarch64.dmg.sig")).toThrow()
  })

  it("globs match exactly the names it derives, and nothing the bundler names", () => {
    for (const platform of PLATFORMS) {
      for (const kind of KINDS[platform]) {
        const glob = artifactGlob(kind)
        const name = artifactName({ platform, kind, version: "1.2.3", arch: "x86_64" })
        expect(new Bun.Glob(glob).match(name)).toBe(true)
        expect(new Bun.Glob(glob).match(`liaison-desktop_1.2.3_amd64.${kind}`)).toBe(false)
      }
    }
  })
})

describe("the workflow uploads the names this module derives", () => {
  const workflow = loadDesktopReleaseWorkflow()
  const uploads: Record<Platform, string> = {
    macos: String(
      step(workflow.jobs["build-macos"].steps, "Upload the macOS artifact").with?.path ?? "",
    ),
    windows: String(
      step(workflow.jobs["build-windows"].steps, "Upload the Windows artifact").with?.path ?? "",
    ),
    linux: String(
      step(workflow.jobs["build-linux"].steps, "Upload the Linux artifact").with?.path ?? "",
    ),
  }

  it("uploads one glob per artifact kind, from this module", () => {
    for (const platform of PLATFORMS) {
      for (const kind of KINDS[platform]) {
        expect(uploads[platform]).toContain(artifactGlob(kind))
      }
    }
  })

  it("renames the bundler's own output before anything downstream reads it", () => {
    for (const [job, platform] of [
      ["build-windows", "windows"],
      ["build-linux", "linux"],
    ] as const) {
      const rename = step(workflow.jobs[job].steps, `Name the ${platform} artifacts`)
      expect(rename.run).toContain("apps/desktop/ci/artifact-names.ts")
      expect(rename.run).toContain("rename")
    }
  })

  it("is what make-dmg.sh names the image with, rather than a second spelling", () => {
    const script = readFileSync(path.join(import.meta.dir, "ci", "make-dmg.sh"), "utf8")
    expect(script).toContain("artifact-names.ts")
    // The shape is asserted by the derivation tests above; what matters here
    // is that the shell is a CONSUMER of it and not a second author.
    expect(script).not.toContain("Liaison_$")
  })
})
