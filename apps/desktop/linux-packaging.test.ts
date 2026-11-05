// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Linux ships two packages and no signature. Both facts are load bearing:
//   - `tauri build` with no --bundles argument produces whatever the config's
//     target list happens to hold on that runner, and a release that quietly
//     lost its .deb looks identical to one that never built it;
//   - there is no Linux signing credential anywhere in this epic, so the only
//     integrity a downloader gets is the checksum file published beside the
//     packages. If that file is missing, nothing about the download can be
//     checked at all.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { loadDesktopReleaseWorkflow, step, stepIndex, WORKFLOW_PATH } from "./ci/workflow"

const steps = loadDesktopReleaseWorkflow().jobs["build-linux"].steps
const source = readFileSync(WORKFLOW_PATH, "utf8")

describe("the Linux packaging job", () => {
  it("builds both bundler targets, named", () => {
    expect(step(steps, "Build the app bundle").run).toContain("--bundles appimage,deb")
  })

  it("fails the job when either package is missing", () => {
    const run = step(steps, "List package outputs").run ?? ""
    expect(run).toContain(".AppImage")
    expect(run).toContain(".deb")
    expect(run).toContain("exit 1")
  })

  it("publishes a sha256 checksum file beside the packages", () => {
    const checksum = step(steps, "Checksum the Linux packages").run ?? ""
    expect(checksum).toContain("sha256sum")
    expect(checksum).toContain("SHA256SUMS")
    // Written after both packages were proven to exist, and before anything
    // is uploaded: a checksum of a file that was not there is an empty file.
    expect(stepIndex(steps, "Checksum the Linux packages")).toBeGreaterThan(
      stepIndex(steps, "List package outputs"),
    )
    expect(stepIndex(steps, "Checksum the Linux packages")).toBeLessThan(
      stepIndex(steps, "Upload the Linux artifact"),
    )
  })

  it("uploads both packages and the checksum file", () => {
    const path = String(step(steps, "Upload the Linux artifact").with?.path ?? "")
    expect(path).toContain(".AppImage")
    expect(path).toContain(".deb")
    expect(path).toContain("SHA256SUMS")
  })

  it("carries no operating system signature, and says so in the file", () => {
    // No Linux signing credential exists anywhere in this epic, and a GPG step
    // without a key would be theatre. The file says so rather than leaving a
    // reader to notice an absence.
    expect(source).toContain("unsigned by design")
    for (const entry of steps) {
      const body = String(entry.run ?? "")
      expect(body).not.toContain("codesign")
      expect(body).not.toContain("signtool")
      expect(body).not.toContain("AZURE_")
      expect(body).not.toContain("gpg")
    }
  })

  it("signs the updater archive, which is the only integrity a Linux updater gets", () => {
    // The one signature a Linux build does carry. Without it an installed copy
    // has nothing at all to check before it replaces its own binary: the
    // checksum file protects a human downloading from the release page, and
    // the updater never reads it.
    const names = steps.map((entry) => entry.name ?? "")
    expect(names).toContain("Sign the updater archive")
    expect(names.filter((name) => name.startsWith("Sign "))).toEqual(["Sign the updater archive"])
  })
})
