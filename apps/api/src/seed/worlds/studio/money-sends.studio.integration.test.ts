// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The services world's money, done by its people through the real tool path (sandbox, bridge,
// RLS), on a freshly seeded world:
//  - finance sends an issued invoice to its client from the mailbox chosen in Settings, Invoicing,
//    with the month's timesheet filed on it: one mail, the invoice and its annex;
//  - a person whose role may not use that mailbox is told so in a person's words (422), never a
//    server error, and nothing is sent;
//  - the project lead, who holds the schedule tool's scope but not the invoicing settings, raises a
//    retainer's included hours: the change completes, its dates in the issuer's zone.
//
// Run it from `apps/api`:
//   bun run scripts/test-run.ts demo-seed --file src/seed/worlds/studio/money-sends.studio.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEMO_WORLD_NEEDS } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import type { SmtpSendParams } from "~/modules/apps/sandbox/smtp-bridge"
import { APP_TOOL_ERROR_STATUS } from "~/modules/apps/tool-error-status"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { rowsOf } from "~/seed/factories/people/actors"
import { seedDemoWorld } from "~/seed/tiers/demo/seed-demo"
import {
  activeAppNames,
  installFromDist,
  uninstallAppsSince,
} from "../../../../test-support/seed/install-dist-apps"

const DB_URL = process.env.DATABASE_URL ?? ""
/** The board date: Monday 9 November 2026, 09:30 in Paris. */
const BOARD_DATE = new Date("2026-11-09T08:30:00.000Z")

let orgId = ""
const people = new Map<string, string>()
const sent: Array<{ identifier: string; message: SmtpSendParams }> = []

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return withPrivilegedDb(orgId, "studio-money-sends", async (tx) =>
    rowsOf<T>(await tx.execute(query)),
  )
}

/** A person of the world as they act on the REST path: their own scopes and grants. */
async function personActor(key: string): Promise<UserContext & { actorType: "user" }> {
  const userId = people.get(key)
  if (!userId) throw new Error(`no person ${key}`)
  const perms = await withPrivilegedDb(orgId, "studio-money-sends-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants ?? {},
  }
}

async function call(key: string, toolName: string, params: Record<string, unknown>) {
  const actor = await personActor(key)
  return executeTool({ toolName, orgId, actor, params, origin: "human-ui" })
}

/** The code and HTTP status of a refused call, or null when it completed. */
async function refusal(
  promise: Promise<unknown>,
): Promise<{ code: string; status: number } | null> {
  try {
    await promise
    return null
  } catch (err) {
    const code = String((err as { code?: unknown }).code ?? "")
    return { code, status: APP_TOOL_ERROR_STATUS[code] ?? 500 }
  }
}

/** The apps active before the world seed: the ones it adds are removed after the file. */
let appsBeforeSeed = new Set<string>()

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database")
  }
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(
      mkdtempSync(path.join(tmpdir(), "studio-money-sends-")),
      "apps",
    )
  }
  await initSandboxPool()
  await installFromDist("invoicing", crypto.randomUUID())
  // What the world seed installs from the catalog (its needs name the agreements app).
  appsBeforeSeed = await activeAppNames()
  const slug = `studio-sends-${crypto.randomUUID().slice(0, 8)}`
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
  await ensureAppsForOrg(orgId)
  for (const p of await rows<{ email: string; id: string }>(
    sql`SELECT email, id::text AS id FROM kernel.users WHERE org_id = ${orgId}::uuid`,
  )) {
    people.set(p.email.split("@")[0] as string, p.id)
  }
  // Not a demo instance from here on: a send goes to the transport, which this test holds.
  DemoModeTestAccess.set(null)
  SandboxBridgeTestAccess.setSmtpSend(async (_connection, identifier, message) => {
    sent.push({ identifier, message: message as SmtpSendParams })
    return { messageId: `<sent-${sent.length}@test.example>`, deliveryState: "delivered" }
  })
}, 900_000)

afterAll(async () => {
  await uninstallAppsSince(appsBeforeSeed)
  SandboxBridgeTestAccess.setSmtpSend(null)
  await shutdownSandboxPool()
  resetAppRegistries()
  DemoModeTestAccess.set(null)
})

describe("sending the services world's invoices", () => {
  it("finance sends an issued invoice and its timesheet in one mail from the mailbox Settings names", async () => {
    const [issuer] = await rows<{ mail_account_id: string | null; email: string | null }>(sql`
      SELECT p.mail_account_id::text AS mail_account_id, a.email_address AS email
        FROM app_invoicing.issuer_profiles p
        LEFT JOIN app_mail.accounts a ON a.id = p.mail_account_id
       WHERE p.org_id = ${orgId}::uuid`)
    expect(issuer?.mail_account_id).toBeTruthy()
    const [doc] = await rows<{
      id: string
      number: string
      project_id: string
      period: string
      email: string
    }>(sql`
      SELECT d.id::text AS id, d.number, d.billing_project_id::text AS project_id,
             to_char(d.service_period_start, 'YYYY-MM') AS period, c.email
        FROM app_invoicing.documents d
        JOIN kernel.contacts c ON c.id = d.counterparty_contact_id
       WHERE d.org_id = ${orgId}::uuid AND d.type = 'invoice' AND d.status = 'issued'
         AND d.billing_project_id IS NOT NULL AND d.service_period_start IS NOT NULL
         AND c.email IS NOT NULL
       ORDER BY d.issued_at DESC LIMIT 1`)
    if (!doc) throw new Error("the world has no issued invoice for a project's month")

    const exported = (await call("anais", "projects:timesheet_export", {
      projectId: doc.project_id,
      month: doc.period,
      format: "pdf",
      acceptPartial: true,
    })) as { data: { fileId?: string } }
    const fileId = exported.data.fileId as string
    expect(fileId).toBeTruthy()
    await call("anais", "invoicing:document_attachment_add", {
      documentId: doc.id,
      fileId,
      kind: "timesheet",
    })

    const before = sent.length
    await call("anais", "invoicing:documents_send_to_customer", { document_id: doc.id })
    const mails = sent.slice(before)
    expect(mails).toHaveLength(1)
    const mail = mails[0] as (typeof sent)[number]
    expect(mail.identifier).toBe(issuer?.email as string)
    expect(JSON.stringify(mail.message.to)).toContain(doc.email)
    // The invoice's own PDF and the timesheet filed on it.
    expect(mail.message.attachments?.length).toBe(2)
    const [record] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM app_mail.messages
       WHERE org_id = ${orgId}::uuid AND account_id = ${issuer?.mail_account_id}::uuid
         AND direction = 'outbound'`)
    expect(record?.n).toBe(1)
  })

  it("a person whose role may not use that mailbox is told so in a person's words and nothing is sent", async () => {
    const [doc] = await rows<{ id: string }>(sql`
      SELECT d.id::text AS id FROM app_invoicing.documents d
        JOIN kernel.contacts c ON c.id = d.counterparty_contact_id
       WHERE d.org_id = ${orgId}::uuid AND d.type = 'invoice' AND d.status = 'issued'
         AND c.email IS NOT NULL
       ORDER BY d.issued_at ASC LIMIT 1`)
    if (!doc) throw new Error("the world has no issued invoice")
    const before = sent.length
    const refused = await refusal(
      call("romain", "invoicing:documents_send_to_customer", { document_id: doc.id }),
    )
    expect(refused).toEqual({ code: "mailbox_unavailable", status: 422 })
    expect(sent.length).toBe(before)
  })
})

describe("a retainer's terms changed by the project lead", () => {
  it("the lead raises the included hours and the change completes", async () => {
    const [schedule] = await rows<{ id: string; version: number; minutes: number }>(sql`
      SELECT id::text AS id, version, retainer_minutes AS minutes
        FROM app_invoicing.recurring_schedules
       WHERE org_id = ${orgId}::uuid AND retainer_minutes IS NOT NULL LIMIT 1`)
    if (!schedule) throw new Error("the world has no retainer")
    const lead = await personActor("bastien")
    expect(lead.scopes).not.toContain("invoicing:settings:read")
    const out = (await call("bastien", "invoicing:recurring_schedule_update", {
      id: schedule.id,
      expected_version: schedule.version,
      retainer_minutes: schedule.minutes + 600,
    })) as { data: { status?: string } }
    expect(out.data.status).toBe("completed")
    const [after] = await rows<{ minutes: number; version: number }>(sql`
      SELECT retainer_minutes AS minutes, version FROM app_invoicing.recurring_schedules
       WHERE id = ${schedule.id}::uuid`)
    expect(after).toEqual({ minutes: schedule.minutes + 600, version: schedule.version + 1 })
  })
})
