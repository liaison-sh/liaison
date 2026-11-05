// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The store release pipeline, pinned as data.
//
// Nothing in this workflow can be tested by running it: there is no Apple
// distribution certificate and no upload keystore anywhere near this
// repository, and a store build is not something a test suite may perform. So
// what is asserted is everything that is decidable from the file: the trigger
// set, the least privilege each job holds, the commit pin on every action, the
// order of the steps, and the one rule this file exists to hold, which is that
// a build with no credentials comes out UNSIGNED and labelled, rather than
// failing in a keychain or signing with whatever was in the environment.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { ANDROID_SIGNING_SECRETS, IOS_SIGNING_SECRETS } from "./ci/signing-marker"
import { type Job, loadMobileReleaseWorkflow, step, stepIndex, WORKFLOW_PATH } from "./ci/workflow"

const workflow = loadMobileReleaseWorkflow()
const source = readFileSync(WORKFLOW_PATH, "utf8")

/**
 * An env key whose value would be a credential if it were spelled out. A name
 * ending in _FILE or _PATH is excluded because its value is a location on the
 * runner, not a secret: the keystore BYTES are a credential, the path the job
 * decoded them to is not.
 */
const CREDENTIAL_KEY =
  /^\s+(?![A-Z0-9_]*_(?:FILE|PATH):)[A-Z0-9_]*(PASSWORD|PWD|SECRET|P12|KEYSTORE|PRIVATE_KEY|PROFILE|TOKEN|APPLE_ID|CERTIFICATE)[A-Z0-9_]*:/

function job(name: string): Job {
  const found = workflow.jobs[name]
  if (!found) throw new Error(`no job named ${name}`)
  return found
}

/** The jobs pinned here. One per store, each on its own runner. */
const JOBS = ["build-ios", "build-android"]

/** Every step that puts a signature on something, or asks a store to. */
const SEALING = /^(Sign|Import|Export|Upload to)/

describe("the mobile release workflow", () => {
  it("fires on a mobile version tag and on a manual dry run, and on nothing else", () => {
    const triggers = workflow.on as unknown as Record<string, unknown>
    expect(Object.keys(triggers).sort()).toEqual(["push", "workflow_dispatch"])
    expect(workflow.on.push).toEqual({ tags: ["mobile-v[0-9]+.[0-9]+.[0-9]+"] })
    const dispatch = triggers.workflow_dispatch as {
      inputs: Record<string, { type: string; default: unknown }>
    }
    expect(Object.keys(dispatch.inputs)).toEqual(["dry_run"])
    expect(dispatch.inputs.dry_run.type).toBe("boolean")
    // The store facing path is the one somebody has to ask for.
    expect(dispatch.inputs.dry_run.default).toBe(true)
  })

  it("declares the store jobs on the runners their toolchains exist on", () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual([...JOBS].sort())
    // Each on the only runner its toolchain exists on, and neither waiting on
    // the other: one store being down is not the other store's problem.
    expect(job("build-ios")["runs-on"]).toBe("macos-latest")
    expect(job("build-android")["runs-on"]).toBe("ubuntu-latest")
    for (const name of JOBS) expect(job(name).needs ?? []).toEqual([])
  })

  it("gives each job the least token it can do its work with", () => {
    expect(workflow.permissions).toEqual({})
    for (const name of JOBS) {
      expect(job(name).permissions, `${name} permissions`).toEqual({ contents: "read" })
    }
  })

  it("pins every action to a commit, never to a tag somebody else can move", () => {
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
    expect(source).not.toContain("-----BEGIN")
    const credentialLines = source.split("\n").filter((line) => CREDENTIAL_KEY.test(line))
    expect(credentialLines.length).toBeGreaterThan(0)
    for (const line of credentialLines) {
      expect(line).toMatch(/\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}/)
    }
  })

  it("names every signing secret the marker requires, and no other", () => {
    // A secret the job forgets to pass is a build that comes out unsigned for
    // a reason nobody can see from the workflow.
    for (const [name, secrets] of [
      ["build-ios", IOS_SIGNING_SECRETS],
      ["build-android", ANDROID_SIGNING_SECRETS],
    ] as const) {
      const marker = step(job(name).steps, "Resolve the signing credentials")
      expect(Object.keys(marker.env ?? {}).sort()).toEqual([...secrets].sort())
      for (const secret of secrets) {
        expect(marker.env?.[secret]).toBe(`\${{ secrets.${secret} }}`)
      }
    }
  })

  it("checks the Home budget and the no Node gate before it builds anything shippable", () => {
    for (const name of JOBS) {
      const steps = job(name).steps
      const build = stepIndex(steps, "Build the mobile app")
      const budget = stepIndex(steps, "Check the Home chunk budget")
      const noNode = stepIndex(steps, "Verify no Node runtime is needed")
      expect(build).toBeGreaterThanOrEqual(0)
      expect(budget).toBeGreaterThan(build)
      expect(noNode).toBeGreaterThanOrEqual(0)
      expect(Math.max(budget, noNode)).toBeLessThan(
        stepIndex(steps, "Resolve the signing credentials"),
      )
    }
  })

  it("checks the synced assets for a host path before anything is sealed", () => {
    // A signature over a bundle carrying the runner's own directories only
    // makes a broken build look trustworthy.
    for (const name of JOBS) {
      const steps = job(name).steps
      const check = stepIndex(steps, "Verify no absolute paths in the synced assets")
      expect(check).toBeGreaterThanOrEqual(0)
      const sealing = steps
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => SEALING.test(entry.name ?? ""))
      expect(sealing.length).toBeGreaterThan(0)
      for (const { entry, index } of sealing) {
        expect(index, `${name}: ${entry.name} runs before the path check`).toBeGreaterThan(check)
      }
    }
  })

  it("does every signing step only when the marker says every credential was there", () => {
    // The one rule: no credentials means an unsigned artifact that says so,
    // never a signing step entered with half a set.
    for (const name of JOBS) {
      for (const entry of job(name).steps) {
        if (!SEALING.test(entry.name ?? "")) continue
        expect(entry.if, `${name}: ${entry.name} is not gated on the marker`).toContain(
          "steps.signing.outputs.signed == 'true'",
        )
      }
      expect(step(job(name).steps, "Resolve the signing credentials").id).toBe("signing")
    }
  })

  it("sends nothing to a store on a dry run", () => {
    for (const name of JOBS) {
      for (const entry of job(name).steps) {
        if (!/^Upload to/.test(entry.name ?? "")) continue
        expect(entry.if, `${name}: ${entry.name}`).toContain("!inputs.dry_run")
      }
    }
  })

  it("uploads the marker beside the artifact, so an unsigned build is labelled downstream", () => {
    for (const name of JOBS) {
      const upload = step(job(name).steps, "Upload the build artifacts")
      expect(String(upload.with?.path)).toContain("signing-marker.json")
    }
  })

  it("hands the android build the keystore values only through its own step", () => {
    // A password exported into the job environment is a password every later
    // step, and every action those steps call, can read.
    const steps = job("build-android").steps
    const bundle = step(steps, "Build the release bundle")
    expect(Object.keys(bundle.env ?? {}).sort()).toEqual([
      "LIAISON_KEYSTORE_ALIAS",
      "LIAISON_KEYSTORE_ALIAS_PASSWORD",
      "LIAISON_KEYSTORE_FILE",
      "LIAISON_KEYSTORE_PASSWORD",
    ])
    expect(source).not.toContain("GITHUB_ENV")
  })
})
