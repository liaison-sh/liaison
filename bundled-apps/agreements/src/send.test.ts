// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Freezing, sending and what a decision does, over the in-memory db double and
// a recording double of the kernel's bridge methods: one approval mints every
// link, the next signer's turn needs no card, a version that moved sends
// nothing, a save over a sent version withdraws its links, and a decision on
// another app's record changes nothing here.

import { describe, expect, it } from "bun:test"
import { agreementCreate, agreementPrepare, agreementUpdate } from "./agreements"
import type { AgreementsCtx } from "./ctx"
import { memoryDb, type Row } from "./memory-db.testutil"
import {
  agreementSend,
  agreementVoid,
  clientActionViewGet,
  onClientActionDecided,
  resolveSigners,
} from "./send"

const PERSON = "11111111-1111-4111-8111-111111111111"
const AGENT = "33333333-3333-4333-8333-333333333333"
const C1 = "aaaaaaaa-0000-4000-8000-000000000001"
const C2 = "aaaaaaaa-0000-4000-8000-000000000002"
const C3 = "aaaaaaaa-0000-4000-8000-000000000003"
const SHA = "b".repeat(64)

type Db = ReturnType<typeof memoryDb>

interface Calls {
  approvals: unknown[]
  mints: unknown[]
  revokes: unknown[]
  emitted: string[]
}

function ctxFor(
  db: Db,
  opts: { agent?: string | null; approved?: boolean; render?: Record<string, unknown> } = {},
) {
  const calls: Calls = { approvals: [], mints: [], revokes: [], emitted: [] }
  const contacts: Record<string, Record<string, unknown>> = {
    [C1]: { id: C1, name: "Paul Morel", email: "paul@maison-morel.example" },
    [C2]: { id: C2, name: "Anne Morel", email: "paul@maison-morel.example" },
    [C3]: { id: C3, name: "Jean Petit", email: null },
  }
  const records = new Map<string, Record<string, unknown>>()
  const ctx: AgreementsCtx & { calls: Calls; records: typeof records } = {
    orgId: "org",
    userId: PERSON,
    db,
    turn: { get: async () => ({ agentId: opts.agent ?? null }) },
    kernel: {
      caller: async () => ({ kind: "person", userId: PERSON, roleIds: [], holds: {} }),
      findByIds: async (_e: string, ids: string[]) =>
        ids.flatMap((id) => (contacts[id] ? [contacts[id]] : [])),
    } as unknown as AgreementsCtx["kernel"],
    ...(opts.approved ? { approval: { id: "approved" } } : {}),
    requestApproval: async (req) => {
      calls.approvals.push(req)
      return { approval_id: `card-${calls.approvals.length}` }
    },
    rich_text_render: async () => ({
      status: "ok",
      bytesBase64: "JVBERi0=",
      sha256: SHA,
      byteSize: 5,
      pageCount: 2,
      blanks: [],
      sourceText: "Scope of work",
      textMatches: true,
      ...opts.render,
    }),
    files_importAttachment: async () => ({ id: "55555555-5555-4555-8555-555555555555" }),
    client_actions_mint: async (p: unknown) => {
      calls.mints.push(p)
      const send = (p as { send?: { signers: Array<{ name: string }>; order: string } }).send
      if (!send) return { status: "ok", opened_id: "next" }
      return {
        status: "ok",
        group_id: "g",
        actions: send.signers.map((s, i) => ({
          id: `ca-${i + 1}`,
          status: send.order === "sequential" && i > 0 ? "waiting_turn" : "open",
          sign_order: send.order === "sequential" ? i + 1 : null,
          invited_name: s.name,
          signer_is_staff: false,
          mail_queued: !(send.order === "sequential" && i > 0),
        })),
      }
    },
    client_actions_revoke: async (p) => {
      calls.revokes.push(p)
      return { status: "ok", revoked_ids: ["ca-1"] }
    },
    client_actions_record: async ({ id }) => ({ status: "ok", record: records.get(id) }),
    emit: async (e) => {
      calls.emitted.push(`${e.entity}:${e.action}`)
      return null
    },
    today: "2026-11-16",
    calls,
    records,
  }
  return ctx
}

const source = { body: { blocks: [{ type: "paragraph", text: "Scope of work" }] } }

async function frozen(db: Db, fit_tag?: string) {
  const ctx = ctxFor(db)
  const created = (await agreementCreate(ctx, {
    kind: "nda",
    title: "Mutual NDA",
    source,
    ...(fit_tag ? { fit_tag } : {}),
  })) as { agreement: { id: string } }
  const id = created.agreement.id
  const prepared = (await agreementPrepare(ctx, { id })) as {
    status: string
    version_id: string
    sha256: string
  }
  return { id, prepared }
}

const rowOf = (db: Db, table: string, id: string) =>
  db.tables.get(table)?.find((r) => r.id === id) as Row

describe("freezing a draft", () => {
  it("stores the version with the rendered file's hash and the source's text", async () => {
    const db = memoryDb()
    const { prepared } = await frozen(db)
    expect(prepared.status).toBe("ok")
    expect(rowOf(db, "agreement_versions", prepared.version_id)).toMatchObject({
      number: 1,
      sha256: SHA,
      file_id: "55555555-5555-4555-8555-555555555555",
      source_text: "Scope of work",
      status: "frozen",
    })
  })

  it("a blank field refuses the freeze and names it", async () => {
    const db = memoryDb()
    const ctx = ctxFor(db, { render: { blanks: [{ path: "client.name", label: "Client name" }] } })
    const id = (
      (await agreementCreate(ctx, { kind: "nda", title: "NDA", source })) as {
        agreement: { id: string }
      }
    ).agreement.id
    const out = (await agreementPrepare(ctx, { id })) as {
      error: { code: string; message: string }
    }
    expect(out.error.code).toBe("BLANK_FIELD")
    expect(out.error.message).toContain("Client name")
    expect(db.tables.get("agreement_versions") ?? []).toEqual([])
  })

  it("a drawn text that differs from the source refuses the freeze", async () => {
    const db = memoryDb()
    const ctx = ctxFor(db, { render: { textMatches: false } })
    const id = (
      (await agreementCreate(ctx, { kind: "nda", title: "NDA", source })) as {
        agreement: { id: string }
      }
    ).agreement.id
    const out = (await agreementPrepare(ctx, { id })) as { error: { code: string } }
    expect(out.error.code).toBe("FREEZE_TEXT_MISMATCH")
    expect(db.tables.get("agreement_versions") ?? []).toEqual([])
  })
})

describe("sending for signature", () => {
  it("an agent's send parks one card and mints nothing", async () => {
    const db = memoryDb()
    const { prepared } = await frozen(db)
    const ctx = ctxFor(db, { agent: AGENT })
    const out = (await agreementSend(ctx, {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }],
    })) as { status: string }
    expect(out.status).toBe("pending_approval")
    expect(ctx.calls.approvals).toHaveLength(1)
    expect(ctx.calls.mints).toEqual([])
  })

  it("one approval of a two-signer send mints every link it should, and no second card appears", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    const ctx = ctxFor(db, { agent: AGENT, approved: true })
    const out = (await agreementSend(ctx, {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }, { email: "lea@maison-roux.example", name: "Léa Roux" }],
      order: "sequential",
    })) as { status: string; client_actions: Array<{ state: string }> }
    expect(out.status).toBe("ok")
    expect(ctx.calls.approvals).toEqual([])
    expect(ctx.calls.mints).toHaveLength(1)
    const send = (ctx.calls.mints[0] as { send: { signers: unknown[]; sha256: string } }).send
    expect(send.signers).toHaveLength(2)
    expect(send.sha256).toBe(SHA)
    expect(out.client_actions.map((a) => a.state)).toEqual(["open", "waiting_turn"])
    expect(rowOf(db, "agreements", id).status).toBe("sent")
    expect(ctx.calls.emitted).toEqual(["agreement:sent"])
  })

  it("a change between card and approval fails and nothing is sent", async () => {
    const db = memoryDb()
    const { prepared } = await frozen(db)
    const ctx = ctxFor(db, { approved: true })
    const out = (await agreementSend(ctx, {
      version_id: prepared.version_id,
      sha256: "c".repeat(64),
      signers: [{ contact_id: C1 }],
    })) as { error: { code: string } }
    expect(out.error.code).toBe("VERSION_CHANGED")
    expect(ctx.calls.mints).toEqual([])
  })

  it("a document this signature does not fit is refused at send", async () => {
    const db = memoryDb()
    const { id } = await frozen(db)
    await db.update("agreements", id, { fit_tag: "guarantee" })
    const v = db.tables.get("agreement_versions")?.[0] as Row
    const ctx = ctxFor(db, { approved: true })
    const out = (await agreementSend(ctx, {
      version_id: v.id,
      sha256: SHA,
      signers: [{ contact_id: C1 }],
    })) as { error: { code: string } }
    expect(out.error.code).toBe("SIGNATURE_DOES_NOT_FIT")
    expect(ctx.calls.mints).toEqual([])
  })

  it("a refusal from the kernel's mint (no timestamp authority) is passed on and the agreement stays a draft", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    const ctx = ctxFor(db, { approved: true })
    ctx.client_actions_mint = async () => ({
      status: "error",
      error: { code: "TIMESTAMP_NOT_CONFIGURED", message: "No timestamp authority" },
    })
    const out = (await agreementSend(ctx, {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }],
    })) as { error: { code: string } }
    expect(out.error.code).toBe("TIMESTAMP_NOT_CONFIGURED")
    expect(rowOf(db, "agreements", id).status).toBe("draft")
  })
})

describe("signers", () => {
  it("the same contact twice is one signer; two contacts on one address stay two, and the card says so", async () => {
    const ctx = ctxFor(memoryDb())
    const out = (await resolveSigners(ctx, [
      { contact_id: C1 },
      { contact_id: C1 },
      { contact_id: C2 },
    ])) as { signers: unknown[]; sharedAddresses: string[] }
    expect(out.signers).toHaveLength(2)
    expect(out.sharedAddresses).toEqual(["paul@maison-morel.example"])
  })

  it("a contact with no email blocks the send, by name", async () => {
    const ctx = ctxFor(memoryDb())
    const out = (await resolveSigners(ctx, [{ contact_id: C1 }, { contact_id: C3 }])) as {
      error: { code: string; message: string }
    }
    expect(out.error.code).toBe("SIGNER_HAS_NO_EMAIL")
    expect(out.error.message).toContain("Jean Petit")
  })
})

function record(over: Record<string, unknown>) {
  return {
    id: "ca-1",
    decision: "signed",
    decided_at: "2026-11-16",
    invited_email: "paul@maison-morel.example",
    invited_name: "Paul Morel",
    invited_by: "Claire",
    sign_order: 1,
    contact_id: C1,
    signer_user_id: null,
    typed_name: "Paul Morel",
    capacity: "Director",
    words_shown: "I sign NDA",
    words_lang: "en",
    required_phrase: null,
    typed_phrase: null,
    code_verified_at: "2026-11-16",
    document_shown_at: "2026-11-16",
    reached_end_at: null,
    ip: "192.0.2.1",
    user_agent: "test",
    target_sha256: SHA,
    group: [
      { id: "ca-1", sign_order: 1, decision: "signed", open: false },
      { id: "ca-2", sign_order: 2, decision: null, open: true },
    ],
    ...over,
  }
}

describe("a decision", () => {
  it("signer 2's link is minted by the decided handler with no card", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    const ctx = ctxFor(db)
    ctx.records.set("ca-1", record({}))
    const event = {
      data: {
        id: "ca-1",
        decision: "signed",
        target: { app: "agreements", type: "agreement_version", id: prepared.version_id },
      },
    }
    const out = (await onClientActionDecided(ctx, event)) as { status: string }
    expect(out.status).toBe("partly_signed")
    expect(ctx.calls.approvals).toEqual([])
    expect(ctx.calls.mints).toEqual([{ next_turn_after: "ca-1" }])
    expect(rowOf(db, "agreements", id).status).toBe("partly_signed")
    const events = db.tables.get("signature_events") ?? []
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      client_action_id: "ca-1",
      typed_name: "Paul Morel",
      consent_words: "I sign NDA",
      document_sha256: SHA,
      level: "ses",
    })
    // The same decision delivered twice writes one signature event.
    await onClientActionDecided(ctx, event)
    expect(db.tables.get("signature_events") ?? []).toHaveLength(1)
  })

  it("the last signature marks the version signed", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    const ctx = ctxFor(db)
    ctx.records.set(
      "ca-2",
      record({
        id: "ca-2",
        sign_order: 2,
        group: [
          { id: "ca-1", sign_order: 1, decision: "signed", open: false },
          { id: "ca-2", sign_order: 2, decision: "signed", open: false },
        ],
      }),
    )
    const out = (await onClientActionDecided(ctx, {
      data: {
        id: "ca-2",
        target: { app: "agreements", type: "agreement_version", id: prepared.version_id },
      },
    })) as { status: string }
    expect(out.status).toBe("signed")
    expect(rowOf(db, "agreement_versions", prepared.version_id).status).toBe("signed")
    expect(rowOf(db, "agreements", id).status).toBe("signed")
  })

  it("a decline writes no signature and closes the agreement as declined", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "sent" })
    const ctx = ctxFor(db)
    ctx.records.set("ca-1", record({ decision: "declined" }))
    await onClientActionDecided(ctx, {
      data: {
        id: "ca-1",
        target: { app: "agreements", type: "agreement_version", id: prepared.version_id },
      },
    })
    expect(db.tables.get("signature_events") ?? []).toEqual([])
    expect(rowOf(db, "agreements", id).status).toBe("declined")
    expect(ctx.calls.emitted).toEqual(["agreement:declined"])
  })

  it("a decision on another app's record changes no agreements row", async () => {
    const db = memoryDb()
    await frozen(db)
    const before = JSON.stringify([...db.tables])
    const ctx = ctxFor(db)
    const out = (await onClientActionDecided(ctx, {
      data: {
        id: "q-1",
        decision: "accepted",
        target: { app: "invoicing", type: "document", id: C1 },
      },
    })) as { status: string }
    expect(out.status).toBe("ignored")
    expect(JSON.stringify([...db.tables])).toBe(before)
    expect(ctx.calls.mints).toEqual([])
  })
})

describe("after a send", () => {
  it("an agent's save over a sent version revokes its links without parking", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "sent" })
    const ctx = ctxFor(db, { agent: AGENT })
    const out = (await agreementUpdate(ctx, { id, source })) as { status: string; message: string }
    expect(out.status).toBe("ok")
    expect(ctx.calls.approvals).toEqual([])
    expect(ctx.calls.revokes).toEqual([
      { target_type: "agreement_version", target_id: prepared.version_id, reason: "replaced" },
    ])
    expect(rowOf(db, "agreement_versions", prepared.version_id).status).toBe("superseded")
    expect(rowOf(db, "agreements", id).status).toBe("draft")
    // A person reads the agent's text; the next freeze is version 2.
    await agreementUpdate(ctxFor(db), { id, source })
    const next = (await agreementPrepare(ctxFor(db), { id })) as { version: number }
    expect(next.version).toBe(2)
  })

  it("a void needs a reason, withdraws every open link, and keeps signatures", async () => {
    const db = memoryDb()
    const { id } = await frozen(db)
    await db.update("agreements", id, { status: "partly_signed" })
    const ctx = ctxFor(db, { approved: true })
    expect(
      ((await agreementVoid(ctx, { id, reason: " " })) as { error: { code: string } }).error.code,
    ).toBe("REASON_REQUIRED")
    const out = (await agreementVoid(ctx, { id, reason: "Terms changed" })) as { status: string }
    expect(out.status).toBe("ok")
    expect((ctx.calls.revokes[0] as { reason: string }).reason).toBe("sender_voided")
    expect(rowOf(db, "agreements", id)).toMatchObject({
      status: "voided",
      void_reason: "Terms changed",
    })
  })

  it("the person outside is shown the frozen version and its fingerprint", async () => {
    const db = memoryDb()
    const { prepared } = await frozen(db)
    const view = (await clientActionViewGet(ctxFor(db), {
      targetType: "agreement_version",
      targetId: prepared.version_id,
    })) as { sha256: string; text: string; title: string }
    expect(view.sha256).toBe(SHA)
    expect(view.text).toBe("Scope of work")
    expect(view.title).toContain("Mutual NDA")
  })
})
