// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The daily reconcile of the Scope check's group, over the in-memory db: each signed
// agreement's client is added through the declared call made as the agreement's sender (on its
// signed version); a change request, an agreement with no client or no signed version adds
// nothing; with no group (the Scope check not enabled) nothing is called.

import { describe, expect, it } from "bun:test"
import type { AgreementsCtx } from "./ctx"
import { memoryDb } from "./memory-db.testutil"
import { onScopeCheckEnabled, SCOPE_GROUP_KEY, scopeGroupReconcile } from "./scope-group"

const GROUP = "99999999-0000-4000-8000-000000000009"

async function world(groupId: string | null) {
  const db = memoryDb()
  const calls: Array<Record<string, unknown>> = []
  const keys: string[] = []
  const sow = await db.insert("agreements", {
    number: "AG-1",
    kind: "sow",
    status: "signed",
    contact_id: "contact-a",
  })
  const v = await db.insert("agreement_versions", { agreement_id: sow.id, status: "signed" })
  const cr = await db.insert("agreements", {
    number: "CR-1",
    kind: "change_request",
    status: "signed",
    contact_id: "contact-b",
  })
  await db.insert("agreement_versions", { agreement_id: cr.id, status: "signed" })
  await db.insert("agreements", { number: "AG-2", kind: "nda", status: "signed", contact_id: null })
  await db.insert("agreements", {
    number: "AG-3",
    kind: "msa",
    status: "signed",
    contact_id: "contact-c",
  })
  const ctx = {
    orgId: "org",
    userId: "system",
    db,
    today: "2026-11-17",
    client_actions_own_group: async (p: { key: string }) => {
      keys.push(p.key)
      return { status: "ok", group_id: groupId }
    },
    client_actions_call_as_sender: async (p: Record<string, unknown>) => {
      calls.push(p)
      return { status: "completed", result: { added: ["contact-a"] } }
    },
  } as unknown as AgreementsCtx
  return { ctx, calls, keys, versionId: v.id, sowId: sow.id }
}

describe("the Scope check's group reconcile", () => {
  it("adds each signed agreement's client as the person who sent it, and nothing else", async () => {
    const w = await world(GROUP)
    const out = (await scopeGroupReconcile(w.ctx)) as { status: string; added: number }
    expect(w.keys).toEqual([SCOPE_GROUP_KEY])
    expect(out).toMatchObject({ status: "ok", added: 1 })
    expect(w.calls).toEqual([
      {
        target_type: "agreement_version",
        target_id: w.versionId,
        tool: "kernel:contacts_group_add",
        params: { groupId: GROUP, contactIds: ["contact-a"] },
        idempotency_key: `agreements:scope-group:${w.sowId}:2026-11-17`,
      },
    ])
  })

  it("with the Scope check not enabled, calls nothing", async () => {
    const w = await world(null)
    expect(((await scopeGroupReconcile(w.ctx)) as { status: string }).status).toBe("skipped")
    expect(w.calls).toEqual([])
  })

  it("fills the group as soon as the Scope check template is enabled, not at the next daily pass", async () => {
    const w = await world(GROUP)
    const out = (await onScopeCheckEnabled(w.ctx, {
      data: { appName: "agreements", templateKey: "scope-check" },
    })) as { status: string; added: number }
    expect(out).toMatchObject({ status: "ok", added: 1 })
    expect(w.calls).toHaveLength(1)
  })

  it("another routine created does nothing", async () => {
    const w = await world(GROUP)
    for (const data of [
      { appName: "agreements", templateKey: "other" },
      { appName: "projects", templateKey: "scope-check" },
      { appName: null, templateKey: null },
    ]) {
      expect(((await onScopeCheckEnabled(w.ctx, { data })) as { status: string }).status).toBe(
        "ignored",
      )
    }
    expect(w.calls).toEqual([])
    expect(w.keys).toEqual([])
  })
})
