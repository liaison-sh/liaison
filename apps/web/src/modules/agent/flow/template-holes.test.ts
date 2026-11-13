// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A template's status the project lacks is left empty and named in the editor's hint, until a
// status is chosen in that place; once every place has one, the hint is gone.
import { describe, expect, it } from "vitest"
import { fillTemplate, unresolvedStatuses } from "./flow-model"

const PROJECT = {
  id: "p-1",
  statuses: [
    { id: "s-received", label: "Received" },
    { id: "s-repaired", label: "Repaired" },
  ],
}

const TEMPLATE = {
  flow: {
    steps: [
      {
        id: "a1",
        type: "action",
        params: { statusIds: ["{{status:received}}", "{{status:done}}"] },
      },
    ],
  },
  eventFilter: { projectId: "{{projectId}}", toStatusId: "{{status:done}}" },
}

describe("template holes", () => {
  it("names a lacking status while its places are empty", () => {
    const filled = fillTemplate(TEMPLATE, PROJECT)
    expect(filled.missing).toEqual(["done"])
    expect(filled.value.eventFilter).toEqual({ projectId: "p-1", toStatusId: "" })
    expect(filled.value.flow.steps[0]?.params.statusIds).toEqual(["s-received"])
    expect(unresolvedStatuses(filled.holes, filled.value)).toEqual(["done"])
  })

  it("clears the hint once every place has a status chosen", () => {
    const filled = fillTemplate(TEMPLATE, PROJECT)
    const filterChosen = {
      ...filled.value,
      eventFilter: { ...filled.value.eventFilter, toStatusId: "s-repaired" },
    }
    // The dropped list entry is still a hole.
    expect(unresolvedStatuses(filled.holes, filterChosen)).toEqual(["done"])
    const all = {
      ...filterChosen,
      flow: {
        steps: [
          { ...filled.value.flow.steps[0], params: { statusIds: ["s-received", "s-repaired"] } },
        ],
      },
    }
    expect(unresolvedStatuses(filled.holes, all)).toEqual([])
  })

  it("has no hole when every status resolves", () => {
    const filled = fillTemplate({ eventFilter: { toStatusId: "{{status:Repaired}}" } }, PROJECT)
    expect(filled.holes).toEqual([])
    expect(unresolvedStatuses(filled.holes, filled.value)).toEqual([])
  })
})
