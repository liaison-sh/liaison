// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Freezing, sending and what a decision does, over the in-memory db double and
// a recording double of the kernel's bridge methods: one approval mints every
// link, the next signer's turn needs no card, a version that moved sends
// nothing, a save over a sent version withdraws its links, and a decision on
// another app's record changes nothing here.

import { describe, expect, it } from "bun:test"
import {
  agreementCreate,
  agreementGet,
  agreementPrepare,
  agreementPriceSet,
  agreementUpdate,
} from "./agreements"
import type { AgreementsCtx } from "./ctx"
import { memoryDb, type Row } from "./memory-db.testutil"
import {
  agreementNewLink,
  agreementNewLinkPreflight,
  agreementReminderSend,
  agreementReminderSendPreflight,
  agreementSend,
  agreementSendPreflight,
  agreementVoid,
  agreementVoidPreflight,
  clientActionViewGet,
  decidedReconcile,
  onClientActionDecided,
  onLinksMade,
  resolveSigners,
} from "./send"
import { markSent } from "./sent-state"

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
    client_actions_record: async (p) =>
      "id" in p ? { status: "ok", record: records.get(p.id) } : { status: "ok", links: [] },
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
    const p = {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }, { email: "lea@maison-roux.example", name: "Léa Roux" }],
      order: "sequential" as const,
    }
    const ctx = ctxFor(db, { agent: AGENT, approved: true })
    const out = (await agreementSend(ctx, { ...p, ...(await pinnedFor(db, p)) })) as {
      status: string
      message: string
      client_actions: Array<{ state: string }>
    }
    expect(out.status).toBe("ok")
    // One signer waiting for the one before: "Léa Roux gets a link only after...".
    expect(out.message).toContain("Léa Roux gets a link only after the signer before them")
    expect(ctx.calls.approvals).toEqual([])
    expect(ctx.calls.mints).toHaveLength(1)
    const send = (ctx.calls.mints[0] as { send: { signers: unknown[]; sha256: string } }).send
    expect(send.signers).toHaveLength(2)
    expect(send.sha256).toBe(SHA)
    expect(out.client_actions.map((a) => a.state)).toEqual(["open", "waiting_turn"])
    expect(rowOf(db, "agreements", id).status).toBe("sent")
    expect(ctx.calls.emitted).toEqual(["agreement:sent"])
  })

  it("a restricted agreement's links are minted visible to its list only; an open one's to everyone", async () => {
    const db = memoryDb()
    const { prepared } = await frozen(db)
    const p = {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }],
      order: "sequential" as const,
    }
    const open = ctxFor(db, { agent: AGENT, approved: true })
    await agreementSend(open, { ...p, ...(await pinnedFor(db, p)) })
    const openSend = (open.calls.mints[0] as { send: Record<string, unknown> }).send
    expect(openSend.visible_to).toBeUndefined()

    const db2 = memoryDb()
    const closed = await frozen(db2)
    const row = rowOf(db2, "agreements", closed.id)
    row.org_access = "none"
    const p2 = { ...p, version_id: closed.prepared.version_id, sha256: closed.prepared.sha256 }
    const ctx = ctxFor(db2, { agent: AGENT, approved: true })
    await agreementSend(ctx, { ...p2, ...(await pinnedFor(db2, p2)) })
    const send = (ctx.calls.mints[0] as { send: Record<string, unknown> }).send
    expect(send.visible_to).toEqual([PERSON])
  })

  it("the card of a restricted agreement says a colleague off its list signs by link and reads it only there; an open one's does not", async () => {
    const sentence =
      "Restricted document: a signer who works here but is not on its list signs by their own link and reads it only there."
    const cardOf = async (access: "none" | "editor") => {
      const db = memoryDb()
      const { id, prepared } = await frozen(db)
      rowOf(db, "agreements", id).org_access = access
      const ctx = ctxFor(db, { agent: AGENT })
      await agreementSend(ctx, {
        version_id: prepared.version_id,
        sha256: prepared.sha256,
        signers: [{ contact_id: C1 }],
      })
      const card = ctx.calls.approvals[0] as { summary_detail: { lines: string[] } }
      return card.summary_detail.lines
    }
    expect(await cardOf("none")).toContain(sentence)
    expect(await cardOf("editor")).not.toContain(sentence)
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
    const p = {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }],
    }
    const out = (await agreementSend(ctx, { ...p, ...(await pinnedFor(db, p)) })) as {
      error: { code: string }
    }
    expect(out.error.code).toBe("TIMESTAMP_NOT_CONFIGURED")
    expect(rowOf(db, "agreements", id).status).toBe("draft")
  })
})

/** What the card's preflight pinned for a send, as the approved call carries it. */
async function pinnedFor(db: Db, p: Parameters<typeof agreementSend>[1]) {
  const out = (await agreementSendPreflight(ctxFor(db), p)) as {
    ok: true
    pinnedParams: { sendGuard: Record<string, unknown>; guardKey: string }
  }
  return out.pinnedParams
}

describe("the send check an approved send carries", () => {
  it("the card pins a service-mail check to every signer's address and the send's key", async () => {
    const db = memoryDb()
    const { prepared } = await frozen(db)
    const pin = await pinnedFor(db, {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }, { email: "Lea@Maison-Roux.example", name: "Léa Roux" }],
    })
    expect(pin.sendGuard).toMatchObject({
      v: 1,
      applies: true,
      mode: "plain",
      classification: "service",
      addresses: ["paul@maison-morel.example", "lea@maison-roux.example"],
      contactIds: [C1],
      refs: [],
    })
    expect(pin.guardKey).toBe(
      `${prepared.version_id}:${SHA}:lea@maison-roux.example,paul@maison-morel.example`,
    )
  })

  it("two people who share an address are two signers, and another card than one of them", async () => {
    const db = memoryDb()
    const { prepared } = await frozen(db)
    const of = (signers: Array<{ email: string; name: string }>) =>
      pinnedFor(db, { version_id: prepared.version_id, sha256: prepared.sha256, signers })
    const email = "couple@example.org"
    const both = await of([
      { email, name: "Anne" },
      { email, name: "Jean" },
      { email: "Couple@example.org", name: "jean " },
    ])
    expect(both.sendGuard.addresses).toEqual([email, email])
    expect(both.guardKey).not.toBe((await of([{ email, name: "Anne" }])).guardKey)
    const out = (await resolveSigners(ctxFor(db), [
      { email, name: "Anne" },
      { email, name: "Jean" },
    ])) as { signers: Array<{ name: string }>; sharedAddresses: string[] }
    expect(out.signers.map((s) => s.name)).toEqual(["Anne", "Jean"])
    expect(out.sharedAddresses).toEqual([email])
  })

  it("an approved send passes the pinned check on to the kernel's mint", async () => {
    const db = memoryDb()
    const { prepared } = await frozen(db)
    const p = {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }],
    }
    const pin = await pinnedFor(db, p)
    const ctx = ctxFor(db, { agent: AGENT, approved: true })
    const out = (await agreementSend(ctx, { ...p, ...pin })) as { status: string }
    expect(out.status).toBe("ok")
    const send = (ctx.calls.mints[0] as { send: { send_guard: unknown } }).send
    expect(send.send_guard).toEqual(pin.sendGuard)
  })

  it("an approved send whose signers differ from the card's key mints nothing", async () => {
    const db = memoryDb()
    const { prepared } = await frozen(db)
    const p = {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }],
    }
    const pin = await pinnedFor(db, p)
    const ctx = ctxFor(db, { agent: AGENT, approved: true })
    const out = (await agreementSend(ctx, {
      ...p,
      ...pin,
      signers: [{ email: "someone@else.example" }],
    })) as { error: { code: string; message: string } }
    expect(out.error.code).toBe("SEND_GUARD_MISMATCH")
    expect(out.error.message).toContain("Nothing was sent")
    expect(ctx.calls.mints).toEqual([])
  })

  it("an approved send with no pinned check mints nothing", async () => {
    const db = memoryDb()
    const { prepared } = await frozen(db)
    const ctx = ctxFor(db, { agent: AGENT, approved: true })
    const out = (await agreementSend(ctx, {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }],
    })) as { error: { code: string } }
    expect(out.error.code).toBe("SEND_GUARD_MISMATCH")
    expect(ctx.calls.mints).toEqual([])
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

  it("a contact named with another address than the directory's is refused, and the directory's own address passes", async () => {
    const ctx = ctxFor(memoryDb())
    const out = (await resolveSigners(ctx, [
      { contact_id: C1, email: "someone-else@other.example" },
    ])) as { error: { code: string; message: string } }
    expect(out.error.code).toBe("NOT_THE_CONTACTS_ADDRESS")
    expect(out.error.message).toContain("paul@maison-morel.example")
    expect(out.error.message).toContain("Nothing was sent")
    const same = (await resolveSigners(ctx, [
      { contact_id: C1, email: "Paul@Maison-Morel.example" },
    ])) as { signers: Array<{ email: string; contact_id: string | null }> }
    expect(same.signers).toEqual([
      expect.objectContaining({ contact_id: C1, email: "paul@maison-morel.example" }),
    ])
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
    await db.update("agreements", id, { status: "sent" })
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
    await db.update("agreements", id, { status: "partly_signed" })
    const ctx = ctxFor(db)
    ctx.records.set("ca-1", record({ id: "ca-1", sign_order: 1 }))
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

  it("a signature on an agreement that is not waiting for signatures records nothing and seals nothing", async () => {
    for (const status of ["voided", "declined", "signed"]) {
      const db = memoryDb()
      const { id, prepared } = await frozen(db)
      await db.update("agreements", id, { status })
      const ctx = ctxFor(db)
      ctx.records.set(
        "ca-1",
        record({ group: [{ id: "ca-1", sign_order: null, decision: "signed", open: false }] }),
      )
      const out = (await onClientActionDecided(ctx, {
        data: {
          id: "ca-1",
          target: { app: "agreements", type: "agreement_version", id: prepared.version_id },
        },
      })) as { status: string }
      expect(out.status).toBe("ignored")
      expect(db.tables.get("signature_events") ?? []).toEqual([])
      expect(rowOf(db, "agreements", id).status).toBe(status)
      expect(rowOf(db, "agreement_versions", prepared.version_id).status).toBe("frozen")
    }
  })

  it("a decision on a link a later one replaced counts for nothing", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "partly_signed" })
    const ctx = ctxFor(db)
    ctx.records.set(
      "ca-1",
      record({ decision: "declined", code_verified_at: null, replaced: true }),
    )
    const out = (await onClientActionDecided(ctx, {
      data: {
        id: "ca-1",
        target: { app: "agreements", type: "agreement_version", id: prepared.version_id },
      },
    })) as { status: string }
    expect(out.status).toBe("ignored")
    expect(rowOf(db, "agreements", id).status).toBe("partly_signed")
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

describe("reminders and new links", () => {
  it("a reminder asks the kernel to remail the named open links, held to the card's check", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "partly_signed" })
    const ctx = ctxFor(db, { approved: true })
    ctx.records.set("ca-2", record({ id: "ca-2", target_id: prepared.version_id }))
    const pin = (await agreementReminderSendPreflight(ctx, { client_action_ids: ["ca-2"] })) as {
      pinnedParams: { sendGuard: { addresses: string[] }; guardKey: string }
    }
    expect(pin.pinnedParams.sendGuard.addresses).toEqual(["paul@maison-morel.example"])
    ctx.client_actions_mint = async (p: unknown) => {
      ctx.calls.mints.push(p)
      return { status: "ok", reminded: [{ id: "ca-2", invited_name: "Anne Morel" }] }
    }
    expect(
      (
        (await agreementReminderSend(ctx, { client_action_ids: ["ca-2"] })) as {
          error: { code: string }
        }
      ).error.code,
    ).toBe("SEND_GUARD_MISMATCH")
    const out = (await agreementReminderSend(ctx, {
      client_action_ids: ["ca-2"],
      ...pin.pinnedParams,
    })) as { status: string; message: string }
    expect(out.status).toBe("ok")
    expect(ctx.calls.mints).toEqual([
      { remind: { ids: ["ca-2"], send_guard: pin.pinnedParams.sendGuard } },
    ])
    expect(out.message).toContain("Anne Morel")
    expect(out.message).toContain("stop working")
  })

  it("a reminder for a draft is refused and nothing is mailed", async () => {
    const db = memoryDb()
    const { prepared } = await frozen(db)
    const ctx = ctxFor(db, { approved: true })
    ctx.records.set("ca-1", record({ target_id: prepared.version_id }))
    const out = (await agreementReminderSend(ctx, { client_action_ids: ["ca-1"] })) as {
      error: { code: string }
    }
    expect(out.error.code).toBe("NOT_SENT")
    expect(ctx.calls.mints).toEqual([])
  })

  it("a new link after a decline made without the code reopens the agreement for that signer", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "declined" })
    const ctx = ctxFor(db, { approved: true })
    ctx.records.set(
      "ca-1",
      record({
        decision: "declined",
        code_verified_at: null,
        target_id: prepared.version_id,
        group: [{ id: "ca-1", sign_order: null, decision: "declined", open: false }],
      }),
    )
    ctx.client_actions_mint = async (p: unknown) => {
      ctx.calls.mints.push(p)
      return {
        status: "ok",
        replaced_id: "ca-1",
        action: {
          id: "ca-9",
          status: "open",
          invited_name: "Paul Morel",
          invited_email: "p@x.example",
        },
      }
    }
    const out = (await agreementNewLink(ctx, {
      client_action_id: "ca-1",
      email: "p@x.example",
    })) as { status: string; message: string }
    expect(out.status).toBe("ok")
    expect(ctx.calls.mints).toEqual([
      { new_link: { after: "ca-1", email: "p@x.example", expires_in_days: 14 } },
    ])
    expect(rowOf(db, "agreements", id).status).toBe("sent")
    expect(out.message).toContain("Paul Morel")
  })

  it("a new link for a signed agreement is refused and nothing is minted", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "signed" })
    const ctx = ctxFor(db, { approved: true })
    ctx.records.set("ca-1", record({ target_id: prepared.version_id }))
    const out = (await agreementNewLink(ctx, { client_action_id: "ca-1" })) as {
      error: { code: string }
    }
    expect(out.error.code).toBe("NOT_SENT")
    expect(ctx.calls.mints).toEqual([])
  })

  it("a new link after a decline made with the code is refused at the card", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "declined" })
    const ctx = ctxFor(db, { approved: true })
    ctx.records.set("ca-1", record({ decision: "declined", target_id: prepared.version_id }))
    const out = (await agreementNewLinkPreflight(ctx, { client_action_id: "ca-1" })) as {
      error: { code: string }
    }
    expect(out.error.code).toBe("DECLINED_BY_SIGNER")
  })
})

describe("every signer's signature before the seal", () => {
  const both = [
    { id: "ca-1", sign_order: null, decision: "signed", open: false },
    { id: "ca-2", sign_order: null, decision: "signed", open: false },
  ]

  it("when the first signer's delivery was lost, the last signature writes their event from its record before the version is marked signed", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "sent" })
    const ctx = ctxFor(db)
    ctx.records.set(
      "ca-1",
      record({ id: "ca-1", sign_order: null, typed_name: "Paul Morel", group: both }),
    )
    ctx.records.set(
      "ca-2",
      record({ id: "ca-2", sign_order: null, typed_name: "Anne Morel", group: both }),
    )
    const out = (await onClientActionDecided(ctx, {
      data: {
        id: "ca-2",
        target: { app: "agreements", type: "agreement_version", id: prepared.version_id },
      },
    })) as { status: string }
    expect(out.status).toBe("signed")
    const events = (db.tables.get("signature_events") ?? []) as Row[]
    expect(events.map((e) => e.client_action_id).sort()).toEqual(["ca-1", "ca-2"])
  })

  it("a signer whose decision cannot be read keeps the version waiting, never signed with one signature", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "sent" })
    const ctx = ctxFor(db)
    ctx.records.set("ca-2", record({ id: "ca-2", sign_order: null, group: both }))
    const out = (await onClientActionDecided(ctx, {
      data: {
        id: "ca-2",
        target: { app: "agreements", type: "agreement_version", id: prepared.version_id },
      },
    })) as { status: string }
    expect(out.status).toBe("partly_signed")
    expect(rowOf(db, "agreement_versions", prepared.version_id).status).toBe("frozen")
  })

  it("the reconcile job repairs a version marked signed with fewer events than signers", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "signed" })
    await db.update("agreement_versions", prepared.version_id, { status: "signed" })
    const ctx = ctxFor(db)
    ctx.records.set("ca-1", record({ id: "ca-1", sign_order: null, group: both }))
    ctx.records.set("ca-2", record({ id: "ca-2", sign_order: null, group: both }))
    await db.insert("signature_events", {
      version_id: prepared.version_id,
      client_action_id: "ca-2",
      typed_name: "Anne Morel",
      level: "ses",
      code_verified_at: "2026-11-16",
      signed_at: "2026-11-16",
    })
    const links = both.map((g) => ({
      id: g.id,
      invited_name: "x",
      sign_order: null,
      state: "decided",
    }))
    const read = ctx.client_actions_record
    ctx.client_actions_record = async (p) =>
      "target_id" in p ? { status: "ok", links } : read?.(p)
    const out = (await decidedReconcile(ctx)) as { repaired: number }
    expect(out.repaired).toBe(1)
    const events = (db.tables.get("signature_events") ?? []) as Row[]
    expect(events.map((e) => e.client_action_id).sort()).toEqual(["ca-1", "ca-2"])
  })
})

describe("a decision whose event was lost", () => {
  it("the reconcile job records it once, through the same handler", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "sent" })
    const ctx = ctxFor(db)
    const rec = record({
      sign_order: null,
      group: [{ id: "ca-1", sign_order: null, decision: "signed", open: false }],
    })
    ctx.client_actions_record = async (p) =>
      "target_id" in p
        ? {
            status: "ok",
            links: [{ id: "ca-1", invited_name: "Paul Morel", sign_order: null, state: "decided" }],
          }
        : { status: "ok", record: rec }
    const first = (await decidedReconcile(ctx)) as { handled: number }
    expect(first.handled).toBe(1)
    expect(db.tables.get("signature_events") ?? []).toHaveLength(1)
    expect(rowOf(db, "agreements", id).status).toBe("signed")
    expect(rowOf(db, "agreement_versions", prepared.version_id).status).toBe("signed")
    const again = (await decidedReconcile(ctx)) as { handled: number }
    expect(again.handled).toBe(0)
    expect(db.tables.get("signature_events") ?? []).toHaveLength(1)
  })
})

describe("a send cut off before the agreement left draft", () => {
  type Link = { id: string; state: string; replaced?: boolean; send_size?: number | null }

  /**
   * The kernel lists these links on the version, and answers each one's record. One whole send
   * by default, as the kernel writes them.
   */
  function withLinks(
    ctx: ReturnType<typeof ctxFor>,
    links: Link[],
    records: Record<string, unknown> = {},
  ) {
    ctx.client_actions_record = async (p) =>
      "target_id" in p
        ? {
            status: "ok",
            links: links.map((l) => ({
              invited_name: l.id,
              invited_email: `${l.id}@signers.example`,
              sign_order: null,
              decided_at: null,
              code_verified: false,
              expires_at: "2026-12-01",
              send_size: links.length,
              ...l,
            })),
          }
        : { status: "ok", record: records[p.id] }
    return ctx
  }
  const made = (versionId: string) => ({
    data: { id: "ca-1", target: { app: "agreements", type: "agreement_version", id: versionId } },
  })
  const sentOnce = (ctx: ReturnType<typeof ctxFor>) =>
    ctx.calls.emitted.filter((e) => e === "agreement:sent").length

  it("the kernel's word of its links marks it sent, once", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    const ctx = ctxFor(db)
    expect(await onLinksMade(ctx, made(prepared.version_id))).toEqual({ status: "sent" })
    expect(await onLinksMade(ctx, made(prepared.version_id))).toEqual({ status: "ignored" })
    expect(rowOf(db, "agreements", id).status).toBe("sent")
    expect(sentOnce(ctx)).toBe(1)
  })

  it("links of another app's record, of an unknown version or of a closed agreement change nothing", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    const ctx = ctxFor(db)
    for (const target of [
      { app: "invoicing", type: "agreement_version", id: prepared.version_id },
      { app: "agreements", type: "milestone", id: prepared.version_id },
      { app: "agreements", type: "agreement_version", id: C1 },
    ])
      expect(await onLinksMade(ctx, { data: { id: "ca-1", target } })).toEqual({
        status: "ignored",
      })
    expect(rowOf(db, "agreements", id).status).toBe("draft")
    for (const status of ["partly_signed", "signed", "voided", "declined"]) {
      await db.update("agreements", id, { status })
      await onLinksMade(ctx, made(prepared.version_id))
      expect(rowOf(db, "agreements", id).status).toBe(status)
    }
    expect(sentOnce(ctx)).toBe(0)
  })

  it("links made on a version that is no longer the latest are withdrawn", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await agreementPrepare(ctxFor(db), { id })
    const ctx = ctxFor(db)
    expect(await onLinksMade(ctx, made(prepared.version_id))).toEqual({ status: "replaced" })
    expect(ctx.calls.revokes).toEqual([
      { target_type: "agreement_version", target_id: prepared.version_id, reason: "replaced" },
    ])
    expect(rowOf(db, "agreements", id).status).toBe("draft")
  })

  it("a signature is recorded and moves the agreement on; a decline closes it", async () => {
    for (const [decision, status, events] of [
      ["signed", "partly_signed", 1],
      ["declined", "declined", 0],
    ] as const) {
      const db = memoryDb()
      const { id, prepared } = await frozen(db)
      const ctx = withLinks(
        ctxFor(db),
        [
          { id: "ca-1", state: decision === "signed" ? "decided" : "declined" },
          { id: "ca-2", state: "open" },
        ],
        { "ca-1": record({ decision }) },
      )
      await onClientActionDecided(ctx, made(prepared.version_id))
      expect(rowOf(db, "agreements", id).status).toBe(status)
      expect(db.tables.get("signature_events") ?? []).toHaveLength(events)
      expect(sentOnce(ctx)).toBe(1)
    }
  })

  it("a decision on an older version, or given for another document, stays ignored", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    const ctx = ctxFor(db)
    ctx.records.set("ca-1", record({ target_sha256: "c".repeat(64) }))
    const out = await onClientActionDecided(ctx, made(prepared.version_id))
    expect(out).toEqual({ status: "ignored" })
    ctx.records.set("ca-1", record({}))
    await agreementPrepare(ctxFor(db), { id })
    expect(await onClientActionDecided(ctx, made(prepared.version_id))).toEqual({
      status: "ignored",
    })
    expect(rowOf(db, "agreements", id).status).toBe("draft")
    expect(db.tables.get("signature_events") ?? []).toEqual([])
  })

  it("the reconcile job marks it sent and records the signature it was never told of", async () => {
    const db = memoryDb()
    const { id } = await frozen(db)
    const rec = record({ sign_order: null })
    const ctx = withLinks(
      ctxFor(db),
      [
        { id: "ca-1", state: "decided" },
        { id: "ca-2", state: "open" },
      ],
      { "ca-1": rec },
    )
    expect(await decidedReconcile(ctx)).toMatchObject({ resumed: 1, handled: 1 })
    expect(rowOf(db, "agreements", id).status).toBe("partly_signed")
    expect(db.tables.get("signature_events") ?? []).toHaveLength(1)
    expect(await decidedReconcile(ctx)).toMatchObject({ resumed: 0, handled: 0 })
    expect(sentOnce(ctx)).toBe(1)
  })

  it("the reconcile job leaves a draft whose links are gone, and one never sent", async () => {
    for (const links of [
      [],
      [{ id: "ca-1", state: "revoked" }],
      [{ id: "ca-1", state: "expired" }],
      [{ id: "ca-1", state: "open", replaced: true }],
    ]) {
      const db = memoryDb()
      const { id } = await frozen(db)
      expect(await decidedReconcile(withLinks(ctxFor(db), links))).toMatchObject({ resumed: 0 })
      expect(rowOf(db, "agreements", id).status).toBe("draft")
    }
  })

  it("a change request being sent right now is left to its own run; a stale one is marked", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { kind: "change_request", parent_agreement_id: C1 })
    const ctx = withLinks(ctxFor(db), [{ id: "ca-1", state: "open" }])
    expect(await onLinksMade(ctx, made(prepared.version_id))).toEqual({ status: "ignored" })
    expect(await decidedReconcile(ctx)).toMatchObject({ resumed: 0 })
    await db.update("agreement_versions", prepared.version_id, {
      frozen_at: new Date(Date.now() - 11 * 60_000).toISOString(),
    })
    expect(await decidedReconcile(ctx)).toMatchObject({ resumed: 1 })
    expect(rowOf(db, "agreements", id).status).toBe("sent")
  })

  it("a void withdraws its links; a draft never sent is still nothing to void", async () => {
    const db = memoryDb()
    const { id } = await frozen(db)
    const ctx = withLinks(ctxFor(db, { approved: true }), [{ id: "ca-2", state: "open" }])
    expect(await agreementVoidPreflight(ctx, { id, reason: "Terms changed" })).toEqual({ ok: true })
    const out = (await agreementVoid(ctx, { id, reason: "Terms changed" })) as { status: string }
    expect(out.status).toBe("ok")
    expect(rowOf(db, "agreements", id).status).toBe("voided")
    const other = memoryDb()
    const never = await frozen(other)
    const refused = (await agreementVoid(ctxFor(other, { approved: true }), {
      id: never.id,
      reason: "Terms changed",
    })) as { error: { code: string } }
    expect(refused.error.code).toBe("NOT_SENT")
  })

  it("a save replaces it like a sent version", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    const ctx = withLinks(ctxFor(db), [{ id: "ca-2", state: "open" }])
    const out = (await agreementUpdate(ctx, { id, source })) as { status: string }
    expect(out.status).toBe("ok")
    expect(rowOf(db, "agreement_versions", prepared.version_id).status).toBe("superseded")
    expect(rowOf(db, "agreements", id).status).toBe("draft")
    expect((ctx.calls.revokes[0] as { reason: string }).reason).toBe("replaced")
  })

  it("an answer not recorded yet holds a save and a void, and leaves every link", async () => {
    for (const state of ["decided", "declined"]) {
      const db = memoryDb()
      const { id, prepared } = await frozen(db)
      const ctx = withLinks(ctxFor(db, { approved: true }), [
        { id: "ca-1", state },
        { id: "ca-2", state: "open" },
      ])
      const saved = (await agreementUpdate(ctx, { id, source })) as { error: { code: string } }
      expect(saved.error.code).toBe("ANSWER_BEING_RECORDED")
      expect(rowOf(db, "agreements", id).status).toBe("sent")
      await db.update("agreements", id, { status: "draft" })
      const voided = (await agreementVoid(ctx, { id, reason: "Terms changed" })) as {
        error: { code: string }
      }
      expect(voided.error.code).toBe("ANSWER_BEING_RECORDED")
      expect(ctx.calls.revokes).toEqual([])
      expect(rowOf(db, "agreement_versions", prepared.version_id).status).toBe("frozen")
    }
  })

  it("it is neither prepared nor priced again, and a read says its links stand", async () => {
    const db = memoryDb()
    const { id } = await frozen(db)
    const ctx = withLinks(ctxFor(db), [{ id: "ca-1", state: "open" }])
    const prepared = (await agreementPrepare(ctx, { id })) as { error: { code: string } }
    expect(prepared.error.code).toBe("NOT_A_DRAFT")
    const priced = (await agreementPriceSet(ctx, {
      id,
      price_minor: "100",
      currency: "EUR",
    })) as { error: { code: string } }
    expect(priced.error.code).toBe("NOT_A_DRAFT")
    const read = (await agreementGet(ctx, { id })) as {
      signing_links: Array<{ client_action_id: string }>
      message: string
    }
    expect(read.signing_links.map((l) => l.client_action_id)).toEqual(["ca-1"])
    expect(read.message).toContain("its links stand")
  })

  it("the same send again says what had happened, and never moves a signed agreement back", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    const ctx = ctxFor(db)
    ctx.client_actions_mint = async () => {
      // A signer answered between the kernel's answer and this run's own write.
      await db.update("agreements", id, { status: "signed" })
      return {
        status: "ok",
        group_id: "g",
        already_sent: true,
        actions: [{ id: "ca-1", status: "decided", sign_order: null, invited_name: "Paul Morel" }],
      }
    }
    const out = (await agreementSend(ctx, {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }],
    })) as { status: string; already_sent: boolean; message: string; agreement: { status: string } }
    expect(out).toMatchObject({
      status: "ok",
      already_sent: true,
      agreement: { status: "signed" },
    })
    expect(out.message).toContain("already been sent to Paul Morel")
    expect(rowOf(db, "agreements", id).status).toBe("signed")
    expect(sentOnce(ctx)).toBe(0)
  })

  it("other signers on a version already out are refused, and the agreement is marked sent", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    const ctx = withLinks(ctxFor(db), [{ id: "ca-1", state: "open" }])
    ctx.client_actions_mint = async () => ({
      status: "error",
      error: { code: "ALREADY_SENT", message: "The document was already sent to Anne Morel." },
    })
    const out = (await agreementSend(ctx, {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }],
    })) as { error: { code: string; message: string } }
    expect(out.error.code).toBe("ALREADY_SENT")
    expect(out.error.message).toContain("Anne Morel")
    expect(rowOf(db, "agreements", id).status).toBe("sent")
  })

  it("links made one by one, or a draft changed since, are never taken for a send", async () => {
    for (const why of ["half made", "edited"]) {
      const db = memoryDb()
      const { id, prepared } = await frozen(db)
      const author = rowOf(db, "agreements", id).created_by_user_id
      if (why === "edited") {
        const [draft] = db.tables.get("agreement_drafts") ?? []
        await db.update("agreement_drafts", String(draft?.id), {
          source: { body: { blocks: [{ type: "paragraph", text: "Other terms" }] } },
        })
      }
      const links: Link[] = [
        { id: "ca-1", state: "decided", ...(why === "half made" ? { send_size: null } : {}) },
      ]
      const ctx = withLinks(ctxFor(db, { approved: true }), links, {
        "ca-1": record({
          sign_order: null,
          group: [{ id: "ca-1", sign_order: null, decision: "signed", open: false }],
        }),
      })
      const told: Array<{ why: string; personIds: string[] }> = []
      ctx.emit = async (e) => {
        ctx.calls.emitted.push(`${e.entity}:${e.action}`)
        if (e.action === "send_unfinished") told.push(e.data as (typeof told)[number])
        return null
      }
      // The signer's answer is kept, and nothing is signed or sealed on it.
      expect(await onClientActionDecided(ctx, made(prepared.version_id))).toEqual({
        status: "kept",
      })
      expect(db.tables.get("signature_events") ?? []).toHaveLength(1)
      for (let i = 0; i < 2; i++)
        expect(await decidedReconcile(ctx)).toMatchObject({ resumed: 0, handled: 0 })
      expect(rowOf(db, "agreements", id).status).toBe("draft")
      expect(rowOf(db, "agreement_versions", prepared.version_id).status).toBe("frozen")
      expect(sentOnce(ctx)).toBe(0)
      // Its author is told once, in words that say what happened.
      expect(told).toHaveLength(1)
      expect(told[0]?.personIds).toContain(author as string)
      const words = why === "edited" ? "draft changed after version 1" : "may have stopped before"
      expect(told[0]?.why).toContain(words)
      const read = (await agreementGet(ctx, { id })) as { message: string }
      expect(read.message).toContain(words)
      expect(read.message).not.toContain("reads as sent in a few minutes")
      // Other signers on it: refused, and it stays a draft.
      const mint = ctx.client_actions_mint
      ctx.client_actions_mint = async () => ({
        status: "error",
        error: { code: "ALREADY_SENT", message: "The document was already sent to Paul." },
      })
      const send = { version_id: prepared.version_id, sha256: prepared.sha256 }
      const card = (await agreementSendPreflight(ctx, {
        ...send,
        signers: [{ contact_id: C1 }, { email: "x@signers.example" }],
      })) as { pinnedParams: object }
      const more = (await agreementSend(ctx, {
        ...send,
        signers: [{ contact_id: C1 }, { email: "x@signers.example" }],
        ...card.pinnedParams,
      })) as { error: { code: string; message: string } }
      expect(more.error.code).toBe("ALREADY_SENT")
      expect(more.error.message).toContain("stays a draft")
      expect(rowOf(db, "agreements", id).status).toBe("draft")
      ctx.client_actions_mint = mint
      // The recorded answer holds nothing: the person voids it, and the signature stays.
      const out = (await agreementVoid(ctx, { id, reason: "Sent by half" })) as { status: string }
      expect(out.status).toBe("ok")
      expect(db.tables.get("signature_events") ?? []).toHaveLength(1)
    }
  })

  it("an unfinished send says so to nobody off a restricted agreement's list", async () => {
    const db = memoryDb()
    const { id } = await frozen(db)
    await db.update("agreements", id, { org_access: "none" })
    for (const s of db.tables.get("agreement_shares") ?? [])
      await db.update("agreement_shares", s.id, { removed_at: "2026-11-16" })
    const ctx = withLinks(ctxFor(db), [{ id: "ca-1", state: "open", send_size: null }])
    let people: unknown
    ctx.emit = async (e) => {
      if (e.action === "send_unfinished") people = (e.data as { personIds: string[] }).personIds
      return null
    }
    await decidedReconcile(ctx)
    expect(people).toEqual([])
  })

  it("an answer not recorded yet holds a save and a void until it is, whatever the agreement reads as", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "sent" })
    const ctx = withLinks(
      ctxFor(db, { approved: true }),
      [
        { id: "ca-1", state: "decided" },
        { id: "ca-2", state: "open" },
      ],
      { "ca-1": record({ sign_order: null }) },
    )
    const ask = async () => [
      ((await agreementVoid(ctx, { id, reason: "No" })) as { error?: { code: string } }).error
        ?.code,
      ((await agreementUpdate(ctx, { id, source })) as { error?: { code: string } }).error?.code,
    ]
    for (let i = 0; i < 3; i++)
      expect(await ask()).toEqual(["ANSWER_BEING_RECORDED", "ANSWER_BEING_RECORDED"])
    expect(ctx.calls.revokes).toEqual([])
    expect(await decidedReconcile(ctx)).toMatchObject({ handled: 1 })
    expect(rowOf(db, "agreements", id).status).toBe("partly_signed")
    expect((await ask())[0]).toBeUndefined()
    expect(rowOf(db, "agreement_versions", prepared.version_id).status).toBe("frozen")
    expect(db.tables.get("signature_events") ?? []).toHaveLength(1)
  })

  it("a save over a partly signed one is held by the second answer only until it is recorded", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "partly_signed" })
    await db.insert("signature_events", {
      version_id: prepared.version_id,
      client_action_id: "ca-1",
    })
    const ctx = withLinks(ctxFor(db), [
      { id: "ca-1", state: "decided" },
      { id: "ca-2", state: "declined" },
    ])
    const held = (await agreementUpdate(ctx, { id, source })) as { error: { message: string } }
    expect(held.error.message).toContain("ca-2 answered")
    const free = withLinks(ctxFor(db), [
      { id: "ca-1", state: "decided" },
      { id: "ca-2", state: "declined", replaced: true },
    ])
    expect(((await agreementUpdate(free, { id, source })) as { status: string }).status).toBe("ok")
    expect(rowOf(db, "agreement_versions", prepared.version_id).status).toBe("superseded")
  })

  it("the job reads no version's text, takes the newest first, and one bad draft stops no other", async () => {
    const db = memoryDb()
    const first = await frozen(db)
    const second = await frozen(db)
    const third = await frozen(db)
    await db.update("agreements", third.id, { status: "sent" })
    const ctx = withLinks(
      ctxFor(db),
      [
        { id: "ca-1", state: "decided" },
        { id: "ca-2", state: "open" },
      ],
      { "ca-1": record({ sign_order: null, target_id: third.prepared.version_id }) },
    )
    const reads: Array<{ entity: string; opts: Record<string, unknown> }> = []
    const inner = ctx.db
    const bad = rowOf(db, "agreements", first.id).number
    ctx.db = {
      ...inner,
      findMany: async (entity: string, opts: Record<string, unknown>) => {
        reads.push({ entity, opts })
        return inner.findMany(entity, opts as never)
      },
      updateMany: async (entity: string, o: { where: Record<string, unknown> }) => {
        if (o.where.number === bad) throw new Error("not now")
        return inner.updateMany(entity, o as never)
      },
    } as unknown as typeof ctx.db
    const out = (await decidedReconcile(ctx)) as { resumed: number; failed: number }
    expect(out).toMatchObject({ resumed: 1, failed: 1 })
    expect(rowOf(db, "agreements", first.id).status).toBe("draft")
    expect(rowOf(db, "agreements", second.id).status).toBe("sent")
    expect(rowOf(db, "agreements", third.id).status).toBe("partly_signed")
    const versions = reads.filter((r) => r.entity === "agreement_versions")
    expect(versions.length).toBeGreaterThan(0)
    for (const v of versions) {
      const select = (v.opts.select ?? ["everything"]) as string[]
      expect(
        select.filter((c) => ["everything", "source", "source_text", "pages"].includes(c)),
      ).toEqual([])
    }
    const newest = versions.find(
      (v) => (v.opts.where as { status?: string }).status === "frozen" && v.opts.limit === 500,
    )
    expect(newest?.opts.orderBy).toEqual({ frozen_at: "desc" })
  })

  it("a version prepared while the one before was being sent: nothing is called sent", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    const ctx = ctxFor(db, { approved: true })
    const mint = ctx.client_actions_mint
    ctx.client_actions_mint = async (p: unknown) => {
      // It is frozen between the send's own check and its links.
      await agreementPrepare(ctxFor(db), { id })
      return mint?.(p)
    }
    const signers = [{ contact_id: C1 }]
    const card = (await agreementSendPreflight(ctx, {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers,
    })) as { pinnedParams: object }
    const out = (await agreementSend(ctx, {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers,
      ...card.pinnedParams,
    })) as { error: { code: string; message: string } }
    expect(out.error.code).toBe("VERSION_CHANGED")
    expect(out.error.message).toContain("version 2")
    expect(ctx.calls.revokes).toEqual([
      { target_type: "agreement_version", target_id: prepared.version_id, reason: "replaced" },
    ])
    expect(rowOf(db, "agreements", id).status).toBe("draft")
  })

  it("sent by the run that was cut off and replaced by a version nobody sent: a draft again, its answers kept, its people told", async () => {
    for (const seenBy of ["the word of the links", "the job"]) {
      const db = memoryDb()
      const { id, prepared } = await frozen(db)
      await agreementPrepare(ctxFor(db), { id })
      await db.update("agreements", id, { status: "sent" })
      const ctx = ctxFor(db)
      const told: string[] = []
      ctx.emit = async (e) => {
        if (e.action === "send_unfinished") told.push((e.data as { why: string }).why)
        return null
      }
      ctx.client_actions_record = async (p) =>
        "target_id" in p
          ? {
              status: "ok",
              links:
                p.target_id === prepared.version_id
                  ? [
                      { id: "ca-1", invited_name: "Paul", sign_order: null, state: "decided" },
                      { id: "ca-2", invited_name: "Anne", sign_order: null, state: "open" },
                    ]
                  : [],
            }
          : { status: "ok", record: record({ id: p.id, sign_order: null }) }
      if (seenBy === "the job") await decidedReconcile(ctx)
      else
        expect(await onLinksMade(ctx, made(prepared.version_id))).toEqual({ status: "replaced" })
      expect(rowOf(db, "agreements", id).status).toBe("draft")
      expect(rowOf(db, "agreement_versions", prepared.version_id).status).toBe("superseded")
      const events = (db.tables.get("signature_events") ?? []) as Row[]
      expect(events.map((e) => e.client_action_id)).toEqual(["ca-1"])
      expect(told).toHaveLength(1)
      expect(told[0]).toContain("Send version 2")
      // The new version can be sent, and is not told it was.
      const v2 = (db.tables.get("agreement_versions") ?? []).find((v) => v.number === 2) as Row
      const ready = (await agreementSendPreflight(ctx, {
        version_id: v2.id,
        sha256: SHA,
        signers: [{ contact_id: C1 }],
      })) as { ok?: boolean }
      expect(ready.ok).toBe(true)
    }
  })

  it("a sent agreement whose newest version never had a link can send it; one that has is refused", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "sent" })
    const ask = async (links: Link[]) =>
      (await agreementSendPreflight(withLinks(ctxFor(db), links), {
        version_id: prepared.version_id,
        sha256: prepared.sha256,
        signers: [{ contact_id: C1 }],
      })) as { ok?: boolean; error?: { code: string } }
    expect((await ask([])).ok).toBe(true)
    expect((await ask([{ id: "ca-1", state: "revoked" }])).error?.code).toBe("ALREADY_SENT")
    const blind = ctxFor(db)
    blind.client_actions_record = undefined
    const refused = (await agreementSendPreflight(blind, {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }],
    })) as { error?: { code: string } }
    expect(refused.error?.code).toBe("ALREADY_SENT")
  })

  it("a signature on the version before the one that is out counts for nothing on it", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await agreementPrepare(ctxFor(db), { id })
    await db.update("agreements", id, { status: "sent" })
    const ctx = ctxFor(db)
    ctx.records.set(
      "ca-1",
      record({
        sign_order: null,
        group: [{ id: "ca-1", sign_order: null, decision: "signed", open: false }],
      }),
    )
    expect(await onClientActionDecided(ctx, made(prepared.version_id))).toEqual({
      status: "ignored",
    })
    expect(rowOf(db, "agreements", id).status).toBe("sent")
    expect(rowOf(db, "agreement_versions", prepared.version_id).status).toBe("frozen")
  })

  it("links that arrive on an agreement voided meanwhile are withdrawn", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "voided" })
    const ctx = ctxFor(db)
    expect(await onLinksMade(ctx, made(prepared.version_id))).toEqual({ status: "withdrawn" })
    expect(ctx.calls.revokes).toEqual([
      { target_type: "agreement_version", target_id: prepared.version_id, reason: "sender_voided" },
    ])
  })

  it("marked sent only itself: not another parent's CR-1, not a version a save replaced meanwhile", async () => {
    const db = memoryDb()
    const cr = async (parent: string) =>
      (
        await db.insert("agreements", {
          number: "CR-1",
          kind: "change_request",
          status: "draft",
          parent_agreement_id: parent,
        })
      ).id
    const mine = await cr(C1)
    const other = await cr(C2)
    const v = (await db.insert("agreement_versions", { number: 1, status: "frozen" })).id
    const row = {
      id: mine,
      number: "CR-1",
      kind: "change_request",
      status: "draft",
      parent_agreement_id: C1,
    }
    const ctx = ctxFor(db)
    expect(await markSent(ctx, row, { id: v, number: 1 })).toBe(true)
    expect(rowOf(db, "agreements", mine).status).toBe("sent")
    expect(rowOf(db, "agreements", other).status).toBe("draft")
    await db.update("agreements", mine, { status: "draft" })
    await db.update("agreement_versions", v, { status: "superseded" })
    expect(await markSent(ctx, row, { id: v, number: 1 })).toBe(false)
    expect(rowOf(db, "agreements", mine).status).toBe("draft")
    expect(sentOnce(ctx)).toBe(1)
  })

  it("a locked link stands; a signed link of a replaced version does not make its draft sent", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    const locked = withLinks(ctxFor(db), [{ id: "ca-1", state: "locked" }])
    expect(await decidedReconcile(locked)).toMatchObject({ resumed: 1 })
    await db.update("agreements", id, { status: "draft" })
    await db.update("agreement_versions", prepared.version_id, { status: "superseded" })
    const signed = withLinks(ctxFor(db), [{ id: "ca-1", state: "decided" }])
    expect(await decidedReconcile(signed)).toMatchObject({ resumed: 0 })
    expect(rowOf(db, "agreements", id).status).toBe("draft")
    const next = (await agreementPrepare(signed, { id })) as { status: string }
    expect(next.status).toBe("ok")
  })

  it("the same send asked again names the mails that failed or have not left", async () => {
    const db = memoryDb()
    const { prepared } = await frozen(db)
    const ctx = ctxFor(db)
    ctx.client_actions_mint = async () => ({
      status: "ok",
      group_id: "g",
      already_sent: true,
      actions: (["sent", "failed", "owed"] as const).map((mail, i) => ({
        id: `ca-${i}`,
        status: "open",
        sign_order: null,
        invited_name: `${mail} signer`,
        mail,
      })),
    })
    const out = (await agreementSend(ctx, {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }],
    })) as { message: string }
    expect(out.message).toContain("The mail to failed signer failed, so nobody holds that link")
    expect(out.message).toContain("The mail to owed signer has not left yet")
  })

  it("a send whose state could not be written says the links went out", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    const ctx = ctxFor(db)
    ctx.db = {
      ...db,
      updateMany: async () => {
        throw new Error("connection lost")
      },
    } as unknown as typeof ctx.db
    const out = (await agreementSend(ctx, {
      version_id: prepared.version_id,
      sha256: prepared.sha256,
      signers: [{ contact_id: C1 }],
    })) as { status: string; message: string; agreement: { status: string } }
    expect(out.status).toBe("ok")
    expect(out.agreement.status).toBe("draft")
    expect(out.message).toContain("was sent")
    expect(out.message).toContain("its state follows")
    expect(rowOf(db, "agreements", id).status).toBe("draft")
    await onLinksMade(ctxFor(db), made(prepared.version_id))
    expect(rowOf(db, "agreements", id).status).toBe("sent")
  })

  it("a reminder answers who was mailed minutes ago, and mails them nothing", async () => {
    const db = memoryDb()
    const { id, prepared } = await frozen(db)
    await db.update("agreements", id, { status: "sent" })
    const ctx = ctxFor(db)
    ctx.records.set("ca-1", record({ target_id: prepared.version_id }))
    ctx.client_actions_mint = async () => ({
      status: "ok",
      reminded: [],
      recently_mailed: [{ id: "ca-1", invited_name: "Paul Morel" }],
    })
    const out = (await agreementReminderSend(ctx, { client_action_ids: ["ca-1"] })) as {
      status: string
      message: string
    }
    expect(out.status).toBe("ok")
    expect(out.message).toContain("nothing was mailed now")
    expect(out.message).toContain("Paul Morel got a fresh link minutes ago")
  })
})
