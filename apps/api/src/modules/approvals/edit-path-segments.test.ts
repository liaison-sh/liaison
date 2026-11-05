// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An approval edit names its target with a dot-path (`customerEmail.body`).
// A path segment is a property name chosen by the caller (a person through
// POST /api/approvals/:id/payload, or an agent through approval_update_payload),
// so the segments `__proto__`, `constructor` and `prototype` must never be
// walked: writing through them changes Object.prototype for the whole server
// process, every org included. These tests send such a path and check that the
// edit is refused and that no plain object gained the property.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { validateOutboundUrlNoDns } from "~/lib/outbound-fetch"
import { updatePayload } from "~/modules/approvals/edit"
import { approvalEditableFieldsRegistry, toolRegistry } from "~/modules/apps/app-registries"

const ORG = "00000000-0000-4000-8000-0000000a5e01"
const REQUESTER = "00000000-0000-4000-8000-0000000a5e02"
const THREAD = "00000000-0000-4000-8000-0000000a5e03"
const REQUEST = "00000000-0000-4000-8000-0000000a5e04"
const APP = "path_probe"
const TOOL = "send"

const requester: UserContext = {
  actorType: "user",
  userId: REQUESTER,
  orgId: ORG,
  scopes: [`${APP}:approve`, "kernel:approvals:read", "kernel:approvals:write"],
  dimensionGrants: {},
}

/** Remove whatever an attempt managed to plant, so a red run never poisons the next test. */
function scrubPrototype(...names: string[]): void {
  for (const n of names) delete (Object.prototype as Record<string, unknown>)[n]
}

async function attemptEdit(fields: Record<string, unknown>): Promise<unknown> {
  try {
    return await updatePayload({ orgId: ORG, requestId: REQUEST, fields, actor: requester })
  } catch (err) {
    return err
  }
}

describe("approval edit path segments", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Path Probe Org', 'path-probe-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES (${REQUESTER}, ${ORG}, 'path-probe@test.local', 'Path Probe', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${REQUESTER}, ${ORG}, ${`${APP}:approve`}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD}, ${ORG}, 'path-probe-thread', 'approval', ${REQUESTER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES (${THREAD}, ${REQUESTER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    approvalEditableFieldsRegistry.set(
      [ORG, APP, TOOL],
      [{ field: "message", label: "Message", widget: "text" }],
    )
    toolRegistry.set([ORG, APP, TOOL], {
      appName: APP,
      name: TOOL,
      description: "path segment probe tool",
      requiredScopes: [`${APP}:write`],
      gated: true,
      handler: { bundlePath: "unused", exportName: "unused" },
      params: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    } as Parameters<typeof toolRegistry.set>[1])
  })

  // A fresh pending row per test: a refused edit leaves it pending, a landed one
  // would change it, and either way the next test starts from the same payload.
  async function seedPending(): Promise<void> {
    await sql`DELETE FROM kernel.approval_requests WHERE id = ${REQUEST}`
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES (
      ${REQUEST}, ${ORG}, 'path-probe-request', ${THREAD}, ${THREAD}, ${`${APP}:${TOOL}`},
      '{"message":"old"}'::jsonb, '{"message":"old"}'::jsonb, now() + interval '1 hour',
      ARRAY[${REQUESTER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
      '{"kind":"edit","title":"Path probe","lines":[]}'::jsonb
    )`
  }

  afterAll(async () => {
    scrubPrototype("sec3ProbeFlag", "allowPrivate")
    approvalEditableFieldsRegistry.delete([ORG, APP, TOOL])
    toolRegistry.delete([ORG, APP, TOOL])
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("a __proto__ segment under an editable field is refused and plants nothing", async () => {
    await seedPending()
    try {
      const outcome = await attemptEdit({ "message.__proto__.sec3ProbeFlag": "planted" })
      const planted = ({} as Record<string, unknown>).sec3ProbeFlag
      expect({ planted, refused: outcome instanceof Error }).toEqual({
        planted: undefined,
        refused: true,
      })
    } finally {
      scrubPrototype("sec3ProbeFlag")
    }
  })

  it("a constructor.prototype path is refused and plants nothing", async () => {
    await seedPending()
    try {
      const outcome = await attemptEdit({
        "message.constructor.prototype.sec3ProbeFlag": "planted",
      })
      const planted = ({} as Record<string, unknown>).sec3ProbeFlag
      expect({ planted, refused: outcome instanceof Error }).toEqual({
        planted: undefined,
        refused: true,
      })
    } finally {
      scrubPrototype("sec3ProbeFlag")
    }
  })

  it("an edit cannot switch off the outbound private-network guard for the process", async () => {
    await seedPending()
    try {
      await attemptEdit({ "message.__proto__.allowPrivate": "yes" })
      // validateOutboundUrlNoDns reads `opts.allowPrivate` off a fresh `{}`.
      expect(() => validateOutboundUrlNoDns("https://127.0.0.1/")).toThrow(
        "Outbound URL must not point to a private network",
      )
    } finally {
      scrubPrototype("allowPrivate")
    }
  })
})
