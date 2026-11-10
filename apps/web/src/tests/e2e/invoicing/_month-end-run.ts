// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A real month-end run for browser tests: a fresh issuer, `count` monthly schedules each with a
// paid previous invoice billing the same line, and the app's own draft job run once, which drafts
// the rows and stages the run's one approval card. The schedules and their previous invoices are
// written as rows, as the run's integration test does; everything after that is the app's code.
import { randomUUID } from "node:crypto"
import { api, type WorkerEnv } from "@liaison/test-helpers"

export interface MonthEndRun {
  issuerId: string
  runId: string
  approvalId: string
  /** The month the run bills (`November`). */
  month: string
}

/** Today's date and the last day of this month, as plain `YYYY-MM-DD` days in UTC. */
function days(): { today: string; monthEnd: string } {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10)
  return { today, monthEnd }
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

function insert(table: string, row: Record<string, unknown>): { text: string; values: unknown[] } {
  const keys = Object.keys(row)
  const values = keys.map((k) => row[k])
  const params = keys.map((k, i) =>
    k === "lines" || k === "external_refs" || k === "lifecycle_log"
      ? `$${i + 1}::text::jsonb`
      : `$${i + 1}`,
  )
  return { text: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${params.join(", ")})`, values }
}

export async function draftMonthEndRun(
  env: WorkerEnv,
  opts: {
    orgId: string
    adminToken: string
    accountManagerId: string
    count: number
    customer?: (i: number) => string
  },
): Promise<MonthEndRun> {
  const created = await api(
    env.serverUrl,
    "/api/apps/invoicing/tools/settings_issuer_profile_create",
    {
      method: "POST",
      token: opts.adminToken,
      body: {
        params: {
          legal_name: `Maison Studio ${randomUUID().slice(0, 6)}`,
          country: "FR",
          vat_id: "FR40902000009",
          address: "1 rue de Test, 75011 Paris",
          default_currency: "EUR",
          default_language: "en",
        },
      },
    },
  )
  const body = created.body as { data?: { id?: string; data?: { id?: string } } }
  const issuerId = String(body.data?.id ?? body.data?.data?.id ?? "")
  if (!issuerId)
    throw new Error(`issuer not created: ${created.status} ${JSON.stringify(created.body)}`)
  const inv = env.schemaPrefix ? `"${env.schemaPrefix}app_invoicing"` : "app_invoicing"
  await env.db.sql.unsafe(`UPDATE ${inv}.issuer_profiles SET timezone = 'UTC' WHERE id = $1`, [
    issuerId,
  ])
  const { today, monthEnd } = days()
  const name = opts.customer ?? ((i: number) => `Maison Client ${i}`)
  for (let i = 1; i <= opts.count; i++) {
    const contact = randomUUID()
    const prev = randomUUID()
    const price = 49000
    const docRow = insert(`${inv}.documents`, {
      id: prev,
      org_id: opts.orgId,
      type: "invoice",
      status: "issued",
      issuer_profile_id: issuerId,
      counterparty_contact_id: contact,
      counterparty_name: name(i),
      counterparty_address: `${i} rue des Tests, 75011 Paris`,
      counterparty_country: "FR",
      customer_kind: "individual",
      counterparty_email: `client${i}@e2e.test`,
      currency: "EUR",
      payment_status: "paid",
      external_refs: "{}",
      lifecycle_log: "[]",
    })
    await env.db.sql.unsafe(docRow.text, docRow.values as never[])
    const lineRow = insert(`${inv}.document_lines`, {
      org_id: opts.orgId,
      document_id: prev,
      position: 1,
      description: "Team plan",
      quantity: 1,
      unit_price_minor: price,
      discount_minor: 0,
      line_kind: "service",
      tax_rate_bp: 2000,
      subtotal_minor: price,
      tax_minor: price / 5,
      total_minor: price + price / 5,
    })
    await env.db.sql.unsafe(lineRow.text, lineRow.values as never[])
    const scheduleRow = insert(`${inv}.recurring_schedules`, {
      id: randomUUID(),
      org_id: opts.orgId,
      issuer_profile_id: issuerId,
      contact_id: contact,
      status: "active",
      repeats: "month",
      billing_day: "last",
      lines: JSON.stringify([
        {
          description: "Team plan",
          qty: 1,
          unit_price_minor: price,
          vat_bp: 2000,
          line_kind: "service",
        },
      ]),
      next_issue_on: monthEnd,
      next_draft_on: today,
      last_document_id: prev,
      created_by: opts.accountManagerId,
    })
    await env.db.sql.unsafe(scheduleRow.text, scheduleRow.values as never[])
  }
  const ran = await api(env.serverUrl, "/api/_test/apps/invoicing/jobs/recurring-draft/run", {
    method: "POST",
    body: { orgId: opts.orgId },
  })
  const outcome = (ran.body as { data?: { ok?: boolean; error?: string } }).data
  if (!outcome?.ok) throw new Error(`draft job failed: ${ran.status} ${JSON.stringify(ran.body)}`)
  const [run] = (await env.db.sql.unsafe(
    `SELECT id::text AS id, approval_request_id::text AS approval FROM ${inv}.recurring_runs WHERE issuer_profile_id = $1`,
    [issuerId],
  )) as Array<{ id: string; approval: string | null }>
  if (!run?.approval) throw new Error(`no run card for issuer ${issuerId}`)
  return {
    issuerId,
    runId: run.id,
    approvalId: run.approval,
    month: MONTHS[Number(monthEnd.slice(5, 7)) - 1] ?? "",
  }
}
