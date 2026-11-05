// SPDX-License-Identifier: FSL-1.1-ALv2
// HTTP-level tests for the `/api/apps` routes: auth gating, the registry
// listing, upgrade-preview error branches, and `:name` path-traversal
// rejection. The download-based happy paths (install / signed upgrade) are
// covered at the service layer in `install-service.test.ts` — exercising them
// over HTTP would need a cosign-signed tarball served on a port, since the
// routes honor `LIAISON_REQUIRE_APP_SIGNATURE` (default `true`).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000aac01"
const USER = "00000000-0000-4000-8000-0000000aac02"

let adminToken: string
let plainToken: string

async function token(scopes: string[]): Promise<string> {
  return signAccessToken(
    {
      userId: USER,
      orgId: ORG,
      name: "Apps Admin",
      authVersion: 1,
      permissionVersion: 1,
      scopes,
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Apps Route Org', 'apps-route-org')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'apps-route@test.com', 'Apps Admin')`
  adminToken = await token(["kernel:apps:admin"])
  plainToken = await token([])
})

afterAll(async () => {
  await sql`DELETE FROM kernel.apps_installed WHERE name LIKE 'route-test%'`
  await sql`DELETE FROM kernel.apps_active_version WHERE name LIKE 'route-test%'`
  await sql`DELETE FROM kernel.users WHERE id = ${USER}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

async function authed(path: string, t: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${t}` },
  })
}

describe("/api/apps auth gating", () => {
  it("401s every route without a token", async () => {
    expect((await app.request("/api/apps")).status).toBe(401)
    expect((await app.request("/api/apps/install", { method: "POST" })).status).toBe(401)
    expect((await app.request("/api/apps/x", { method: "DELETE" })).status).toBe(401)
    expect((await app.request("/api/apps/x/upgrade/preview", { method: "POST" })).status).toBe(401)
  })

  it("403s every route for a token lacking kernel:apps:admin", async () => {
    expect((await authed("/api/apps", plainToken)).status).toBe(403)
    expect((await authed("/api/apps/install", plainToken, { method: "POST" })).status).toBe(403)
    expect((await authed("/api/apps/x", plainToken, { method: "DELETE" })).status).toBe(403)
    expect((await authed("/api/apps/x/upgrade/apply", plainToken, { method: "POST" })).status).toBe(
      403,
    )
  })
})

describe("GET /api/apps", () => {
  it("returns the registry listing including bundled apps for an admin", async () => {
    const res = await authed("/api/apps", adminToken)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ name: string; source: string }> }
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data.some((a) => a.source === "in-tree")).toBe(true)
  })
})

describe("POST /api/apps/install validation", () => {
  it("400s when the body has no url", async () => {
    const res = await authed("/api/apps/install", adminToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(400)
  })
})

describe("signature-required-but-no-trusted-publisher misconfiguration (operator trap)", () => {
  // The trap: signature verification is required but LIAISON_TRUSTED_APP_PUBLISHERS
  // is unset. Without the guard this surfaced as an opaque 500, pushing operators
  // to disable signing entirely. It must be an actionable 4xx naming the env var.
  function withSignatureEnv<T>(
    cfg: { require: string; publishers: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    const prevRequire = env.LIAISON_REQUIRE_APP_SIGNATURE
    const prevPublishers = env.LIAISON_TRUSTED_APP_PUBLISHERS
    env.LIAISON_REQUIRE_APP_SIGNATURE = cfg.require
    env.LIAISON_TRUSTED_APP_PUBLISHERS = cfg.publishers
    return fn().finally(() => {
      env.LIAISON_REQUIRE_APP_SIGNATURE = prevRequire
      env.LIAISON_TRUSTED_APP_PUBLISHERS = prevPublishers
    })
  }

  it("returns an actionable 400 (not a 500) naming the env var when signing is required and the publisher is unset", async () => {
    await withSignatureEnv({ require: "true", publishers: "" }, async () => {
      const res = await authed("/api/apps/install", adminToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.invalid/app.liaisonapp" }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { message: string } }
      expect(body.error.message).toMatch(/LIAISON_TRUSTED_APP_PUBLISHERS/)
      // And it must NOT have leaked as a 500 / opaque internal error.
      expect(body.error.message).not.toMatch(/internal server error/i)
    })
  })

  it("rejects a '.*' wildcard publisher with the same actionable 400", async () => {
    await withSignatureEnv({ require: "true", publishers: ".*" }, async () => {
      const res = await authed("/api/apps/install", adminToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.invalid/app.liaisonapp" }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { message: string } }
      expect(body.error.message).toMatch(/LIAISON_TRUSTED_APP_PUBLISHERS/)
    })
  })

  it("does not fire the guard once a publisher is configured (config-gated, not a blanket block)", async () => {
    // With a real publisher set, the misconfig guard must NOT short-circuit. The
    // request then proceeds to the download, which fails for an unrelated reason
    // (unresolvable host) — proving the 400 above is specific to the misconfig,
    // not a blanket rejection of every install while signing is on.
    await withSignatureEnv(
      { require: "true", publishers: "https://github.com/liaison-apps/.*" },
      async () => {
        const res = await authed("/api/apps/install", adminToken, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://example.invalid/app.liaisonapp" }),
        })
        // Past the guard: whatever the download failure is, it must NOT be the
        // trusted-publisher misconfiguration message.
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
        expect(body.error?.message ?? "").not.toMatch(/LIAISON_TRUSTED_APP_PUBLISHERS/)
      },
    )
  })
})

describe("path-traversal rejection on :name", () => {
  it("400s a DELETE with a traversal-shaped app name", async () => {
    const res = await authed("/api/apps/..%2f..%2fetc", adminToken, { method: "DELETE" })
    expect(res.status).toBe(400)
  })
})

describe("DELETE /:name bundled-app guard", () => {
  // Bundled (in-tree) apps must NOT be uninstallable via the API — the install
  // path already rejects bundled-name collisions; uninstall must be symmetric, or
  // a DELETE would unregister a bundled app's live handlers (no DB row to remove)
  // and falsely report success.
  it("409s an attempt to uninstall a bundled (in-tree) app", async () => {
    const list = (await (await authed("/api/apps", adminToken)).json()) as {
      data: Array<{ name: string; source: string }>
    }
    const bundled = list.data.find((a) => a.source === "in-tree")
    expect(bundled, "expected at least one in-tree app in the registry").toBeDefined()
    const res = await authed(`/api/apps/${bundled!.name}`, adminToken, { method: "DELETE" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/bundled/i)
  })
})

describe("POST /:name/upgrade/preview", () => {
  it("404s when the app is not installed", async () => {
    const res = await authed("/api/apps/route-test-absent/upgrade/preview", adminToken, {
      method: "POST",
    })
    expect(res.status).toBe(404)
  })

  it("404s with a 'no update channel' message when update_url is null", async () => {
    await sql`INSERT INTO kernel.apps_installed (name, version, source_url, update_url, sha256, installed_by)
      VALUES ('route-test-pinned', '1.0.0', 'https://example.com/route-test-pinned-1.0.0.liaisonapp', NULL, ${"a".repeat(64)}, ${USER})`
    await sql`INSERT INTO kernel.apps_active_version (name, version) VALUES ('route-test-pinned', '1.0.0')`
    const res = await authed("/api/apps/route-test-pinned/upgrade/preview", adminToken, {
      method: "POST",
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message ?? "").toMatch(/update channel/i)
  })
})
