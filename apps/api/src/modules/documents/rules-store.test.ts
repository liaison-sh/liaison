// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/document-template-rules (modules/documents/rules-store.ts) on real
// Postgres: only an org admin reads and writes, another organisation sees
// nothing (FORCE RLS), a `when` that is empty or carries an unknown key is
// refused at save, a rule names only live templates of its record type, and
// matching drops a template that is archived, disabled or gone, and ignores
// an unknown key found in stored data.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { matchRecordsForType } from "./rules-store"

interface Actor {
  orgId: string
  userId: string
  token: string
}

let admin: Actor
let member: Actor
let otherAdmin: Actor
const TYPE = "shipping:shipment"

async function actor(orgId: string, userId: string): Promise<Actor> {
  return { orgId, userId, token: await minimal.token(userId) }
}

async function call(who: Actor, method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${who.token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

const rules = (who: Actor, method: string, path = "", body?: unknown) =>
  call(who, method, `/api/document-template-rules${path}`, body)

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

interface RuleJson {
  id: string
  recordType: string
  name: string
  when: Record<string, string[]>
  templateIds: string[]
  enabled: boolean
}

async function template(who: Actor, name: string, recordType: string | null = TYPE) {
  const res = await call(who, "POST", "/api/document-templates", {
    kind: "rich_text",
    name,
    recordType,
    body: { blocks: [] },
  })
  expect(res.status).toBe(201)
  return (await json<{ data: { id: string } }>(res)).data.id
}

async function createRule(who: Actor, body: Record<string, unknown>): Promise<RuleJson> {
  const res = await rules(who, "POST", "", body)
  expect(res.status).toBe(201)
  return (await json<{ data: RuleJson }>(res)).data
}

function match(who: Actor, records: Parameters<typeof matchRecordsForType>[2]) {
  return withRlsContext(
    { actorType: "user", userId: who.userId, orgId: who.orgId, scopes: ["*"], dimensionGrants: {} },
    (tx) => matchRecordsForType(tx, TYPE, records),
  )
}

let steel = ""
let tsca = ""
let other = ""

beforeAll(async () => {
  await acquireTestLock()
  const { id: orgId } = await createTestOrg()
  admin = await actor(orgId, (await minimal.orgAdmin(orgId)).id)
  member = await actor(orgId, (await minimal.person(orgId)).id)
  const second = await minimal.secondOrg()
  otherAdmin = await actor(second.orgId, second.adminUserId)
  steel = await template(admin, "Steel content")
  tsca = await template(admin, "TSCA certificate")
  other = await template(admin, "Order letter", "store:order")
}, 180_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("saving a rule", () => {
  it("refuses an empty `when` and an unknown key with 400, and stores nothing", async () => {
    const base = { recordType: TYPE, name: "Plate to US", templateIds: [steel] }
    for (const when of [{}, { material: ["steel"] }, { sku: ["A-1"], material: ["steel"] }]) {
      const res = await rules(admin, "POST", "", { ...base, when })
      expect(res.status).toBe(400)
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("VALIDATION_ERROR")
    }
    const res = await rules(admin, "PATCH", `/${crypto.randomUUID()}`, {
      when: { weight: ["2kg"] },
    })
    expect(res.status).toBe(400)
    const [row] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.document_template_rules WHERE org_id = ${admin.orgId}`
    expect(row?.n).toBe(0)
  })

  it("creates, reads, patches and deletes a rule; values are normalized", async () => {
    const created = await createRule(admin, {
      recordType: TYPE,
      name: "Plate to US",
      when: { sku: [" ACC-PLATE-01 "], countryIso2: ["us", "US"], carrier: ["UPS"] },
      templateIds: [steel, tsca, steel],
      note: "US customs",
    })
    expect(created.when).toEqual({ sku: ["ACC-PLATE-01"], countryIso2: ["US"], carrier: ["ups"] })
    expect(created.templateIds).toEqual([steel, tsca])

    const got = await rules(admin, "GET", `/${created.id}`)
    expect(got.status).toBe(200)
    const list = await json<{ data: RuleJson[] }>(await rules(admin, "GET", `?recordType=${TYPE}`))
    expect(list.data.map((r) => r.id)).toContain(created.id)

    const patched = await rules(admin, "PATCH", `/${created.id}`, {
      enabled: false,
      when: { countryIso2: ["ca"] },
    })
    expect(patched.status).toBe(200)
    const p = (await json<{ data: RuleJson }>(patched)).data
    expect(p.enabled).toBe(false)
    expect(p.when).toEqual({ countryIso2: ["CA"] })

    expect((await rules(admin, "DELETE", `/${created.id}`)).status).toBe(200)
    expect((await rules(admin, "GET", `/${created.id}`)).status).toBe(404)
    expect((await rules(admin, "DELETE", `/${created.id}`)).status).toBe(404)
  })

  it("refuses a template that does not exist, is archived, or prints another record type", async () => {
    const archived = await template(admin, "Old declaration")
    expect((await call(admin, "POST", `/api/document-templates/${archived}/archive`)).status).toBe(
      200,
    )
    for (const id of [crypto.randomUUID(), archived, other]) {
      const res = await rules(admin, "POST", "", {
        recordType: TYPE,
        name: "Bad",
        when: { countryIso2: ["US"] },
        templateIds: [id],
      })
      expect(res.status).toBe(422)
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("template_invalid")
    }
  })
})

describe("who may read and write", () => {
  it("a member without kernel:org:admin gets 403 on every method", async () => {
    const rule = await createRule(admin, {
      recordType: TYPE,
      name: "Admin only",
      when: { countryIso2: ["JP"] },
      templateIds: [steel],
    })
    const body = { recordType: TYPE, name: "x", when: { sku: ["x"] }, templateIds: [steel] }
    expect((await rules(member, "GET")).status).toBe(403)
    expect((await rules(member, "GET", `/${rule.id}`)).status).toBe(403)
    expect((await rules(member, "POST", "", body)).status).toBe(403)
    expect((await rules(member, "PATCH", `/${rule.id}`, { enabled: false })).status).toBe(403)
    expect((await rules(member, "DELETE", `/${rule.id}`)).status).toBe(403)
    await rules(admin, "DELETE", `/${rule.id}`)
  })

  it("another organisation cannot see, change or delete a rule, nor point one at our template", async () => {
    const rule = await createRule(admin, {
      recordType: TYPE,
      name: "Ours",
      when: { countryIso2: ["DE"] },
      templateIds: [steel],
    })
    const list = await json<{ data: RuleJson[] }>(await rules(otherAdmin, "GET"))
    expect(list.data.map((r) => r.id)).not.toContain(rule.id)
    expect((await rules(otherAdmin, "GET", `/${rule.id}`)).status).toBe(404)
    expect((await rules(otherAdmin, "PATCH", `/${rule.id}`, { enabled: false })).status).toBe(404)
    expect((await rules(otherAdmin, "DELETE", `/${rule.id}`)).status).toBe(404)
    const borrow = await rules(otherAdmin, "POST", "", {
      recordType: TYPE,
      name: "Borrow",
      when: { countryIso2: ["DE"] },
      templateIds: [steel],
    })
    expect(borrow.status).toBe(422)
    await rules(admin, "DELETE", `/${rule.id}`)
  })
})

describe("matching", () => {
  it("needs sku AND country, drops templates that cannot print, ignores stored unknown keys", async () => {
    const rule = await createRule(admin, {
      recordType: TYPE,
      name: "Plate to US",
      when: { sku: ["acc-plate-01"], countryIso2: ["US"] },
      templateIds: [steel, tsca],
    })
    const plateUs = { id: "s1", skus: ["ACC-PLATE-01"], countryIso2: "US" }
    const plateFr = { id: "s2", skus: ["ACC-PLATE-01"], countryIso2: "FR" }
    const cableUs = { id: "s3", skus: ["CABLE-2M"], countryIso2: "US" }
    expect((await match(admin, [plateUs, plateFr, cableUs])).map((m) => m.templateIds)).toEqual([
      [steel, tsca],
      [],
      [],
    ])

    // An unknown key written straight into the data has no effect.
    await sql`UPDATE kernel.document_template_rules
       SET "when" = "when" || '{"material": ["aluminium"]}'::jsonb WHERE id = ${rule.id}`
    expect((await match(admin, [plateUs]))[0]?.templateIds).toEqual([steel, tsca])

    // A disabled template, then a deleted one, disappear from the matches.
    await sql`UPDATE kernel.document_templates SET enabled = false WHERE id = ${tsca}`
    expect((await match(admin, [plateUs]))[0]?.templateIds).toEqual([steel])
    await sql`UPDATE kernel.document_templates SET enabled = true WHERE id = ${tsca}`
    await sql`DELETE FROM kernel.document_templates WHERE id = ${steel}`
    expect((await match(admin, [plateUs]))[0]?.templateIds).toEqual([tsca])

    // A disabled rule matches nothing; another organisation's records never see our rules.
    await rules(admin, "PATCH", `/${rule.id}`, { enabled: false })
    expect((await match(admin, [plateUs]))[0]?.ruleIds).toEqual([])
    await rules(admin, "PATCH", `/${rule.id}`, { enabled: true })
    expect((await match(otherAdmin, [plateUs]))[0]?.ruleIds).toEqual([])
  })
})
