// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Issuing an invoice is a person's act. An org may set an auto-approve policy on invoicing's tools;
// an agent's `invoice_issue` must still park for a person, and take no number, under it. Proven
// through executeTool -> sandbox -> bridge on real Postgres, with the app's manifest as shipped.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { autoApprovePolicies } from "~/db/schema/kernel"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import {
  createHandlerApprovalRequest,
  executeTool,
  type ToolOrigin,
} from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

function invoicingDescriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "invoicing", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(
      REPO_ROOT,
      "bundled-apps",
      "invoicing",
      String(manifest.version),
      "bundle.js",
    ),
  }
}

const SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:contacts:read",
  "invoicing:contacts:write",
  "invoicing:settings:read",
  "invoicing:settings:write",
  "invoicing:approve",
]

let ORG = ""
let ADMIN = ""
let THREAD = ""
let actor: UserContext

interface Called {
  data?: Record<string, unknown>
  blocked?: { approvalRequestId?: string }
  error?: string
}

async function call(
  toolName: string,
  params: Record<string, unknown>,
  origin: ToolOrigin,
): Promise<Called> {
  try {
    const res = await executeTool<Record<string, unknown>>({
      toolName: `invoicing:${toolName}`,
      orgId: ORG,
      actor,
      params,
      threadId: THREAD,
      origin,
    })
    return res as Called
  } catch (err) {
    return { error: String(err) }
  }
}

async function issuedCount(): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM app_invoicing.documents
    WHERE org_id = ${ORG} AND number IS NOT NULL`
  return Number(row?.n ?? 0)
}

describe("an auto-approve policy on invoicing", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    const org = await createTestOrg()
    ORG = org.id
    const admin = await minimal.person(ORG, { role: "admin" })
    ADMIN = admin.id
    THREAD = await minimal.thread(ORG, admin.id)
    actor = { actorType: "user", userId: admin.id, orgId: ORG, scopes: SCOPES, dimensionGrants: {} }
    await initSandboxPool()
    await initWorkerPool()
    await registerApps([invoicingDescriptor() as never], ORG)
  }, 120_000)

  afterAll(async () => {
    if (ORG) {
      await withPrivilegedDb(ORG, "test:auto-approve-issue-cleanup", (tx) =>
        tx.delete(autoApprovePolicies).where(eq(autoApprovePolicies.orgId, ORG)),
      ).catch(() => {})
    }
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("with an auto-approve policy on invoicing an agent's issue still waits for a person", async () => {
    const issuer = await call(
      "settings_issuer_profile_create",
      {
        legal_name: `Maison Issuer ${randomUUID().slice(0, 8)}`,
        country: "FR",
        vat_id: "FR40902000009",
        address: "1 rue de Test, 75011 Paris",
        default_currency: "EUR",
        default_language: "en",
      },
      "human-ui",
    )
    const issuerId = String(issuer.data?.id ?? "")
    expect(issuerId).not.toBe("")
    const draft = await call(
      "drafts_create",
      {
        type: "invoice",
        issuer_profile_id: issuerId,
        currency: "EUR",
        counterparty_name: "Erika Mustermann",
        counterparty_country: "DE",
        counterparty_address: "Hauptstrasse 1, 10115 Berlin",
        counterparty_email: "erika@example.com",
        customer_kind: "individual",
        operation_category: "services",
        items: [
          {
            description: "Data export, 3 d",
            quantity: "3",
            unit_price_minor: 93000,
            line_kind: "service",
          },
        ],
      },
      "human-ui",
    )
    const draftId = String(draft.data?.draft_id ?? "")
    expect(draftId).not.toBe("")

    // The org lets agents run invoicing's tools without asking, by name and by wildcard.
    for (const toolName of ["invoicing:invoice_issue", "invoicing:*"]) {
      await withPrivilegedDb(ORG, "test:auto-approve-policy", (tx) =>
        tx
          .insert(autoApprovePolicies)
          .values({ orgId: ORG, toolName, createdBy: ADMIN })
          .onConflictDoNothing(),
      )
    }

    const before = await issuedCount()
    const res = await call("invoice_issue", { draft_id: draftId }, "in-app-agent")
    expect(res.blocked?.approvalRequestId).toBeTruthy()
    expect(await issuedCount()).toBe(before)
    const [row] = await sql<Array<{ status: string }>>`
      SELECT status FROM app_invoicing.documents WHERE id = ${draftId}`
    expect(row?.status).toBe("draft")
    const [req] = await sql<Array<{ status: string; tool_name: string }>>`
      SELECT status, tool_name FROM kernel.approval_requests
      WHERE id = ${String(res.blocked?.approvalRequestId)}`
    expect(req).toMatchObject({ status: "pending", tool_name: "invoicing:invoice_issue" })
  })

  const COUNTERPARTY = {
    legal_name: "Erika Mustermann",
    country: "DE",
    address: "Hauptstrasse 1, 10115 Berlin",
    email: "erika@example.com",
    customer_kind: "individual",
  }

  /** The approval an agent's call parked on: the gate's block, or the handler's own park. */
  function parkedId(res: Called): string | null {
    const handler = res.data as { status?: unknown; approval_id?: unknown } | undefined
    if (res.blocked?.approvalRequestId) return res.blocked.approvalRequestId
    if (handler?.status === "pending_approval" && typeof handler.approval_id === "string")
      return handler.approval_id
    return null
  }

  async function expectWaitsForPerson(res: Called, before: number): Promise<void> {
    expect(await issuedCount()).toBe(before)
    const id = parkedId(res)
    expect(id).toBeTruthy()
    const [req] = await sql<Array<{ status: string }>>`
      SELECT status FROM kernel.approval_requests WHERE id = ${String(id)}`
    expect(req?.status).toBe("pending")
  }

  it("with an auto-approve policy a draft from planned vs done still waits for a person to issue it", async () => {
    // The issue approval a draft made from a planned vs done card raises, exactly as its handler
    // asks for it: through a cross-app hop (no person's own scopes, the in-app agent's origin),
    // with the deciding scope of the people who issue invoices.
    const draft = await call(
      "drafts_create",
      {
        type: "invoice",
        currency: "EUR",
        counterparty_name: COUNTERPARTY.legal_name,
        counterparty_country: COUNTERPARTY.country,
        counterparty_address: COUNTERPARTY.address,
        counterparty_email: COUNTERPARTY.email,
        customer_kind: "individual",
        operation_category: "services",
        items: [
          {
            description: "Data export, 3 d",
            quantity: "3",
            unit_price_minor: 93000,
            line_kind: "service",
          },
        ],
      },
      "human-ui",
    )
    const draftId = String(draft.data?.draft_id ?? "")
    expect(draftId).not.toBe("")
    const before = await issuedCount()
    const parked = await createHandlerApprovalRequest({
      orgId: ORG,
      requestedBy: ADMIN,
      actorScopes: [...SCOPES, "invoicing:*"],
      defaultAppName: "invoicing",
      origin: "in-app-agent",
      input: {
        tool_name: "invoicing:invoice_issue",
        summary: "Issue the invoice draft from planned vs done",
        current_payload: { draft_id: draftId },
        approve_scope: "invoicing:documents:write",
        expiry_hours: 720,
      },
    })
    expect(parked.auto_approved).not.toBe(true)
    expect(parked.approval_id).toBeTruthy()
    const [req] = await sql<Array<{ status: string; thread_id: string | null }>>`
      SELECT status, thread_id FROM kernel.approval_requests WHERE id = ${String(parked.approval_id)}`
    expect(req?.status).toBe("pending")
    // With no thread an anchor thread holds the approval.
    expect(req?.thread_id).toBeTruthy()
    expect(await issuedCount()).toBe(before)
  })

  it("with an auto-approve policy an agent's create-and-issue of an invoice still waits for a person", async () => {
    const before = await issuedCount()
    const res = await call(
      "invoice_create_and_issue",
      {
        counterparty: COUNTERPARTY,
        currency: "EUR",
        operation_category: "services",
        items: [
          {
            description: "Monitoring, 4 d",
            quantity: "4",
            unit_price_minor: 93000,
            line_kind: "service",
          },
        ],
      },
      "in-app-agent",
    )
    await expectWaitsForPerson(res, before)
  })

  it("with an auto-approve policy an agent's credit note still waits for a person", async () => {
    const before = await issuedCount()
    const res = await call(
      "credit_note_create_and_issue",
      {
        counterparty: COUNTERPARTY,
        currency: "EUR",
        operation_category: "services",
        reason: "Monitoring billed one day too many",
        items: [
          {
            description: "Monitoring, 1 d",
            quantity: "1",
            unit_price_minor: -93000,
            line_kind: "service",
          },
        ],
      },
      "in-app-agent",
    )
    await expectWaitsForPerson(res, before)
  })

  it("with an auto-approve policy an agent's issue of a credit note draft still waits for a person", async () => {
    const draft = await call(
      "drafts_create",
      {
        type: "credit_note",
        currency: "EUR",
        counterparty_name: COUNTERPARTY.legal_name,
        counterparty_country: COUNTERPARTY.country,
        counterparty_address: COUNTERPARTY.address,
        counterparty_email: COUNTERPARTY.email,
        customer_kind: "individual",
        operation_category: "services",
        items: [
          {
            description: "Data export, 1 d",
            quantity: "1",
            unit_price_minor: -93000,
            line_kind: "service",
          },
        ],
      },
      "human-ui",
    )
    const draftId = String(draft.data?.draft_id ?? "")
    expect(draftId).not.toBe("")
    const before = await issuedCount()
    const res = await call("credit_note_issue", { draft_id: draftId }, "in-app-agent")
    await expectWaitsForPerson(res, before)
  })
})
