// SPDX-License-Identifier: FSL-1.1-ALv2
// The services world's client scenario, from the approved card on: on a demo box
// the change request's link is recorded sent to the fictional client, then the
// world beat records her approval as a stand-in. The agreements app's own
// handler accepts the change request and runs its effects; the seal records a
// stand-in, with no seal key and no timestamp request, and no Home line asks
// for a seal afterwards. Two clicks on the world beat accept once.
import { afterAll, beforeAll, describe, expect, it, setSystemTime, spyOn } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  DEMO_WORLD_NEEDS,
  STUDIO_CLIENT_CFG,
  STUDIO_CLIENT_PROJECT_NAME,
  scenarioStudioClientTour,
} from "@liaison/shared"
import { sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { tourProgress } from "~/db/schema/kernel"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { decideApproval } from "~/modules/approvals/decide"
import { activeVersionRows } from "~/modules/apps/activation"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { aggregateAttentionItems } from "~/modules/apps/attention-aggregator"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { uninstallApp } from "~/modules/apps/install-service"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { registerTranslatorConsumer } from "~/modules/attention/translator"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { demoWorldOf, loadDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { runWorldBeatOnce } from "~/modules/demo/world/registry"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as sealModule from "~/modules/signing/seal"
import * as timestampModule from "~/modules/signing/timestamp"
import { rowsOf } from "~/seed/factories/people/actors"
import { seedDemoWorld } from "~/seed/tiers/demo/seed-demo"
import { STAND_IN_CONSENT_WORDS, studioAgreements } from "~/seed/worlds/studio/agreements"
import { studioPlan } from "~/seed/worlds/studio/plan"
import { drainOutbox } from "~/tests/helpers/outbox"
import { installFromDist } from "../../../../../test-support/seed/install-dist-apps"
import { acceptWorldChangeRequest, worldChangeRequestAction } from "./cr-accepted"

const DB_URL = process.env.DATABASE_URL ?? ""
/** The board date: Monday 9 November 2026, 09:30 in Paris. */
const BOARD_DATE = new Date(Date.UTC(2026, 10, 9, 8, 30))
const CR = studioAgreements(BOARD_DATE).changeRequest
const TOUR_ID = scenarioStudioClientTour.id
const WORLD_BEAT = "client-decides"

let orgId = ""
let ownerId = ""
let installedAgreements = false
let outcomes: string[] = []
/** The world the seed recorded on the workspace's marker, before the door's own marking. */
let seededWorld = ""
/** What a refused world beat left behind: its error and the stand-in events it wrote. */
const refusals: Record<string, { error: string; standIns: number; decided: boolean }> = {}

/** The `demo` signature events on the change request's sent version. */
async function standInsOf(versionId: string): Promise<number> {
  const [n] = await rows<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM app_agreements.signature_events
     WHERE version_id = ${versionId}::uuid AND level = 'demo'`)
  return n?.n ?? 0
}

/** Run the world's acceptance, expecting a refusal; record what it left. */
async function refusedAcceptance(name: string, versionId: string): Promise<void> {
  let error = ""
  try {
    await acceptWorldChangeRequest(orgId)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  refusals[name] = {
    error,
    standIns: await standInsOf(versionId),
    decided: (await worldChangeRequestAction(orgId))?.decided ?? true,
  }
}
const spies: Array<ReturnType<typeof spyOn>> = []

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return withPrivilegedDb(orgId, "test-studio-cr-accepted", async (tx) =>
    rowsOf<T>(await tx.execute(query)),
  )
}

async function ownerActor() {
  const perms = await withPrivilegedDb(orgId, "test-studio-cr-accepted-perms", (tx) =>
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

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database")
  }
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(mkdtempSync(path.join(tmpdir(), "studio-cr-")), "apps")
  }
  await initSandboxPool()
  registerTranslatorConsumer()
  await installFromDist("invoicing", crypto.randomUUID())
  installedAgreements =
    (await withSystemDb("test-studio-cr-accepted", (db) => activeVersionRows(db, "agreements")))
      .length === 0
  await installFromDist("agreements", crypto.randomUUID())
  const slug = `studio-cr-${crypto.randomUUID().slice(0, 8)}`
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
  seededWorld = demoWorldOf(
    await withPrivilegedDb(orgId, "test-studio-cr-marker", (tx) => loadDemoMarker(orgId, tx)),
  )
  // As the door marks a visitor's workspace: of the services world.
  await markOrgAsDemo(
    orgId,
    visitorMarker(24, new Date(), [...DEMO_WORLD_NEEDS.studio], { worldId: "studio" }),
  )
  await ensureAppsForOrg(orgId)

  // Beat 4: the visitor approves the one card on Home.
  const [card] = await rows<{ id: string }>(sql`
    SELECT id::text AS id FROM kernel.approval_requests
     WHERE org_id = ${orgId}::uuid AND tool_name = 'agreements:change_request_send'
       AND status = 'pending'`)
  if (!card) throw new Error("no change request card")
  await decideApproval({
    orgId,
    requestId: card.id,
    actor: await ownerActor(),
    decision: "approve",
  })
  await drainOutbox()
  // The link mail is sent without being awaited by the mint: give it its moment.
  await new Promise((r) => setTimeout(r, 500))
  await drainOutbox()

  // Before the beat: refused acceptances leave no stand-in on the open action.
  const open = await worldChangeRequestAction(orgId)
  if (!open) throw new Error("the change request was not sent")
  DemoModeTestAccess.set(false)
  try {
    await refusedAcceptance("notDemoBox", open.versionId)
  } finally {
    DemoModeTestAccess.set(true)
  }
  // An expired link: the demo decide refuses it as not open.
  const [{ expires } = { expires: "" }] = await rows<{ expires: string }>(sql`
    SELECT expires_at::text AS expires FROM kernel.client_actions WHERE id = ${open.actionId}::uuid`)
  await rows(sql`UPDATE kernel.client_actions SET expires_at = now() - interval '1 minute'
                  WHERE id = ${open.actionId}::uuid`)
  try {
    await refusedAcceptance("expired", open.versionId)
  } finally {
    await rows(sql`UPDATE kernel.client_actions SET expires_at = ${expires}::timestamptz
                    WHERE id = ${open.actionId}::uuid`)
  }

  // Nothing below may seal with the key or ask a timestamp authority.
  spies.push(
    spyOn(sealModule, "computeSeal"),
    spyOn(sealModule, "sealManifest"),
    spyOn(timestampModule, "requestTimestamp"),
    spyOn(timestampModule, "loadTsaConfig"),
  )

  // Beat 5: the owner stands on the world beat and clicks twice at once.
  const done = "done" as const
  const progress = {
    status: "active" as const,
    beatId: WORLD_BEAT,
    beatIndex: 4,
    beatStates: {
      "more-than-signed": done,
      "read-scope": done,
      "open-agreement": done,
      "approve-cr": done,
    },
  }
  await withPrivilegedDb(orgId, "test-studio-cr-accepted-progress", (tx) =>
    tx
      .insert(tourProgress)
      .values({ orgId, userId: ownerId, tourId: TOUR_ID, source: "demo", ...progress })
      .onConflictDoUpdate({
        target: [tourProgress.orgId, tourProgress.userId, tourProgress.tourId],
        set: progress,
      }),
  )
  outcomes = await Promise.all([
    runWorldBeatOnce(orgId, ownerId, TOUR_ID),
    runWorldBeatOnce(orgId, ownerId, TOUR_ID),
  ])
  await drainOutbox()
  await drainOutbox()
}, 1_200_000)

afterAll(async () => {
  for (const s of spies) s.mockRestore()
  if (installedAgreements) await uninstallApp({ name: "agreements" })
  await shutdownSandboxPool()
  resetAppRegistries()
  DemoModeTestAccess.set(null)
})

describe("the client's acceptance in the services world", () => {
  it("the tour's card and project are the world's", () => {
    expect(STUDIO_CLIENT_CFG.cardTitle).toBe(CR.title)
    expect(studioPlan(BOARD_DATE).projects.map((p) => p.name)).toContain(STUDIO_CLIENT_PROJECT_NAME)
  })

  it("the services world's seed records its world on the workspace's demo marker", () => {
    expect(seededWorld).toBe("studio")
  })

  it("off a demo box the world beat refuses and leaves no stand-in signature on the open action", () => {
    expect(refusals.notDemoBox).toEqual({
      error: expect.stringMatching(/not a demo server.*Nothing was accepted/),
      standIns: 0,
      decided: false,
    })
  })

  it("a world beat the demo decide refuses leaves no stand-in signature on the action", () => {
    expect(refusals.expired).toEqual({
      error: expect.stringMatching(/not open|nothing more was decided/),
      standIns: 0,
      decided: false,
    })
  })

  it("on a demo box the approved card's link to the client is recorded sent, and the sender is told nothing failed", async () => {
    const action = await worldChangeRequestAction(orgId)
    expect(action).not.toBeNull()
    const [row] = await rows<{ sent: boolean; rotated: number }>(sql`
      SELECT (a.sent_at IS NOT NULL) AS sent,
             (SELECT count(*)::int FROM kernel.client_action_events e
               WHERE e.action_id = a.id AND e.event = 'rotated') AS rotated
        FROM kernel.client_actions a WHERE a.id = ${action?.actionId}::uuid`)
    expect(row).toEqual({ sent: true, rotated: 0 })
    const failed = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM kernel.attention_events
       WHERE org_id = ${orgId}::uuid AND kind LIKE '%send_failed%'`)
    expect(failed[0]?.n).toBe(0)
  })

  it("two clicks on the world beat accept once", async () => {
    expect([...outcomes].sort()).toEqual(["busy", "completed"])
    const action = await worldChangeRequestAction(orgId)
    const decided = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM kernel.client_action_events
       WHERE action_id = ${action?.actionId}::uuid AND event = 'decided'`)
    expect(decided[0]?.n).toBe(1)
    // A replay of the beat in the same run injects nothing more.
    expect(await runWorldBeatOnce(orgId, ownerId, TOUR_ID)).not.toBe("completed")
    const accepted = await rows<{ status: string }>(sql`
      SELECT status FROM app_agreements.agreements WHERE id = ${action?.agreementId}::uuid`)
    expect(accepted.map((a) => a.status)).toEqual(["accepted"])
  })

  it("the accepted change request holds one signature event, a stand-in, and its evidence record says stand-in", async () => {
    const action = await worldChangeRequestAction(orgId)
    const events = await rows<{ level: string; consent_words: string; typed_name: string }>(sql`
      SELECT level, consent_words, typed_name FROM app_agreements.signature_events
       WHERE version_id = ${action?.versionId}::uuid`)
    expect(events).toEqual([
      {
        level: "demo",
        consent_words: STAND_IN_CONSENT_WORDS,
        typed_name: action?.invitedName ?? "",
      },
    ])
    const packages = await rows<Record<string, string | null>>(sql`
      SELECT level, seal, signed_pdf_file_id::text, evidence_file_id::text, tsr_file_id::text,
             timestamped_at::text
        FROM app_agreements.evidence_packages WHERE version_id = ${action?.versionId}::uuid`)
    expect(packages).toEqual([
      {
        level: "demo",
        seal: null,
        signed_pdf_file_id: null,
        evidence_file_id: null,
        tsr_file_id: null,
        timestamped_at: null,
      },
    ])
    const copies = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM app_agreements.copy_mails WHERE org_id = ${orgId}::uuid`)
    expect(copies[0]?.n).toBe(0)
  })

  it("no timestamp request and no seal key use follow the world beat", () => {
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })

  it("after the client's acceptance the contract reads 70,600, the timebox 480 h with 134 left, a new unassigned task exists and a 6,600 line is planned on the billing plan, and nothing is issued", async () => {
    const action = await worldChangeRequestAction(orgId)
    const [cr] = await rows<{
      parent: string
      task: string | null
      billing: string | null
      done: boolean
      time_plan: string | null
      note: string | null
    }>(sql`
      SELECT parent_agreement_id::text AS parent, effects_task_id::text AS task,
             effects_billing AS billing, (effects_done_at IS NOT NULL) AS done,
             effects_time_plan AS time_plan, effects_note AS note
        FROM app_agreements.agreements WHERE id = ${action?.agreementId}::uuid`)
    // The task and the billing step are the consequence of the send the owner approved: both
    // run on that act (a call no agent turn made, so no turn's taint parks it), once.
    expect(cr?.done).toBe(true)
    expect(cr?.task).not.toBeNull()
    expect(cr?.billing).toBe("added")
    const pending = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM kernel.approval_requests
       WHERE org_id = ${orgId}::uuid AND tool_name = 'invoicing:billing_step_add'`)
    expect(pending[0]?.n).toBe(0)
    const [parent] = await rows<{ total: string }>(sql`
      SELECT amended_total_minor::text AS total FROM app_agreements.agreements
       WHERE id = ${cr?.parent}::uuid`)
    expect(parent?.total).toBe("7060000")
    // The hours as the project's budget reads them: the tool the tour's last beat reads.
    const budget = (await executeTool({
      toolName: "projects:budget_get",
      orgId,
      actor: await ownerActor(),
      params: { projectName: STUDIO_CLIENT_PROJECT_NAME },
      origin: "human-ui",
    })) as { data: { timebox?: number; left?: number } }
    expect(budget.data.timebox).toBe(480 * 60)
    expect(budget.data.left).toBe(134 * 60)
    const tasks = await rows<{ assignee: string | null }>(sql`
      SELECT assignee_id::text AS assignee FROM app_projects.tasks WHERE id = ${cr?.task}::uuid`)
    expect(tasks).toEqual([{ assignee: null }])
    // On the plan once, billed when its task is done: nothing is invoiced meanwhile.
    const steps = await rows<{ amount: string; task: string | null }>(sql`
      SELECT amount_minor::text AS amount, task_id::text AS task FROM app_invoicing.billing_steps
       WHERE org_id = ${orgId}::uuid AND change_request_ref = ${action?.agreementId}`)
    expect(steps).toEqual([{ amount: "660000", task: cr?.task ?? null }])
    const issued = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM app_invoicing.documents
       WHERE org_id = ${orgId}::uuid AND issued_at > ${BOARD_DATE.toISOString()}::timestamptz`)
    expect(issued[0]?.n).toBe(0)
  })

  it("an hour after the world beat the owner's Home holds no seal line", async () => {
    const handler = JobsTestAccess.getHandler("agreements", "seal-retry")
    if (!handler) throw new Error("seal-retry is not registered")
    setSystemTime(new Date(Date.now() + 60 * 60 * 1000))
    try {
      await dispatchAppJobWithContext(
        handler,
        { orgId },
        { actorType: "system", orgId, purpose: "job", scopes: ["agreements:*"] },
        "session",
      )
      await drainOutbox()
      const feed = await aggregateAttentionItems({ orgId, actor: await ownerActor() })
      expect(feed.items.filter((i) => /seal/i.test(String(i.kind)))).toEqual([])
      const lines = await rows<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM kernel.attention_events
         WHERE org_id = ${orgId}::uuid AND kind LIKE '%seal%'`)
      expect(lines[0]?.n).toBe(0)
    } finally {
      setSystemTime()
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })
})
