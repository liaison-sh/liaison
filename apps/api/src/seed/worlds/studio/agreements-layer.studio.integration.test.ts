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
import { withPrivilegedDb } from "~/db/privileged"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { aggregateAttentionItems } from "~/modules/apps/attention-aggregator"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { evaluateSendGuard, type PinnedSendGuard } from "~/modules/mail/send-guard"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { rowsOf } from "~/seed/factories/people/actors"
import { seedDemoWorld } from "~/seed/tiers/demo/seed-demo"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { STUDIO_SOW_EXCLUSIONS, studioAgreementNumber, studioAgreements } from "./agreements"

const DB_URL = process.env.DATABASE_URL ?? ""
/** The board date: Monday 9 November 2026, 09:30 in Paris. */
const BOARD_DATE = new Date(Date.UTC(2026, 10, 9, 8, 30))
const PLAN = studioAgreements(BOARD_DATE)

let orgId = ""
let ownerId = ""

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
  await installFromDist("invoicing", crypto.randomUUID())
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

  it("every signed row is a stand-in level", async () => {
    const levels = await rows<{ level: string; n: number }>(sql`
      SELECT e.level, count(*)::int AS n FROM app_agreements.signature_events e
       WHERE e.org_id = ${orgId}::uuid GROUP BY e.level`)
    expect(levels.map((l) => l.level)).toEqual(["demo"])
    const packages = await rows<{ level: string }>(sql`
      SELECT level FROM app_agreements.evidence_packages WHERE org_id = ${orgId}::uuid`)
    expect(packages.filter((p) => p.level !== "demo")).toEqual([])
  })

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

    const [conv] = await rows<{ account_id: string }>(sql`
      SELECT account_id::text AS account_id FROM app_mail.conversations
       WHERE id = ${guard.conversationId}::uuid`)
    const client = guard.addresses[0] as string
    await withPrivilegedDb(orgId, "studio-agreements-layer:new-mail", (tx) =>
      tx.execute(sql`
        INSERT INTO app_mail.messages (
          org_id, conversation_id, account_id, external_message_id, message_references,
          from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body, snippet,
          is_read, is_starred, labels, direction, owner_type, sent_at, synced_at, raw_headers
        ) VALUES (
          ${orgId}::uuid, ${guard.conversationId}::uuid, ${conv?.account_id}::uuid,
          ${`later-${crypto.randomUUID()}`}, '[]'::jsonb,
          ${JSON.stringify({ name: "Client", email: client })}::jsonb, '[]'::jsonb,
          '[]'::jsonb, '[]'::jsonb, 'Re: one more thing', 'Also, one question first.',
          'Also, one question first.', false, false, '["INBOX"]'::jsonb, 'inbound', 'org',
          now(), now(), '{}'::jsonb
        )`),
    )
    const stopped = await check()
    expect(stopped.state).toBe("replied")
  })
})
