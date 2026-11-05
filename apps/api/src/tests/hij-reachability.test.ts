// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "bun:test"
import type { ActorContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { createTestOrg } from "~/tests/helpers/org"

// createTestOrg → bootstrapRegister → ensureAppsForOrg, which registers the
// in-tree host apps (projects, contacts, knowledge) AND calls
// registerKernelAgentTools(orgId). So after this the toolRegistry carries every
// Module H/I/J tool for the org and buildToolSet can resolve them by name.
// ALL_DEFERRED_TOOLS_UNLOCKED is passed so deferred read tools (if any) surface
// the same way a sub-agent / non-discovery caller sees them — the assertion is
// about REACHABILITY (registered + scope-visible), not the tool_search flow.

let orgId: string

const USER_ID = "00000000-0000-0000-0000-0000000090aa"

function actorWith(scopes: string[]): ActorContext {
  return {
    actorType: "user",
    userId: USER_ID,
    orgId,
    scopes,
    dimensionGrants: {},
  }
}

describe("modules H/I/J capabilities are reachable by the agent", () => {
  beforeAll(async () => {
    const org = await createTestOrg()
    orgId = org.id
  })

  it("an interactive actor with the right scopes sees the new projects + contacts + knowledge tools", () => {
    const actor = actorWith([
      "projects:tasks:read",
      "projects:tasks:write",
      "projects:projects:write",
      "kernel:contacts:export",
      "kernel:contacts:read",
      "knowledge:documents:read",
      "knowledge:documents:update",
      "knowledge:sources:manage",
    ])
    const names = Object.keys(
      buildToolSet(orgId, actor, "T1", ALL_DEFERRED_TOOLS_UNLOCKED, "agent"),
    )
    expect(names).toEqual(
      expect.arrayContaining([
        "projects__tasks_byAssignee",
        "projects__merge",
        "projects__instantiate_template",
        "projects__add_dependency",
        "kernel__contacts_export",
        "knowledge__review_queue",
        "knowledge__verify",
        "knowledge__add_folder_source",
      ]),
    )
  })

  it("an actor lacking kernel:contacts:export does NOT see contacts_export (scope gate)", () => {
    const actor = actorWith(["projects:tasks:read"])
    const names = Object.keys(
      buildToolSet(orgId, actor, "T1", ALL_DEFERRED_TOOLS_UNLOCKED, "agent"),
    )
    expect(names).not.toContain("kernel__contacts_export")
  })

  it("watch_state and web_watch are NOT in the tool set for an interactive turn (no routine frame)", () => {
    const actor = actorWith(["kernel:agent:web"])
    const names = Object.keys(
      buildToolSet(orgId, actor, "T1", ALL_DEFERRED_TOOLS_UNLOCKED, "agent"),
    )
    expect(names).not.toContain("kernel__watch_state")
    expect(names).not.toContain("kernel__web_watch")
  })

  it("watch_state and web_watch ARE in the tool set when the run frame carries routineId", () => {
    const actor = actorWith(["kernel:agent:web"])
    const runFrame: RunContext = {
      runId: "run1",
      parentRunId: null,
      rootRunId: "run1",
      nestingDepth: 0,
      routineId: "00000000-0000-0000-0000-0000000090bb",
    }
    const names = Object.keys(
      buildToolSet(orgId, actor, "T1", ALL_DEFERRED_TOOLS_UNLOCKED, "agent", runFrame),
    )
    expect(names).toEqual(expect.arrayContaining(["kernel__watch_state", "kernel__web_watch"]))
  })
})
