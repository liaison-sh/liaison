// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The release workflow is the only place where the signing order exists. Get
// the order wrong and nothing fails loudly: the app bundle is signed, then the
// sidecar inside it is re-signed underneath the outer signature, and the first
// customer to launch it gets a Gatekeeper refusal that no CI run reproduced.
// So the order is pinned here, as YAML step indices, rather than trusted to
// whoever edits the file next.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { JOB_PLATFORMS } from "./ci/build-publish-request"
import { ACCESS_KEY_ID_ENV, ACCOUNT_ENV, SECRET_ACCESS_KEY_ENV } from "./ci/downloads"
import {
  type Job,
  loadDesktopReleaseWorkflow,
  secretRef,
  step,
  stepIndex,
  WORKFLOW_PATH,
} from "./ci/workflow"

const workflow = loadDesktopReleaseWorkflow()
const source = readFileSync(WORKFLOW_PATH, "utf8")

/** An env key whose value would be a credential if it were spelled out. */
const CREDENTIAL_KEY =
  /^\s+[A-Z0-9_]*(PASSWORD|PWD|SECRET|P12|TOKEN|APPLE_ID|CERTIFICATE)[A-Z0-9_]*:/

/** The shell test for an unset or empty variable, built rather than written
 *  out: a literal would carry a dollar brace pair the linter reads as a
 *  template placeholder somebody forgot to interpolate. */
const emptyGuard = (variable: string) => `[ -z "\${${variable}:-}" ]`

const BUILD_JOBS = ["build-macos", "build-windows", "build-linux"] as const
const BUILD_KEY_STEP = "Generate a throwaway updater key for the build"
const RELEASE_KEY_CHECK_STEP = "Check the updater signing secrets are set"
const SIGN_UPDATER_STEP = "Sign the updater archive"
const LINUX_PREREQUISITE_STEP = "Install the Linux build prerequisites"

/** Tauri's own Ubuntu list, plus the three this build found missing on top of
 *  it: pkg-config and libglib2.0-dev, which are what `glib-sys` looks for, and
 *  patchelf, which the AppImage bundler shells out to. Written here so a
 *  package dropped from the workflow fails this, not a runner twenty minutes
 *  into a release. */
const LINUX_BUILD_PACKAGES = [
  "libwebkit2gtk-4.1-dev",
  "build-essential",
  "curl",
  "wget",
  "file",
  "libxdo-dev",
  "libssl-dev",
  "libayatana-appindicator3-dev",
  "librsvg2-dev",
  "libglib2.0-dev",
  "pkg-config",
  "patchelf",
  // linuxdeploy and its appimage plugin are AppImages themselves, and an
  // AppImage mounts itself with FUSE 2 before it runs anything. Ubuntu 24.04
  // ships FUSE 3 only, and the package that brings the old one back is named
  // libfuse2t64 there. The bundler asks for extraction instead of mounting, so
  // this is the belt to that brace: without it the only thing the log says is
  // "failed to run linuxdeploy", because tauri swallows linuxdeploy's stderr.
  "libfuse2t64",
]

const LINUX_BUILD_STEP = "Build the app bundle"
const PUBLISH_STEP = "Verify both signatures and publish the manifest"
const MIRROR_STEP = "Mirror the release to the public downloads host"

function job(name: string): Job {
  const found = workflow.jobs[name]
  if (!found) throw new Error(`no job named ${name} in ${path.basename(WORKFLOW_PATH)}`)
  return found
}

describe("the desktop release workflow", () => {
  it("fires on a desktop version tag and on a manual dry run, and on nothing else", () => {
    // The trigger set is asserted WHOLE. A test that only reads the tag filter
    // is silent about a `pull_request` or a `schedule` added next to it, and
    // either of those runs this file, with these secrets, on somebody else's
    // commit.
    const triggers = workflow.on as unknown as Record<string, unknown>
    expect(Object.keys(triggers).sort()).toEqual(["push", "workflow_dispatch"])
    expect(workflow.on.push).toEqual({ tags: ["desktop-v[0-9]+.[0-9]+.[0-9]+"] })
    const dispatch = triggers.workflow_dispatch as {
      inputs: Record<string, { type: string; default: unknown }>
    }
    expect(Object.keys(dispatch.inputs).sort()).toEqual([
      "channel",
      "dry_run",
      "platforms",
      "version",
    ])
    // The test channel is opt in: empty is production, which a dispatch
    // never publishes.
    expect(dispatch.inputs.channel.default).toBe("")
    expect(dispatch.inputs.version.default).toBe("")
    expect(dispatch.inputs.dry_run.type).toBe("boolean")
    // A comma list is not a choice, so this one is a string, and its default
    // is the whole set.
    expect(dispatch.inputs.platforms.type).toBe("string")
    expect(dispatch.inputs.platforms.default).toBe("all")
    // Defaulting to true: the expensive, credential touching path is the one
    // somebody has to ask for.
    expect(dispatch.inputs.dry_run.default).toBe(true)
  })

  it("lets a dry run pick its runners, and never lets a release pick", () => {
    // Debugging this pipeline means dry runs, and a fix to one runner costs
    // three runners on a free plan, one of them billed at ten times the
    // others. So a dry run may be narrowed to the runner in question.
    //
    // A RELEASE may not. Every build job's condition starts with "not a dry
    // run", so a tag push and a dry_run=false dispatch build all three
    // whatever the input says: the publish job needs all three, and a
    // half-built release would otherwise silently skip the publish instead of
    // failing.
    const jobs = workflow.jobs as unknown as Record<string, { if?: string }>
    for (const [name, platform] of [
      ["build-macos", "macos"],
      ["build-windows", "windows"],
      ["build-linux", "linux"],
    ] as const) {
      const condition = jobs[name].if ?? ""
      const clauses = condition
        .replace(/^\$\{\{\s*/, "")
        .replace(/\s*\}\}$/, "")
        .split("||")
        .map((clause) => clause.trim())
      // The release escape is FIRST: an expression is read left to right by a
      // human, and this is the clause that makes a release unconditional.
      // A test channel build is not a release: it may be narrowed like a dry
      // run, and only a tag push (channel empty) or a production dispatch is
      // exempt.
      expect(clauses[0], `${name} does not exempt a release`).toBe(
        "(!inputs.dry_run && inputs.channel == '')",
      )
      // An unset input (a tag push) and the default both mean everything.
      expect(clauses, `${name} refuses an unset input`).toContain("inputs.platforms == ''")
      expect(clauses, `${name} refuses the default`).toContain("inputs.platforms == 'all'")
      // Matched as a whole comma delimited word, so "windows" never selects a
      // job because some other name contains it.
      expect(condition, `${name} does not select itself`).toContain(
        `contains(format(',{0},', inputs.platforms), ',${platform},')`,
      )
      for (const other of ["macos", "windows", "linux"].filter((entry) => entry !== platform)) {
        expect(condition, `${name} also selects on ${other}`).not.toContain(`,${other},`)
      }
    }
  })

  it("keeps the publish waiting on all three jobs whatever was selected", () => {
    // A skipped dependency skips its dependent, so a narrowed dry run cannot
    // reach the publish even if its own condition were ever relaxed.
    const publish = workflow.jobs["publish-manifest"] as unknown as { if?: string }
    // Built rather than written out: a literal expression here is a template
    // placeholder the linter reads as one somebody forgot to interpolate.
    expect(publish.if?.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "")).toBe(
      "!inputs.dry_run && inputs.channel == ''",
    )
    expect(publish.if, "the publish reads the platform input").not.toContain("platforms")
    expect(job("publish-manifest").needs?.slice().sort()).toEqual([
      "build-linux",
      "build-macos",
      "build-windows",
    ])
  })

  it("publishes nothing on a dry run", () => {
    // A dry run signs nothing, so a manifest published from one would point at
    // unsigned artifacts, and every installed copy acts on a manifest
    // unattended.
    const publish = workflow.jobs["publish-manifest"] as unknown as { if?: string }
    expect(publish.if).toContain("!inputs.dry_run")
  })

  it("hands a Windows dry run its unsigned installer back, as a one day artifact and nothing more", () => {
    // The Windows build is walked by a human on a real machine before it is
    // released, and a dry run is the only build that exists before a release.
    // So a dry run uploads the installer it built, as a WORKFLOW artifact
    // named for what it is, with the shortest retention GitHub allows. The
    // invariant above still holds: the release upload and the publish job
    // stay behind !inputs.dry_run, and nothing here names a secret.
    const steps = job("build-windows").steps
    const walk = step(steps, "Upload the unsigned installer for a dry run walk")
    expect(walk.if ?? "").toMatch(/^\$\{\{\s*inputs\.dry_run\s*\}\}$/)
    expect(walk.uses ?? "").toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/)
    const withs = (walk as unknown as { with?: Record<string, unknown> }).with ?? {}
    expect(withs.name).toBe("windows-dry-run-installer-UNSIGNED")
    expect(withs["retention-days"]).toBe(1)
    // The rename step above has already given the installer its derived name
    // (ci/artifact-names.ts: Liaison_<version>_x86_64.exe), so this is the
    // same glob the release upload matches, and the .sig it would also
    // match does not exist on a dry run.
    expect(String(withs.path)).toMatch(/Liaison_\*_\*\.exe$/)
    const release = step(steps, "Upload the Windows artifact")
    const releasePaths = String(
      (release as unknown as { with?: { path?: string } }).with?.path ?? "",
    )
      .split("\n")
      .map((line) => line.trim())
    expect(releasePaths).toContain(String(withs.path))
    expect(String(withs.path)).not.toContain(".sig")
    expect(withs["if-no-files-found"]).toBe("error")
    expect(walk.env ?? {}).toEqual({})
    // It comes after the install and launch checks, so a build those refused
    // is never handed to a human.
    expect(stepIndex(steps, "Upload the unsigned installer for a dry run walk")).toBeGreaterThan(
      stepIndex(steps, "Scripted install and launch check"),
    )
    // And the release upload is untouched: still one step, still release only.
    expect(release.if ?? "").toContain("!inputs.dry_run")
  })

  it("mirrors the release to the public downloads host, after the publish and never on a dry run", () => {
    // This repository is PRIVATE. Its release assets and its
    // releases/latest/download path answer 404 to every anonymous client, so
    // the release the job above publishes reaches nobody: not an installed
    // copy asking for its next version, not a customer clicking a download
    // link. The public surface is downloads.liaison.sh, and without this step
    // a tagged release is green and invisible.
    const steps = job("publish-manifest").steps
    const mirror = step(steps, MIRROR_STEP)
    expect(stepIndex(steps, MIRROR_STEP)).toBeGreaterThan(stepIndex(steps, PUBLISH_STEP))
    // Through the script, so the ordering and the refusals are code
    // apps/desktop/downloads-mirror.test.ts drives in process.
    expect(mirror.run ?? "").toContain("apps/desktop/ci/mirror-to-downloads.ts")
    expect(mirror.run ?? "").toContain("--manifest latest.json")
    // The request the gate acted on, so the mirror can re-run that gate over
    // the same bytes rather than trusting this job's own earlier step.
    expect(mirror.run ?? "").toContain("--request publish-request.json")
    // Both credentials by NAME, never a value, and nothing interpolated into
    // the script body where it would land in the shell's command line.
    // Plus the Apple team the re-run gate checks the macOS app against.
    expect(mirror.env ?? {}).toEqual({
      APPLE_TEAM_ID: secretRef("APPLE_TEAM_ID"),
      [ACCOUNT_ENV]: secretRef(ACCOUNT_ENV),
      [ACCESS_KEY_ID_ENV]: secretRef(ACCESS_KEY_ID_ENV),
      [SECRET_ACCESS_KEY_ENV]: secretRef(SECRET_ACCESS_KEY_ENV),
    })
    expect(mirror.run ?? "").not.toMatch(/secrets\.[A-Z0-9_]+/)
    // A dry run publishes nothing and touches no secret: the job itself is
    // behind the same guard, and so is this step, so relaxing either one
    // alone cannot hand a rehearsal the downloads credentials.
    expect(mirror.if ?? "").toContain("!inputs.dry_run")
    const publishJob = workflow.jobs["publish-manifest"] as unknown as { if?: string }
    expect(publishJob.if ?? "").toContain("!inputs.dry_run")
  })

  it("gives the publish job the time a home connection needs", () => {
    // 0.1.5's publish job was cancelled at 30 minutes, on a self-hosted Mac,
    // with the GitHub release out and the downloads mirror half written.
    const publish = workflow.jobs["publish-manifest"] as unknown as { "timeout-minutes"?: number }
    expect(publish["timeout-minutes"] ?? 0).toBeGreaterThanOrEqual(90)
  })

  it("downloads the platform artifacts with a Node 24 action", () => {
    // download-artifact v4 is a Node 20 action the runner forces onto Node 24,
    // where it ended green part way through extracting: 0.1.5's publish job
    // got the Windows installer without its .sig. v7 is the first Node 24 one.
    const steps = job("publish-manifest").steps
    const download = steps[stepIndex(steps, "Download the platform artifacts")]
    const line = source.split("\n").find((l) => l.includes(`uses: ${download.uses}`)) ?? ""
    const major = Number(/# v(\d+)/.exec(line)?.[1] ?? 0)
    expect(download.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/)
    expect(major).toBeGreaterThanOrEqual(7)
  })

  it("installs every Linux package the bundler shells out to", () => {
    // GitHub's hosted Ubuntu ships some of these; a self-hosted plain Ubuntu
    // does not, so the list has to name them rather than rely on the image.
    const steps = job("build-linux").steps
    const install = steps[stepIndex(steps, "Install the Linux build prerequisites")].run ?? ""
    for (const pkg of ["patchelf", "squashfs-tools", "libfuse2t64", "xdg-utils", "file"]) {
      expect(install).toMatch(new RegExp(`\\b${pkg}\\b`))
    }
  })

  it("uninstalls the Windows test install whatever happened after it", () => {
    // A self-hosted Windows runner runs in a real user's session and outlives
    // the job: the silent install must not stay in that profile, even when a
    // check between the install and the uninstall failed.
    const steps = job("build-windows").steps
    const uninstall = stepIndex(steps, "Uninstall the app")
    expect(uninstall).toBeGreaterThan(stepIndex(steps, "Install the app silently"))
    expect(uninstall).toBeGreaterThan(stepIndex(steps, "Scripted install and launch check"))
    expect(steps[uninstall].if).toBe("always()")
    expect(steps[uninstall].run).toBe("apps/desktop/ci/uninstall-windows.ps1")
  })

  it("declares exactly the four named jobs on their own runners", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual([
      "build-linux",
      "build-macos",
      "build-windows",
      "publish-manifest",
      "publish-test-channel",
    ])
    // Hosted by default; a repository variable swaps in a self-hosted label.
    // The publish job runs the macOS toolchain (codesign, notarytool) too, so
    // it follows the macOS variable.
    const onRunner = (variable: string, hosted: string) =>
      new RegExp(`^\\$\\{\\{ vars\\.${variable} \\|\\| '${hosted}' \\}\\}$`)
    expect(job("build-macos")["runs-on"]).toMatch(onRunner("DESKTOP_RUNNER_MACOS", "macos-latest"))
    expect(job("build-windows")["runs-on"]).toMatch(
      onRunner("DESKTOP_RUNNER_WINDOWS", "windows-latest"),
    )
    expect(job("build-linux")["runs-on"]).toMatch(onRunner("DESKTOP_RUNNER_LINUX", "ubuntu-latest"))
    expect(job("publish-manifest")["runs-on"]).toMatch(
      onRunner("DESKTOP_RUNNER_MACOS", "macos-latest"),
    )
    expect(job("publish-test-channel")["runs-on"]).toMatch(
      onRunner("DESKTOP_RUNNER_MACOS", "macos-latest"),
    )
  })

  it("builds exactly the platforms the publish gate requires", () => {
    // One constant, here and in the gate. A fourth build job added with no
    // platform beside it builds an artifact the manifest never names; a
    // platform named with no job behind it makes every release refuse. Either
    // way the mistake is this assertion, not a release.
    const buildJobs = Object.keys(workflow.jobs)
      .filter((name) => !name.startsWith("publish-"))
      .sort()
    expect(buildJobs).toEqual(Object.keys(JOB_PLATFORMS).sort())
    expect(job("publish-manifest").needs?.slice().sort()).toEqual(Object.keys(JOB_PLATFORMS).sort())
  })

  it("publishes the manifest last, after every platform built", () => {
    expect(job("publish-manifest").needs?.slice().sort()).toEqual([
      "build-linux",
      "build-macos",
      "build-windows",
    ])
    // Nothing may wait on the publish: it is the end of the pipeline.
    for (const [name, entry] of Object.entries(workflow.jobs)) {
      if (name.startsWith("publish-")) continue
      expect(entry.needs ?? []).not.toContain("publish-manifest")
    }
  })

  it("every platform job builds the overlay and prepares the sidecar before it builds", () => {
    const prepare: Record<string, string> = {
      "build-macos": "Prepare the universal sidecar",
      "build-windows": "Prepare the sidecar for the host triple",
      "build-linux": "Prepare the sidecar for the host triple",
    }
    for (const [name, prepareStep] of Object.entries(prepare)) {
      const steps = job(name).steps
      const overlay = stepIndex(steps, "Build the desktop overlay")
      const sidecar = stepIndex(steps, prepareStep)
      const build = stepIndex(steps, "Build the app bundle")
      expect(overlay).toBeGreaterThanOrEqual(0)
      expect(sidecar).toBeGreaterThan(overlay)
      expect(build).toBeGreaterThan(sidecar)
    }
  })

  it("builds one universal macOS app, both slices checked before anything is signed", () => {
    // An arm64 only app installs on an Intel Mac and never starts. Every piece
    // of the universal build is pinned: the toolchain has both targets, the
    // install fetches the Intel CLI, the sidecar and the bundle ask for the
    // universal triple, and lipo checks both slices before the path check.
    const steps = job("build-macos").steps
    const toolchain = steps.find((entry) =>
      String(entry.uses ?? "").startsWith("dtolnay/rust-toolchain"),
    )
    expect(String(toolchain?.with?.targets)).toBe("aarch64-apple-darwin,x86_64-apple-darwin")
    expect(step(steps, "Install dependencies").run).toContain("bun install --cpu='*'")
    expect(step(steps, "Prepare the universal sidecar").run).toContain(
      "--target universal-apple-darwin",
    )
    expect(step(steps, "Build the app bundle").run).toContain("--target universal-apple-darwin")
    const verify = stepIndex(steps, "Verify the app is universal")
    expect(verify).toBeGreaterThan(stepIndex(steps, "Build the app bundle"))
    expect(verify).toBeLessThan(stepIndex(steps, "Sign and notarize the app"))
    expect(step(steps, "Verify the app is universal").run).toContain("lipo -archs")
    for (const entry of steps) {
      expect(String(entry.run ?? "")).not.toContain("target/release/bundle")
    }
  })

  it("signs the sidecar before the outer app is built or signed", () => {
    const steps = job("build-macos").steps
    const signSidecar = stepIndex(steps, "Sign sidecar binaries")
    expect(signSidecar).toBeGreaterThanOrEqual(0)
    expect(signSidecar).toBeLessThan(stepIndex(steps, "Build the app bundle"))
    expect(signSidecar).toBeLessThan(stepIndex(steps, "Sign and notarize the app"))
  })

  it("gives each job the least token it can do its work with", () => {
    // The default token is repository wide. A build job that can write
    // contents is a build job that could create the release itself, with the
    // two signature gate below it never running: the gate is only a gate while
    // nothing upstream of it can publish.
    const permissions = (
      workflow as unknown as {
        permissions: Record<string, string>
        jobs: Record<string, { permissions?: Record<string, string> }>
      }
    ).permissions
    expect(permissions).toEqual({})
    const jobs = workflow.jobs as unknown as Record<
      string,
      { permissions?: Record<string, string> }
    >
    for (const name of ["build-macos", "build-windows", "build-linux"]) {
      expect(jobs[name].permissions, `${name} permissions`).toEqual({ contents: "read" })
    }
    expect(jobs["publish-manifest"].permissions).toEqual({ contents: "write" })
  })

  it("pins every action to a commit, never to a tag somebody else can move", () => {
    // A tag is a pointer its owner can repoint. These jobs hold the Apple, the
    // Azure and the updater signing secrets, so an action that changes under
    // its tag is an action that reads them. The moving tag stays in a comment,
    // because a bare 40 character hash says nothing about what it is.
    const uses = [...source.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((match) => match[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const reference of uses) {
      expect(reference, `${reference} is not pinned to a commit`).toMatch(/@[0-9a-f]{40}$/)
    }
    for (const line of source.split("\n").filter((entry) => /uses:/.test(entry))) {
      expect(line, `${line.trim()} names no version`).toMatch(/#\s*\S+/)
    }
  })

  it("never spells a credential out, only names a secret", () => {
    // A value pasted here would be in git forever. Anything credential shaped
    // has to arrive as a ${{ secrets.NAME }} reference, or as the release-only
    // form that hands a dry run an empty string instead.
    expect(source).not.toContain("-----BEGIN")
    const credentialLines = source.split("\n").filter((line) => CREDENTIAL_KEY.test(line))
    expect(credentialLines.length).toBeGreaterThan(0)
    for (const line of credentialLines) {
      expect(line).toMatch(
        /\$\{\{\s*(!inputs\.dry_run && )?secrets\.[A-Z0-9_]+( \|\| '')?\s*\}\}\s*$/,
      )
    }
  })

  it("installs the Tauri Linux prerequisites before anything compiles", () => {
    // Without them the first cargo build dies inside a build script, minutes
    // in, on a library this file never mentions: "The system library glib-2.0
    // required by crate glib-sys was not found".
    const steps = job("build-linux").steps
    const install = step(steps, LINUX_PREREQUISITE_STEP)
    expect(stepIndex(steps, LINUX_PREREQUISITE_STEP)).toBeLessThan(
      stepIndex(steps, "Build the app bundle"),
    )
    const script = install.run ?? ""
    // The index has to be refreshed first: the image ships a stale one and
    // apt-get install then fails on a URL that no longer resolves.
    expect(script).toContain("apt-get update")
    const update = script.indexOf("apt-get update")
    const installs = script.indexOf("apt-get install")
    expect(installs).toBeGreaterThan(update)
    for (const packageName of LINUX_BUILD_PACKAGES) {
      expect(script, `${packageName} is not installed`).toContain(packageName)
    }
  })

  it("runs the Linux bundler with extraction, no strip and its stderr showing", () => {
    // Three things this job lost a whole runner to, all of them silent:
    //   APPIMAGE_EXTRACT_AND_RUN, so linuxdeploy and the appimage plugin
    //     unpack themselves instead of asking a 24.04 runner for FUSE 2;
    //   NO_STRIP, so linuxdeploy does not strip the binary a second time and
    //     take the symbol tauri patches the bundle type into with it;
    //   verbosity, because tauri only reports linuxdeploy's own stderr when
    //     the log level is above error. Without it the failure reads "failed
    //     to run linuxdeploy" and names nothing.
    const steps = job("build-linux").steps
    const build = step(steps, LINUX_BUILD_STEP)
    const env = build.env ?? {}
    expect(env.APPIMAGE_EXTRACT_AND_RUN).toBe("1")
    expect(env.NO_STRIP).toBe("true")
    expect(build.run ?? "").toContain("--verbose")
  })

  it("gives every build its own throwaway updater key, before it builds", () => {
    // tauri.conf.json carries createUpdaterArtifacts, so the bundler signs the
    // updater payload as part of the build and refuses to finish with "A
    // public key has been found, but no private key". Every build, a release
    // included, makes a keypair it throws away: the real key never reaches the
    // build, whose crates and scripts all read the environment file.
    for (const name of BUILD_JOBS) {
      const steps = job(name).steps
      const key = step(steps, BUILD_KEY_STEP)
      expect(key.if, `${name} key step runs on every build`).toBeUndefined()
      expect(stepIndex(steps, BUILD_KEY_STEP), `${name} key step order`).toBeLessThan(
        stepIndex(steps, "Build the app bundle"),
      )
      for (const value of Object.values(key.env ?? {})) {
        expect(value, `${name} key step holds a secret`).not.toContain("secrets.")
      }
      const script = key.run ?? ""
      expect(script).toContain("tauri signer generate")
      expect(script).toContain("TAURI_SIGNING_PRIVATE_KEY=")
      expect(script).toContain("TAURI_SIGNING_PRIVATE_KEY_PASSWORD=")
      // Not an empty password: a key this CLI generates with one cannot be
      // read back with one, so an empty password fails the build this step
      // exists to unblock.
      expect(script).not.toMatch(/--password\s+(""|'')/)
      // The key never leaves the runner's own temporary directory, which is
      // discarded with the runner. Every path it writes is under RUNNER_TEMP,
      // and the only other thing it writes to is the environment file.
      const assigned = new Map(
        [...script.matchAll(/^\s*([a-z_]+)="([^"]*)"$/gm)].map((match) => [match[1], match[2]]),
      )
      const writes = [...script.matchAll(/--write-keys\s+"([^"]+)"/g)]
        .map((match) => match[1])
        .map((target) => assigned.get(target.replace(/^\$/, "")) ?? target)
      expect(writes.length, `${name} writes no key`).toBe(1)
      for (const target of writes) {
        expect(target.startsWith("$RUNNER_TEMP/"), `${name} writes ${target}`).toBe(true)
      }
      const redirects = [...script.matchAll(/>>?\s*"?([^"\s]+)"?/g)].map((match) => match[1])
      for (const target of redirects) {
        expect(target, `${name} redirects outside the environment file`).toBe("$GITHUB_ENV")
      }
    }
  })

  it("refuses a release outright when either updater secret is missing, before it builds", () => {
    // A release that builds unsigned updater artifacts is worse than one that
    // does not build: every installed copy acts on the manifest unattended, so
    // the absent secret has to stop the run, and before every runner compiled.
    // The check only reads the two secrets: it writes nothing anywhere.
    for (const name of BUILD_JOBS) {
      const steps = job(name).steps
      const check = step(steps, RELEASE_KEY_CHECK_STEP)
      expect(check.if ?? "", `${name} check condition`).toMatch(
        /^\$\{\{\s*!inputs\.dry_run\s*\}\}$/,
      )
      expect(stepIndex(steps, RELEASE_KEY_CHECK_STEP), `${name} check order`).toBeLessThan(
        stepIndex(steps, "Build the app bundle"),
      )
      const env = check.env ?? {}
      expect(env.TAURI_SIGNING_PRIVATE_KEY).toBe(secretRef("TAURI_SIGNING_PRIVATE_KEY"))
      expect(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD).toBe(
        secretRef("TAURI_SIGNING_PRIVATE_KEY_PASSWORD"),
      )
      const script = check.run ?? ""
      expect(script, `${name} does not guard the key`).toContain(
        `if ${emptyGuard("TAURI_SIGNING_PRIVATE_KEY")}`,
      )
      expect(script, `${name} does not guard the password`).toContain(
        emptyGuard("TAURI_SIGNING_PRIVATE_KEY_PASSWORD"),
      )
      expect(script, `${name} does not refuse`).toContain("exit 1")
      expect(script.toLowerCase(), `${name} says nothing about why`).toContain("unsigned")
      const redirects = [...script.matchAll(/>>?\s*"?([^"\s]+)"?/g)]
        .map((match) => match[1])
        .filter((target) => !target.startsWith("&"))
      expect(redirects, `${name} check writes somewhere`).toEqual([])
    }
  })

  it("hands the updater private key only to the steps that check it and sign with it", () => {
    // These jobs run on self-hosted runners, and the build runs
    // hundreds of crates' build scripts and proc macros plus bun scripts. A
    // key in the environment file is in every one of them, and the updater key
    // cannot be rotated. So the secret is named only in a step's own env, only
    // on the check and the signing step, never written to a file GitHub feeds
    // to later steps, and never in a step that compiles or installs anything.
    const SECRET = /secrets\.TAURI_SIGNING_PRIVATE_KEY/
    const BUILD_TOOLS =
      /\bcargo\b|\bbun (install|i|add)\b|\bbunx\b|\bnpx?\b|tauri build|tauri-build\.ts|rustc\b/
    const runnerFiles = ["GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH", "GITHUB_STATE"]
    let named = 0
    const top = workflow as unknown as { env?: Record<string, string> }
    for (const value of Object.values(top.env ?? {})) expect(value).not.toMatch(SECRET)
    for (const [name, entry] of Object.entries(workflow.jobs)) {
      const jobEnv = (entry as unknown as { env?: Record<string, string> }).env ?? {}
      for (const value of Object.values(jobEnv)) {
        expect(value, `${name} job env`).not.toMatch(SECRET)
      }
      for (const entryStep of entry.steps) {
        const label = `${name}/${entryStep.name}`
        const run = entryStep.run ?? ""
        expect(run, `${label} interpolates the key into a script`).not.toMatch(SECRET)
        expect(
          JSON.stringify(entryStep.with ?? {}),
          `${label} hands the key to an action`,
        ).not.toMatch(SECRET)
        const carrying = Object.values(entryStep.env ?? {}).filter((value) => SECRET.test(value))
        if (carrying.length === 0) {
          // A step without the secret may still write the throwaway key into
          // the environment file, and only the step that generates it does.
          if (/TAURI_SIGNING_PRIVATE_KEY[^\n]*GITHUB_ENV/.test(run)) {
            expect(entryStep.name, label).toBe(BUILD_KEY_STEP)
            expect(run).toContain("tauri signer generate")
          }
          continue
        }
        named += carrying.length
        expect([RELEASE_KEY_CHECK_STEP, SIGN_UPDATER_STEP], label).toContain(entryStep.name ?? "")
        expect(entryStep.uses, `${label} gives the key to an action`).toBeUndefined()
        for (const file of runnerFiles) {
          expect(run, `${label} writes the key's step into ${file}`).not.toContain(file)
        }
        expect(run, `${label} builds or installs with the key in its env`).not.toMatch(BUILD_TOOLS)
      }
    }
    // Every mention of the secret in the file is one of the env entries above.
    expect(named).toBe((source.match(new RegExp(SECRET.source, "g")) ?? []).length)
    expect(named).toBeGreaterThanOrEqual(12)
  })

  it("never hands a dry run a release secret, and never signs a release with a throwaway", () => {
    // Every step that carries the updater secret is a step a dry run does not
    // run, or it hands a dry run an empty string under a name the signer does
    // not read, so the throwaway key in the environment file stays in charge.
    const guarded = (secret: string) => `\${{ !inputs.dry_run && secrets.${secret} || '' }}`
    for (const [name, entry] of Object.entries(workflow.jobs)) {
      for (const entryStep of entry.steps) {
        const env = entryStep.env ?? {}
        for (const [key, value] of Object.entries(env)) {
          if (!value.includes("secrets.TAURI_SIGNING_PRIVATE_KEY")) continue
          const label = `${name}/${entryStep.name}/${key}`
          if ((entryStep.if ?? "").includes("!inputs.dry_run")) {
            expect(value, label).toBe(secretRef(key))
          } else {
            expect(key.startsWith("TAURI_SIGNING"), `${label} could clobber the throwaway`).toBe(
              false,
            )
            expect([
              guarded("TAURI_SIGNING_PRIVATE_KEY"),
              guarded("TAURI_SIGNING_PRIVATE_KEY_PASSWORD"),
            ]).toContain(value)
          }
        }
      }
    }
    // Each build job's archive signature is made with the real key on a
    // release: macOS and Windows sign only on a release, from the secret; the
    // Linux step signs on both and refuses a release without the secret.
    for (const name of BUILD_JOBS) {
      const sign = step(job(name).steps, SIGN_UPDATER_STEP)
      expect(sign.run ?? "").toContain("sign-updater-artifact.ts")
      if (name === "build-linux") {
        const run = sign.run ?? ""
        expect(sign.env?.DRY_RUN).toBe(`\${{ inputs.dry_run }}`)
        expect(run).toContain('if [ "$DRY_RUN" != "true" ]; then')
        expect(run).toContain(emptyGuard("RELEASE_UPDATER_KEY"))
        expect(run).toContain("exit 1")
        expect(run).toContain('export TAURI_SIGNING_PRIVATE_KEY="$RELEASE_UPDATER_KEY"')
        expect(run).toContain(
          'export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$RELEASE_UPDATER_KEY_PASSWORD"',
        )
      } else {
        expect(sign.if ?? "").toMatch(/^\$\{\{\s*!inputs\.dry_run\s*\}\}$/)
        expect(sign.env?.TAURI_SIGNING_PRIVATE_KEY).toBe(secretRef("TAURI_SIGNING_PRIVATE_KEY"))
      }
    }
  })
})

// THE ACCOUNT'S ARTIFACT STORAGE FILLED UP (2026-09-28): every release kept its
// three platform artifacts for GitHub's default 90 days, about 950 MB a run,
// and the thirty-first upload was refused mid release. An artifact only has to
// live from its build job to the publish job of the same run; the published
// copies are the GitHub release and downloads.liaison.sh.
describe("the build artifacts", () => {
  it("are kept three days at most", () => {
    const workflow = loadDesktopReleaseWorkflow()
    let uploads = 0
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const s of job.steps ?? []) {
        if (!String(s.uses ?? "").startsWith("actions/upload-artifact@")) continue
        uploads++
        const days = Number((s.with as { "retention-days"?: number })?.["retention-days"])
        expect(days, `${name}: ${s.name} has no retention-days of 3 or less`).toBeLessThanOrEqual(3)
        expect(days, `${name}: ${s.name}`).toBeGreaterThanOrEqual(1)
      }
    }
    expect(uploads).toBeGreaterThanOrEqual(4)
  })
})

describe("every step that runs the two signature gate names the Apple team", () => {
  // The gate refuses a macOS app unless APPLE_TEAM_ID names the one team it
  // must be signed by. The mirror steps re-run the gate before uploading, and
  // the first signed test build under the owner's team (run 36852115463) was
  // refused there because only the verify step had the variable.
  const GATE_SCRIPTS = [
    "apps/desktop/ci/verify-and-publish.ts",
    "apps/desktop/ci/mirror-to-downloads.ts",
  ]
  const gateSteps = Object.entries(workflow.jobs).flatMap(([job, def]) =>
    (def.steps ?? [])
      .filter((s) => GATE_SCRIPTS.some((script) => (s.run ?? "").includes(script)))
      .map((s) => ({ job, name: s.name ?? "(unnamed)", env: s.env ?? {} })),
  )

  it("finds the verify and mirror steps of both the release and the test channel", () => {
    expect(gateSteps.length).toBeGreaterThanOrEqual(4)
  })

  for (const s of gateSteps) {
    it(`${s.job} / ${s.name} gets APPLE_TEAM_ID`, () => {
      expect(s.env.APPLE_TEAM_ID).toBe(secretRef("APPLE_TEAM_ID"))
    })
  }

  it("the mirror's own gate call passes the team on", () => {
    const mirror = readFileSync(path.join(import.meta.dir, "ci", "mirror-to-downloads.ts"), "utf8")
    expect(mirror).toMatch(
      /publishManifest\(request, \{[^}]*appleTeamId: process\.env\.APPLE_TEAM_ID/s,
    )
  })
})
