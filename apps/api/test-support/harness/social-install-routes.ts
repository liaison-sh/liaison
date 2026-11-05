// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Social "Ground Control" E2E harness — test-only install + mock-control routes
// (B10). Gated on `qaSeedRoutesEnabled` (NODE_ENV=test, or ENABLE_QA_SEED_ROUTES
// for the qa/ harness). Mounts:
//   POST /api/_test/social/install-for-test    — register the bundled social
//        app from source for an org (load-from-source side channel; no freeze)
//        + seed a `social` connected_account so connection-driven setup ran.
//   POST /api/_test/social/seed-finding         — inject a finding directly
//        (drives the Findings surface without a live platform fetch).
//   POST /api/_test/social/seed-conversation    — inject a DM conversation.
//
// Mirrors `boxtal-install-routes.ts` but uses the bundled-from-source
// `registerApps` path (the discipline is: never freeze/install for tests).
import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { qaSeedRoutesEnabled } from "~/lib/env"
import { zValidator } from "~/lib/validate"
import { handleSkillRead } from "~/modules/agent/tools/skills-routines-tools"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { teardownAppRegistrations } from "~/modules/apps/runtime"
import { bakeIntoTestCatalog } from "~/tests/helpers/test-app-catalog"
import { resetSocialMockState, setSocialMockMode, socialMockAllRequests } from "./social-mock-fetch"

export const socialTestInstallRoutes = new Hono<AppEnv>()

function assertTestEnv(): void {
  if (!qaSeedRoutesEnabled) {
    throw new HTTPException(404, { message: "Not found" })
  }
}

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
// Read the version from the manifest (build-bundled-app.sh emits
// `social-<version>.liaisonapp`). A hardcoded literal goes stale the moment
// the manifest version bumps and resolves to a nonexistent tarball.
const SOCIAL_VERSION = (
  JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "social", "app.manifest.json"), "utf8"),
  ) as { version: string }
).version
const SOCIAL_BUNDLE = join(
  REPO_ROOT,
  "bundled-apps",
  "social",
  "dist",
  `social-${SOCIAL_VERSION}.liaisonapp`,
)
const SOCIAL_GRANTED_SCOPES = [
  "social:findings:read",
  "social:findings:write",
  "social:dm:read",
  "social:dm:write",
  "social:watched:read",
  "social:watched:write",
  "social:terms:read",
  "social:terms:write",
  "social:admin:connection",
  "social:internal",
]

const installBody = z.object({
  orgId: z.string().uuid(),
  connectionName: z.enum(["meta", "google"]).default("meta"),
  identifier: z.string().optional(),
})

socialTestInstallRoutes.post("/install-for-test", zValidator("json", installBody), async (c) => {
  assertTestEnv()
  const body = c.req.valid("json")
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"

  // Attribute seeded rows to a real user in the org.
  const installedBy = await withSystemDb("social-test-install:resolve-installer", async (db) => {
    const r = await db.execute(
      sql.raw(
        `SELECT id FROM ${schemaRef("kernel")}.users WHERE org_id = '${body.orgId}' ORDER BY created_at ASC LIMIT 1`,
      ),
    )
    const rows =
      (r as unknown as { rows?: Array<{ id: string }> }).rows ??
      (r as unknown as Array<{ id: string }>)
    const userId = rows?.[0]?.id
    if (!userId) {
      throw new HTTPException(500, {
        message: `social install-for-test: org ${body.orgId} has no users; seed the org first`,
      })
    }
    return userId
  })

  // Install the frozen `.liaisonapp` (serves `ui.js` to the web shell, creates
  // the active-version row, registers the app + its schema/tools for the org).
  // The handler bundle still loads FROM SOURCE via the
  // LIAISON_BUNDLED_APPS_FROM_SOURCE side channel above (loadBundle rebuilds
  // `bundled-apps/social/handlers.ts`), so handler edits take effect without a
  // re-freeze — only the UI bundle comes from the installed tarball.
  if (!existsSync(SOCIAL_BUNDLE)) {
    throw new HTTPException(500, {
      message: `social install-for-test: bundle missing at ${SOCIAL_BUNDLE} — run \`bash scripts/build-bundled-app.sh social --skip-sign\``,
    })
  }
  // `apps_installed` is a GLOBAL (org-agnostic) registry keyed by app name. In a
  // single Playwright worker the same `social` app is shared across every test
  // file, so a second `installAppFromTarball` for the same worker hits a
  // primary-key conflict. Install the tarball only once per worker; subsequent
  // calls just re-reconcile + re-seed for the requesting org (idempotent).
  const alreadyInstalled = await withSystemDb("social-test-install:check-installed", async (db) => {
    const r = await db.execute(
      sql.raw(`SELECT 1 FROM ${schemaRef("kernel")}.apps_installed WHERE name = 'social' LIMIT 1`),
    )
    const rows = (r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])
    return Array.isArray(rows) && rows.length > 0
  })
  if (!alreadyInstalled) {
    await installAppFromTarball({
      // Test harness: stands in for the admin approving the interface at install.
      approveUiFullAccess: true,
      tarballPath: bakeIntoTestCatalog(SOCIAL_BUNDLE),
      installedBy,
      grantedScopes: SOCIAL_GRANTED_SCOPES,
      grantedConnections: ["meta", "google"],
    })
  }
  await reloadInstalledApps(body.orgId)

  // Seed a `social` connected_account so the connection-established setup has a
  // record to attach to (the E2E asserts findings ingest from a connected acct).
  const identifier = body.identifier ?? `acct-${randomBytes(4).toString("hex")}`
  const kerSchema = schemaRef("kernel")
  const connectedAccountId = await withSystemDb(
    "social-test-install:seed-connected-account",
    async (db) => {
      const id = randomUUID()
      await db.execute(
        sql.raw(
          `INSERT INTO ${kerSchema}.connected_accounts
            (id, org_id, app_name, connection_name, owner_type, owner_id,
             provider_type, identifier, display_name, status, created_by)
           VALUES ('${id}', '${body.orgId}', 'social', '${body.connectionName}', 'org', NULL,
                   'oauth2', '${identifier}', '${identifier}', 'active', '${installedBy}')`,
        ),
      )
      return id
    },
  )

  return c.json({ appName: "social", connectedAccountId, identifier })
})

const seedFindingBody = z.object({
  orgId: z.string().uuid(),
  platform: z.enum(["facebook", "instagram", "youtube"]).default("youtube"),
  externalId: z.string().optional(),
  relation: z.string().default("keyword_match"),
  contentText: z.string().default("Where can I buy this?"),
  status: z.string().default("new"),
  authorHandle: z.string().default("@fan"),
})

socialTestInstallRoutes.post("/seed-finding", zValidator("json", seedFindingBody), async (c) => {
  assertTestEnv()
  const body = c.req.valid("json")
  const appSchema = schemaRef("app_social")
  const externalId = body.externalId ?? `ext-${randomBytes(4).toString("hex")}`
  const id = await withSystemDb("social-test-install:seed-finding", async (db) => {
    const fid = randomUUID()
    await db.execute(
      sql.raw(
        `INSERT INTO ${appSchema}.finding
            (id, org_id, platform, external_id, relation, content_text, author_handle, status)
           VALUES ('${fid}', '${body.orgId}', '${body.platform}', '${externalId}',
                   '${body.relation}', '${body.contentText.replace(/'/g, "''")}',
                   '${body.authorHandle.replace(/'/g, "''")}', '${body.status}')`,
      ),
    )
    return fid
  })
  return c.json({ findingId: id, externalId })
})

const seedConversationBody = z.object({
  orgId: z.string().uuid(),
  platform: z.enum(["facebook", "instagram"]).default("instagram"),
  lastInboundAt: z.string().optional(),
  participantHandle: z.string().default("@fan"),
})

socialTestInstallRoutes.post(
  "/seed-conversation",
  zValidator("json", seedConversationBody),
  async (c) => {
    assertTestEnv()
    const body = c.req.valid("json")
    const appSchema = schemaRef("app_social")
    const lastInbound = body.lastInboundAt ?? new Date().toISOString()
    const id = await withSystemDb("social-test-install:seed-conversation", async (db) => {
      const cid = randomUUID()
      const externalId = `psid-${randomBytes(4).toString("hex")}`
      // A received DM has a latest message: dm_list hides conversations with
      // no snippet (Meta's empty shells of deleted or blocked accounts).
      const handle = body.participantHandle.replace(/'/g, "''")
      await db.execute(
        sql.raw(
          `INSERT INTO ${appSchema}.dm_conversation
            (id, org_id, platform, external_id, participant_handle, last_inbound_at,
             last_message_at, last_message_snippet, status)
           VALUES ('${cid}', '${body.orgId}', '${body.platform}', '${externalId}',
                   '${handle}', '${lastInbound}', '${lastInbound}', 'Hi from ${handle}', 'open')`,
        ),
      )
      return cid
    })
    return c.json({ conversationId: id })
  },
)

// — platform-fetch mock control + recorder (B10) —
//
// The social platform-fetch mock runs SERVER-SIDE (in the spawned API process),
// so the Playwright worker drives it over HTTP. `mode` forces a post-back HTTP
// status (failure arms); `requests` reads the recorder (assert "no graph POST
// before approve / exactly one after"); `reset` clears both.

const mockModeBody = z.object({ postStatus: z.number().int().optional() })

socialTestInstallRoutes.post("/mock/mode", zValidator("json", mockModeBody), (c) => {
  assertTestEnv()
  setSocialMockMode(c.req.valid("json"))
  return c.json({ ok: true })
})

socialTestInstallRoutes.post("/mock/reset", (c) => {
  assertTestEnv()
  resetSocialMockState()
  return c.json({ ok: true })
})

socialTestInstallRoutes.get("/mock/requests", (c) => {
  assertTestEnv()
  return c.json({ requests: socialMockAllRequests() })
})

// — deactivate / reactivate (B10 lifecycle assertion) —
//
// The social app is registered from source (not via the freeze/install store),
// so its lifecycle is driven directly through the runtime registration helpers:
//   deactivate → teardownAppRegistrations → pauseAppRoutinesForOrg
//        (instantiated app routines flip to status='paused_app_disabled')
//   reactivate → registerApps → resumeAppRoutinesForOrg
//        (those routines restore to status='active')
// The E2E enables a routine template, deactivates, asserts paused, reactivates,
// asserts active — proving Task A12's lifecycle pause end-to-end (§9 last / §1 #10).

const lifecycleBody = z.object({ orgId: z.string().uuid() })

socialTestInstallRoutes.post(
  "/deactivate-for-test",
  zValidator("json", lifecycleBody),
  async (c) => {
    assertTestEnv()
    const { orgId } = c.req.valid("json")
    await teardownAppRegistrations(orgId, "social")
    return c.json({ ok: true, appName: "social", action: "deactivated" })
  },
)

socialTestInstallRoutes.post(
  "/reactivate-for-test",
  zValidator("json", lifecycleBody),
  async (c) => {
    assertTestEnv()
    const { orgId } = c.req.valid("json")
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    // Re-register the installed app for the org → resumeAppRoutinesForOrg restores
    // the paused (`paused_app_disabled`) instantiated routines to `active`.
    await reloadInstalledApps(orgId)
    return c.json({ ok: true, appName: "social", action: "reactivated" })
  },
)

// — guide-read (B10 §9 #11) —
//
// Proves the social app's `social-overview` guide was seeded into the skill
// registry through the real install-from-source reconcile path: reads it via
// the SAME `skill_read` tool the agent uses (full scopes so requiredScopes are
// never the blocker), returning the seeded body. The E2E asserts the body is
// the real, non-placeholder guide content.

const guideBody = z.object({
  orgId: z.string().uuid(),
  name: z.string().default("social-overview"),
})

socialTestInstallRoutes.post("/read-guide-for-test", zValidator("json", guideBody), async (c) => {
  assertTestEnv()
  const { orgId, name } = c.req.valid("json")
  const userId = await withSystemDb("social-test-install:resolve-reader", async (db) => {
    const r = await db.execute(
      sql.raw(
        `SELECT id FROM ${schemaRef("kernel")}.users WHERE org_id = '${orgId}' ORDER BY created_at ASC LIMIT 1`,
      ),
    )
    const rows =
      (r as unknown as { rows?: Array<{ id: string }> }).rows ??
      (r as unknown as Array<{ id: string }>)
    const uid = rows?.[0]?.id
    if (!uid) {
      throw new HTTPException(500, {
        message: `social read-guide-for-test: org ${orgId} has no users`,
      })
    }
    return uid
  })
  const res = await handleSkillRead({ name }, { orgId, userId, scopes: ["*"] })
  return c.json(res)
})
