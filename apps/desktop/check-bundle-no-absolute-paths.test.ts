// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sidecar's own check (6a) scans one compiled binary. This one scans the
// whole shipped bundle: the shell, the sidecar, the overlay compiled into the
// shell, and anything else the bundler put in Contents. The failure it guards
// is a path from the machine that BUILT the artifact surviving into the
// artifact, which works on that machine and resolves to nothing anywhere else.
//
// The distinction the check has to get right is between a path that identifies
// THIS build (the checkout, the home directory, the runner workspace) and an
// absolute path baked into a third party binary the build only vendors. The
// first is a defect this pipeline can fix; the second cannot be fixed here and
// must still be visible rather than silently swallowed.
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { remapFlags } from "./ci/tauri-build"
import { loadDesktopReleaseWorkflow, REPO_ROOT, step, stepIndex } from "./ci/workflow"
import { hostTarget } from "./sidecar/build"

const SCRIPT = path.join(import.meta.dir, "ci", "check-bundle-no-absolute-paths.ts")

function fixtureBundle(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "liaison-bundle-"))
  const app = path.join(root, "Liaison.app")
  mkdirSync(app, { recursive: true })
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(app, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
  return app
}

async function run(bundle: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", SCRIPT, bundle], {
    env: { ...process.env, BUILD_ROOT_PREFIX: "/Volumes/ci-build", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code: await child.exited, stdout, stderr }
}

/** A bun install cache holding one fake runtime for the host triple, which is
 *  the payload `bunRuntimeFor` finds for the sidecar under test. A real
 *  runtime is 90 MB of somebody else's build; three planted strings prove the
 *  same arithmetic in a file the test can reason about. */
function vendorCache(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "liaison-bun-cache-"))
  writeFileSync(path.join(dir, `${hostTarget()}-v${Bun.version}`), contents)
  return dir
}

const CLEAN = {
  "Contents/Info.plist": "<plist><string>Liaison</string></plist>",
  "Contents/MacOS/liaison-desktop": "relative/assets/overlay.js and ./Contents/Resources",
  "Contents/MacOS/liaison-sidecar": "no host path here",
}

describe("the bundle absolute path check", () => {
  it("fails when the build root is baked into a bundled binary", async () => {
    const bundle = fixtureBundle({
      ...CLEAN,
      "Contents/MacOS/liaison-desktop": "loaded from /Volumes/ci-build/liaison/apps/web/dist",
    })
    const { code, stdout } = await run(bundle)
    expect(code).toBe(1)
    expect(stdout).toContain("liaison-desktop")
    expect(stdout).toContain("/Volumes/ci-build")
  })

  it("fails when the build machine's home directory is baked in", async () => {
    const bundle = fixtureBundle({
      ...CLEAN,
      "Contents/MacOS/liaison-sidecar": "panic at /Users/builder/.cargo/registry/src/x.rs",
    })
    const { code, stdout } = await run(bundle, { HOME: "/Users/builder" })
    expect(code).toBe(1)
    expect(stdout).toContain("liaison-sidecar")
  })

  it("fails when the CI workspace is baked into the overlay", async () => {
    const bundle = fixtureBundle({
      ...CLEAN,
      "Contents/Resources/overlay.js": 'import("/home/runner/work/liaison/liaison/x.js")',
    })
    const { code, stdout } = await run(bundle, { GITHUB_WORKSPACE: "/home/runner/work/liaison" })
    expect(code).toBe(1)
    expect(stdout).toContain("overlay.js")
  })

  it("passes a clean bundle and says how much it inspected", async () => {
    const { code, stdout } = await run(fixtureBundle(CLEAN))
    expect(code).toBe(0)
    // A gate that reports success having read nothing is the failure 6a's
    // no-Node guard already shipped once.
    expect(stdout).toMatch(/inspected 3 files/)
  })

  it("reports a vendored third party path without failing the build", async () => {
    const bundle = fixtureBundle({
      ...CLEAN,
      "Contents/MacOS/liaison-sidecar": "built at /Users/runner/work/apps/apps/packages/cli.ts",
    })
    const { code, stdout } = await run(bundle)
    expect(code).toBe(0)
    expect(stdout).toContain("/Users/runner/")
    expect(stdout).toContain("not this build")
  })

  it("treats a Windows runner workspace as a build path", async () => {
    // windows-latest checks out into D:\\a\\<repo>\\<repo>. A check that only
    // accepts a prefix starting with "/" drops every prefix the Windows job
    // has, and then passes every Windows bundle it is ever pointed at.
    const bundle = fixtureBundle({
      ...CLEAN,
      "Contents/MacOS/liaison-desktop":
        "loaded from D:\\a\\liaison\\liaison\\apps\\web\\dist\\index.html",
    })
    const { code, stdout } = await run(bundle, {
      BUILD_ROOT_PREFIX: "",
      GITHUB_WORKSPACE: "D:\\a\\liaison\\liaison",
    })
    expect(code).toBe(1)
    expect(stdout).toContain("liaison-desktop")
  })

  it("matches a Windows prefix whatever the slash kind and the case", async () => {
    // rustc writes the same directory with forward slashes, and Windows
    // itself is case insensitive: three spellings of one path, one defect.
    const bundle = fixtureBundle({
      ...CLEAN,
      "Contents/MacOS/liaison-desktop": "panic at d:/A/Liaison/liaison/src/main.rs",
    })
    const { code } = await run(bundle, {
      BUILD_ROOT_PREFIX: "",
      GITHUB_WORKSPACE: "D:\\a\\liaison\\liaison",
    })
    expect(code).toBe(1)
  })

  it("takes the Windows profile directory from USERPROFILE", async () => {
    // HOME is not set on a Windows runner, so a check that only reads HOME
    // never refuses the runner account's own directory.
    const bundle = fixtureBundle({
      ...CLEAN,
      "Contents/MacOS/liaison-sidecar": "C:\\Users\\runneradmin\\.cargo\\registry\\src\\x.rs",
    })
    const { code } = await run(bundle, {
      BUILD_ROOT_PREFIX: "",
      USERPROFILE: "C:\\Users\\runneradmin",
    })
    expect(code).toBe(1)
  })

  it("refuses the repository checkout it is running from, with no prefix configured", async () => {
    // The default is DERIVED: the repo root this script resolves at runtime.
    // The alternative, a volume name committed in the source, is a default
    // that is correct on exactly one machine.
    const bundle = fixtureBundle({
      ...CLEAN,
      "Contents/Resources/overlay.js": `import("${REPO_ROOT}/apps/desktop/x.js")`,
    })
    const { code, stdout } = await run(bundle, { BUILD_ROOT_PREFIX: "" })
    expect(code).toBe(1)
    expect(stdout).toContain("overlay.js")
  })

  it("finds a path written as UTF-16, which is how a Windows toolchain writes one", async () => {
    // A PE image keeps its strings as UTF-16: the panic paths, the resource
    // table, the NSIS strings. A latin1 only scan reads those as a path with a
    // NUL between every character and matches nothing, so the Windows job's
    // check is clean on a binary that carries the runner's checkout in full.
    const root = mkdtempSync(path.join(tmpdir(), "liaison-bundle-"))
    const app = path.join(root, "Liaison.app")
    mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true })
    writeFileSync(path.join(app, "Contents", "Info.plist"), CLEAN["Contents/Info.plist"])
    writeFileSync(
      path.join(app, "Contents", "MacOS", "liaison-desktop"),
      Buffer.from("panic at D:\\a\\liaison\\liaison\\src-tauri\\src\\main.rs", "utf16le"),
    )
    const { code, stdout } = await run(app, {
      BUILD_ROOT_PREFIX: "",
      GITHUB_WORKSPACE: "D:\\a\\liaison\\liaison",
    })
    expect(code).toBe(1)
    expect(stdout).toContain("utf16le")
  })

  it("does not blame the embedded sidecar for what its vendored payloads carry", async () => {
    // The compiled sidecar is a Bun runtime with the Claude Code CLI appended
    // to it, and both of those were compiled by somebody else on a CI runner,
    // so both carry that runner's home directory. On a GitHub runner that is
    // the same directory this check refuses, and counting the vendored
    // references as this build's fails every runner job while catching
    // nothing. Only the excess over what the payloads brought is ours.
    const planted = "/Volumes/ci-build/vendor/runtime.ts"
    const cache = vendorCache(`a ${planted} b ${planted} c ${planted}`)
    const bundle = fixtureBundle({
      ...CLEAN,
      "Contents/MacOS/liaison-sidecar": `x ${planted} y ${planted} z ${planted}`,
    })
    const { code, stdout } = await run(bundle, { BUN_INSTALL_CACHE_DIR: cache })
    expect(stdout).toContain("raw 3, vendored 3, excess 0")
    expect(code).toBe(0)
  })

  it("still refuses the one reference the sidecar carries beyond its payloads", async () => {
    // The subtraction must not become a blanket exemption: a path this build
    // bakes in itself is still there when the vendored ones are accounted for.
    const planted = "/Volumes/ci-build/vendor/runtime.ts"
    const cache = vendorCache(`a ${planted} b ${planted} c ${planted}`)
    const bundle = fixtureBundle({
      ...CLEAN,
      "Contents/MacOS/liaison-sidecar": `OURS ${planted} x ${planted} y ${planted} z ${planted}`,
    })
    const { code, stdout } = await run(bundle, { BUN_INSTALL_CACHE_DIR: cache })
    expect(code).toBe(1)
    expect(stdout).toContain("raw 4, vendored 3, excess 1")
    expect(stdout).toContain("first occurrence")
    expect(stdout).toContain("OURS")
  })

  it("subtracts both slices' payloads from a universal sidecar, and nothing more", async () => {
    // A universal macOS sidecar is the arm64 and the x86_64 sidecars in one
    // file, so it carries BOTH runtimes' vendored references. Measuring only
    // the host's runtime fails every universal release; measuring both must
    // still refuse the one reference that is this build's.
    const planted = "/Volumes/ci-build/vendor/runtime.ts"
    const cache = mkdtempSync(path.join(tmpdir(), "liaison-bun-cache-"))
    for (const target of ["bun-darwin-arm64", "bun-darwin-x64"]) {
      writeFileSync(
        path.join(cache, `${target}-v${Bun.version}`),
        `a ${planted} b ${planted} c ${planted}`,
      )
    }
    const header = Buffer.alloc(8 + 20 * 2)
    header.writeUInt32BE(0xcafebabe, 0)
    header.writeUInt32BE(2, 4)
    header.writeUInt32BE(0x01000007, 8)
    header.writeUInt32BE(0x0100000c, 28)
    const slices = `${planted} ${planted} ${planted} | ${planted} ${planted} ${planted}`
    const fat = (body: string) => Buffer.concat([header, Buffer.from(body)]).toString("latin1")

    const clean = fixtureBundle({ ...CLEAN, "Contents/MacOS/liaison-sidecar": "" })
    writeFileSync(
      path.join(clean, "Contents/MacOS/liaison-sidecar"),
      Buffer.from(fat(slices), "latin1"),
    )
    const passed = await run(clean, { BUN_INSTALL_CACHE_DIR: cache })
    expect(passed.stdout).toContain("raw 6, vendored 6, excess 0")
    expect(passed.code).toBe(0)

    const dirty = fixtureBundle({ ...CLEAN, "Contents/MacOS/liaison-sidecar": "" })
    writeFileSync(
      path.join(dirty, "Contents/MacOS/liaison-sidecar"),
      Buffer.from(fat(`OURS ${planted} ${slices}`), "latin1"),
    )
    const refused = await run(dirty, { BUN_INSTALL_CACHE_DIR: cache })
    expect(refused.stdout).toContain("raw 7, vendored 6, excess 1")
    expect(refused.code).toBe(1)
  })

  it("subtracts nothing from the shell binary, which this build compiles", async () => {
    // cargo builds the shell with --remap-path-prefix, so a runner path in it
    // is ours by construction. Nothing about the sidecar's payloads excuses
    // one, even when the same string is in the vendored runtime.
    const planted = "/Volumes/ci-build/vendor/runtime.ts"
    const cache = vendorCache(`a ${planted} b ${planted} c ${planted}`)
    const bundle = fixtureBundle({
      ...CLEAN,
      "Contents/MacOS/liaison-desktop": `panic at ${planted}`,
    })
    const { code, stdout } = await run(bundle, { BUN_INSTALL_CACHE_DIR: cache })
    expect(code).toBe(1)
    expect(stdout).toContain("liaison-desktop")
  })

  it("names the payloads it measured, so an unmeasured one is visible", async () => {
    const planted = "/Volumes/ci-build/vendor/runtime.ts"
    const cache = vendorCache(`only ${planted}`)
    const bundle = fixtureBundle({
      ...CLEAN,
      "Contents/MacOS/liaison-sidecar": `x ${planted}`,
    })
    const { stdout } = await run(bundle, { BUN_INSTALL_CACHE_DIR: cache })
    expect(stdout).toContain("vendored payloads measured:")
    expect(stdout).toContain(`${hostTarget()}-v`)
  })

  it("refuses to pass on a bundle that is not there", async () => {
    const { code, stderr } = await run(path.join(tmpdir(), "liaison-absent.app"))
    expect(code).toBe(2)
    expect(stderr).toContain("not found")
  })

  it("refuses to pass on an empty bundle", async () => {
    const { code, stderr } = await run(fixtureBundle({}))
    expect(code).toBe(2)
    expect(stderr).toContain("no files")
  })
})

describe("the workflow's path check step", () => {
  const workflow = loadDesktopReleaseWorkflow()

  it("runs in every platform job", () => {
    for (const name of ["build-macos", "build-windows", "build-linux"]) {
      const entry = step(workflow.jobs[name].steps, "Verify no absolute paths in the bundle")
      expect(entry.run).toContain("apps/desktop/ci/check-bundle-no-absolute-paths.ts")
    }
  })

  it("runs after the bundle is built, in every job that signs one", () => {
    for (const job of ["build-macos", "build-windows"]) {
      const steps = workflow.jobs[job].steps
      expect(stepIndex(steps, "Verify no absolute paths in the bundle")).toBeGreaterThan(
        stepIndex(steps, "Build the app bundle"),
      )
    }
  })

  it("is the step immediately before EVERY step that seals an artifact", () => {
    // The rule is not "somewhere before the signature", it is immediately
    // before it: a step inserted between the check and the signature is a step
    // that can change what gets signed.
    //
    // "Sealing" is wider than "signing", and the earlier version of this test
    // matched a "Sign " prefix, which quietly exempted Package DMG (it
    // notarizes and staples the image). So a step seals when its NAME carries
    // one of the verbs below, or when its run calls one of the scripts that
    // seal. A step whose name starts with Verify only reads a signature.
    const VERBS = /\b(sign|signs|signed|signing|notariz\w*|stapl\w*)\b/i
    // A step that makes or checks a key is not a step that applies one. These
    // two generate the build's throwaway updater key and check the release
    // secrets are present; they touch no artifact at all, so a path check in
    // front of them would check a bundle that does not exist yet, while the
    // signature is covered where it happens ("Sign the updater archive").
    // They are named in full rather than matched by a pattern: an exemption
    // wide enough to read "key" would exempt a real signing step that happened
    // to mention one.
    const KEY_PLUMBING = [
      "Generate a throwaway updater key for the build",
      "Check the updater signing secrets are set",
    ]
    const SEALING_SCRIPTS = [
      "sign-sidecar-macos.sh",
      "sign-app-macos.sh",
      "make-dmg.sh",
      "sign-windows.ps1",
      "sign-updater-artifact.ts",
    ]
    let checked = 0
    for (const [name, job] of Object.entries(workflow.jobs)) {
      const sealing = job.steps
        .map((entry, index) => ({ name: entry.name ?? "", run: entry.run ?? "", index }))
        .filter((entry) => !entry.name.startsWith("Verify"))
        .filter((entry) => !KEY_PLUMBING.includes(entry.name))
        .filter(
          (entry) =>
            VERBS.test(entry.name) || SEALING_SCRIPTS.some((script) => entry.run.includes(script)),
        )
      if (name === "build-linux") {
        // Nothing signs a Linux build for the operating system: no Linux
        // signing credential exists in this epic. The one signature it does
        // carry is the updater's, and it is the ONLY integrity an installed
        // copy can check before replacing itself, so it follows the same rule
        // as every other signature here rather than being exempt from it.
        expect(sealing.map((entry) => entry.name)).toEqual(["Sign the updater archive"])
      }
      if (name === "build-macos") {
        // Named in full, so a sealing step added here has to be added to this
        // list as well rather than slipping past a pattern.
        expect(sealing.map((entry) => entry.name)).toEqual([
          "Sign sidecar binaries",
          "Sign and notarize the app",
          "Package DMG",
          "Sign the updater archive",
        ])
      }
      for (const entry of sealing) {
        checked++
        const previous = job.steps[entry.index - 1]?.name ?? ""
        expect(previous, `${entry.name} is not preceded by a path check`).toContain(
          "Verify no absolute paths",
        )
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8)
  })
})

describe("the build wrapper that keeps those paths out", () => {
  it("remaps the cargo home, the workspace and the home directory", () => {
    expect(
      remapFlags({ HOME: "/Users/builder", GITHUB_WORKSPACE: "/home/runner/work/liaison" }),
    ).toEqual([
      "--remap-path-prefix=/Users/builder/.cargo=/cargo",
      "--remap-path-prefix=/home/runner/work/liaison=/liaison",
      "--remap-path-prefix=/Users/builder=/rust",
    ])
  })

  it("remaps an explicit cargo home rather than guessing one", () => {
    expect(remapFlags({ CARGO_HOME: "/opt/cargo", HOME: "/root" })).toContain(
      "--remap-path-prefix=/opt/cargo=/cargo",
    )
  })

  it("asks for nothing when the environment names nothing", () => {
    expect(remapFlags({})).toEqual([])
  })

  it("is what every platform job builds with", () => {
    const workflow = loadDesktopReleaseWorkflow()
    for (const name of ["build-macos", "build-windows", "build-linux"]) {
      expect(step(workflow.jobs[name].steps, "Build the app bundle").run).toContain(
        "apps/desktop/ci/tauri-build.ts",
      )
    }
  })
})

describe("the build path defaults", () => {
  // A default prefix written into the source is a default that is right on one
  // machine and silently wrong on every other one, CI runners included.
  const QUOTED = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g

  function literals(file: string): string[] {
    return [...readFileSync(file, "utf8").matchAll(QUOTED)].map((match) => match[2])
  }

  for (const file of [
    path.join(import.meta.dir, "ci", "check-bundle-no-absolute-paths.ts"),
    path.join(import.meta.dir, "sidecar", "check-no-absolute-paths.ts"),
  ]) {
    it(`names no machine of its own: ${path.basename(file)}`, () => {
      const machine = literals(file).filter((value) => /^\/(Volumes|Users|home)\/[^/]+/.test(value))
      expect(machine).toEqual([])
    })
  }
})
