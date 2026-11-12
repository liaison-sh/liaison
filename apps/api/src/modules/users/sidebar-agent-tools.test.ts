// SPDX-License-Identifier: FSL-1.1-ALv2
// The agent's sidebar tools (0293): the caller's own list by default, a
// member's only with kernel:users:admin and only in the caller's org, a delta
// that never wipes the list, and a change refused outside a live person turn.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { withRlsContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { registerSkillRoutineTools } from "~/modules/agent/tools/skills-routines-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  handleSidebarAppsGet,
  handleSidebarAppsSet,
  type SidebarToolContext,
  sidebarAppsSetParams,
} from "./sidebar-agent-tools"

let orgId: string
let adminId: string
let memberId: string
let otherOrgUserId: string

const MEMBER_SCOPES = ["kernel:agent:memory"]
const ADMIN_SCOPES = ["kernel:agent:memory", "kernel:users:admin"]

function frame(extra: Partial<RunContext> = {}): RunContext {
  const runId = crypto.randomUUID()
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, ...extra }
}

/** Run a handler as `userId`'s agent turn, under that user's RLS. */
function asTurn<T>(
  userId: string,
  scopes: string[],
  fn: (ctx: SidebarToolContext) => Promise<T>,
  opts: { frame?: RunContext | null } = {},
): Promise<T> {
  const run = () =>
    withRlsContext({ actorType: "user", userId, orgId, scopes, dimensionGrants: {} }, (tx) =>
      fn({ userId, orgId, db: tx, actorType: "agent", scopes }),
    )
  const f = opts.frame === undefined ? frame() : opts.frame
  return f ? runContextStore.run(f, run) : run()
}

type SetResult = {
  userId: string
  hidden: string[]
  changed: { hidden: string[]; shown: string[] }
  error?: { code: string; message: string }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  adminId = (await minimal.orgAdmin(orgId)).id
  memberId = (await minimal.person(orgId)).id
  otherOrgUserId = (await minimal.secondOrg()).adminUserId
})

afterAll(async () => {
  await releaseTestLock()
})

describe("sidebar_apps_get / sidebar_apps_set", () => {
  it("are registered as kernel tools, ungated, on the always-held scope", () => {
    registerSkillRoutineTools(orgId)
    for (const name of ["sidebar_apps_get", "sidebar_apps_set"]) {
      const entry = toolRegistry.get([orgId, "kernel", name]) as
        | { requiredScopes: string[]; gated?: boolean }
        | undefined
      expect(entry).toBeDefined()
      expect(entry?.requiredScopes).toEqual(["kernel:agent:memory"])
      expect(entry?.gated).toBeFalsy()
    }
  })

  it("reads and changes the caller's own list as a delta", async () => {
    const empty = (await asTurn(memberId, MEMBER_SCOPES, (ctx) =>
      handleSidebarAppsGet({}, ctx),
    )) as { userId: string; hidden: string[] }
    expect(empty).toMatchObject({ userId: memberId, hidden: [] })

    const hid = (await asTurn(memberId, MEMBER_SCOPES, (ctx) =>
      handleSidebarAppsSet({ hide: ["sessions", "monitoring"] }, ctx),
    )) as SetResult
    expect(hid.hidden).toEqual(["sessions", "monitoring"])
    expect(hid.changed).toEqual({ hidden: ["sessions", "monitoring"], shown: [] })

    const shown = (await asTurn(memberId, MEMBER_SCOPES, (ctx) =>
      handleSidebarAppsSet({ show: ["sessions"], hide: ["dashboards"] }, ctx),
    )) as SetResult
    expect(shown.hidden).toEqual(["monitoring", "dashboards"])
    expect(shown.changed).toEqual({ hidden: ["dashboards"], shown: ["sessions"] })

    // Already hidden: nothing changes, and it says so.
    const again = (await asTurn(memberId, MEMBER_SCOPES, (ctx) =>
      handleSidebarAppsSet({ hide: ["monitoring"] }, ctx),
    )) as SetResult
    expect(again.hidden).toEqual(["monitoring", "dashboards"])
    expect(again.changed).toEqual({ hidden: [], shown: [] })
  })

  it("refuses an empty delta and an id in both hide and show", async () => {
    expect(sidebarAppsSetParams.safeParse({}).success).toBe(false)
    expect(sidebarAppsSetParams.safeParse({ hide: [] }).success).toBe(false)
    const both = (await asTurn(memberId, MEMBER_SCOPES, (ctx) =>
      handleSidebarAppsSet({ hide: ["sessions"], show: ["sessions"] }, ctx),
    )) as SetResult
    expect(both.error?.code).toBe("INVALID_INPUT")
  })

  it("lets an admin read and change a member's list", async () => {
    const set = (await asTurn(adminId, ADMIN_SCOPES, (ctx) =>
      handleSidebarAppsSet({ userId: memberId, hide: ["tickets"] }, ctx),
    )) as SetResult
    expect(set.userId).toBe(memberId)
    expect(set.hidden).toEqual(["monitoring", "dashboards", "tickets"])

    const own = (await asTurn(memberId, MEMBER_SCOPES, (ctx) => handleSidebarAppsGet({}, ctx))) as {
      hidden: string[]
    }
    expect(own.hidden).toEqual(["monitoring", "dashboards", "tickets"])

    const read = (await asTurn(adminId, ADMIN_SCOPES, (ctx) =>
      handleSidebarAppsGet({ userId: memberId }, ctx),
    )) as { hidden: string[] }
    expect(read.hidden).toEqual(["monitoring", "dashboards", "tickets"])
  })

  it("refuses another person's list without kernel:users:admin", async () => {
    const get = (await asTurn(memberId, MEMBER_SCOPES, (ctx) =>
      handleSidebarAppsGet({ userId: adminId }, ctx),
    )) as SetResult
    expect(get.error?.code).toBe("FORBIDDEN")
    const set = (await asTurn(memberId, MEMBER_SCOPES, (ctx) =>
      handleSidebarAppsSet({ userId: adminId, hide: ["sessions"] }, ctx),
    )) as SetResult
    expect(set.error?.code).toBe("FORBIDDEN")
  })

  it("answers NOT_FOUND for a user of another organization", async () => {
    const set = (await asTurn(adminId, ADMIN_SCOPES, (ctx) =>
      handleSidebarAppsSet({ userId: otherOrgUserId, hide: ["sessions"] }, ctx),
    )) as SetResult
    expect(set.error?.code).toBe("NOT_FOUND")
    const get = (await asTurn(adminId, ADMIN_SCOPES, (ctx) =>
      handleSidebarAppsGet({ userId: otherOrgUserId }, ctx),
    )) as SetResult
    expect(get.error?.code).toBe("NOT_FOUND")
  })

  it("refuses a change in a routine or background run, but still reads", async () => {
    const routine = (await asTurn(
      memberId,
      MEMBER_SCOPES,
      (ctx) => handleSidebarAppsSet({ hide: ["sessions"] }, ctx),
      { frame: frame({ routineId: crypto.randomUUID() }) },
    )) as SetResult
    expect(routine.error?.code).toBe("E_INTERACTIVE_ONLY")
    const background = (await asTurn(
      memberId,
      MEMBER_SCOPES,
      (ctx) => handleSidebarAppsSet({ hide: ["sessions"] }, ctx),
      { frame: frame({ background: true }) },
    )) as SetResult
    expect(background.error?.code).toBe("E_INTERACTIVE_ONLY")
    const read = (await asTurn(memberId, MEMBER_SCOPES, (ctx) => handleSidebarAppsGet({}, ctx), {
      frame: null,
    })) as { hidden: string[] }
    expect(read.hidden).toEqual(["monitoring", "dashboards", "tickets"])
  })
})
