// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The services world's agreements at the board date, read through the agreements app's own
// tools on a freshly seeded workspace, as the owner: the list, the signed text a change request
// quotes, the stand-in level of every seeded signature, and the change request card whose mail
// check a new mail from the client stops.
import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEMO_WORLD_NEEDS } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { app } from "~/app"
import { withPortalContext } from "~/db/portal-rls"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { activeVersionRows } from "~/modules/apps/activation"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { aggregateAttentionItems } from "~/modules/apps/attention-aggregator"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { uninstallApp } from "~/modules/apps/install-service"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { registerTranslatorConsumer } from "~/modules/attention/translator"
import { createPortalSession, createSession } from "~/modules/auth/auth"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { evaluateSendGuard, type PinnedSendGuard } from "~/modules/mail/send-guard"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { seedContext } from "~/seed/context"
import { insertUnarmedMail } from "~/seed/factories/mail/conversations"
import { rowsOf } from "~/seed/factories/people/actors"
import { seedDemoWorld } from "~/seed/tiers/demo/seed-demo"
import { drainOutbox } from "~/tests/helpers/outbox"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { STUDIO_SOW_EXCLUSIONS, studioAgreementNumber, studioAgreements } from "./agreements"
import { STUDIO_KNOWLEDGE_SPECS, STUDIO_PAST_SIGN_ON_HOURS } from "./knowledge"
import { studioMoney } from "./money"
import { STUDIO_PORTAL_CLIENT } from "./portal"

const DB_URL = process.env.DATABASE_URL ?? ""
/** The board date: Monday 9 November 2026, 09:30 in Paris. */
const BOARD_DATE = new Date(Date.UTC(2026, 10, 9, 8, 30))
const PLAN = studioAgreements(BOARD_DATE)

let orgId = ""
let ownerId = ""
/** Whether this file installed the app: a later file in the same process must not inherit it. */
let installedAgreements = false

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return withPrivilegedDb(orgId, "studio-agreements-layer", async (tx) =>
    rowsOf<T>(await tx.execute(query)),
  )
}

async function ownerActor() {
  const perms = await withPrivilegedDb(orgId, "studio-agreements-layer-perms", (tx) =>
    loadEffectivePermissions(tx, ownerId, orgId),
  )
  return {
    actorType: "user" as const,
    userId: ownerId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants ?? {},
  }
}

async function asOwner<T = Record<string, any>>(toolName: string, params: Record<string, unknown>) {
  const perms = await withPrivilegedDb(orgId, "studio-agreements-layer-perms", (tx) =>
    loadEffectivePermissions(tx, ownerId, orgId),
  )
  const out = (await executeTool({
    toolName,
    orgId,
    actor: {
      actorType: "user",
      userId: ownerId,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants ?? {},
    },
    params,
    origin: "human-ui",
  })) as { data: T }
  return out.data
}

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database")
  }
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "studio-agreements-")),
      "apps",
    )
  }
  await initSandboxPool()
  registerTranslatorConsumer()
  await installFromDist("invoicing", crypto.randomUUID())
  installedAgreements =
    (await withSystemDb("test-agreements-layer", (db) => activeVersionRows(db, "agreements")))
      .length === 0
  await installFromDist("agreements", crypto.randomUUID())
  const slug = `studio-agr-${crypto.randomUUID().slice(0, 8)}`
  const result = await seedDemoWorld({
    orgSlug: slug,
    variant: "visitor",
    locale: "en",
    owner: { email: `owner@${slug}.example`, name: "Studio Owner", password: "StudioOwner1!Seed" },
    worldId: "studio",
    needs: [...DEMO_WORLD_NEEDS.studio],
    baseTime: BOARD_DATE,
  })
  expect(result.failures).toEqual([])
  orgId = result.orgId
  ownerId = result.org.ownerUserId ?? result.org.adminUserId
  await ensureAppsForOrg(orgId)
}, 900_000)

afterAll(async () => {
  // The install is instance-wide: left in place, every org a later file seeds holds the app.
  if (installedAgreements) await uninstallApp({ name: "agreements" })
  await shutdownSandboxPool()
  resetAppRegistries()
  DemoModeTestAccess.set(null)
})

describe("the services world's agreements at the board date", () => {
  it("the list holds the board's agreements, with the two waiting for a signature first", async () => {
    const out = await asOwner<{ total: number; items: Array<{ number: string; needs: string }> }>(
      "agreements:agreements_search",
      { limit: 50 },
    )
    expect(out.total).toBe(PLAN.agreements.length)
    expect(out.items.map((i) => i.number).sort()).toEqual(
      PLAN.agreements.map((a) => studioAgreementNumber(PLAN.year, a)).sort(),
    )
    const waiting = out.items.filter((i) => i.needs === "waiting for signatures")
    expect(waiting.map((i) => i.number)).toEqual(
      expect.arrayContaining([
        studioAgreementNumber(PLAN.year, { series: "AG", seq: 14 }),
        studioAgreementNumber(PLAN.year, { series: "AG", seq: 15 }),
      ]),
    )
    expect(out.items.slice(0, 2).every((i) => i.needs === "waiting for signatures")).toBe(true)
  })

  it("the change request card is one pending approval keyed on the client's mail, so three items need someone", async () => {
    const cards = await rows<{ key: string | null }>(sql`
      SELECT tool_params->>'mail_message_id' AS key FROM kernel.approval_requests
       WHERE org_id = ${orgId}::uuid AND tool_name = 'agreements:change_request_send'
         AND status = 'pending'`)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.key).toBeTruthy()
    const out = await asOwner<{ items: Array<{ needs: string }> }>("agreements:agreements_search", {
      limit: 50,
    })
    const needSomeone = out.items.filter((i) => i.needs !== "signed" && i.needs !== "closed").length
    expect(needSomeone + cards.length).toBe(3)
  })

  it("the signed statement of work quotes its exclusions word for word", async () => {
    const [version] = await rows<{ id: string }>(sql`
      SELECT v.id::text AS id FROM app_agreements.agreement_versions v
        JOIN app_agreements.agreements a ON a.id = v.agreement_id
       WHERE a.org_id = ${orgId}::uuid
         AND a.number = ${studioAgreementNumber(PLAN.year, { series: "AG", seq: 11 })}`)
    expect(version?.id).toBeTruthy()
    const out = await asOwner<{ passage: { section: string; text: string } }>(
      "agreements:agreement_passage_get",
      { version_id: version?.id, section: "3" },
    )
    expect(out.passage.text).toBe(STUDIO_SOW_EXCLUSIONS)
    expect(out.passage.text).toContain("single sign-on")
  })

  it("the past projects' notes in Knowledge hold the sign-on hours the change request is sized from", async () => {
    const hours: number[] = []
    for (const article of STUDIO_KNOWLEDGE_SPECS.articles) {
      const found = await asOwner<{ found: boolean; document: { id: string } | null }>(
        "knowledge:find_by_title",
        { title: article.title },
      )
      expect(found.found).toBe(true)
      const doc = await asOwner("knowledge:get", { id: found.document?.id })
      const h = Number(/took (\d+) h of real time/.exec(JSON.stringify(doc))?.[1])
      hours.push(h)
    }
    expect(hours).toEqual([STUDIO_PAST_SIGN_ON_HOURS.brume, STUDIO_PAST_SIGN_ON_HOURS.osier])
    const mean = (hours[0]! + hours[1]!) / 2
    expect(PLAN.changeRequest.hoursMinutes).toBe(mean * 60)
    expect(PLAN.changeRequest.hoursSource).toContain(`${mean} h on average`)
  })

  it("every signed row is a stand-in level", async () => {
    const levels = await rows<{ level: string; n: number }>(sql`
      SELECT e.level, count(*)::int AS n FROM app_agreements.signature_events e
       WHERE e.org_id = ${orgId}::uuid GROUP BY e.level`)
    expect(levels.map((l) => l.level)).toEqual(["demo"])
    const packages = await rows<{ level: string }>(sql`
      SELECT level FROM app_agreements.evidence_packages WHERE org_id = ${orgId}::uuid`)
    expect(packages.filter((p) => p.level !== "demo")).toEqual([])
  })

  it("the seal retry over the stand-in signatures writes stand-in records and raises no seal-overdue line", async () => {
    // Every seeded signature was given days before now, so an unsealed one is past its hour.
    const handler = JobsTestAccess.getHandler("agreements", "seal-retry")
    if (!handler) throw new Error("seal-retry is not registered")
    for (let pass = 0; pass < 2; pass++) {
      await dispatchAppJobWithContext(
        handler,
        { orgId },
        { actorType: "system", orgId, purpose: "job", scopes: ["agreements:*"] },
        "session",
      )
      await drainOutbox()
    }
    const signed = await rows<{ id: string }>(sql`
      SELECT v.id::text AS id FROM app_agreements.agreement_versions v
       WHERE v.org_id = ${orgId}::uuid AND v.status = 'signed'`)
    expect(signed.length).toBeGreaterThan(0)
    const packages = await rows<{
      level: string
      seal: string | null
      signed_pdf_file_id: string | null
      evidence_file_id: string | null
      tsr_file_id: string | null
      timestamped_at: string | null
    }>(sql`
      SELECT level, seal, signed_pdf_file_id::text, evidence_file_id::text, tsr_file_id::text,
             timestamped_at::text
        FROM app_agreements.evidence_packages WHERE org_id = ${orgId}::uuid`)
    expect(packages).toHaveLength(signed.length)
    for (const p of packages) {
      expect(p).toEqual({
        level: "demo",
        seal: null,
        signed_pdf_file_id: null,
        evidence_file_id: null,
        tsr_file_id: null,
        timestamped_at: null,
      })
    }
    const [copies] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM app_agreements.copy_mails WHERE org_id = ${orgId}::uuid`)
    expect(copies?.n).toBe(0)
    const overdue = await rows<{ number: string }>(sql`
      SELECT number FROM app_agreements.agreements
       WHERE org_id = ${orgId}::uuid AND seal_overdue_at IS NOT NULL`)
    expect(overdue).toEqual([])
    // No Home line for anyone who reads the evidence.
    const lines = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM kernel.attention_events
       WHERE org_id = ${orgId}::uuid AND kind = 'agreements:evidence.seal_overdue'`)
    expect(lines[0]?.n).toBe(0)
  }, 120_000)

  it("the next agreement a person makes takes the next number of its series", async () => {
    const [seq] = await rows<{ value: number }>(sql`
      SELECT value::int AS value FROM kernel.app_sequences
       WHERE org_id = ${orgId}::uuid AND app_id = 'agreements'
         AND key = ${`agreements:AG:${PLAN.year}`}`)
    expect(seq?.value).toBe(15)
  })

  it("Home at the board date counts the change request card as the owner's one decision", async () => {
    const actor = await ownerActor()
    setSystemTime(BOARD_DATE)
    try {
      const feed = await aggregateAttentionItems({ orgId, actor })
      expect(feed.errors ?? []).toEqual([])
      const counted = feed.items.filter(
        (i) => i.kind === "approval_pending" && i.metadata?.uncounted !== true,
      )
      // The owner's one decision at the board date is the card: the world's other Home lines
      // reach the lead and finance, not the owner.
      expect(counted).toHaveLength(1)
      expect(counted.map((i) => i.metadata?.toolName)).toContain("agreements:change_request_send")
    } finally {
      setSystemTime()
    }
  })

  it("the change request card's guard stops on a new client mail", async () => {
    const [card] = await rows<{ guard: PinnedSendGuard }>(sql`
      SELECT current_payload->'sendGuard' AS guard FROM kernel.approval_requests
       WHERE org_id = ${orgId}::uuid AND tool_name = 'agreements:change_request_send'`)
    const guard = card?.guard as PinnedSendGuard
    expect(guard.conversationId).toBeTruthy()
    const check = () => evaluateSendGuard({ orgId, guard, recipients: guard.addresses, at: "card" })
    expect((await check()).state).toBe("clear")

    // The client writes again in the same conversation, through the mail factory: the card's
    // conversation and its first message are adopted, the second one is new.
    const [box] = await rows<{ email: string; name: string | null }>(sql`
      SELECT a.email_address AS email, a.display_name AS name FROM app_mail.conversations c
        JOIN app_mail.accounts a ON a.id = c.account_id
       WHERE c.id = ${guard.conversationId}::uuid`)
    const cr = PLAN.changeRequest
    const client = { name: "Client", email: guard.addresses[0] as string }
    const mailbox = { name: box?.name ?? "", email: box?.email ?? "" }
    const ctx = seedContext({ orgId, now: BOARD_DATE, log: () => {} })
    const { conversationIds } = await insertUnarmedMail(ctx, {
      domain: mailbox.email.split("@")[1] ?? "",
      mailboxes: [
        { box: "org", ownerUserId: null, email: mailbox.email, displayName: mailbox.name },
      ],
      conversations: [
        {
          key: `studio:${cr.key}`,
          box: "org",
          subject: cr.mailSubject,
          status: "open",
          labels: ["INBOX"],
          isRead: false,
          isStarred: false,
          messages: [
            {
              direction: "inbound",
              fromName: client.name,
              fromEmail: client.email,
              toName: mailbox.name,
              toEmail: mailbox.email,
              hoursAgo: (BOARD_DATE.getTime() - cr.mailAt.getTime()) / 3_600_000,
              body: cr.mailBody,
            },
            {
              direction: "inbound",
              fromName: client.name,
              fromEmail: client.email,
              toName: mailbox.name,
              toEmail: mailbox.email,
              hoursAgo: 0,
              body: "Also, one question first.",
            },
          ],
        },
      ],
    })
    expect(conversationIds).toEqual([guard.conversationId as string])
    const stopped = await check()
    expect(stopped.state).toBe("replied")
  })
})

describe("the services world's client portal at the board date", () => {
  type Person = { user_id: string; name: string; user_type: string; company: string }
  const people = () =>
    rows<Person & { last_sign_in_at: string | null; sessions: number }>(sql`
      SELECT p.user_id::text AS user_id, u.name, u.user_type, c.name AS company,
             p.last_sign_in_at::text AS last_sign_in_at,
             (SELECT count(*)::int FROM kernel.sessions s WHERE s.user_id = u.id) AS sessions
        FROM kernel.portal_people p
        JOIN kernel.users u ON u.id = p.user_id
        JOIN kernel.companies c ON c.id = p.company_id
       WHERE p.org_id = ${orgId}::uuid AND p.removed_at IS NULL
       ORDER BY u.name`)
  const companyOf = async () =>
    (
      await rows<{ id: string }>(sql`
        SELECT DISTINCT p.company_id::text AS id FROM kernel.portal_people p
         WHERE p.org_id = ${orgId}::uuid`)
    )[0]?.id as string

  async function preview(userId: string) {
    const { accessToken } = await createSession(ownerId, orgId)
    const res = await app.request(
      `/api/contacts/companies/${await companyOf()}/portal/preview/${userId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: { signedInWouldSee: Record<string, any[] | null> } }).data
      .signedInWouldSee
  }

  it("the fixed-price client's two people are its portal users, invited and never signed in", async () => {
    const found = await people()
    expect(found.map((p) => [p.name, p.user_type, p.last_sign_in_at, p.sessions])).toEqual([
      ["Pauline Gros", "external", null, 0],
      ["Rémi Castel", "external", null, 0],
    ])
    expect(new Set(found.map((p) => p.company)).size).toBe(1)
    const [client] = await rows<{ key: string }>(sql`
      SELECT ${STUDIO_PORTAL_CLIENT}::text AS key FROM kernel.companies
       WHERE id = ${await companyOf()}::uuid AND name = ${found[0]?.company ?? ""}`)
    expect(client?.key).toBe(STUDIO_PORTAL_CLIENT)
  })

  it("only the project's progress and reports, invoices, requests and three agreements are open; hours and files stay closed", async () => {
    const shares = await rows<{ kind: string; named: number | null }>(sql`
      SELECT kind, cardinality(only_user_ids)::int AS named FROM kernel.portal_shares
       WHERE org_id = ${orgId}::uuid AND closed_at IS NULL ORDER BY kind, named NULLS FIRST`)
    expect(shares.map((s) => [s.kind, s.named])).toEqual([
      ["agreement", null],
      ["agreement", null],
      ["agreement", 1],
      ["invoices", null],
      ["project_progress", null],
      ["project_reports", null],
      ["requests", null],
    ])
  })

  it("the client access preview reads the paid invoices and the milestones still to bill, as the portal does", async () => {
    const [pauline] = await people()
    const seen = await preview(pauline?.user_id as string)
    const paid = (seen.invoices ?? [])
      .filter((i) => i.payment_status === "paid")
      .reduce((sum, i) => sum + Number(i.grand_total_minor), 0)
    expect(paid).toBe(5_376_000)
    const plan = studioMoney(BOARD_DATE)
    expect((seen.upcoming ?? []).map((u) => [u.label, Number(u.amount_minor)]).sort()).toEqual(
      plan.steps
        .filter((s) => s.state === "planned" || s.state === "drafted")
        .map((s) => [s.label, s.amountMinor])
        .sort(),
    )
    expect((seen.projects ?? []).map((p) => p.name)).toEqual(["Partner portal rebuild"])
  })

  it("the mutual NDA reaches the person it is named to and not the other", async () => {
    const nda = studioAgreementNumber(PLAN.year, { series: "AG", seq: 2 })
    // The portal's own read of agreements, as each person.
    const seenBy = (userId: string) =>
      withPortalContext({ orgId, userId }, async (tx) =>
        rowsOf<{ number: string }>(await tx.execute(sql`SELECT number FROM portal.agreements`)).map(
          (r) => r.number,
        ),
      )
    const [pauline, remi] = await people()
    expect(await seenBy(pauline?.user_id as string)).toContain(nda)
    expect(await seenBy(remi?.user_id as string)).not.toContain(nda)
    expect((await seenBy(remi?.user_id as string)).sort()).toEqual(
      [
        studioAgreementNumber(PLAN.year, { series: "AG", seq: 11 }),
        studioAgreementNumber(PLAN.year, { series: "AG", seq: 15 }),
      ].sort(),
    )
  })

  it("the waiting addendum reads with its text on the portal and its signer holds the open link, unmailed", async () => {
    const dpa = studioAgreementNumber(PLAN.year, { series: "AG", seq: 15 })
    const [pauline, remi] = await people()
    const [row] = await rows<{ id: string }>(sql`
      SELECT id::text AS id FROM app_agreements.agreements
       WHERE org_id = ${orgId}::uuid AND number = ${dpa}`)
    const read = async (userId: string) => {
      const { accessToken } = await createPortalSession(userId, orgId)
      const res = await app.request(`/api/portal/documents/${row?.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      expect(res.status).toBe(200)
      return (
        (await res.json()) as {
          data: {
            versions: Array<{ source: { body: { blocks: Array<{ text: string }> } } }>
            actions: Array<{ mine: boolean; kind: string; decidedAt: string | null }>
          }
        }
      ).data
    }
    const mine = await read(pauline?.user_id as string)
    const text = mine.versions[0]?.source.body.blocks.map((b) => b.text).join("\n") ?? ""
    expect(text).toContain("Personal data stays in the European Union.")
    expect(mine.actions.map((a) => [a.kind, a.mine, a.decidedAt])).toEqual([["sign", true, null]])
    // A colleague sees who it waits on, and has nothing to decide.
    expect((await read(remi?.user_id as string)).actions.map((a) => a.mine)).toEqual([false])
    // The link was never mailed by the seed: no event says it was sent.
    const events = await rows<{ event: string }>(sql`
      SELECT e.event FROM kernel.client_action_events e
        JOIN kernel.client_actions a ON a.id = e.action_id
        JOIN app_agreements.agreement_versions v ON v.id = a.target_id
       WHERE a.org_id = ${orgId}::uuid AND v.agreement_id = ${row?.id}::uuid`)
    expect(events.map((e) => e.event)).toEqual(["created"])
  })
})
