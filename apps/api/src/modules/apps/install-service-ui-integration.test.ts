// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16.5 — End-to-end backend pipeline test: a tarball with `ui.tsx`
// survives freeze → install → discovery → registration → manifest
// announcement → HTTP serve.
//
// Must run under `bun:test` — `freezeApp` uses `Bun.build` + esbuild and
// `child_process.spawnSync('tar')`. The freeze-tool import path is a 6-level
// relative because `liaison/tsconfig.json` has no path alias to `scripts/`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { env } from "~/lib/env"
import { discoverInstalledApps } from "~/modules/apps/discover-apps"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
// 5-level relative — `liaison/tsconfig.json` has no alias to `scripts/`.
// Path: apps/api/src/modules/apps -> liaison root -> scripts/freeze-app.
import { freezeApp } from "../../../../../scripts/freeze-app"

const ORG = "00000000-0000-4000-8000-0000000ee001"
const USER = "00000000-0000-4000-8000-0000000ee002"
const ADMIN_UUID = "00000000-0000-4000-8000-0000000ee003"
const APP_NAME = "ui-int-fixture"
const APP_VERSION = "1.0.0"

let workspace: string
let token: string

async function authed(path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } })
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'UI Int Org', 'ui-int-org')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'uiint@test.com', 'UIint')`
  token = await signAccessToken(
    {
      userId: USER,
      orgId: ORG,
      name: "UI Int",
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["kernel:apps:admin"],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )

  workspace = mkdtempSync(join(tmpdir(), "ui-integration-"))
  process.env.LIAISON_APPS_DIR = join(workspace, "install-root")
  mkdirSync(process.env.LIAISON_APPS_DIR, { recursive: true })

  // Build a fixture app source dir with ui.tsx
  const appDir = join(workspace, "src-app")
  mkdirSync(appDir, { recursive: true })
  writeFileSync(
    join(appDir, "app.manifest.json"),
    JSON.stringify({
      name: APP_NAME,
      version: APP_VERSION,
      packageFormat: 1,
      license: "MIT",
      scopes: [`${APP_NAME}:noop`],
    }),
  )
  writeFileSync(join(appDir, "handlers.ts"), `export const noop = async () => ({})`)
  writeFileSync(
    join(appDir, "ui.tsx"),
    `import { createSignal } from "solid-js"
     export function SettingsPanel() {
       const [n] = createSignal(42)
       return <div data-testid="ui-int">{n()}</div>
     }`,
  )

  const { tarballPath } = await freezeApp({
    appName: APP_NAME,
    appDir,
    outDir: join(workspace, "dist"),
  })
  await installAppFromTarball({
    tarballPath,
    installedBy: ADMIN_UUID,
    grantedScopes: [`${APP_NAME}:noop`],
    requireSignature: false,
    // An unsigned third-party UI runs only once an admin approves it
    // (install-grants.test.ts covers the refusal); this test is about serving it.
    approveUiFullAccess: true,
  })

  // Discovery boundary check — if the installed manifest is malformed,
  // discovery silently skips it and the manifest-fetch test would fail with
  // an opaque "no app" — catch the bug at the right layer.
  const discovered = await discoverInstalledApps()
  if (!discovered.some((a) => a.name === APP_NAME)) {
    throw new Error(
      `discoverInstalledApps did not see '${APP_NAME}' — the installed manifest is malformed`,
    )
  }

  await reloadInstalledApps(ORG)
})

afterAll(async () => {
  rmSync(workspace, { recursive: true, force: true })
  delete process.env.LIAISON_APPS_DIR
  await withSystemDb("ui-int:cleanup", async (db) => {
    await db.delete(appsInstalled).where(eq(appsInstalled.name, APP_NAME))
    await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, APP_NAME))
  })
  await sql`DELETE FROM kernel.users WHERE id = ${USER}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

async function announcedUiBundleUrl(): Promise<string | null | undefined> {
  const res = await authed("/api/apps/manifests")
  expect(res.status).toBe(200)
  const json = (await res.json()) as { data: Array<{ name: string; uiBundleUrl: string | null }> }
  return json.data.find((a) => a.name === APP_NAME)?.uiBundleUrl
}

describe("Plugin UI bundle — install + serve + announce (integration)", () => {
  it("/api/apps/manifests returns the installed app with a non-null uiBundleUrl", async () => {
    // The URL carries a signed `t` token for the bundle route.
    const url = await announcedUiBundleUrl()
    expect(url?.split("?")[0]).toBe(`/api/apps/${APP_NAME}/${APP_VERSION}/ui.js`)
    expect(new URL(url ?? "", "http://x").searchParams.get("t")).toBeTruthy()
  })

  it("the announced uiBundleUrl serves valid ESM with the declared export", async () => {
    const url = await announcedUiBundleUrl()
    expect(url).toBeTruthy()
    const res = await authed(url as string)
    expect(res.status).toBe(200)
    // An outside app's bundle (here admin-approved, not first-party) is served as
    // text the page hands to the app's sandboxed frame, never as a script this
    // origin runs (ui-bundle-routes.ts).
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/)
    const body = await res.text()
    expect(
      /export\s*\{[^}]*\bSettingsPanel\b[^}]*\}|export\s+function\s+SettingsPanel\b/.test(body),
    ).toBe(true)
    expect(body).toMatch(/from\s+["']solid-js["']/)
  })
})
