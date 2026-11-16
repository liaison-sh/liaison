// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agreements tools over an in-memory db double: the order of the list, the price only a
// person sets, the checks prepare runs, templates whose sent text never moves, the access
// list's rules, and the levels a signature row may carry.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { DbBatchOp, DbBatchSpec, DbClient } from "@liaison/app-sdk"
import manifest from "../app.manifest.json"
import {
  agreementCreate,
  agreementPrepare,
  agreementPriceSet,
  agreementsSearch,
  agreementUpdate,
  orderByNeed,
} from "./agreements"
import type { AgreementsCtx } from "./ctx"
import { templateSave } from "./templates"

type Row = Record<string, unknown> & { id: string }

function memoryDb(): DbClient & { tables: Map<string, Row[]> } {
  const tables = new Map<string, Row[]>()
  const t = (e: string) => {
    if (!tables.has(e)) tables.set(e, [])
    return tables.get(e) as Row[]
  }
  const matches = (r: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([k, v]) => r[k] === v)
  const seq = new Map<string, number>()
  const resolve = (
    v: unknown,
    refs: Record<string, Row>,
    s: { value: number; formatted?: string } | undefined,
  ): unknown => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      if (typeof o.$ref === "string") return refs[o.$ref]?.id
      if (o.$seq === "formatted") return s?.formatted
      if (o.$seq === "value") return s?.value
    }
    return v
  }
  const db = {
    tables,
    async findMany(entity: string, opts?: { where?: Record<string, unknown>; limit?: number }) {
      return t(entity)
        .filter((r) => matches(r, opts?.where))
        .map((r) => ({ ...r }))
    },
    async findOne(entity: string, id: string) {
      return t(entity).find((r) => r.id === id) ?? null
    },
    async insert(entity: string, data: Record<string, unknown>) {
      const id = crypto.randomUUID()
      t(entity).push({ ...data, id })
      return { id }
    },
    async update(entity: string, id: string, data: Record<string, unknown>) {
      const r = t(entity).find((x) => x.id === id)
      if (r) Object.assign(r, data)
    },
    async updateMany(
      entity: string,
      opts: { where: Record<string, unknown>; data: Record<string, unknown> },
    ) {
      const rows = t(entity).filter((r) => matches(r, opts.where))
      for (const r of rows) Object.assign(r, opts.data)
      return { count: rows.length }
    },
    async delete() {
      throw new Error("rows of this app are never removed")
    },
    async count(entity: string, opts?: { where?: Record<string, unknown> }) {
      return t(entity).filter((r) => matches(r, opts?.where)).length
    },
    async batch(spec: DbBatchSpec) {
      let s: { value: number; formatted?: string } | undefined
      if (spec.sequence) {
        const n = (seq.get(spec.sequence.key) ?? 0) + 1
        seq.set(spec.sequence.key, n)
        const f = spec.sequence.format
        s = {
          value: n,
          formatted: f ? `${f.prefix}${String(n).padStart(f.pad ?? 0, "0")}` : undefined,
        }
      }
      const snapshot = new Map([...tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
      const refs: Record<string, Row> = {}
      try {
        for (const op of spec.ops as DbBatchOp[]) {
          if ("insert" in op) {
            const data = Object.fromEntries(
              Object.entries(op.data).map(([k, v]) => [k, resolve(v, refs, s)]),
            )
            const row = { ...data, id: crypto.randomUUID() } as Row
            t(op.insert).push(row)
            if (op.as) refs[op.as] = row
          } else if ("updateMany" in op) {
            const rows = t(op.updateMany).filter((r) => matches(r, op.where))
            if (op.expect?.minRows !== undefined && rows.length < op.expect.minRows)
              throw Object.assign(
                new Error(
                  `ctx.db.batch: precondition_failed at ops[0] (updateMany ${op.updateMany}): expected at least 1 row, matched ${rows.length}`,
                ),
                { code: "precondition_failed" },
              )
            for (const r of rows) Object.assign(r, op.data)
          } else if ("update" in op) {
            const id = resolve(op.id, refs, s) as string
            const r = t(op.update).find((x) => x.id === id)
            if (r && op.data) Object.assign(r, op.data)
          }
        }
      } catch (err) {
        tables.clear()
        for (const [k, v] of snapshot) tables.set(k, v)
        throw err
      }
      return { sequence: s, rows: refs }
    },
  }
  return db as unknown as DbClient & { tables: Map<string, Row[]> }
}

const PERSON = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const AGENT = "33333333-3333-4333-8333-333333333333"

function ctxFor(
  db: DbClient,
  opts: { user?: string; agent?: string | null; approved?: boolean } = {},
) {
  const approvals: unknown[] = []
  const ctx: AgreementsCtx & { approvals: unknown[] } = {
    orgId: "org",
    userId: opts.user ?? PERSON,
    db,
    turn: { get: async () => ({ agentId: opts.agent ?? null }) },
    ...(opts.approved ? { approval: { id: "a" } } : {}),
    requestApproval: async (req) => {
      approvals.push(req)
      return { approval_id: `card-${approvals.length}` }
    },
    today: "2026-11-16",
    approvals,
  }
  return ctx
}

const okId = (r: unknown) => (r as { agreement: { id: string } }).agreement.id

describe("the list of agreements", () => {
  it("orders by what needs someone first: drafts, waiting signatures, a renewal inside notice, signed, closed", () => {
    const base = { kind: "msa", title: "x" }
    const rows = [
      { ...base, id: "a", number: "AG-1", status: "voided" },
      {
        ...base,
        id: "b",
        number: "AG-2",
        status: "signed",
        renews_on: "2027-06-01",
        notice_days: 30,
      },
      {
        ...base,
        id: "c",
        number: "AG-3",
        status: "signed",
        renews_on: "2026-12-01",
        notice_days: 30,
      },
      { ...base, id: "d", number: "AG-4", status: "sent" },
      { ...base, id: "e", number: "AG-5", status: "draft" },
      { ...base, id: "f", number: "AG-6", status: "partly_signed" },
    ]
    expect(orderByNeed(rows, "2026-11-16").map((r) => r.number)).toEqual([
      "AG-5",
      "AG-4",
      "AG-6",
      "AG-3",
      "AG-2",
      "AG-1",
    ])
  })

  it("the search tool answers in the same order and names what each row needs", async () => {
    const db = memoryDb()
    const ctx = ctxFor(db)
    await agreementCreate(ctx, { kind: "nda", title: "Mutual NDA" })
    const signed = await agreementCreate(ctx, { kind: "msa", title: "Master" })
    await db.update("agreements", okId(signed), { status: "signed" })
    const out = (await agreementsSearch(ctx, {})) as {
      items: Array<{ title: string; needs: string }>
    }
    expect(out.items.map((i) => [i.title, i.needs])).toEqual([
      ["Mutual NDA", "being drafted"],
      ["Master", "signed"],
    ])
  })
})

describe("a proposal's price", () => {
  it("only a person's price route writes the price; prepare refuses while it is unset", async () => {
    const db = memoryDb()
    const created = await agreementCreate(ctxFor(db, { agent: AGENT }), {
      kind: "proposal",
      title: "Website",
    })
    const id = okId(created)
    expect((created as { message: string }).message).toContain("no price was set")
    const row = () => db.tables.get("agreements")?.find((r) => r.id === id) as Row
    expect(row().price_minor).toBeUndefined()

    const refused = await agreementPrepare(ctxFor(db), { id })
    expect((refused as { error: { code: string } }).error.code).toBe("PRICE_NOT_SET")

    const byAgent = await agreementPriceSet(ctxFor(db, { agent: AGENT }), {
      id,
      price_minor: "1200000",
      currency: "EUR",
    })
    expect((byAgent as { error: { code: string } }).error.code).toBe("PRICE_NEEDS_A_PERSON")
    const byApproval = await agreementPriceSet(ctxFor(db, { approved: true }), {
      id,
      price_minor: "1200000",
      currency: "EUR",
    })
    expect((byApproval as { error: { code: string } }).error.code).toBe("PRICE_NEEDS_A_PERSON")
    const viaUpdate = await agreementUpdate(ctxFor(db), { id, price_minor: "1" } as never)
    expect((viaUpdate as { error: { code: string } }).error.code).toBe("PRICE_NEEDS_A_PERSON")
    expect(row().price_minor).toBeUndefined()

    await agreementPriceSet(ctxFor(db), { id, price_minor: "1200000", currency: "EUR" })
    expect(row()).toMatchObject({
      price_minor: "1200000",
      currency: "EUR",
      priced_by_user_id: PERSON,
    })
    // The agent wrote the brief: its clauses still wait for a person.
    const prepared = (await agreementPrepare(ctxFor(db), { id })) as { status: string }
    expect(prepared.status).toBe("checked")
  })
})

describe("documents this signature does not fit", () => {
  it("a guarantee, real estate, family or employment document refuses prepare", async () => {
    const db = memoryDb()
    for (const fit_tag of ["guarantee", "real_estate", "family", "employment"]) {
      const id = okId(
        await agreementCreate(ctxFor(db), {
          kind: "other",
          title: "Doc",
          what_it_is: "A document",
          fit_tag,
        }),
      )
      const out = await agreementPrepare(ctxFor(db), { id })
      expect((out as { error: { code: string } }).error.code).toBe("SIGNATURE_DOES_NOT_FIT")
    }
  })

  it("a listed word stops prepare until a person says it is not a personal guarantee; an agent cannot", async () => {
    const db = memoryDb()
    const id = okId(
      await agreementCreate(ctxFor(db), {
        kind: "other",
        title: "Acte de caution",
        what_it_is: "Lettre",
      }),
    )
    const first = await agreementPrepare(ctxFor(db), { id })
    expect((first as { error: { code: string; message: string } }).error.message).toContain(
      "This looks like a personal guarantee",
    )
    const agentSays = await agreementUpdate(ctxFor(db, { agent: AGENT }), {
      id,
      not_a_guarantee: true,
    })
    expect((agentSays as { error: { code: string } }).error.code).toBe("NEEDS_A_PERSON")
    await agreementUpdate(ctxFor(db), { id, not_a_guarantee: true })
    expect(((await agreementPrepare(ctxFor(db), { id })) as { status: string }).status).toBe(
      "checked",
    )
  })

  it("any PDF makes a normal draft holding its file, with no project, invoice or knowledge document", async () => {
    const db = memoryDb()
    const file = "44444444-4444-4444-8444-444444444444"
    const out = await agreementCreate(ctxFor(db), {
      kind: "other",
      title: "Shareholders' pact",
      what_it_is: "A shareholders' agreement",
      file_id: file,
    })
    const id = okId(out)
    expect(db.tables.get("agreements")?.find((r) => r.id === id)).toMatchObject({
      kind: "other",
      status: "draft",
      number: expect.stringMatching(/^DOC-\d{4}-001$/),
    })
    expect(
      db.tables.get("agreement_drafts")?.find((r) => r.agreement_id === id)?.upload_file_id,
    ).toBe(file)
    expect([...db.tables.keys()].sort()).toEqual([
      "agreement_drafts",
      "agreement_shares",
      "agreements",
    ])
    const bad = await agreementCreate(ctxFor(db), { kind: "other", title: "x", file_id: "nope" })
    expect((bad as { error: { code: string } }).error.code).toBe("INVALID_FILE")
  })

  it("a document of kind other needs a person to say what it is", async () => {
    const db = memoryDb()
    const id = okId(await agreementCreate(ctxFor(db), { kind: "other", title: "Scan" }))
    const out = await agreementPrepare(ctxFor(db), { id })
    expect((out as { error: { code: string } }).error.code).toBe("WHAT_IT_IS_REQUIRED")
  })

  it("minutes of a general meeting pass with a check-with-your-lawyer note that does not block", async () => {
    const db = memoryDb()
    const id = okId(
      await agreementCreate(ctxFor(db), {
        kind: "other",
        title: "PV",
        what_it_is: "Procès-verbal de l'assemblée générale",
      }),
    )
    const out = (await agreementPrepare(ctxFor(db), { id })) as {
      status: string
      checks: Array<{ code: string; blocking: boolean; message: string }>
    }
    expect(out.status).toBe("checked")
    const note = out.checks.find((c) => c.code === "CHECK_WITH_LAWYER")
    expect(note?.blocking).toBe(false)
    expect(note?.message).toContain("Check with your lawyer first")
  })

  it("clauses an agent wrote refuse prepare naming them until a person saves them", async () => {
    const db = memoryDb()
    const source = { body: { blocks: [{ type: "paragraph", text: "The work is a website." }] } }
    const id = okId(
      await agreementCreate(ctxFor(db, { agent: AGENT }), { kind: "nda", title: "NDA", source }),
    )
    const out = await agreementPrepare(ctxFor(db), { id })
    expect((out as { error: { code: string; message: string } }).error).toMatchObject({
      code: "AGENT_TEXT_UNREAD",
    })
    expect((out as { error: { message: string } }).error.message).toContain(
      'clause 1 "The work is a website."',
    )
    await agreementUpdate(ctxFor(db), { id, source })
    expect(((await agreementPrepare(ctxFor(db), { id })) as { status: string }).status).toBe(
      "checked",
    )
  })
})

describe("templates", () => {
  it("an agreement from template version 4 keeps its text after version 5", async () => {
    const db = memoryDb()
    const ctx = ctxFor(db)
    const body = (n: number) => ({
      blocks: [{ type: "paragraph", text: `Clause text, version ${n}` }],
    })
    const first = (await templateSave(ctx, { name: "NDA", kind: "nda", body: body(1) })) as {
      template_id: string
    }
    for (const n of [2, 3, 4])
      await templateSave(ctx, { template_id: first.template_id, body: body(n) })
    const id = okId(
      await agreementCreate(ctx, {
        kind: "nda",
        title: "With a client",
        template_id: first.template_id,
      }),
    )
    const saved = (await templateSave(ctx, { template_id: first.template_id, body: body(5) })) as {
      version: number
    }
    expect(saved.version).toBe(5)
    const draft = db.tables.get("agreement_drafts")?.find((r) => r.agreement_id === id) as Row
    expect(JSON.stringify(draft.source)).toContain("version 4")
    expect(db.tables.get("agreements")?.find((r) => r.id === id)?.template_version).toBe(4)
  })

  it("an agent's save waits for a person; a template takes one field's equality only", async () => {
    const db = memoryDb()
    const ctx = ctxFor(db, { agent: AGENT })
    const out = await templateSave(ctx, { name: "T", kind: "nda", body: { blocks: [] } })
    expect((out as { status: string }).status).toBe("pending_approval")
    expect(db.tables.get("agreement_template_meta") ?? []).toEqual([])
    const bad = await templateSave(ctxFor(db), {
      name: "T",
      kind: "nda",
      body: { blocks: [{ type: "paragraph", text: "x", when: { path: "a", atLeast: 3 } }] },
    })
    expect((bad as { error: { code: string } }).error.code).toBe("TEMPLATE_INVALID")
  })
})

describe("who can see an agreement (the one writer)", () => {
  it("the creator is on the list as editor; the list is never empty; a viewer cannot change it", async () => {
    const db = memoryDb()
    const id = okId(
      await agreementCreate(ctxFor(db), {
        kind: "nda",
        title: "Closed",
        org_access: "none",
        shares: [{ user_id: OTHER, role: "viewer" }],
      }),
    )
    const list = () =>
      (db.tables.get("agreement_shares") ?? [])
        .filter((r) => r.agreement_id === id && !r.removed_at)
        .map((r) => [r.user_id, r.role])
    expect(list()).toEqual([
      [PERSON, "editor"],
      [OTHER, "viewer"],
    ])
    expect(db.tables.get("agreements")?.find((r) => r.id === id)?.org_access).toBe("none")

    const empty = await agreementUpdate(ctxFor(db), { id, shares: [] })
    expect((empty as { error: { code: string } }).error.code).toBe("ACCESS_LIST_EMPTY")
    const viewer = await agreementUpdate(ctxFor(db, { user: OTHER }), { id, org_access: "editor" })
    expect((viewer as { error: { code: string } }).error.code).toBe("NOT_AN_EDITOR")

    // The creator can leave once another named editor exists.
    await agreementUpdate(ctxFor(db), { id, shares: [{ user_id: OTHER, role: "editor" }] })
    expect(list()).toEqual([[OTHER, "editor"]])
  })

  it("an agent's change parks a card no auto-approve can pass, and changes nothing", async () => {
    const db = memoryDb()
    const id = okId(await agreementCreate(ctxFor(db), { kind: "nda", title: "Open" }))
    const ctx = ctxFor(db, { agent: AGENT })
    const out = await agreementUpdate(ctx, { id, org_access: "none" })
    expect((out as { status: string }).status).toBe("pending_approval")
    expect((ctx.approvals[0] as { noAutoApprove: boolean }).noAutoApprove).toBe(true)
    expect(db.tables.get("agreements")?.find((r) => r.id === id)?.org_access).toBe("editor")
  })

  it("a stale lock_version refuses the save and keeps the draft", async () => {
    const db = memoryDb()
    const id = okId(await agreementCreate(ctxFor(db), { kind: "nda", title: "Lock" }))
    await agreementUpdate(ctxFor(db), { id, lock_version: 1, source: { body: { blocks: [] } } })
    const stale = await agreementUpdate(ctxFor(db), {
      id,
      lock_version: 1,
      source: { body: { blocks: [{ type: "paragraph", text: "late" }] } },
    })
    expect((stale as { error: { code: string } }).error.code).toBe("VERSION_CONFLICT")
  })
})

describe("the app's records", () => {
  it("a signature row's level reads past and future levels; no code path writes aes or qes", () => {
    const levels = manifest.schema.signature_events.fields.level.enum
    expect(levels).toEqual(["ses", "recorded_approval", "aes", "qes", "demo"])
    expect(manifest.schema.evidence_packages.fields.level.enum).toEqual(levels)
    const src = sourceFiles()
      .map((f) => readFileSync(f, "utf8"))
      .join("\n")
    expect(src).not.toMatch(/level:\s*["'](aes|qes)["']/)
  })

  it("the app's source removes no row", () => {
    const word = ["DE", "LETE"].join("")
    const call = new RegExp(
      `\\b${word}\\b|\\.${word.toLowerCase()}\\(|["']${word.toLowerCase()}["']\\s*:`,
    )
    const hits = sourceFiles().filter((f) => call.test(readFileSync(f, "utf8")))
    expect(hits).toEqual([])
  })

  it("every table a person can close declares sharedRows, and every user column is anonymized on erasure", () => {
    for (const t of [
      "agreements",
      "agreement_shares",
      "agreement_drafts",
      "agreement_versions",
      "signature_events",
      "evidence_packages",
    ]) {
      expect(
        (manifest.schema as Record<string, { sharedRows?: unknown }>)[t]?.sharedRows,
      ).toBeDefined()
    }
    for (const [table, def] of Object.entries(
      manifest.schema as Record<string, { fields: Record<string, unknown> }>,
    )) {
      for (const [col, f] of Object.entries(def.fields)) {
        if (!/_user_id$|^user_id$|^created_by$/.test(col) || table === "signature_events") continue
        expect({ table, col, f }).toMatchObject({ f: { userRef: true, onErase: "anonymize" } })
      }
    }
  })
})

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
    }
  }
  walk(import.meta.dir)
  return out
}
