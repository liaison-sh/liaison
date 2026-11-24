// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `organizations.class`: an org's class (`standard` | `demo`) is a database
// fact written when the org is created, and the demo purge and reset act on
// that, never on the jsonb marker alone. On a real database:
//
//   - a customer org with a forged marker is never purged or reset, and its
//     immutable legal record survives;
//   - a demo org can hold no billing row, and the control plane API refuses it;
//   - an expiry moved while the purge starts is seen: the purge locks the row;
//   - a purge whose mark is taken back stops before it deletes a row;
//   - the operator's org and an org the control plane created are refused;
//   - a trigger body of an older release is rewritten at boot.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import postgres from "postgres"
import { runDemoReclassifyCli } from "~/cli/demo-reclassify"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { orgBillingState } from "~/db/schema/kernel"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import * as beforeDisconnectModule from "~/modules/apps/connections/before-disconnect"
import {
  generateImmutableTriggerDdl,
  IMMUTABLE_TRIGGER_DELETING_BRANCH,
  ORG_PURGE_SETTING,
} from "~/modules/apps/ddl"
import { applyBillingPush } from "~/modules/cloud/billing"
import { createCloudOrg } from "~/modules/cloud/create-org"
import { applyCreditGrant } from "~/modules/cloud/credits"
import { cloudHandoff } from "~/modules/cloud/handoff"
import { lookupOrgsByEmail } from "~/modules/cloud/lookup"
import { CLOUD_CREATE_ORG_ENDPOINT, claimOutcome } from "~/modules/cloud/outcomes"
import { listExpiredDemoOrgs } from "~/modules/demo/demo-expiry"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  invalidateDemoMarker,
  markOrgAsDemo,
  reservedMarker,
  visitorMarker,
} from "~/modules/demo/demo-org"
import { createVisitorOrgShell, demoOrgSlug } from "~/modules/demo/demo-pool"
import { DemoOrgGuardError, purgeDemoOrg, resetDemoOrgContent } from "~/modules/demo/demo-reset"
import { orgClassOf } from "~/modules/demo/org-class"
import { markOrgDeleting } from "~/modules/org/purge/deleting"
import type { OrgExternalStateDeps } from "~/modules/org/purge/external"
import { ensureImmutableTriggersCurrent } from "~/modules/org/purge/immutable-triggers"
import { purgeOrg } from "~/modules/org/purge/purge-org"
import { ensureOrg, OrgClassMismatchError } from "~/modules/provisioning/ensure-org"
import { upsertAppRow } from "~/seed/factories/app-tables"
import { AUTO_TOP_UP_OFF, seedOrgBillingState } from "~/seed/factories/billing/billing"
import { type OrgRowSeed, seedOrgRow, seedRoleRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const tag = crypto.randomUUID().slice(0, 8)
const APP = `orgclass_${tag}`
const APP_SCHEMA = `app_${APP}`
const HOUR = 3_600_000
/** Expired two days ago. */
const expired = () => visitorMarker(1, new Date(Date.now() - 48 * HOUR))
const noStorage: OrgExternalStateDeps = {
  deleteObjects: async () => 0,
  countObjects: async () => 0,
}

/** The tables' owner, for the one case that takes a constraint away. */
function ownerUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

async function asAdmin(statements: string[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE liaison_admin")
    for (const s of statements) await tx.unsafe(s)
  })
}

const statements = (ddl: string) => ddl.split(";\n").filter((s) => s.trim())

/** The trigger body the release before the class wrote: the jsonb marker opens it. */
function oldTriggerStatements(): string[] {
  return statements(
    generateImmutableTriggerDdl(APP_SCHEMA, "legal", { retentionYears: 10 }).replace(
      "o.class = 'demo'",
      "(jsonb_typeof(o.settings->'demo') = 'object' AND o.settings->'demo'->>'variant' IN ('reserved', 'visitor'))",
    ),
  )
}

let n = 0
/** An org row with one person and one immutable legal record. */
async function makeOrg(row: Partial<OrgRowSeed> & { class?: "standard" | "demo" } = {}) {
  const id = crypto.randomUUID()
  const slug = row.slug ?? `orgclass-${tag}-${++n}`
  await seedOrgRow({ name: `Org ${n}`, ...row, id, slug } as OrgRowSeed)
  await seedUserRow({
    orgId: id,
    email: `p${n}-${tag}@orgclass.test`,
    name: "P",
    passwordHash: "x",
  })
  await withSystemDb("test-org-class-legal", (tx) =>
    upsertAppRow(tx, APP, "legal", { id: crypto.randomUUID(), org_id: id, sha: "h" }),
  )
  return { id, slug }
}

/** A customer org whose `settings.demo` somebody forged. */
async function customerWithForgedMarker(marker: unknown) {
  const org = await makeOrg()
  await seedOrgBillingState(org.id)
  await sql`UPDATE kernel.organizations
    SET settings = settings || jsonb_build_object('demo', ${JSON.stringify(marker)}::jsonb)
    WHERE id = ${org.id}`
  await invalidateDemoMarker(org.id)
  return org
}

const count = async (q: Promise<Array<{ n: string | number }>>) => Number((await q)[0]?.n ?? 0)
const legalRows = (orgId: string) =>
  count(sql.unsafe(`SELECT count(*) AS n FROM "${APP_SCHEMA}".legal WHERE org_id = '${orgId}'`))
const userRows = (orgId: string) =>
  count(sql`SELECT count(*) AS n FROM kernel.users WHERE org_id = ${orgId}` as never)

async function orgRow(orgId: string) {
  const [r] = await sql<{ deleting_at: Date | null }[]>`
    SELECT deleting_at FROM kernel.organizations WHERE id = ${orgId}`
  return r ?? null
}

/** Nothing was destroyed, and nothing says it is about to be. */
async function expectUntouched(orgId: string) {
  expect(await orgRow(orgId)).toEqual({ deleting_at: null })
  expect(await legalRows(orgId)).toBe(1)
  expect(await userRows(orgId)).toBe(1)
}

beforeAll(async () => {
  await acquireTestLock()
  await asAdmin([
    `CREATE SCHEMA "${APP_SCHEMA}"`,
    `CREATE TABLE "${APP_SCHEMA}".legal (id uuid primary key default gen_random_uuid(), org_id uuid not null, created_at timestamptz not null default now(), sha text)`,
    ...statements(generateImmutableTriggerDdl(APP_SCHEMA, "legal", { retentionYears: 10 })),
  ])
  await sql.unsafe(`GRANT USAGE ON SCHEMA "${APP_SCHEMA}" TO liaison_app`).catch(() => undefined)
  await sql.unsafe(`GRANT ALL ON "${APP_SCHEMA}".legal TO liaison_app`).catch(() => undefined)
}, 60_000)

beforeEach(() => DemoModeTestAccess.set(true))
afterEach(() => DemoModeTestAccess.set(null))

afterAll(async () => {
  await asAdmin([`DROP SCHEMA IF EXISTS "${APP_SCHEMA}" CASCADE`])
  const orgs = sql`SELECT id FROM kernel.organizations WHERE slug LIKE ${`orgclass-${tag}-%`}`
  await sql`DELETE FROM kernel.users WHERE org_id IN (${orgs})`
  await sql`DELETE FROM kernel.organizations WHERE slug LIKE ${`orgclass-${tag}-%`}`
  await sql`DELETE FROM kernel.cloud_request_outcomes WHERE idem_key LIKE ${`orgclass-${tag}-%`}`
  await invalidateDemoMarker()
  await releaseTestLock()
})

describe("a customer org with a forged demo marker", () => {
  it("is not purged: the org and its legal record survive", async () => {
    const org = await customerWithForgedMarker(expired())
    const result = await purgeDemoOrg(org.id, new Date(), noStorage).catch((e: Error) => e)
    expect(result).toEqual({ purged: false, refusal: "not-demo-class" })
    await expectUntouched(org.id)
  })

  it("is not reset", async () => {
    const org = await customerWithForgedMarker(reservedMarker())
    const err = await resetDemoOrgContent(org.id).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DemoOrgGuardError)
    expect((err as DemoOrgGuardError).refusal).toBe("not-demo-class")
    await expectUntouched(org.id)
  })

  it("does not open the immutability trigger, even for the purge's role and setting", async () => {
    const org = await customerWithForgedMarker(expired())
    const err = await asAdmin([
      `SELECT set_config('${ORG_PURGE_SETTING}', '${org.id}', true)`,
      `DELETE FROM "${APP_SCHEMA}".legal WHERE org_id = '${org.id}'`,
    ]).catch((e: Error) => e)
    expect(String(err)).toMatch(/immutable_retention/)
    expect(await legalRows(org.id)).toBe(1)
  })
})

describe("a demo org and the control plane", () => {
  const push = (orgId: string) =>
    applyBillingPush(
      {
        orgId,
        version: 1,
        plan: "base",
        status: "active",
        periodEnd: new Date(Date.now() + 20 * 24 * HOUR).toISOString(),
        includedCredits: "100",
        caps: {},
        previewEndsAt: null,
        autoTopUp: { enabled: false, threshold: "0", topUpCredits: "0", monthlyCapCredits: "0" },
      } as never,
      {},
    )

  it("a billing push to it fails and stores nothing", async () => {
    const org = await makeOrg({ class: "demo" })
    await markOrgAsDemo(org.id, expired())
    const result = await push(org.id).catch((e: Error) => e)
    expect(result).toEqual({ status: 404, reply: { ok: false, code: "not_found" } })
    const rows = await sql`SELECT 1 FROM kernel.org_billing_state WHERE org_id = ${org.id}`
    expect(rows).toHaveLength(0)
  })

  it("no sign-in link, credit or lookup names it, and no create adopts it", async () => {
    const org = await makeOrg({ class: "demo" })
    const email = `lookup-${tag}@orgclass.test`
    const owner = await seedUserRow({
      orgId: org.id,
      email,
      name: "L",
      passwordHash: "x",
      status: "active",
    })
    // An owner the handoff would find, were the org a standard one.
    await seedRoleRow(org.id, "admin")
    await sql`INSERT INTO kernel.user_roles (org_id, user_id, role_id)
      SELECT ${org.id}, ${owner}, id FROM kernel.roles WHERE org_id = ${org.id} AND name = 'admin'`
    expect(await lookupOrgsByEmail(email)).toEqual({ ok: true, orgs: [] })
    expect((await cloudHandoff(org.id, crypto.randomUUID())).status).toBe(404)
    expect(
      (
        await applyCreditGrant({
          orgId: org.id,
          grantId: `orgclass-${tag}-grant`,
          kind: "topup",
          credits: "10",
        } as never)
      ).status,
    ).toBe(404)
    const create = {
      slug: org.slug,
      name: "Taken",
      ownerEmail: email,
      ownerName: "L",
      plan: "base",
    }
    expect((await createCloudOrg(create as never)).status).toBe(409)
    // Nor a resumed attempt's claim on the slug (the attempt that made it died).
    await claimOutcome(CLOUD_CREATE_ORG_ENDPOINT, org.slug, email)
    await sql`UPDATE kernel.cloud_request_outcomes SET claimed_at = now() - interval '1 day'
      WHERE endpoint = ${CLOUD_CREATE_ORG_ENDPOINT} AND idem_key = ${org.slug}`
    expect((await createCloudOrg(create as never)).status).toBe(409)
    expect(await orgClassOf(org.id)).toBe("demo")
  })

  it("Postgres itself refuses a billing row for it, whatever the class the row claims", async () => {
    const org = await makeOrg({ class: "demo" })
    const err = await seedOrgBillingState(org.id).catch((e: unknown) => e)
    expect(String((err as { cause?: unknown }).cause ?? err)).toMatch(/org_billing_state_org_class/)
    const claimed = await withSystemDb("test-org-class-claimed", (tx) =>
      tx.insert(orgBillingState).values({
        orgId: org.id,
        orgClass: "demo" as "standard",
        version: 1,
        plan: "base",
        status: "active",
        periodEnd: new Date(),
        includedCredits: "0",
        autoTopUp: AUTO_TOP_UP_OFF,
      }),
    ).catch((e: unknown) => e)
    expect(String((claimed as { cause?: unknown }).cause ?? claimed)).toMatch(
      /org_billing_state_org_class/,
    )
  })

  it("a customer org is billed as before, and deleting it takes its billing row", async () => {
    const org = await makeOrg()
    expect((await push(org.id)).status).toBe(200)
    await sql`DELETE FROM kernel.users WHERE org_id = ${org.id}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${org.id}`
    const rows = await sql`SELECT 1 FROM kernel.org_billing_state WHERE org_id = ${org.id}`
    expect(rows).toHaveLength(0)
  })
})

describe("purging a demo org", () => {
  it("an expired visitor org goes whole, its legal record with it", async () => {
    const org = await makeOrg({ class: "demo" })
    await markOrgAsDemo(org.id, expired())
    expect((await purgeDemoOrg(org.id, new Date(), noStorage)).purged).toBe(true)
    expect(await orgRow(org.id)).toBeNull()
    expect(await legalRows(org.id)).toBe(0)
  })

  it("waits for an expiry being moved, sees it and leaves the org alone", async () => {
    const org = await makeOrg({ class: "demo" })
    await markOrgAsDemo(org.id, expired())
    const later = JSON.stringify(visitorMarker(72))
    let release = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    let locked = () => {}
    const isLocked = new Promise<void>((r) => {
      locked = r
    })
    // The connected-TTL extension, its row lock held and not yet committed.
    const extension = sql.begin(async (tx) => {
      await tx`UPDATE kernel.organizations
        SET settings = settings || jsonb_build_object('demo', ${later}::jsonb) WHERE id = ${org.id}`
      locked()
      await held
    })
    await isLocked
    let settled = false
    const purge = purgeDemoOrg(org.id, new Date(), noStorage)
      .catch((e: Error) => e)
      .finally(() => {
        settled = true
      })
    // The purge is waiting on exactly that row lock, in Postgres.
    const deadline = Date.now() + 10_000
    let waiting = 0
    while (waiting === 0 && !settled && Date.now() < deadline) {
      waiting = await count(
        sql`SELECT count(*) AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%organizations%'` as never,
      )
      if (waiting === 0) await Bun.sleep(20)
    }
    expect({ settled, rows: await userRows(org.id) }).toEqual({ settled: false, rows: 1 })
    expect(waiting).toBeGreaterThan(0)
    release()
    await extension
    expect(await purge).toEqual({ purged: false, refusal: "not-expired" })
    await expectUntouched(org.id)
  }, 30_000)

  it("re-checks at the row delete: a mark taken back stops it before a row goes", async () => {
    const org = await makeOrg({ class: "demo" })
    await markOrgAsDemo(org.id, expired())
    const spy = spyOn(beforeDisconnectModule, "runBeforeDisconnectForOrg").mockImplementation(
      async () => {
        await sql`UPDATE kernel.organizations SET deleting_at = NULL WHERE id = ${org.id}`
        return []
      },
    )
    try {
      const err = await purgeDemoOrg(org.id, new Date(), noStorage).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DemoOrgGuardError)
      expect((err as DemoOrgGuardError).refusal).toBe("not-deleting")
    } finally {
      spy.mockRestore()
    }
    await expectUntouched(org.id)
  })

  it("a purge that stopped half way is finished by the next one", async () => {
    const org = await makeOrg({ class: "demo" })
    await markOrgAsDemo(org.id, expired())
    const broken = await purgeDemoOrg(org.id, new Date(), {
      deleteObjects: async () => {
        throw new Error("storage down")
      },
    }).catch((e: Error) => e)
    expect(broken).toBeInstanceOf(Error)
    expect((await orgRow(org.id))?.deleting_at).not.toBeNull()
    expect((await purgeDemoOrg(org.id, new Date(), noStorage)).purged).toBe(true)
    expect(await orgRow(org.id)).toBeNull()
  })

  it("refuses with demo mode off, and marks nothing", async () => {
    const org = await makeOrg({ class: "demo" })
    await markOrgAsDemo(org.id, expired())
    DemoModeTestAccess.set(false)
    const err = await purgeDemoOrg(org.id, new Date(), noStorage).catch((e: unknown) => e)
    expect((err as DemoOrgGuardError).refusal).toBe("demo-mode-off")
    await expectUntouched(org.id)
  })

  it("refuses the operator's org", async () => {
    const org = await makeOrg({ class: "demo" })
    await markOrgAsDemo(org.id, expired())
    const mutable = env as { LIAISON_OPERATOR_ORG_ID?: string }
    const saved = mutable.LIAISON_OPERATOR_ORG_ID
    mutable.LIAISON_OPERATOR_ORG_ID = org.id
    try {
      expect(await purgeDemoOrg(org.id, new Date(), noStorage)).toEqual({
        purged: false,
        refusal: "operator-org",
      })
    } finally {
      mutable.LIAISON_OPERATOR_ORG_ID = saved
    }
    await expectUntouched(org.id)
  })

  it("refuses an org the control plane created", async () => {
    const org = await makeOrg({ class: "demo" })
    await markOrgAsDemo(org.id, expired())
    await claimOutcome(CLOUD_CREATE_ORG_ENDPOINT, org.slug, "owner@example.test")
    expect(await purgeDemoOrg(org.id, new Date(), noStorage)).toEqual({
      purged: false,
      refusal: "customer-org",
    })
    await expectUntouched(org.id)
  })

  it("refuses a billed org even if the database constraint were gone", async () => {
    const org = await makeOrg({ class: "demo" })
    await markOrgAsDemo(org.id, expired())
    const owner = postgres(ownerUrl(), { max: 1, onnotice: () => {} })
    await owner.unsafe(
      "ALTER TABLE kernel.org_billing_state DROP CONSTRAINT org_billing_state_org_class_fk",
    )
    try {
      await seedOrgBillingState(org.id)
      expect(await purgeDemoOrg(org.id, new Date(), noStorage)).toEqual({
        purged: false,
        refusal: "customer-org",
      })
      await expectUntouched(org.id)
    } finally {
      await sql`DELETE FROM kernel.org_billing_state WHERE org_id = ${org.id}`
      await owner.unsafe(
        `ALTER TABLE kernel.org_billing_state ADD CONSTRAINT org_billing_state_org_class_fk
           FOREIGN KEY (org_id, org_class) REFERENCES kernel.organizations (id, class) ON DELETE CASCADE`,
      )
      await owner.end()
    }
  })

  it("resets only the reserved demo org", async () => {
    const visitor = await makeOrg({ class: "demo" })
    await markOrgAsDemo(visitor.id, expired())
    const err = await resetDemoOrgContent(visitor.id).catch((e: unknown) => e)
    expect((err as DemoOrgGuardError).refusal).toBe("not-a-reserved-org")
    await expectUntouched(visitor.id)
  })
})

describe("the immutability trigger of an older release", () => {
  it("opens for a forged marker until boot rewrites it, then no longer", async () => {
    await asAdmin(oldTriggerStatements())
    const org = await customerWithForgedMarker(expired())
    const bodies = async () =>
      (
        await sql<{ body: string }[]>`
          SELECT p.prosrc AS body FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
          JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE ns.nspname = ${APP_SCHEMA} AND t.tgname = 'kernel_immutable'`
      )[0]?.body ?? ""
    // It holds the deleting branch already: that alone must not read as current.
    expect(await bodies()).toContain(IMMUTABLE_TRIGGER_DELETING_BRANCH)

    const { regenerated } = await ensureImmutableTriggersCurrent()
    expect(regenerated).toContain(`${APP_SCHEMA}.legal`)
    expect(await bodies()).toContain("o.class = 'demo'")
    expect((await ensureImmutableTriggersCurrent()).regenerated).not.toContain(
      `${APP_SCHEMA}.legal`,
    )
    const err = await asAdmin([
      `SELECT set_config('${ORG_PURGE_SETTING}', '${org.id}', true)`,
      `DELETE FROM "${APP_SCHEMA}".legal WHERE org_id = '${org.id}'`,
    ]).catch((e: Error) => e)
    expect(String(err)).toMatch(/immutable_retention/)
    expect(await legalRows(org.id)).toBe(1)
  })
})

describe("the class is written when the org is created", () => {
  const made: string[] = []
  afterAll(async () => {
    for (const id of made) {
      await markOrgDeleting(id)
      await purgeOrg(id, { reason: "test", settle: false, externalDeps: noStorage }).catch(
        () => undefined,
      )
    }
  })

  it("ensureOrg: standard unless asked, never changed, another class refused", async () => {
    const slug = `orgclass-${tag}-ensure`
    const first = await ensureOrg({ slug, name: "E" })
    made.push(first.orgId)
    expect(await orgClassOf(first.orgId)).toBe("standard")
    const err = await ensureOrg({ slug, name: "Renamed", class: "demo" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OrgClassMismatchError)
    expect(await orgClassOf(first.orgId)).toBe("standard")
    const [row] = await sql`SELECT name FROM kernel.organizations WHERE id = ${first.orgId}`
    expect(row?.name).toBe("E")
    // A caller that says nothing about the class updates the org as before.
    expect((await ensureOrg({ slug, name: "E2" })).created).toBe(false)
  }, 60_000)

  it("a visitor workspace is a demo org from its first row", async () => {
    const shell = await createVisitorOrgShell({
      slug: demoOrgSlug("Class"),
      locale: "en",
      marker: visitorMarker(72),
      ownerName: "V",
    })
    made.push(shell.orgId)
    expect(await orgClassOf(shell.orgId)).toBe("demo")
  }, 60_000)
})

describe("liaison demo reclassify", () => {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString()
  const window = () => ["--since", at(-HOUR), "--until", at(HOUR)]
  const visitorSlug = () => `demo-orgclass-${tag}-${crypto.randomUUID().slice(-12)}`
  const listed = async (argv: string[]) => {
    const res = await runDemoReclassifyCli(argv)
    expect({ code: res.exitCode, message: res.message }).toEqual({ code: 0, message: undefined })
    return ((res.report?.orgs ?? []) as Array<{ orgId: string }>).map((o) => o.orgId)
  }
  /** A workspace as the previous release leaves it: marked, of class `standard`. */
  const windowOrg = async () => {
    const org = await makeOrg({ slug: visitorSlug() })
    await markOrgAsDemo(org.id, expired())
    return org
  }
  afterAll(async () => {
    const mine = sql`SELECT id FROM kernel.organizations WHERE slug LIKE ${`demo-orgclass-${tag}-%`}`
    await sql`DELETE FROM kernel.org_billing_state WHERE org_id IN (${mine})`
    await sql`DELETE FROM kernel.users WHERE org_id IN (${mine})`
    await sql`DELETE FROM kernel.organizations WHERE slug LIKE ${`demo-orgclass-${tag}-%`}`
  })

  it("lists a window workspace, reclassifies it, and the reaper then takes it", async () => {
    const org = await windowOrg()
    // Until then: refused, and behind every org the reaper can take.
    expect((await purgeDemoOrg(org.id, new Date(), noStorage)).refusal).toBe("not-demo-class")
    const purgeable = await makeOrg({ class: "demo" })
    await markOrgAsDemo(purgeable.id, expired())
    expect((await listExpiredDemoOrgs(new Date(), 1))[0]?.orgId).not.toBe(org.id)

    expect(await listed(window())).toContain(org.id)
    expect(await orgClassOf(org.id)).toBe("standard")
    const other = await windowOrg()
    expect(await listed([...window(), "--org", org.id, "--apply"])).toEqual([org.id])
    expect(await orgClassOf(org.id)).toBe("demo")
    expect(await orgClassOf(other.id)).toBe("standard")
    expect(await listed(window())).not.toContain(org.id)
    expect((await purgeDemoOrg(org.id, new Date(), noStorage)).purged).toBe(true)
  })

  it("never takes an org outside the window, billed, control plane made, the operator's, or not a visitor's", async () => {
    const outside = await windowOrg()
    await sql`UPDATE kernel.organizations SET created_at = now() - interval '2 hours' WHERE id = ${outside.id}`
    const after = await windowOrg()
    await sql`UPDATE kernel.organizations SET created_at = now() + interval '2 hours' WHERE id = ${after.id}`
    const billed = await windowOrg()
    await seedOrgBillingState(billed.id)
    const made = await windowOrg()
    await claimOutcome(CLOUD_CREATE_ORG_ENDPOINT, made.slug, "owner")
    const customer = await customerWithForgedMarker(expired())
    await sql`DELETE FROM kernel.org_billing_state WHERE org_id = ${customer.id}`
    const reserved = await makeOrg({ slug: visitorSlug() })
    await markOrgAsDemo(reserved.id, reservedMarker())
    const malformed = await makeOrg({ slug: visitorSlug() })
    await sql`UPDATE kernel.organizations SET settings = '{"demo":{"variant":"visitor"}}' WHERE id = ${malformed.id}`
    const operator = await windowOrg()
    const mutable = env as { LIAISON_OPERATOR_ORG_ID?: string }
    const saved = mutable.LIAISON_OPERATOR_ORG_ID
    mutable.LIAISON_OPERATOR_ORG_ID = operator.id
    try {
      const before = [outside, after, billed, made, customer, reserved, malformed, operator]
      const taken = await listed([...window(), "--apply"])
      for (const org of before) {
        expect(taken).not.toContain(org.id)
        expect(await orgClassOf(org.id)).toBe("standard")
      }
    } finally {
      mutable.LIAISON_OPERATOR_ORG_ID = saved
    }
    await sql`DELETE FROM kernel.cloud_request_outcomes WHERE idem_key = ${made.slug}`
  })

  it("refuses with demo mode off, in the managed edition, and without a whole window", async () => {
    const org = await windowOrg()
    DemoModeTestAccess.set(false)
    expect((await runDemoReclassifyCli([...window(), "--apply"])).exitCode).toBe(2)
    DemoModeTestAccess.set(true)
    _setEdition("managed")
    try {
      expect((await runDemoReclassifyCli([...window(), "--apply"])).exitCode).toBe(2)
    } finally {
      _setEdition(null)
    }
    for (const argv of [
      ["--since", at(-HOUR), "--apply"],
      ["--since", "2026-11-24", "--until", at(HOUR), "--apply"],
      ["--since", at(HOUR), "--until", at(-HOUR), "--apply"],
      [...window(), "--org", "acme", "--apply"],
      [...window(), "--all"],
    ]) {
      expect((await runDemoReclassifyCli(argv)).exitCode).toBe(2)
    }
    expect(await orgClassOf(org.id)).toBe("standard")
  })
})
