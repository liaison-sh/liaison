// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The non-disclosable gate is scope-aware in BOTH directions (spec-security.md
// S7, D4, FX10a).
//
// The withheld set is built from the agent CEILING's own strings, and a ceiling
// entry is routinely a glob: ceiling `["finance:*"]` with requester grant
// `["finance:read"]` withholds the string `"finance:*"`. Matching an admin's
// policy row literally therefore missed every real case: a row on
// `finance:payouts:read` never equalled `finance:*`, so the glob ceiling was
// shared anyway and disclosed exactly the capability the admin had closed.
//
// The gate now blocks when the withheld entry COVERS a non-disclosable scope,
// and when a non-disclosable entry COVERS the withheld scope, using the repo's
// wildcard-aware `hasScope` semantics (the same ones the message visibility
// predicate and the RLS clause use). It still fails closed, and it still reads
// the withheld set only: a scope the requester already holds is not disclosed
// by sharing.
//
// EVERY CASE GETS ITS OWN ORG, and no case resets anything. Marking a scope
// non-disclosable is tighten-only, and migration 0069 makes that a database
// invariant: while its organization exists, a tightened row cannot be deleted
// (the delete is suppressed and reports 0 rows). A shared org would therefore
// leak each tightened scope into every later case. Dropping the organization is
// the one delete that proceeds, by design, so that is the whole cleanup.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { computeShareAnywayScope } from "~/services/security/share-anyway"

const tag = crypto.randomUUID().slice(0, 8)
const createdOrgs: string[] = []

async function newOrg(label: string): Promise<string> {
  const id = crypto.randomUUID()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${id}, ${`GlobDisclosure ${label} ${tag}`}, ${`glob-disclosure-${label}-${tag}`})`
  createdOrgs.push(id)
  return id
}

function ctxFor(orgId: string): UserContext {
  return {
    actorType: "user",
    userId: crypto.randomUUID(),
    orgId,
    scopes: [],
    dimensionGrants: {},
  }
}

async function markNonDisclosable(orgId: string, scope: string): Promise<void> {
  await sql`INSERT INTO kernel.scope_disclosure_policy (org_id, scope, disclosable)
    VALUES (${orgId}, ${scope}, false)`
}

/** The Share anyway gate for one ceiling and one requester, in `orgId`. */
async function gate(
  orgId: string,
  ceiling: string[],
  grants: string[],
): Promise<{ ok: boolean; nonDisclosable?: string[] }> {
  const result = await withRlsContext(ctxFor(orgId), (db) =>
    computeShareAnywayScope(db, orgId, ceiling, grants),
  )
  return result.ok ? { ok: true } : { ok: false, nonDisclosable: result.nonDisclosable }
}

describe("the non-disclosable gate matches scopes, not strings (S7)", () => {
  let base: string

  beforeAll(async () => {
    base = await newOrg("base")
  })

  afterAll(async () => {
    // The FK cascade removes the policy rows with the org: 0069 allows exactly
    // this delete and refuses every other one.
    for (const id of createdOrgs) {
      await sql`DELETE FROM kernel.organizations WHERE id = ${id}`
    }
  })

  it("a GLOB withheld entry is refused when it covers a non-disclosable scope", async () => {
    // `ceiling ∩ requester` is ["finance:read"], so the withheld entry is the
    // ceiling's own string "finance:*" -- which would disclose finance:payouts:read.
    const org = await newOrg("glob-withheld")
    await markNonDisclosable(org, "finance:payouts:read")
    expect(await gate(org, ["finance:*"], ["finance:read"])).toEqual({
      ok: false,
      nonDisclosable: ["finance:*"],
    })
  })

  it("a bare `*` ceiling is refused when the org has closed anything at all", async () => {
    const org = await newOrg("star-ceiling")
    await markNonDisclosable(org, "finance:payouts:read")
    expect(await gate(org, ["*"], ["finance:read"])).toEqual({ ok: false, nonDisclosable: ["*"] })
  })

  it("a GLOB policy row is refused when it covers a concrete withheld scope", async () => {
    // The other direction: the admin closed a whole family, the ceiling names
    // one member of it, and that member is what sharing would disclose.
    const org = await newOrg("glob-policy")
    await markNonDisclosable(org, "finance:*")
    expect(await gate(org, ["finance:payouts:read", "hr:read"], ["hr:read"])).toEqual({
      ok: false,
      nonDisclosable: ["finance:payouts:read"],
    })
  })

  it("an unrelated policy row does not refuse the share", async () => {
    const org = await newOrg("unrelated")
    await markNonDisclosable(org, "hr:salary:read")
    expect(await gate(org, ["finance:*"], ["finance:read"])).toEqual({ ok: true })
    expect(await gate(org, ["finance:payouts:read", "hr:read"], ["hr:read"])).toEqual({ ok: true })
  })

  it("an exact match still refuses, and a scope with no row is still disclosable", async () => {
    const org = await newOrg("exact")
    await markNonDisclosable(org, "finance:payouts:read")
    expect(await gate(org, ["finance:payouts:read", "hr:read"], ["hr:read"])).toEqual({
      ok: false,
      nonDisclosable: ["finance:payouts:read"],
    })
    expect(await gate(org, ["hr:read", "hr:notes:read"], ["hr:read"])).toEqual({ ok: true })
  })

  it("a non-disclosable scope the requester already holds still does not block the share", async () => {
    // Covered by the glob rule too: "finance:*" is inside `ceiling ∩ requester`
    // here, so it is not withheld and sharing discloses nothing new about it.
    const org = await newOrg("already-held")
    await markNonDisclosable(org, "finance:payouts:read")
    expect(await gate(org, ["finance:*"], ["finance:*", "hr:read"])).toEqual({ ok: true })
  })

  it("another org's policy row never blocks this org's share", async () => {
    const foreign = await newOrg("foreign")
    await markNonDisclosable(foreign, "finance:payouts:read")
    expect(await gate(base, ["finance:*"], ["finance:read"])).toEqual({ ok: true })
  })

  it("a policy read failure refuses the share, naming every withheld scope", async () => {
    const broken = {
      select: () => {
        throw new Error("policy read failed")
      },
    } as unknown as RlsClient
    expect(await computeShareAnywayScope(broken, base, ["finance:*"], ["finance:read"])).toEqual({
      ok: false,
      nonDisclosable: ["finance:*"],
    })
  })
})
