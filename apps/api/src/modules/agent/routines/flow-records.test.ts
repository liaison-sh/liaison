// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Routine flow records are the app's declaration, never a kernel app name: a second app that
 * declares `entities.<e>.routineFlow` is picked up by the same lookups as Projects, an entity that
 * declares nothing has no flow record, and a declaration whose server module is not a core app's
 * is refused when the record is read.
 */
import { afterEach, describe, expect, it } from "bun:test"
import projectsManifest from "~/apps/projects/app.manifest.json"
import { routineFlowRecordRegistry } from "~/modules/apps/app-registries"
import { routineFlowDeclarationErrors } from "~/modules/apps/contract"
import {
  flowRecordPath,
  flowRecordSource,
  flowRecordSourceOfLabel,
  flowRecordTool,
  isUncoalescedRecordEvent,
  type RoutineFlowDeclaration,
  readFlowRecords,
  takesRecordFilter,
} from "./flow-records"

const ORG = "00000000-0000-4000-8000-0000000000f1"

const helpdeskDecl: RoutineFlowDeclaration = {
  filterEvents: ["status_changed", "created"],
  uncoalescedEvents: ["status_changed"],
  recordParam: "caseId",
  updateTool: "case_update",
  commentTool: "case_comment",
  notifyScope: "helpdesk:cases:write",
  tabType: "helpdesk:case",
  urlPath: "/helpdesk/cases/{id}",
  readRecords: "readCases",
  leastLoaded: "caseLoad",
}

afterEach(() => {
  routineFlowRecordRegistry.deleteByPrefix([ORG])
})

describe("routine flow records", () => {
  it("picks up a second app declaring the contract, by its declaration alone", () => {
    routineFlowRecordRegistry.set([ORG, "helpdesk", "case"], {
      decl: helpdeskDecl,
      bundlePath: "/nowhere/helpdesk/handlers.ts",
    })
    const src = flowRecordSource(ORG, "helpdesk", "case")
    expect(src?.decl).toEqual(helpdeskDecl)
    expect(flowRecordSourceOfLabel(ORG, "helpdesk.case.status_changed")?.app).toBe("helpdesk")
    expect(takesRecordFilter(src, "status_changed")).toBe(true)
    expect(takesRecordFilter(src, "updated")).toBe(false)
    expect(isUncoalescedRecordEvent(src, "status_changed")).toBe(true)
    expect(isUncoalescedRecordEvent(src, "created")).toBe(false)
    expect(src && flowRecordTool(src, "update")).toBe("helpdesk:case_update")
    expect(src && flowRecordTool(src, "comment")).toBe("helpdesk:case_comment")
    expect(src && flowRecordPath(src, "c-1")).toBe("/helpdesk/cases/c-1")
  })

  it("gives an entity that declares nothing no flow record", () => {
    expect(flowRecordSource(ORG, "helpdesk", "case")).toBeNull()
    expect(flowRecordSourceOfLabel(ORG, "helpdesk.case.created")).toBeNull()
    expect(flowRecordSourceOfLabel(ORG, null)).toBeNull()
    expect(takesRecordFilter(null, "status_changed")).toBe(false)
    expect(isUncoalescedRecordEvent(null, "status_changed")).toBe(false)
  })

  it("refuses to read a record whose declared module is not a core app's", async () => {
    routineFlowRecordRegistry.set([ORG, "helpdesk", "case"], {
      decl: helpdeskDecl,
      bundlePath: "/nowhere/helpdesk/handlers.ts",
    })
    const src = flowRecordSource(ORG, "helpdesk", "case")
    if (!src) throw new Error("declared above")
    const actor = {
      actorType: "user" as const,
      userId: "u",
      orgId: ORG,
      scopes: ["*"],
      dimensionGrants: {},
    }
    await expect(readFlowRecords(src, actor, ["c-1"])).rejects.toThrow(
      "helpdesk:case: no server module declares its flow record",
    )
  })

  it("Projects declares the contract on its task entity, and it validates", () => {
    const task = (projectsManifest.entities as Record<string, { routineFlow?: unknown }>).task
    expect(task?.routineFlow).toMatchObject({ recordParam: "taskId", tabType: "projects:task" })
    expect(routineFlowDeclarationErrors(projectsManifest)).toEqual([])
  })

  it("checks a declaration's tools and scope against the declaring app", () => {
    const errors = routineFlowDeclarationErrors({
      name: "helpdesk",
      entities: { case: { routineFlow: helpdeskDecl } },
      tools: {
        case_update: { readOnly: true, params: { type: "object", properties: { caseId: {} } } },
        // case_comment is missing.
      },
    })
    expect(errors).toEqual([
      'routine_flow_invalid: entities.case.routineFlow.updateTool: tool "case_update" must write',
      'routine_flow_invalid: entities.case.routineFlow.commentTool: "case_comment" is not a tool of this app',
    ])
    expect(
      routineFlowDeclarationErrors({
        name: "other",
        entities: { case: { routineFlow: helpdeskDecl } },
        tools: {
          case_update: { params: { type: "object", properties: { caseId: {} } } },
          case_comment: { params: { type: "object", properties: { body: {} } } },
        },
      }),
    ).toEqual([
      'routine_flow_invalid: entities.case.routineFlow.recordParam: tool "case_comment" takes no parameter "caseId"',
      'routine_flow_invalid: entities.case.routineFlow.notifyScope: "helpdesk:cases:write" is not a scope of this app',
    ])
  })
})
