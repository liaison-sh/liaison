// SPDX-License-Identifier: FSL-1.1-ALv2
// Disconnecting an org-owned Google Drive connection from the Drive settings page.
//
//   1. An admin holding `google-drive:accounts:admin` opens Settings > Apps >
//      Google Drive, clicks Disconnect on the org-owned account and confirms.
//      The account leaves the list and the API, its tokens are wiped, and the
//      Drive folder synced from that account goes with it: its documents leave
//      Knowledge and search.
//   2. A member without that scope sees no Disconnect control for the org-owned
//      account, and the API refuses the same disconnect.
//
// The connection carries fake tokens and the lane's mock Drive serves the
// folder. Revoking the grant at Google is best effort: its failure is tolerated.

import { api, type WorkerEnv } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import {
  createSyncedSourceViaApi,
  reconcileSyncedSourceInline,
  searchKnowledge,
} from "./helpers/knowledge-seed"
import { seedFactory } from "./helpers/seed"

const QA_PASSWORD = "QaPass1!"

function ks(env: WorkerEnv): string {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

/** A suffix that fits Drive's file id charset `[A-Za-z0-9_-]{8,128}`. */
function idSuffix(env: WorkerEnv): string {
  const worker = env.schemaPrefix.replace(/_/g, "") || "w"
  return `${worker}${Date.now().toString(36)}`
}

/**
 * An org-owned Drive connection (owner_type 'org', no owner) with fake tokens,
 * made by the seed engine's `connections.mock` in the server under test.
 */
async function seedOrgDriveConnection(
  env: WorkerEnv,
  orgId: string,
  createdBy: string,
  identifier: string,
  sharedDrive: { id: string; name: string },
): Promise<string> {
  const { id } = await seedFactory<{ id: string }>(env, orgId, "connections.mock", {
    appName: "google-drive",
    connectionName: "drive",
    ownerType: "org",
    userId: createdBy,
    identifier,
    displayName: "Org Drive (E2E)",
    // An org connection reads only the shared drives an admin chose.
    metadata: { sharedDrives: [sharedDrive] },
    kind: {
      type: "oauth2",
      providerAccountId: `e2e-org-drive-${identifier}`,
      accessToken: "e2e-fake-org-token",
      refreshToken: "e2e-fake-org-refresh",
    },
  })
  return id
}

async function connectionRow(
  env: WorkerEnv,
  id: string,
): Promise<{ status: string; access: string | null; refresh: string | null } | undefined> {
  const rows = (await env.db.sql.unsafe(
    `SELECT status, access_token_encrypted AS access, refresh_token_encrypted AS refresh
       FROM ${ks(env)}.connected_accounts WHERE id = $1`,
    [id],
  )) as unknown as Array<{ status: string; access: string | null; refresh: string | null }>
  return rows[0]
}

async function accountIds(env: WorkerEnv, token: string): Promise<string[]> {
  const res = await api(env.serverUrl, "/api/connections/google-drive/drive/accounts", { token })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return ((res.body as { data: Array<{ id: string }> }).data ?? []).map((a) => a.id)
}

async function searchHit(
  env: WorkerEnv,
  token: string,
  query: string,
  docId: string,
): Promise<boolean> {
  const res = await searchKnowledge(env, token, query)
  return res.hits.some((h) => h.sourceEntityId === docId)
}

test.describe("Google Drive: disconnecting an org-owned connection", () => {
  test("an admin disconnects it from the Drive settings page; its synced folder leaves Knowledge and search", async ({
    page,
    env,
    qa,
    world,
  }) => {
    test.skip(!env.mockDrive, "mock Drive server did not start in this worker")
    if (!env.mockDrive) return

    const sfx = idSuffix(env)
    const identifier = `org-drive-${sfx}@example.com`
    const folderId = `DDFOLDER${sfx}`
    const fileId = `DDFILE${sfx}`
    const word = `zephyrine${sfx.toLowerCase().replace(/[^a-z0-9]/g, "")}`
    const sharedDrive = { id: `DDDRIVE${sfx}`, name: `Org Shared ${sfx}` }

    env.mockDrive.resetFixtures()
    env.mockDrive.resetRequestLog()
    env.mockDrive.addFixture({
      id: folderId,
      name: `Org Handbook ${sfx}`,
      mimeType: "application/vnd.google-apps.folder",
      driveId: sharedDrive.id,
    })
    env.mockDrive.addFixture({
      id: fileId,
      name: `${word}.md`,
      mimeType: "text/markdown",
      parentId: folderId,
      driveId: sharedDrive.id,
      downloadBody: Buffer.from(`# ${word}\n\nThe ${word} handbook.`, "utf-8").toString("base64"),
      modifiedTime: "2026-10-01T10:00:00Z",
    })

    const connectionId = await seedOrgDriveConnection(
      env,
      world.org.id,
      qa.admin.id,
      identifier,
      sharedDrive,
    )

    // The org folder records the org account it syncs from (the admin holds no
    // personal Drive connection here), so disconnecting that account purges it.
    const source = await createSyncedSourceViaApi(env, qa.admin.token, {
      folderRef: folderId,
      displayName: `Org Handbook ${sfx}`,
      scope: "organization",
      defaultSensitivity: "internal",
    })
    expect((source as unknown as { sourceAccount?: string | null }).sourceAccount).toBe(identifier)
    const stats = await reconcileSyncedSourceInline(env, qa.admin.token, source.id)
    expect(stats, `reconcile stats: ${JSON.stringify(stats)}`).toMatchObject({
      status: "ok",
      documentsUpserted: 1,
    })

    const docsRes = await api(env.serverUrl, "/api/knowledge/documents", { token: qa.admin.token })
    expect(docsRes.status).toBe(200)
    const doc = (
      docsRes.body as { data: Array<{ id: string; title: string; syncedSourceId?: string | null }> }
    ).data.find((d) => d.syncedSourceId === source.id)
    expect(doc, "the synced document exists before the disconnect").toBeTruthy()
    const docId = doc!.id
    await expect
      .poll(() => searchHit(env, qa.admin.token, word, docId), { timeout: 30_000 })
      .toBe(true)
    expect(await accountIds(env, qa.admin.token)).toContain(connectionId)

    // ── Browser: Settings > Apps > Google Drive, Disconnect, confirm ──────
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/settings/apps/google-drive`)
    const account = page.getByTestId(`connections-account-${connectionId}`)
    await expect(account).toBeVisible({ timeout: 15_000 })
    await page.getByTestId(`connections-disconnect-${connectionId}`).click()
    await expect(page.getByTestId("connections-disconnect-dialog")).toBeVisible()
    const deleted = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/connections/${connectionId}`) && r.request().method() === "DELETE",
    )
    await page.getByTestId("connections-disconnect-dialog-confirm").click()
    const deleteResponse = await deleted
    expect(deleteResponse.status(), await deleteResponse.text()).toBe(200)

    // The account leaves the list, here and in the API; its tokens are wiped.
    await expect(account).toHaveCount(0, { timeout: 15_000 })
    expect(await accountIds(env, qa.admin.token)).not.toContain(connectionId)
    const row = await connectionRow(env, connectionId)
    expect(row?.status).toBe("disconnected")
    expect(row?.access ?? null).toBeNull()
    expect(row?.refresh ?? null).toBeNull()

    // The synced folder goes with the account (the disconnect event runs the purge).
    await expect
      .poll(
        async () =>
          (await api(env.serverUrl, `/api/knowledge/documents/${docId}`, { token: qa.admin.token }))
            .status,
        { timeout: 30_000 },
      )
      .toBe(404)
    const sourcesLeft = (await env.db.sql.unsafe(
      `SELECT count(*)::int AS n FROM ${
        env.schemaPrefix ? `"${env.schemaPrefix}app_knowledge"` : "app_knowledge"
      }.synced_sources WHERE id = $1`,
      [source.id],
    )) as unknown as Array<{ n: number }>
    expect(sourcesLeft[0]?.n).toBe(0)
    await expect
      .poll(() => searchHit(env, qa.admin.token, word, docId), { timeout: 30_000 })
      .toBe(false)
  })

  test("a member without the Drive admin scope gets no Disconnect for the org-owned account", async ({
    page,
    env,
    qa,
    world,
  }) => {
    const identifier = `org-drive-member-${idSuffix(env)}@example.com`
    const connectionId = await seedOrgDriveConnection(env, world.org.id, qa.admin.id, identifier, {
      id: `DDDRIVEM${idSuffix(env)}`,
      name: "Org Shared (member)",
    })
    // The admin sees the seeded account, so the absence below is about the member.
    expect(await accountIds(env, qa.admin.token)).toContain(connectionId)

    await loginAs(page, env, qa.amina.email, QA_PASSWORD)
    await page.goto(`http://localhost:${env.ports[1]}/settings/apps/google-drive`)
    // Drive administration is not offered to a member: Settings loads, the Drive page does not.
    await expect(page.getByTestId("settings-content")).toBeVisible({ timeout: 15_000 })
    await page.waitForLoadState("networkidle")
    await expect(page.getByTestId("app-settings-page-google-drive")).toHaveCount(0)
    await expect(page.getByTestId(`connections-disconnect-${connectionId}`)).toHaveCount(0)

    // The API refuses the same disconnect, and the account stays connected.
    const res = await api(env.serverUrl, `/api/connections/${connectionId}`, {
      token: qa.amina.token,
      method: "DELETE",
    })
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    expect((await connectionRow(env, connectionId))?.status).toBe("active")
  })
})
