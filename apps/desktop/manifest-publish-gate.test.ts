// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The manifest is the only artifact in this pipeline a customer's machine acts
// on WITHOUT a human: publish a latest.json and every installed copy downloads
// what it names. So the job that writes it is last, it is the only job that can
// write to the repository at all, and every check in it is a hard failure.
//
// The three ways this goes wrong are all silent:
//   1. the job runs before a platform finished, and publishes a manifest naming
//      an artifact that does not exist yet,
//   2. a verify step carries continue-on-error, so a failed signature check is
//      a yellow annotation and the publish runs anyway,
//   3. `permissions: contents: write` sits at the top of the file, so every
//      build job could also have published one.
// Each of the three is pinned below.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { loadDesktopReleaseWorkflow, secretRef, stepIndex, WORKFLOW_PATH } from "./ci/workflow"

const workflow = loadDesktopReleaseWorkflow() as ReturnType<typeof loadDesktopReleaseWorkflow> & {
  permissions?: Record<string, string>
  jobs: Record<
    string,
    {
      permissions?: Record<string, string>
      steps: { name?: string; run?: string; "continue-on-error"?: boolean }[]
    }
  >
}
const source = readFileSync(WORKFLOW_PATH, "utf8")

const publish = workflow.jobs["publish-manifest"]
const steps = publish.steps

describe("the manifest publish job", () => {
  it("is the only job allowed to write to the repository", () => {
    // A top level contents: write grants it to every job in the file. The
    // build jobs download nothing and publish nothing; the one that does say
    // it, says it for itself.
    expect(workflow.permissions?.contents).toBeUndefined()
    expect(publish.permissions?.contents).toBe("write")
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name === "publish-manifest") continue
      expect(job.permissions?.contents).not.toBe("write")
    }
  })

  it("downloads every platform's artifacts before it verifies anything", () => {
    const download = stepIndex(steps, "Download the platform artifacts")
    const verify = stepIndex(steps, "Verify both signatures and publish the manifest")
    expect(download).toBeGreaterThanOrEqual(0)
    expect(verify).toBeGreaterThan(download)
  })

  it("runs the gate through the script, not inline shell", () => {
    // Inline shell in a workflow is code no test can call. The gate lives in
    // a module apps/desktop/two-signature-gate.test.ts drives in process.
    const gate = steps.find(
      (entry) => entry.name === "Verify both signatures and publish the manifest",
    )
    expect(gate?.run).toContain("apps/desktop/ci/verify-and-publish.ts")
  })

  it("names the one Apple team the macOS app must be signed by, on both gates", () => {
    // Any Developer ID passes codesign --verify and Gatekeeper; the gate
    // refuses a macOS artifact unless APPLE_TEAM_ID says whose it must be.
    const testSteps = workflow.jobs["publish-test-channel"].steps as {
      name?: string
      env?: Record<string, string>
    }[]
    for (const [list, name] of [
      [steps, "Verify both signatures and publish the manifest"],
      [testSteps, "Verify both signatures and write the test manifest"],
    ] as const) {
      const gate = (list as { name?: string; env?: Record<string, string> }[]).find(
        (entry) => entry.name === name,
      )
      expect(gate?.env?.APPLE_TEAM_ID).toBe(secretRef("APPLE_TEAM_ID"))
    }
  })

  it("lets no step in the job continue on error", () => {
    // One of these on a verify step turns a failed signature check into a
    // yellow annotation and publishes anyway.
    for (const entry of steps) {
      expect(entry["continue-on-error"]).toBeUndefined()
    }
    expect(source).not.toContain("continue-on-error")
  })

  it("still has no placeholder left in it", () => {
    expect(source).not.toContain("placeholder, two-signature gate")
  })
})
