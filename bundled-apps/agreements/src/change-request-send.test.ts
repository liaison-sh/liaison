// SPDX-License-Identifier: FSL-1.1-ALv2
//
// change_request_send over the in-memory db and recording doubles of the kernel's link methods
// and the declared mail reply: an agent's call parks one card and writes nothing; an approved
// call writes and freezes the change request, mints its approval link under the card's mail
// check, then sends the reply under the same check. Each failure point leaves no partial
// effect: a link refused (the client wrote since) sends no reply, a reply that fails withdraws
// the link, and the change request stays a draft.

import { describe, expect, it } from "bun:test"
import { changeRequestSend, changeRequestSendPreflight, moneyText } from "./change-request-send"
import type { AgreementsCtx } from "./ctx"
import { memoryDb, type Row } from "./memory-db.testutil"
import { summarizeChangeRequestSend } from "./summarizers"

const PERSON = "11111111-1111-4111-8111-111111111111"
const AGENT = "33333333-3333-4333-8333-333333333333"
const CLIENT = "aaaaaaaa-0000-4000-8000-000000000001"
const CONVERSATION = "dddddddd-0000-4000-8000-00000000000d"
const SHA = "b".repeat(64)

type Db = ReturnType<typeof memoryDb>

interface Calls {
  approvals: Array<{ editable_fields: string[]; summary_detail?: { lines?: string[] } }>
  mints: Array<{ send: Record<string, unknown> }>
  revokes: unknown[]
  replies: Array<Record<string, unknown>>
  emitted: string[]
}

async function world() {
  const db = memoryDb()
  const parent = await db.insert("agreements", {
    number: "AG-2026-014",
    kind: "sow",
    title: "Website",
    status: "signed",
    contact_id: CLIENT,
    currency: "EUR",
    price_minor: "4200000",
    language: "en",
  })
  const version = await db.insert("agreement_versions", {
    agreement_id: parent.id,
    number: 1,
    status: "signed",
    sha256: SHA,
    source_text:
      "1. Scope\nA website in two languages.\n8. Changes\n8.2 Extra work is billed at 100.00 EUR per hour.",
  })
  return { db, parentId: parent.id, versionId: version.id }
}

function ctxFor(
  db: Db,
  opts: {
    agent?: boolean
    approved?: boolean
    mint?: Record<string, unknown>
    reply?: Record<string, unknown>
  } = {},
) {
  const calls: Calls = { approvals: [], mints: [], revokes: [], replies: [], emitted: [] }
  const ctx = {
    orgId: "org",
    userId: PERSON,
    db,
    turn: { get: async () => ({ agentId: opts.agent ? AGENT : null }) },
    kernel: {
      caller: async () => ({ kind: "person", userId: PERSON, roleIds: [], holds: {} }),
      findByIds: async (_e: string, ids: string[]) =>
        ids.includes(CLIENT)
          ? [{ id: CLIENT, name: "Pauline Marlin", email: "pauline@maison-marlin.example" }]
          : [],
    },
    ...(opts.approved ? { approval: { id: "approved" } } : {}),
    requestApproval: async (req: Calls["approvals"][number]) => {
      calls.approvals.push(req)
      return { approval_id: `card-${calls.approvals.length}` }
    },
    rich_text_render: async () => ({
      status: "ok",
      bytesBase64: "JVBERi0=",
      sha256: SHA,
      byteSize: 5,
      pageCount: 1,
      blanks: [],
      sourceText: "Change request",
      textMatches: true,
    }),
    files_importAttachment: async () => ({ id: "55555555-5555-4555-8555-555555555555" }),
    client_actions_mint: async (p: { send: Record<string, unknown> }) => {
      calls.mints.push(p)
      return opts.mint ?? { status: "ok", group_id: "g", actions: [{ id: "ca-1", status: "open" }] }
    },
    client_actions_revoke: async (p: unknown) => {
      calls.revokes.push(p)
      return { status: "ok", revoked_ids: ["ca-1"] }
    },
    executeTool: async (name: string, params: Record<string, unknown>) => {
      calls.replies.push({ name, ...params })
      return opts.reply ?? { status: "completed", result: { ok: true } }
    },
    emit: async (e: { entity: string; action: string }) => {
      calls.emitted.push(`${e.entity}:${e.action}`)
      return null
    },
    calls,
  }
  return ctx as unknown as AgreementsCtx & { calls: Calls }
}

const params = (parentId: string, versionId: string, over: Record<string, unknown> = {}) => ({
  parent_agreement_id: parentId,
  title: "Single sign-on",
  work: ["Sign-in with the client's identity provider"],
  hours_minutes: 3600,
  hours_source: "past similar work",
  rate_minor: "10000",
  reply: {
    conversation_id: CONVERSATION,
    body: "Single sign-on is not in the signed scope; here is a change request.",
  },
  passage: { version_id: versionId, section: "8.2" },
  mail_message_id: "mail-1",
  ...over,
})

const changeRequests = (db: Db) =>
  (db.tables.get("agreements") ?? []).filter((r) => r.kind === "change_request") as Row[]

describe("change_request_send", () => {
  it("an agent's call parks one card with the reply, the hours and their source, the rate, the price and the signed passage, and writes nothing", async () => {
    const { db, parentId, versionId } = await world()
    const ctx = ctxFor(db, { agent: true })
    const out = (await changeRequestSend(ctx, params(parentId, versionId))) as { status: string }
    expect(out.status).toBe("pending_approval")
    expect(ctx.calls.approvals).toHaveLength(1)
    const card = ctx.calls.approvals[0]
    expect(card?.editable_fields).toEqual(["hours_minutes", "rate_minor"])
    const lines = card?.summary_detail?.lines ?? []
    expect(lines).toContain("Hours: 60 h (from past similar work)")
    expect(lines).toContain("Rate: 100.00 EUR per hour")
    expect(lines).toContain("Price: 6,000.00 EUR")
    expect(
      lines.some((l) => l.includes("section 8.2") && l.includes("8.2 Extra work is billed")),
    ).toBe(true)
    expect(lines).toContain("Nothing is started until it is approved.")
    expect(changeRequests(db)).toEqual([])
    expect(ctx.calls.mints).toEqual([])
    expect(ctx.calls.replies).toEqual([])
  })

  it("the parked card reads money in the agreement's currency, with the price, never minor units", async () => {
    const { db, parentId, versionId } = await world()
    const pre = (await changeRequestSendPreflight(ctxFor(db), params(parentId, versionId))) as {
      ok: true
      pinnedParams: Record<string, unknown>
    }
    expect(pre.pinnedParams.currency).toBe("EUR")
    const card = await summarizeChangeRequestSend({
      ...params(parentId, versionId),
      ...pre.pinnedParams,
      hours_minutes: 2400,
      rate_minor: "11000",
    })
    expect(card.lines).toContain("Rate: 110.00 EUR per hour")
    expect(card.lines).toContain("Price: 4,400.00 EUR")
    expect(card.lines.join("\n")).not.toContain("minor units")
    expect(moneyText(626400n, "EUR")).toBe("6,264.00 EUR")
  })

  it("an approved call writes the change request, mints its approval link under the card's check, then sends the reply under it", async () => {
    const { db, parentId, versionId } = await world()
    const pre = (await changeRequestSendPreflight(ctxFor(db), params(parentId, versionId))) as {
      ok: true
      pinnedParams: { sendGuard: Record<string, unknown>; guardKey: string }
    }
    expect(pre.pinnedParams.sendGuard).toMatchObject({
      addresses: ["pauline@maison-marlin.example"],
      conversationId: CONVERSATION,
      classification: "service",
    })
    const ctx = ctxFor(db, { approved: true })
    const out = (await changeRequestSend(ctx, {
      ...params(parentId, versionId),
      ...pre.pinnedParams,
    })) as { status: string; change_request: { number: string; price_minor: string } }
    expect(out.status).toBe("ok")
    expect(out.change_request).toMatchObject({ number: "CR-1", price_minor: "600000" })
    const [cr] = changeRequests(db)
    expect(cr).toMatchObject({
      status: "sent",
      parent_agreement_id: parentId,
      hours_minutes: 3600,
      rate_minor: "10000",
      price_minor: "600000",
    })
    expect(ctx.calls.mints).toHaveLength(1)
    expect(ctx.calls.mints[0]?.send).toMatchObject({
      kind: "approve",
      target_type: "agreement_version",
      send_guard: pre.pinnedParams.sendGuard,
    })
    expect(ctx.calls.replies).toEqual([
      expect.objectContaining({
        name: "mail:reply",
        conversationId: CONVERSATION,
        sendGuard: pre.pinnedParams.sendGuard,
      }),
    ])
    // No work is marked started: no other app is called.
    expect(ctx.calls.replies.map((r) => r.name)).toEqual(["mail:reply"])
  })

  it("a change request on a restricted agreement takes its list, and its link is seen by that list alone", async () => {
    const { db, parentId, versionId } = await world()
    const OTHER = "22222222-2222-4222-8222-222222222222"
    await db.update("agreements", parentId, { org_access: "none", acl_user_ids: [OTHER, PERSON] })
    await db.insert("agreement_shares", { agreement_id: parentId, user_id: PERSON, role: "editor" })
    await db.insert("agreement_shares", { agreement_id: parentId, user_id: OTHER, role: "viewer" })
    const pre = (await changeRequestSendPreflight(ctxFor(db), params(parentId, versionId))) as {
      pinnedParams: Record<string, unknown>
    }
    const ctx = ctxFor(db, { approved: true })
    const out = (await changeRequestSend(ctx, {
      ...params(parentId, versionId),
      ...pre.pinnedParams,
    })) as { status: string }
    expect(out.status).toBe("ok")
    const [cr] = changeRequests(db)
    expect(cr?.org_access).toBe("none")
    expect([...((cr?.acl_user_ids as string[]) ?? [])].sort()).toEqual([PERSON, OTHER].sort())
    const list = ((db.tables.get("agreement_shares") ?? []) as Row[])
      .filter((r) => r.agreement_id === cr?.id)
      .map((r) => `${r.user_id}:${r.role}`)
      .sort()
    expect(list).toEqual([`${OTHER}:viewer`, `${PERSON}:editor`].sort())
    expect(ctx.calls.mints[0]?.send.visible_to).toEqual([PERSON, OTHER].sort())
  })

  it("a link the kernel refuses (the client wrote after the card) sends no reply and leaves a draft", async () => {
    const { db, parentId, versionId } = await world()
    const pre = (await changeRequestSendPreflight(ctxFor(db), params(parentId, versionId))) as {
      pinnedParams: Record<string, unknown>
    }
    const ctx = ctxFor(db, {
      approved: true,
      mint: {
        status: "error",
        error: { code: "SEND_GUARD_BLOCKED", message: "The client wrote after this card." },
      },
    })
    const out = (await changeRequestSend(ctx, {
      ...params(parentId, versionId),
      ...pre.pinnedParams,
    })) as {
      status: string
      error: { code: string }
    }
    expect(out.status).toBe("error")
    expect(out.error.code).toBe("SEND_GUARD_BLOCKED")
    expect(ctx.calls.replies).toEqual([])
    expect(changeRequests(db).map((r) => r.status)).toEqual(["draft"])
  })

  it("a reply that fails withdraws the approval link, and the change request stays a draft", async () => {
    const { db, parentId, versionId } = await world()
    const pre = (await changeRequestSendPreflight(ctxFor(db), params(parentId, versionId))) as {
      pinnedParams: Record<string, unknown>
    }
    const ctx = ctxFor(db, {
      approved: true,
      reply: {
        status: "error",
        error: { code: "SEND_GUARD_BLOCKED", message: "The client wrote after this card." },
      },
    })
    const out = (await changeRequestSend(ctx, {
      ...params(parentId, versionId),
      ...pre.pinnedParams,
    })) as {
      status: string
    }
    expect(out.status).toBe("error")
    expect(ctx.calls.revokes).toEqual([
      expect.objectContaining({ target_type: "agreement_version", reason: "withdrawn" }),
    ])
    expect(changeRequests(db).map((r) => r.status)).toEqual(["draft"])
    expect(ctx.calls.emitted).not.toContain("agreement:sent")
  })

  it("an approved call that no longer matches its card's check sends nothing", async () => {
    const { db, parentId, versionId } = await world()
    const ctx = ctxFor(db, { approved: true })
    const out = (await changeRequestSend(ctx, {
      ...params(parentId, versionId),
      sendGuard: { addresses: ["someone@else.example"] },
      guardKey: "other",
    })) as { status: string; error: { code: string } }
    expect(out.error.code).toBe("SEND_GUARD_MISMATCH")
    expect(changeRequests(db)).toEqual([])
    expect(ctx.calls.mints).toEqual([])
  })

  it("a parent that is not signed, or a passage that is not its signed text, is refused before any card", async () => {
    const { db, parentId, versionId } = await world()
    await db.update("agreements", parentId, { status: "sent" })
    const ctx = ctxFor(db, { agent: true })
    const out = (await changeRequestSend(ctx, params(parentId, versionId))) as {
      error: { code: string }
    }
    expect(out.error.code).toBe("PARENT_NOT_SIGNED")
    await db.update("agreements", parentId, { status: "signed" })
    const missing = (await changeRequestSend(
      ctx,
      params(parentId, versionId, { passage: { version_id: versionId, section: "9" } }),
    )) as {
      error: { code: string }
    }
    expect(missing.error.code).toBe("SECTION_NOT_FOUND")
    const noSource = (await changeRequestSend(
      ctx,
      params(parentId, versionId, { hours_source: "" }),
    )) as {
      error: { code: string }
    }
    expect(noSource.error.code).toBe("HOURS_SOURCE_REQUIRED")
    expect(ctx.calls.approvals).toEqual([])
  })
})
