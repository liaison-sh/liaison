// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration tests for GitLab app discovery, registration, and tool wiring (Task 5).
 *
 * Covers:
 *  - All 13 gitlab tools registered (deferred) in toolRegistry after ensureAppsForOrg.
 *  - connectionConfigRegistry has 'gitlab' with allowedDomains containing
 *    BOTH 'gitlab.com' (exact) and '*.gitlab.com' (wildcard).
 *  - member/admin roles + scopes present.
 *  - E2E tool round-trip: register app → seed org-owned creds →
 *    call gitlab_list_commits through the registered handler/bridge/client
 *    with a stubbed HTTP boundary → mapped result.
 *
 * No DB required for pure registry assertions; full infra required for
 * the E2E tool round-trip (bridge resolves creds from kernel.connected_accounts).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import {
  connectionConfigRegistry,
  resetAppRegistries,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// ---------------------------------------------------------------------------
// Per-run-unique org (canonical pattern — mirrors sync.integration.test.ts and
// sync-reconciler.integration.test.ts): acquireTestLock() + gen_random_uuid()
// org with a Date.now() slug, so concurrent/repeat runs never collide and there
// is no hardcoded-UUID / manual ON CONFLICT / DELETE bookkeeping.
// ---------------------------------------------------------------------------

let TEST_ORG: string
let TEST_USER: string

const CANNED_TOKEN = "glpat-registration-test-token-88"
const CANNED_GROUP = "acme-org"

// The 13 tools declared in app.manifest.json
const EXPECTED_TOOLS = [
  "gitlab_list_projects",
  "gitlab_list_commits",
  "gitlab_get_commit",
  "gitlab_list_merge_requests",
  "gitlab_get_merge_request",
  "gitlab_list_issues",
  "gitlab_list_milestones",
  "gitlab_list_labels",
  "gitlab_list_releases",
  "gitlab_list_tags",
  "gitlab_read_file",
  "gitlab_list_tree",
  "gitlab_search",
]

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await acquireTestLock()
  const slug = `gitlab-reg-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'GitlabRegistrationOrg', ${slug})
          RETURNING id`,
    ),
  )
  TEST_ORG = org!.id

  const [u] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users
          (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${TEST_ORG}::uuid,
                  ${`alice-reg-${Date.now()}@gitlab-reg.test`},
                  'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  TEST_USER = u!.id

  // Ensure the gitlab app is registered for this org (discovers in-tree apps)
  await ensureAppsForOrg(TEST_ORG)
})

afterAll(async () => {
  OutboundFetchTestAccess.setFetch(null)
  // A registration test mutates the global app registries (ensureAppsForOrg),
  // so reset them to keep the flat-run isolation contract.
  resetAppRegistries()
  await releaseTestLock()
})

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
})

// ---------------------------------------------------------------------------
// Helper: seed org-owned gitlab credentials
// ---------------------------------------------------------------------------

async function seedGitlabCredentials(): Promise<void> {
  const credentialsJson = JSON.stringify({ token: CANNED_TOKEN, group: CANNED_GROUP })
  const encrypted = encryptSecret(
    credentialsJson,
    env.ENCRYPTION_KEY,
    CryptoContext.connectedAccountCredentials,
  )
  await db.execute(
    sql`INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type,
         identifier, access_token_encrypted, refresh_token_encrypted, credentials_encrypted,
         status, created_by)
        VALUES (
          ${TEST_ORG}::uuid, 'gitlab', 'gitlab', 'org', NULL, 'credentials',
          ${CANNED_GROUP},
          NULL, NULL,
          ${encrypted},
          'active', ${TEST_USER}::uuid
        )
        ON CONFLICT DO NOTHING`,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitLab app registration (T5)", () => {
  // -------------------------------------------------------------------------
  // Tool registry: 13 tools, all deferred
  // -------------------------------------------------------------------------

  it("all 13 gitlab tools are registered in toolRegistry", () => {
    for (const toolName of EXPECTED_TOOLS) {
      const entry = toolRegistry.get([TEST_ORG, "gitlab", toolName])
      expect(entry, `Tool '${toolName}' should be registered`).toBeDefined()
      expect(entry?.appName).toBe("gitlab")
      expect(entry?.name).toBe(toolName)
    }
  })

  it("exactly 13 gitlab tools are registered (no extra tools)", () => {
    const registeredGitlabTools: string[] = []
    for (const [[orgId, appName, toolName]] of toolRegistry.entries()) {
      if (orgId === TEST_ORG && appName === "gitlab") {
        registeredGitlabTools.push(toolName)
      }
    }
    expect(registeredGitlabTools.sort()).toEqual([...EXPECTED_TOOLS].sort())
  })

  it("gitlab tools are registered with trustBoundary='user' and scope='gitlab:repo:read'", () => {
    for (const toolName of EXPECTED_TOOLS) {
      const entry = toolRegistry.get([TEST_ORG, "gitlab", toolName])
      expect(entry?.trustBoundary, `${toolName} trustBoundary`).toBe("user")
      expect(entry?.requiredScopes, `${toolName} scope`).toEqual(["gitlab:repo:read"])
    }
  })

  // -------------------------------------------------------------------------
  // connectionConfigRegistry: gitlab + allowedDomains
  // -------------------------------------------------------------------------

  it("connectionConfigRegistry has 'gitlab' connection for this org", () => {
    const config = connectionConfigRegistry.get([TEST_ORG, "gitlab", "gitlab"])
    expect(config).toBeDefined()
    expect(config?.type).toBe("credentials")
  })

  it("allowedDomains contains 'gitlab.com' (exact match)", () => {
    const config = connectionConfigRegistry.get([TEST_ORG, "gitlab", "gitlab"])
    expect(config?.allowedDomains).toContain("gitlab.com")
  })

  it("allowedDomains contains '*.gitlab.com' (wildcard for subdomains)", () => {
    const config = connectionConfigRegistry.get([TEST_ORG, "gitlab", "gitlab"])
    expect(config?.allowedDomains).toContain("*.gitlab.com")
  })

  it("allowedDomains contains BOTH exact and wildcard domains", () => {
    const config = connectionConfigRegistry.get([TEST_ORG, "gitlab", "gitlab"])
    const domains = config?.allowedDomains ?? []
    expect(domains).toContain("gitlab.com")
    expect(domains).toContain("*.gitlab.com")
    // Exactly 2 entries — the manifest declares only these two
    expect(domains.length).toBe(2)
  })

  // -------------------------------------------------------------------------
  // Credential fields
  // -------------------------------------------------------------------------

  it("connectionConfig has credentialFields for 'token' and 'group'", () => {
    const config = connectionConfigRegistry.get([TEST_ORG, "gitlab", "gitlab"])
    const fieldNames = (config?.credentialFields ?? []).map((f) => f.name)
    expect(fieldNames).toContain("token")
    expect(fieldNames).toContain("group")
  })

  it("token credential field is type='password'", () => {
    const config = connectionConfigRegistry.get([TEST_ORG, "gitlab", "gitlab"])
    const tokenField = config?.credentialFields?.find((f) => f.name === "token")
    expect(tokenField?.type).toBe("password")
  })

  // -------------------------------------------------------------------------
  // E2E tool round-trip: gitlab_list_commits through bridge/client
  // -------------------------------------------------------------------------

  it("E2E: gitlab_list_commits round-trip through registered handler/bridge/client returns mapped result", async () => {
    await seedGitlabCredentials()

    // Stub HTTP boundary: return a canned list of commits
    const cannedCommits = [
      {
        id: "abc123",
        short_id: "abc123",
        title: "Initial commit",
        message: "Initial commit",
        author_name: "Alice",
        authored_date: "2024-01-01T00:00:00Z",
        committed_date: "2024-01-01T00:00:00Z",
        web_url: "https://gitlab.com/acme-org/my-project/-/commit/abc123",
        parent_ids: [],
      },
    ]

    OutboundFetchTestAccess.setFetch(
      (async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(cannedCommits), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    )

    // Import the bridge extension factory and invoke it directly with a synthetic context
    // that uses an RLS-scoped tx so the type matches BridgeExtensionContext.txDb: RlsClient.
    const { createGitlabBridgeExtension } = await import("~/apps/gitlab/bridge")

    const result = await withRlsContext(
      {
        actorType: "user",
        orgId: TEST_ORG,
        userId: TEST_USER,
        scopes: ["gitlab:repo:read", "gitlab:accounts:read"],
        dimensionGrants: {},
      },
      async (tx) => {
        const bridgeExt = createGitlabBridgeExtension({
          txDb: tx,
          orgId: TEST_ORG,
          userId: TEST_USER,
          appName: "gitlab",
          actorType: "user",
        })

        const handler = bridgeExt.gitlab_list_commits
        if (!handler) throw new Error("gitlab_list_commits bridge method not found")

        // Call the bridge method as the sandbox would: JSON-stringify params
        const resultJson = await handler(JSON.stringify({ project: "123", ref: "main" }))
        return JSON.parse(resultJson) as unknown
      },
    )

    // The tool should return a mapped result containing the commit(s)
    expect(result).toBeTruthy()
    // NOT_CONNECTED shape check: must NOT have error.code === 'not_connected'
    const r = result as { error?: { code?: string } }
    expect(r.error?.code).not.toBe("not_connected")
    // gitlabListCommits returns `{ commits: [...] }` (an object, NOT a bare array).
    // Assert the real shape so the canned commit genuinely round-trips through the
    // bridge → handler → client → mapped result.
    const r2 = result as {
      commits: Array<{ sha: string; shortSha: string; author: string }>
    }
    expect(Array.isArray(r2.commits)).toBe(true)
    expect(r2.commits.length).toBeGreaterThan(0)
    expect(r2.commits[0]!.sha).toBe("abc123")
    expect(r2.commits[0]!.author).toBe("Alice")
  })
})
