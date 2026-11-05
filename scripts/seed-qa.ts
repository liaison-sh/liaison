// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * QA Seed Script
 *
 * Creates the exact same deterministic data used by web E2E tests,
 * against the running dev server: the org and its admin through the server,
 * then the standard seed tier (`liaison seed --tier standard`, the world the
 * Playwright and api e2e lanes start from), then the dev-only extras below.
 *
 * Usage: bun run seed:qa
 * Requires: dev server running (bun run dev)
 *
 * DATABASE_URL must be the database OWNER's DSN, never the application's.
 * This script truncates every table in the `kernel` schema and seeds rows
 * across org boundaries; the app role is row-level-security bound and owns no
 * table, so under it the very first TRUNCATE fails. That matters most where
 * it is least obvious: run inside a deployed container, DATABASE_URL is the
 * app's by construction, which is exactly how this failed on the first
 * staging box it was tried on.
 */

// MUST stay the FIRST import: this script only writes rows, and the graph it
// pulls (test-helpers -> the api app) creates BullMQ workers at module scope.
// A seeding process that owns a worker steals jobs from the running app.
import "./lib/no-job-workers"
import { createCipheriv, randomBytes } from "node:crypto"
import path from "node:path"
import { BOOTSTRAP_ECB_RATE, MODEL_PRICING_SEED } from "@liaison/shared"
import { api, createDbClient, createUserWithScopes, TestWorld } from "@liaison/test-helpers"
import { isOwnerPrivilegeError, ownerDsnHint } from "./lib/owner-dsn-hint"

// Safety guard: refuse non-local databases unless explicitly forced
const dbUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/liaison_dev"
if (
  !dbUrl.includes("localhost") &&
  !dbUrl.includes("127.0.0.1") &&
  !process.argv.includes("--force")
) {
  console.error("Refusing to seed non-local database. Use --force to override.")
  process.exit(1)
}

// Require explicit confirmation for destructive truncation
if (!process.argv.includes("--yes")) {
  console.error("This will TRUNCATE all kernel tables. Pass --yes to confirm.")
  process.exit(1)
}

const serverUrl = process.env.SEED_SERVER_URL ?? "http://localhost:3000"

try {
  await fetch(`${serverUrl}/api/health`)
} catch {
  console.error("Start the dev server first: bun run dev")
  process.exit(1)
}

const db = createDbClient(
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/liaison_dev",
)

console.log("Cleaning existing data...")
try {
  await db.sql.unsafe(`
  DO $$ DECLARE t text; BEGIN
    -- shareable_resource_types is a registry the migrations write, not data:
    -- emptied, every knowledge document and contact write fails.
    FOR t IN SELECT tablename FROM pg_tables
      WHERE schemaname = 'kernel' AND tablename <> 'shareable_resource_types'
    LOOP EXECUTE format('TRUNCATE TABLE kernel.%I CASCADE', t); END LOOP;
  END $$
`)
} catch (err) {
  // Postgres reports "permission denied" / "must be owner" and nothing about
  // which credential was wanted. Say it here, where it is known.
  if (isOwnerPrivilegeError(err)) {
    console.error(ownerDsnHint("scripts/seed-qa.ts"))
    console.error(`Postgres said: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  throw err
}
console.log("Clean complete")

console.log("Seeding QA data...")
const world = await TestWorld.create(serverUrl, db, {
  seed: 42,
  admin: { email: "admin@test.com", password: "12345678", name: "Elodie Vasseur" },
})

// The standard tier, as the CLI an operator would run (the same env as `bun run
// demo:seed`). It prints the seeded ids as one JSON line.
const seedRun = Bun.spawnSync(
  [
    "bun",
    "run",
    "apps/api/src/cli/index.ts",
    "seed",
    "--tier",
    "standard",
    "--admin",
    world.admin.email,
  ],
  { cwd: path.resolve(import.meta.dir, ".."), env: process.env, stdout: "pipe", stderr: "inherit" },
)
if (seedRun.exitCode !== 0) {
  console.error(`liaison seed --tier standard exited ${seedRun.exitCode}`)
  process.exit(1)
}
const _qa = JSON.parse(seedRun.stdout.toString().trim().split("\n").pop() ?? "") as {
  admin: { id: string }
  amina: { id: string }
  lucas: { id: string }
  tobias: { id: string }
  margot: { id: string }
  contacts: Record<
    "hansPrimary" | "sofiaPrimary",
    { id: string; name: string | null; email: string | null }
  >
}
// The seed granted the admin knowledge dimensions: sign in again for a token carrying them.
await world.refreshAdminToken()
const adminOrgId = world.org.id
const adminUserId = _qa.admin.id

// ─── Sendable QA mail account ────────────────────────────────────────────────
// One org-owned mailbox backs all manual/dev mail fixtures. By default it points
// at local Mailpit. Override QA_MAIL_* for another SMTP server or set
// QA_MAIL_TRANSPORT=resend with RESEND_API_KEY/QA_MAIL_SMTP_PASS to use Resend's
// SMTP relay. Inbound conversations are DB-seeded; outbound approval execution
// uses the stored SMTP credentials and sends real mail.
console.log("Seeding sendable QA mail inbox + cross-user approval scope split...")

const mailpitEncryptionKey =
  process.env.ENCRYPTION_KEY ?? "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const aesKeyBytes = Buffer.from(mailpitEncryptionKey, "hex")
// The API decrypts these credentials bound to their column (AES-GCM AAD,
// CryptoContext.connectedAccountCredentials in apps/api/src/lib/crypto.ts):
// sealed without it, the QA mailbox could not send ("unable to authenticate data").
const CONNECTED_ACCOUNT_CREDENTIALS = "kernel.connected_accounts:credentials_encrypted"
function encryptDevSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", aesKeyBytes, iv, { authTagLength: 16 })
  cipher.setAAD(Buffer.from(CONNECTED_ACCOUNT_CREDENTIALS, "utf8"))
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

const qaMailTransport = (process.env.QA_MAIL_TRANSPORT ?? "mailpit").toLowerCase()
if (!["mailpit", "smtp", "resend"].includes(qaMailTransport)) {
  throw new Error("QA_MAIL_TRANSPORT must be one of: mailpit, smtp, resend")
}

const qaMailEmail = process.env.QA_MAIL_FROM ?? "support@dev.local"
const qaMailDisplayName = process.env.QA_MAIL_DISPLAY_NAME ?? "Support (QA)"
const qaMailRecipientEmail = process.env.QA_MAIL_RECIPIENT ?? "phase5-recipient@e2e.test"
const qaMailSmtpHost =
  process.env.QA_MAIL_SMTP_HOST ?? (qaMailTransport === "resend" ? "smtp.resend.com" : "localhost")
const qaMailSmtpPort = readIntEnv("QA_MAIL_SMTP_PORT", qaMailTransport === "resend" ? 587 : 1025)
const qaMailSmtpUser =
  process.env.QA_MAIL_SMTP_USER ?? (qaMailTransport === "resend" ? "resend" : qaMailEmail)
const qaMailSmtpPass =
  process.env.QA_MAIL_SMTP_PASS ??
  process.env.QA_MAIL_RESEND_API_KEY ??
  process.env.RESEND_API_KEY ??
  (qaMailTransport === "resend" ? "" : "dev")

if (qaMailTransport === "resend" && !qaMailSmtpPass) {
  throw new Error("QA_MAIL_TRANSPORT=resend requires RESEND_API_KEY or QA_MAIL_SMTP_PASS")
}
if (qaMailTransport !== "mailpit" && !qaMailSmtpPass) {
  console.warn("QA mail SMTP password is empty; outbound sends may fail.")
}

const qaMailCredentials = {
  email: qaMailEmail,
  imapHost: process.env.QA_MAIL_IMAP_HOST ?? qaMailSmtpHost,
  imapPort: String(readIntEnv("QA_MAIL_IMAP_PORT", qaMailSmtpPort)),
  smtpHost: qaMailSmtpHost,
  smtpPort: String(qaMailSmtpPort),
  username: qaMailSmtpUser,
  password: qaMailSmtpPass,
}

const qaConnectedAccountId = crypto.randomUUID()
const qaMailAccountId = crypto.randomUUID()
await db.sql.unsafe(
  `INSERT INTO kernel.connected_accounts
    (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type,
     identifier, display_name, status, credentials_encrypted, created_by)
   VALUES ($1, $2, 'mail', 'imap', 'org', null, 'credentials', $3, $4,
            'active', $5, $6)`,
  [
    qaConnectedAccountId,
    adminOrgId,
    qaMailEmail,
    qaMailDisplayName,
    encryptDevSecret(JSON.stringify(qaMailCredentials)),
    adminUserId,
  ],
)
await db.sql.unsafe(
  `INSERT INTO app_mail.accounts
    (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
     display_name, sync_status)
   VALUES ($1, $2, $3, 'org', null, 'imap', $4, $5, $6)`,
  [
    qaMailAccountId,
    adminOrgId,
    qaConnectedAccountId,
    qaMailEmail,
    qaMailDisplayName,
    process.env.QA_MAIL_SYNC_STATUS ?? "pre-sync",
  ],
)

const allUserIds = [_qa.admin.id, _qa.amina.id, _qa.lucas.id, _qa.tobias.id, _qa.margot.id]
for (const uid of allUserIds) {
  await db.sql.unsafe(
    `INSERT INTO kernel.user_dimension_grants (user_id, org_id, dimension_key, dimension_values)
     VALUES ($1, $2, 'mail:inbox', jsonb_build_array($3::text))
     ON CONFLICT (user_id, org_id, dimension_key)
     DO UPDATE SET dimension_values = (
       CASE WHEN user_dimension_grants.dimension_values @> jsonb_build_array($3::text)
            THEN user_dimension_grants.dimension_values
            ELSE user_dimension_grants.dimension_values || jsonb_build_array($3::text)
       END
     )`,
    [uid, adminOrgId, qaMailAccountId],
  )
}

const phase5MailContacts = [
  {
    contact: _qa.contacts.hansPrimary,
    subject: "Phase 5D Hans follow-up",
    body: "Hans needs a concise support reply.",
  },
  {
    contact: _qa.contacts.sofiaPrimary,
    subject: "Phase 5D Sofia account merge",
    body: "Sofia asked to consolidate duplicate contact records.",
  },
]
for (const fixture of phase5MailContacts) {
  const conversationId = crypto.randomUUID()
  await db.sql.unsafe(
    `
    INSERT INTO app_mail.conversations
      (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet, contact_id, status, labels, is_read, is_starred, last_message_at, message_count)
    VALUES ($1, $2, $3, 'org', null, $4, $5, $6, $7, 'open', '["INBOX"]'::jsonb, false, false, now(), 1)
  `,
    [
      conversationId,
      adminOrgId,
      qaMailAccountId,
      crypto.randomUUID(),
      fixture.subject,
      fixture.body,
      fixture.contact.id,
    ],
  )
  await db.sql`
    INSERT INTO app_mail.messages
      (id, org_id, conversation_id, account_id, external_message_id, external_provider_id, from_address, to_addresses, cc_addresses, bcc_addresses,
       subject, text_body, html_body, snippet, is_read, is_starred, labels, direction, sent_at, synced_at, raw_headers, owner_type, owner_id, message_references)
    VALUES (
      gen_random_uuid(), ${adminOrgId}, ${conversationId}, ${qaMailAccountId},
      ${`<${crypto.randomUUID()}@qa-mail.seed>`}, ${crypto.randomUUID()},
      ${db.sql.json({ name: fixture.contact.name, email: fixture.contact.email ?? qaMailRecipientEmail })},
      ${db.sql.json([{ email: qaMailEmail }])},
      '[]'::jsonb, '[]'::jsonb,
      ${fixture.subject}, ${fixture.body}, ${`<p>${fixture.body}</p>`}, ${fixture.body},
      false, false, '[]'::jsonb, 'inbound', now(), now(), '{}'::jsonb, 'org', null, '[]'::jsonb
    )
  `
}

// Inbound customer conversation — the "reply target" for approval QA.
const devCustomerEmail = "billing-customer@example.com"
const devConversationId = crypto.randomUUID()
const devCustomerSubject = "Question about my latest invoice"
const devCustomerBody = `Hi support team,

I just received invoice INV-4271 and the amount looks higher than usual. Could you take a look and let me know if there's been a pricing change or if this is a mistake?

Thanks,
Sam`
await db.sql.unsafe(
  `INSERT INTO app_mail.conversations
    (id, org_id, account_id, owner_type, owner_id, external_thread_id,
     subject, snippet, status, labels, is_read, is_starred,
     last_message_at, message_count)
   VALUES ($1, $2, $3, 'org', null, $4, $5, $6, 'open',
           '["INBOX"]'::jsonb, false, false, now(), 1)`,
  [
    devConversationId,
    adminOrgId,
    qaMailAccountId,
    crypto.randomUUID(),
    devCustomerSubject,
    devCustomerBody.slice(0, 200),
  ],
)
await db.sql.unsafe(
  `INSERT INTO app_mail.messages
    (id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
     from_address, to_addresses, cc_addresses, bcc_addresses,
     subject, text_body, html_body, snippet,
     is_read, is_starred, labels, direction,
     sent_at, synced_at, raw_headers, owner_type, owner_id, message_references)
   VALUES (gen_random_uuid(), $1, $2, $3, $4, $5,
           $6::jsonb, $7::jsonb, '[]'::jsonb, '[]'::jsonb,
           $8, $9, $10, $11, false, false, '[]'::jsonb, 'inbound',
           now(), now(), '{}'::jsonb, 'org', null, '[]'::jsonb)`,
  [
    adminOrgId,
    devConversationId,
    qaMailAccountId,
    `<${crypto.randomUUID()}@dev.seed>`,
    crypto.randomUUID(),
    // Pass jsonb as objects (postgres.js serializes them) — DON'T JSON.stringify,
    // or the column ends up storing a JSON-encoded string literal instead of an
    // object, and downstream consumers like nodemailer barf on `<email}>` shapes.
    { name: "Sam (Customer)", email: devCustomerEmail } as unknown as string,
    [{ email: qaMailEmail }] as unknown as string,
    devCustomerSubject,
    devCustomerBody,
    `<p>${devCustomerBody.replace(/\n+/g, "</p><p>")}</p>`,
    devCustomerBody.slice(0, 200),
  ],
)

// Cross-user approval split — revoke mail:approve and test:approve from
//    Amina + Lucas so they cannot self-approve gated sends / test app sequenced
//    operations. Tobias + Margot keep both (they're the reviewers). Elodie
//    is admin (* scope) and remains a self-approver. Without this the
//    gated-tool human bypass (execute-tool: direct UI calls auto-approve when
//    the caller holds <app>:approve) would short-circuit any UI test that
//    expects a pending-approval card / blocked envelope from amina or lucas.
for (const email of ["amina@resonantaudiolabs.example", "lucas@resonantaudiolabs.example"]) {
  await db.sql.unsafe(
    `DELETE FROM kernel.role_scope_grants rsg
     USING kernel.user_roles ur, kernel.users u
     WHERE rsg.role_id = ur.role_id
       AND ur.user_id = u.id
       AND u.email = $1
       AND rsg.scope IN ('mail:approve', 'test:approve')`,
    [email],
  )
}

console.log(
  `QA mail inbox seeded (${qaMailEmail}, transport=${qaMailTransport}, account=${qaMailAccountId}). Approvers: Tobias, Margot, Elodie. Drafters: Amina, Lucas.`,
)

// Phase 4a: Seed model pricing, credit balances, and ECB rate
// Model IDs sourced from shared seed — single source of truth backed by LiteLLM database.
console.log("Seeding model pricing...")
for (const model of MODEL_PRICING_SEED) {
  await db.sql.unsafe(
    `
    INSERT INTO kernel.model_pricing (id, provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum, source)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (provider, model_id) DO NOTHING
  `,
    [
      model.provider,
      model.modelId,
      model.displayName,
      model.inputCostPerM,
      model.outputCostPerM,
      model.contextWindow,
      model.autoEligible,
      model.tierMinimum,
      model.source,
    ],
  )
}

console.log("Seeding ECB rate...")
await db.sql.unsafe(`
  INSERT INTO kernel.system_config (key, value)
  VALUES ('usd_eur_rate', '${JSON.stringify(BOOTSTRAP_ECB_RATE)}'::jsonb)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
`)

console.log("Model pricing and ECB rate seeded.")

// Phase 4a/4e: Seed credit balance and org tier for the admin org.
//
// T1.9 — self-hosted edition profile (`QA_EDITION=self_hosted`): skip the
// credit-balance + tier seeding to exercise the gate at
// `apps/api/src/lib/edition.ts`. The runtime edition is detected from
// CONTROL_PLANE_* env vars at boot; the seed mirrors the same posture so
// dev can flip between managed (default) and self-hosted modes.
const qaEdition = process.env.QA_EDITION ?? "managed"
if (qaEdition === "self_hosted") {
  console.log("[QA_EDITION=self_hosted] skipping credit/tier seeding (BYOK-only mode).")
  // Belt-and-suspenders: drop any pre-existing credit balance for the admin
  // org so a reseed cleanly transitions managed→self_hosted without leaving
  // stale rows that the API would surface.
  await db.sql.unsafe(`DELETE FROM kernel.credit_balances WHERE org_id = $1`, [adminOrgId])
  await db.sql.unsafe(`DELETE FROM kernel.credit_transactions WHERE org_id = $1`, [adminOrgId])
  await db.sql.unsafe(`UPDATE kernel.organizations SET tier = 'self_hosted' WHERE id = $1`, [
    adminOrgId,
  ])
  console.log("Self-hosted org tier set; credit rows deleted.")
} else {
  console.log("Seeding credit balance and org tier...")
  // Set org tier to "team" for Phase 4e testing
  await db.sql.unsafe(
    `
  UPDATE kernel.organizations SET tier = 'team' WHERE id = $1
`,
    [adminOrgId],
  )

  // Set resetDate 18 days from now in org settings
  const resetDate = new Date(Date.now() + 18 * 86400000).toISOString()
  await db.sql.unsafe(
    `
  UPDATE kernel.organizations
  SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('resetDate', $1::text)
  WHERE id = $2
`,
    [resetDate, adminOrgId],
  )

  await db.sql.unsafe(
    `
  INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
  VALUES ($1, '2.00000000', '10.00000000', 'EUR')
  ON CONFLICT (org_id) DO UPDATE SET
    included_balance = '2.00000000',
    purchased_balance = '10.00000000'
`,
    [adminOrgId],
  )
  console.log("Credit balance seeded (2.00 EUR included, 10.00 EUR purchased, team tier).")

  // Phase 4e: Seed sample credit_transactions for UI testing
  console.log("Seeding sample credit transactions...")
  const sampleTransactions = [
    {
      type: "top_up",
      amount: "10.00000000",
      balance_after: "10.00000000",
      description: "Top-up",
      external_payment_ref: "ext_seed_001",
    },
    {
      type: "top_up",
      amount: "25.00000000",
      balance_after: "35.00000000",
      description: "Top-up",
      external_payment_ref: "ext_seed_002",
    },
    {
      type: "monthly_reset",
      amount: "20.00000000",
      balance_after: "55.00000000",
      description: "Monthly reset (team tier)",
      cycle_id: "cycle_seed_001",
    },
    {
      type: "usage",
      amount: "-0.05000000",
      balance_after: "54.95000000",
      model: "claude-sonnet-4-6",
      input_tokens: 1000,
      output_tokens: 500,
      raw_cost: "0.04200000",
      user_id: adminUserId,
    },
    {
      type: "usage",
      amount: "-0.12000000",
      balance_after: "54.83000000",
      model: "claude-sonnet-4-6",
      input_tokens: 2000,
      output_tokens: 1200,
      raw_cost: "0.10000000",
      user_id: adminUserId,
    },
    {
      type: "usage",
      amount: "-0.03000000",
      balance_after: "54.80000000",
      model: "claude-haiku-4-5-20251001",
      input_tokens: 5000,
      output_tokens: 200,
      raw_cost: "0.02500000",
      user_id: adminUserId,
    },
    {
      type: "usage",
      amount: "-0.08000000",
      balance_after: "54.72000000",
      model: "claude-sonnet-4-6",
      input_tokens: 1500,
      output_tokens: 800,
      raw_cost: "0.06700000",
      user_id: adminUserId,
    },
    {
      type: "usage",
      amount: "-0.15000000",
      balance_after: "54.57000000",
      model: "claude-opus-4-6",
      input_tokens: 3000,
      output_tokens: 1000,
      raw_cost: "0.12500000",
      user_id: adminUserId,
    },
  ]

  for (const txn of sampleTransactions) {
    await db.sql.unsafe(
      `
    INSERT INTO kernel.credit_transactions (id, org_id, user_id, type, amount, balance_after, model, input_tokens, output_tokens, raw_cost, description, external_payment_ref, cycle_id)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  `,
      [
        adminOrgId,
        (txn as any).user_id ?? null,
        txn.type,
        txn.amount,
        txn.balance_after,
        (txn as any).model ?? null,
        (txn as any).input_tokens ?? null,
        (txn as any).output_tokens ?? null,
        (txn as any).raw_cost ?? null,
        (txn as any).description ?? null,
        (txn as any).external_payment_ref ?? null,
        (txn as any).cycle_id ?? null,
      ],
    )
  }
  console.log("Sample credit transactions seeded.")
} // end of else (managed-edition credit seeding)

// Agent-app fixtures (skills, routines, agent chats) are part of the standard
// tier (apps/api/src/seed/tiers/standard/rows.ts).

// ─── Marie + Bug Tracker demo project ────────────────────────────────────────
console.log("Seeding Marie user + Bug Tracker demo project...")

const projectScopes = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]

const existingMarie = await db.sql`
  SELECT id FROM kernel.users
  WHERE org_id = ${adminOrgId}::uuid AND lower(name) = 'marie' AND status = 'active'
`
if (existingMarie.length > 1) {
  throw new Error(
    "Multiple active Marie users in the org. Refusing to seed: data must be deterministic.",
  )
}
let marieId: string
if (existingMarie.length === 1) {
  marieId = existingMarie[0]!.id as string
} else {
  const marie = await createUserWithScopes(serverUrl, db.sql, world.admin.token, adminOrgId, {
    email: "marie@resonantaudiolabs.example",
    password: "QaPass1!",
    name: "Marie",
    scopes: projectScopes,
  })
  marieId = marie.id
}

// Populated Bug Tracker — drives the visual feel of `bun run dev`. Subtasks,
// mixed statuses, mixed assignees, mixed dues — what a working project looks
// like. Stable titles so QA screenshots stay reproducible across reseeds.
const TASK_TITLES = [
  "Audit user-permission edge cases",
  "Replace logo asset with vector mark",
  "Backfill OAuth refresh-token rotation",
  "Calibration drift on load-cell #4",
  "Document the data-export flow",
  "Drop legacy /v1 search endpoint",
  "Email-bounce dashboard for support",
  "Enable strict CSP on marketing pages",
  "Fix flaky CI step in worker matrix",
  "Investigate intermittent 502 on staging",
  "Migrate auth middleware to Hono v5",
  "Move pricing seed to LiteLLM source",
  "Onboard Marie to release rotation",
  "Patch SSO assertion replay window",
  "Pin Playwright to 1.59 for visual stability",
  "Profile ProjectKanbanView render path",
  "Promote feature flag: unified attention",
  "Publish Q2 roadmap to public site",
  "Reconcile invoice INV-4271 with stripe",
  "Refactor outbox worker leader election",
  "Remove unused activity-bar slot",
  "Rename status 'in_progress' → 'doing'",
  "Run accessibility audit on Home feed",
  "Schedule data-deletion compliance pass",
  "Spike: deterministic LLM provider boundary",
  "Switch tooltip motion to 120ms ease-out",
  "Tighten thread-references rate limit",
  "Triage user-reported regressions",
] as const

const SUBTASK_TITLES = [
  "Reproduce on staging",
  "Capture trace + logs",
  "Draft fix in branch",
  "Add regression test",
  "Get review from owning team",
  "Write changelog entry",
  "Verify in canary",
  "Roll out to production",
] as const

const today = new Date()
const isoDay = (delta: number) =>
  new Date(today.getTime() + delta * 86400000).toISOString().slice(0, 10)

interface ProjectSpec {
  name: string
  description: string
  distribution: {
    backlog: number
    todo: number
    in_progress: number
    done: number
    cancelled: number
  }
  subtaskParents: number[]
}

async function seedProject(spec: ProjectSpec, ownerToken: string, assigneeIds: string[]) {
  const res = await api(serverUrl, "/api/projects", {
    token: ownerToken,
    method: "POST",
    body: { name: spec.name, description: spec.description },
  })
  if (res.status !== 200) {
    throw new Error(`project create failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  const project = res.body.data as {
    id: string
    statuses: Array<{ id: string; label: string; terminal: boolean }>
  }
  const byLabel = new Map(project.statuses.map((s) => [s.label, s]))
  const subtaskParentSet = new Set(spec.subtaskParents)
  const order = ["backlog", "todo", "in_progress", "done", "cancelled"] as const
  let titleIdx = 0
  let subIdx = 0
  let positional = 0
  for (const label of order) {
    const status = byLabel.get(label)
    const count = spec.distribution[label]
    if (!status || count === 0) continue
    for (let i = 0; i < count; i++) {
      const title = TASK_TITLES[titleIdx++ % TASK_TITLES.length]!
      const blocked = !status.terminal && i % 11 === 0
      let dueDate: string | undefined
      if (!status.terminal) {
        if (i % 7 === 0) dueDate = isoDay(-2 - (i % 4))
        else if (i % 5 === 0) dueDate = isoDay(3 + (i % 4))
      }
      const assigneeId = assigneeIds[positional % assigneeIds.length]
      const r = await api(serverUrl, `/api/projects/${project.id}/tasks`, {
        token: ownerToken,
        method: "POST",
        body: {
          title,
          statusId: status.id,
          assigneeId,
          ...(dueDate ? { dueDate } : {}),
          ...(blocked ? { blocked: true } : {}),
        },
      })
      if (r.status !== 200) {
        throw new Error(`task create failed: ${r.status} ${JSON.stringify(r.body)}`)
      }
      const parentId = (r.body.data as { id: string }).id
      if (subtaskParentSet.has(positional)) {
        for (let c = 0; c < 2; c++) {
          await api(serverUrl, `/api/projects/${project.id}/tasks`, {
            token: ownerToken,
            method: "POST",
            body: {
              title: SUBTASK_TITLES[subIdx++ % SUBTASK_TITLES.length]!,
              parentTaskId: parentId,
              statusId: status.id,
              assigneeId: assigneeIds[(positional + c + 1) % assigneeIds.length],
            },
          })
        }
      }
      positional++
    }
  }
  return project.id
}

const allProjectAssignees = [
  adminUserId,
  _qa.amina.id,
  _qa.lucas.id,
  _qa.tobias.id,
  _qa.margot.id,
  marieId,
]

const bugTrackerId = await seedProject(
  {
    name: "Bug Tracker",
    description: "Customer-reported defects and triage queue.",
    distribution: { backlog: 6, todo: 8, in_progress: 5, done: 6, cancelled: 3 },
    subtaskParents: [0, 2, 4, 7, 11, 14, 18, 22],
  },
  world.admin.token,
  allProjectAssignees,
)
const q2RoadmapId = await seedProject(
  {
    name: "Q2 Roadmap",
    description: "Quarterly planning and execution tracker.",
    distribution: { backlog: 3, todo: 4, in_progress: 2, done: 4, cancelled: 0 },
    subtaskParents: [2, 5],
  },
  world.admin.token,
  allProjectAssignees,
)
await seedProject(
  {
    name: "Mobile App Launch",
    description: "iOS + Android launch checklist.",
    distribution: { backlog: 5, todo: 3, in_progress: 4, done: 1, cancelled: 0 },
    subtaskParents: [0, 3, 6],
  },
  world.admin.token,
  allProjectAssignees,
)
await seedProject(
  {
    name: "Customer Onboarding",
    description: "Reduce time-to-first-value for new orgs.",
    distribution: { backlog: 2, todo: 3, in_progress: 1, done: 3, cancelled: 1 },
    subtaskParents: [],
  },
  world.admin.token,
  allProjectAssignees,
)
await seedProject(
  {
    name: "Internal Tools",
    description: "Eng productivity + observability investments.",
    distribution: { backlog: 1, todo: 2, in_progress: 1, done: 2, cancelled: 0 },
    subtaskParents: [],
  },
  world.admin.token,
  allProjectAssignees,
)

console.log(
  `Projects seeded (Bug Tracker=${bugTrackerId}, Q2 Roadmap=${q2RoadmapId}, +3 more, marieId=${marieId})`,
)

// ---------------------------------------------------------------------------
// Second org — for cross-org / multi-tenant isolation QA. The shared-pool model
// keeps multiple orgs in one DB, isolated only by org_id + RLS, so a second
// tenant is required to prove a cross-tenant leak can't happen. Created via the
// dev-only seed route (mounted when ENABLE_QA_SEED_ROUTES is set), which runs
// in-process so the org's roles/credits/app-runtime initialise exactly like a
// bootstrapped org. Skipped gracefully if the route isn't mounted.
// ---------------------------------------------------------------------------
const ORG_B_ADMIN = { email: "orgb-admin@test.com", password: "12345678", name: "Org B Admin" }
try {
  const res = await fetch(`${serverUrl}/api/_test/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      factory: "org.second",
      args: {
        orgName: "Org B (cross-org QA)",
        adminEmail: ORG_B_ADMIN.email,
        adminPassword: ORG_B_ADMIN.password,
        adminName: ORG_B_ADMIN.name,
        withData: true,
      },
    }),
  })
  if (res.ok) {
    const { data } = (await res.json()) as {
      data: { orgId: string; threadId: string | null; contactId: string | null }
    }
    console.log(
      `Second org seeded (org-B=${data.orgId}, admin=${ORG_B_ADMIN.email}, thread=${data.threadId}, contact=${data.contactId})`,
    )
  } else if (res.status === 404) {
    console.log(
      "Second org skipped — /api/_test/seed not mounted (set ENABLE_QA_SEED_ROUTES=1 on the server to enable cross-org QA).",
    )
  } else {
    console.warn(`Second org seed failed: ${res.status} ${await res.text()}`)
  }
} catch (err) {
  console.warn("Second org seed skipped (request failed):", err)
}

console.log("\n✓ QA seed complete!")
if (process.argv.includes("--verbose")) {
  console.log(`  Admin: admin@test.com / 12345678`)
  console.log(
    `  Users: amina@resonantaudiolabs.example, lucas@resonantaudiolabs.example, tobias@resonantaudiolabs.example, margot@resonantaudiolabs.example (password: QaPass1!)`,
  )
}
console.log(`  Threads: 14 (1 pinned, 1 archived, 1 muted, 3 untitled, 5 without Elodie)`)
console.log(`  Agent chats: 2 | Credits: 2.00 EUR included`)

await world.destroy()
await db.close()
