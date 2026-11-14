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
import { executeTool, type ToolOrigin } from "~/modules/apps/execute-tool"
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
})
