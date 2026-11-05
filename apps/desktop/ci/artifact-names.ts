#!/usr/bin/env bun

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One name shape for every desktop artifact, and one place that knows it.
//
// The bundler names its outputs its own way, differently per target
// (`liaison-desktop_0.1.0_amd64.deb` on Linux, `Liaison_0.1.0_x64-setup.exe` on
// Windows, and whatever the next version of it decides). Every consumer
// downstream then grows a glob of its own: the upload step, the checksum file,
// the updater manifest, the download page. A glob that stops matching is not
// an error anywhere, so the first sign is a release that is missing a platform.
//
// So: the bundler's output is RENAMED to the name derived here, immediately
// after it is produced, and everything downstream matches on
// `Liaison_<version>_<arch>.<extension>`. The updater's detached signature is
// the artifact name plus `.sig`, derived rather than spelled a second time.
//
// Usage:
//   bun apps/desktop/ci/artifact-names.ts name <platform> <kind> [version] [arch]
//   bun apps/desktop/ci/artifact-names.ts glob <kind>
//   bun apps/desktop/ci/artifact-names.ts main-binary
//   bun apps/desktop/ci/artifact-names.ts rename <platform> <kind> <file> [arch]
//   bun apps/desktop/ci/artifact-names.ts list [version]

import { existsSync, readFileSync, renameSync } from "node:fs"
import path from "node:path"
import { channelBuild } from "./channel"

export const PLATFORMS = ["macos", "windows", "linux"] as const
export type Platform = (typeof PLATFORMS)[number]

export const ARCHES = ["aarch64", "x86_64", "universal"] as const
export type Arch = (typeof ARCHES)[number]

/** The architectures each platform ships. macOS ships ONE universal build
 *  (arm64 and x86_64 slices in the same binaries), so a Mac of either kind
 *  downloads the same disk image and installs the same updater archive. */
export const PLATFORM_ARCHES = {
  macos: ["aarch64", "x86_64", "universal"],
  windows: ["aarch64", "x86_64"],
  linux: ["aarch64", "x86_64"],
} as const satisfies Record<Platform, readonly Arch[]>

/** The arch a name defaults to when none is given: macOS is always built
 *  universal, the other platforms for the machine building them. */
export function defaultArch(platform: Platform, arch = process.arch): Arch {
  return platform === "macos" ? "universal" : hostArch(arch)
}

/** The artifact kinds each platform produces, which is also the extension.
 *  `msi` is absent on purpose: apps/desktop/ci/windows-installer.md records
 *  the decision, and a name for it here is how it comes back. */
export const KINDS = {
  macos: ["dmg"],
  windows: ["exe"],
  linux: ["AppImage", "deb"],
} as const satisfies Record<Platform, readonly string[]>

export type Kind = (typeof KINDS)[Platform][number]

const VERSION = /^\d+\.\d+\.\d+([.-][0-9A-Za-z.]+)?$/

export const PRODUCT = "Liaison"

export interface ArtifactRequest {
  platform: Platform
  kind: Kind
  version: string
  arch: Arch
}

/** `Liaison_1.2.3_universal.dmg`. Throws on anything it does not recognise: a
 *  name built from a typo is a file nothing downstream will ever match. */
export function artifactName({ platform, kind, version, arch }: ArtifactRequest): string {
  const kinds: readonly string[] = KINDS[platform]
  if (!kinds.includes(kind)) {
    throw new Error(
      `${platform} does not produce a ${kind} artifact (it produces ${kinds.join(", ")})`,
    )
  }
  if (!VERSION.test(version)) {
    throw new Error(`not a version: ${version} (expected 1.2.3, with no leading v)`)
  }
  if (!ARCHES.includes(arch)) {
    throw new Error(`unknown arch: ${arch} (expected ${ARCHES.join(" or ")})`)
  }
  const arches: readonly Arch[] = PLATFORM_ARCHES[platform]
  if (!arches.includes(arch)) {
    throw new Error(`${platform} does not ship a ${arch} build (it ships ${arches.join(", ")})`)
  }
  return `${PRODUCT}_${version}_${arch}.${kind}`
}

/** The glob a consumer matches on. Deliberately narrow: it matches the names
 *  this module derives and NOT the bundler's own, so an artifact that was
 *  never renamed fails to upload instead of shipping under two conventions. */
export function artifactGlob(kind: Kind): string {
  return `${PRODUCT}_*_*.${kind}`
}

/** The updater's detached signature, from the artifact name. */
export function signatureName(artifact: string): string {
  if (artifact.endsWith(".sig")) {
    throw new Error(`${artifact} is already a signature name`)
  }
  return `${artifact}.sig`
}

/** The version tauri itself names its bundles with. One source, read rather
 *  than passed around, so a release cannot ship two versions under one tag. */
export function configuredVersion(
  root = path.resolve(import.meta.dir, ".."),
  env: Record<string, string | undefined> = process.env,
): string {
  // A test channel build (channel.ts) is stamped with its own version through
  // a config merge at build time, so the file on disk is not what the bundler
  // used: every consumer reads the test version from the same place.
  const build = channelBuild(env)
  if (build.channel === "test") return build.version
  const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")) as {
    version: string
  }
  return config.version
}

/**
 * The name of the executable the bundler actually produces and installs, with
 * no extension: `liaison-desktop`, NOT `Liaison`.
 *
 * This is the one name in the pipeline that reads like it should be the
 * product name and is not. Tauri's `main_binary_name` is the cargo binary's
 * name unless `mainBinaryName` overrides it, and nothing here overrides it, so
 * the compiled file is `liaison-desktop.exe`, the macOS bundle holds
 * `Liaison.app/Contents/MacOS/liaison-desktop`, and the NSIS template installs
 * `$INSTDIR\${MAINBINARYNAME}.exe` from that same name. `Liaison.exe` is
 * produced by nothing, anywhere.
 *
 * It was guessed in four places instead of derived, and dry run 34777230634
 * died on the first of them: "BAD: matched no file:
 * apps/desktop/src-tauri/target/release/Liaison.exe". So it is derived here,
 * once, from the two files that decide it.
 */
export function mainBinaryName(root = path.resolve(import.meta.dir, "..")): string {
  const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")) as {
    mainBinaryName?: string
  }
  if (config.mainBinaryName) return config.mainBinaryName
  const manifest = readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8")
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(manifest.slice(manifest.indexOf("[package]")))?.[1]
  if (!name) {
    throw new Error(
      "src-tauri/Cargo.toml declares no package name, so the name of the binary the bundler installs cannot be derived",
    )
  }
  return name
}

/** The build machine's own architecture, in the spelling used above. */
export function hostArch(arch = process.arch): Arch {
  if (arch === "arm64") return "aarch64"
  if (arch === "x64") return "x86_64"
  throw new Error(`no artifact name for this architecture: ${arch}`)
}

/** Renames a bundler output to its derived name, in place. Returns the new
 *  path. Renaming a file that already carries the derived name is a no-op, so
 *  a re-run of the step is not a failure. */
export function renameToDerived(
  file: string,
  request: Omit<ArtifactRequest, "version"> & { version?: string },
): string {
  if (!existsSync(file)) throw new Error(`no such artifact to rename: ${file}`)
  const name = artifactName({
    platform: request.platform,
    kind: request.kind,
    arch: request.arch,
    version: request.version ?? configuredVersion(),
  })
  const target = path.join(path.dirname(file), name)
  if (path.resolve(file) !== path.resolve(target)) renameSync(file, target)
  return target
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  artifact-names.ts name <platform> <kind> [version] [arch]",
      "  artifact-names.ts glob <kind>",
      "  artifact-names.ts main-binary",
      "  artifact-names.ts rename <platform> <kind> <file> [arch]",
      "  artifact-names.ts list [version]",
    ].join("\n"),
  )
  process.exit(2)
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2)
  try {
    if (command === "name") {
      const [platform, kind, version, arch] = rest
      if (!platform || !kind) usage()
      console.log(
        artifactName({
          platform: platform as Platform,
          kind: kind as Kind,
          version: version || configuredVersion(),
          arch: (arch as Arch) || defaultArch(platform as Platform),
        }),
      )
    } else if (command === "glob") {
      const [kind] = rest
      if (!kind) usage()
      console.log(artifactGlob(kind as Kind))
    } else if (command === "rename") {
      const [platform, kind, file, arch] = rest
      if (!platform || !kind || !file) usage()
      console.log(
        renameToDerived(file, {
          platform: platform as Platform,
          kind: kind as Kind,
          arch: (arch as Arch) || defaultArch(platform as Platform),
        }),
      )
    } else if (command === "main-binary") {
      console.log(mainBinaryName())
    } else if (command === "list") {
      const [version] = rest
      for (const platform of PLATFORMS) {
        for (const arch of PLATFORM_ARCHES[platform]) {
          for (const kind of KINDS[platform]) {
            console.log(
              artifactName({
                platform,
                kind,
                arch,
                version: version || configuredVersion(),
              }),
            )
          }
        }
      }
    } else {
      usage()
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
