// SPDX-License-Identifier: FSL-1.1-ALv2
// The services world's recorded coding session: the same shape the replay plays
// (one permission request, a denied ending), a fiction that says it is recorded
// wherever a person reads it, in a client's repository, with its links on the
// reserved stand-in host only.
import { describe, expect, it } from "bun:test"
import { recordingSchema } from "~/modules/demo/replay/replay"
import recordingJson from "./recording.studio.json"

const recording = recordingSchema.parse(recordingJson)
const text = JSON.stringify(recording)

describe("the services world's recording", () => {
  it("plays the replay's shape: one permission request and a denied ending", () => {
    expect(recording.events.filter((e) => e.type === "permission_request")).toHaveLength(1)
    expect(recording.denied.at(-1)?.type).toBe("result")
    expect(recording.events.at(-1)?.type).toBe("result")
    expect(recording.events.at(-1)?.payload).toMatchObject({ pushed: true })
    expect(recording.denied.at(-1)?.payload).toMatchObject({ pushed: false })
  })

  it("says recorded, and links only on the stand-in host", () => {
    expect(text).toMatch(/recorded session/i)
    const hosts = new Set([...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]))
    expect([...hosts]).toEqual(["github-standin.example"])
  })

  it("fixes the bug the client's seeded ticket reports, in that client's repository", () => {
    expect(recording.repo).toBe("stock-data")
    expect(recording.title).toContain("stock export")
    expect(recording.prompt).toContain("empty since the last release")
    for (const branchOf of [recording.events.at(-1), recording.denied.at(-1)]) {
      expect(branchOf?.payload).toMatchObject({ branch: recording.branch })
    }
    // Nothing of another world's session is left in it.
    expect(text).not.toMatch(/payroll|venue|tideform|planner/i)
  })
})
