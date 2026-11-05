// SPDX-License-Identifier: FSL-1.1-ALv2
//
// N16: an approved import_start is replayed as it was when the approval ran
// ("queued"); the import finishes later. Every turn states the run's status
// now, read from its row.
import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { importRunIdsIn, importRunStateLine } from "~/modules/agent/context/import-run-state"
import * as runs from "~/modules/imports/runs"

const RUN = "3138aa78-2896-40f6-8053-b949f22b554d"
const OTHER = "d36c7f7b-b5ba-43a8-914b-a31eb09b891e"

const resultRow = (runId: string, toolName = "kernel:import_start") => ({
  authorType: "system",
  metadata: {
    type: "approval-result",
    toolName,
    result: JSON.stringify({ runId, status: "queued", next: "The import runs in the background." }),
  },
})

const getRun = spyOn(runs, "getImportRun").mockImplementation(async (_orgId, runId) =>
  runId === RUN
    ? ({
        id: RUN,
        status: "done",
        counts: { "projects.task": { created: 25, skipped: 0, failed: 0 } },
      } as unknown as Awaited<ReturnType<typeof runs.getImportRun>>)
    : null,
)
afterAll(() => getRun.mockRestore())

describe("import run state", () => {
  test("reads the runs approved import_start results name, once each", () => {
    expect(
      importRunIdsIn([
        resultRow(RUN),
        resultRow(RUN),
        resultRow(OTHER, "kernel__import_start"),
        resultRow("ffffffff-ffff-4fff-8fff-ffffffffffff", "kernel:import_undo"),
        {
          authorType: "agent",
          metadata: {
            type: "approval-result",
            toolName: "kernel:import_start",
            result: `"runId":"${RUN}"`,
          },
        },
      ]),
    ).toEqual([RUN, OTHER])
  })

  test("states the run's status now, not the replayed snapshot", async () => {
    const line = await importRunStateLine("org", [resultRow(RUN)])
    expect(line).toContain(`run ${RUN}: done (projects.task 25 created, 0 skipped, 0 failed)`)
    expect(line).toContain("never promise to watch it or report back")
    expect(line).not.toContain("queued")
  })

  test("nothing when the conversation started no import", async () => {
    expect(await importRunStateLine("org", [{ authorType: "user", metadata: null }])).toBeNull()
  })
})
