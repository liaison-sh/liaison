// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Adapter version history and the credential-target pre-check, against the
// real database (the app's tables come from the runtime DDL of its manifest).
// Every save keeps the previous document; a save that moves the credential
// target deletes the stored credentials, and the plan says so beforehand.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type Adapter, validateAdapter } from "@liaison/api-connector-core"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApiConnectorApp } from "~/modules/apps/connections/api/app.test-helpers"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  ADAPTER_HISTORY_LIMIT,
  AdapterChangedError,
  CredentialsChangedError,
  deleteConnection,
  getAdapterVersion,
  listAdapterVersions,
  planAdapterSave,
  resolveConnectionCredentials,
  upsertAdapterRow,
} from "./store"

function adapter(overrides: Record<string, unknown> = {}): Adapter {
  const r = validateAdapter({
    id: "crm",
    name: "Fixture CRM",
    version: "1",
    baseUrl: "https://crm.example.com",
    auth: { type: "bearer" },
    operations: [
      {
        name: "list_companies",
        description: "Companies.",
        kind: "read",
        method: "GET",
        path: "/companies",
        params: { type: "object", properties: {} },
        items: "/data",
        fields: ["id", "name"],
      },
    ],
    ...overrides,
  })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.adapter
}

let ORG = ""
let USER = ""
let OTHER = ""

async function newUser(label: string): Promise<string> {
  const { userId } = await ensureUser({
    orgId: ORG,
    email: `${label}-${Date.now()}@adapter-history.test`,
    name: label,
    password: "Passw0rd!",
    role: "admin",
  })
  return userId
}

async function storeToken(identifier: string): Promise<void> {
  await withPrivilegedDb(ORG, "adapter-history-test", (tx) =>
    createCredentialConnection(tx, ORG, USER, "api-connector", "api", {
      identifier,
      credentials: { token: "tok_history_1" },
      ownerType: "org",
    }),
  )
}

async function versionRows(
  identifier: string,
): Promise<Array<{ adapter: { version: string }; saved_by: string | null }>> {
  const rows = await sql<Array<{ adapter: { version: string }; saved_by: string | null }>>`
    SELECT adapter, saved_by FROM app_api_connector.adapter_versions
    WHERE org_id = ${ORG} AND identifier = ${identifier}
    ORDER BY created_at`
  return [...rows]
}

beforeAll(async () => {
  await acquireTestLock()
  ORG = (await ensureOrg({ slug: `adapter-history-${Date.now()}`, name: "Adapter History" })).orgId
  USER = await newUser("first")
  OTHER = await newUser("second")
  await ensureAppsForOrg(ORG)
  await registerApiConnectorApp(ORG)
}, 180_000)

afterAll(async () => {
  resetAppRegistries()
  await releaseTestLock()
})

describe("adapter history", () => {
  it("a save keeps the previous document, saved by whoever saved it", async () => {
    await upsertAdapterRow(ORG, "two-saves", adapter({ version: "1" }), USER)
    expect(await versionRows("two-saves")).toEqual([])
    await upsertAdapterRow(ORG, "two-saves", adapter({ version: "2" }), OTHER)
    const rows = await versionRows("two-saves")
    expect(rows.map((r) => [r.adapter.version, r.saved_by])).toEqual([["1", USER]])

    const listed = await listAdapterVersions(ORG, "two-saves")
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ adapterVersion: "1", savedBy: USER, savedByName: "first" })
    const one = await getAdapterVersion(ORG, "two-saves", listed[0]?.id ?? "")
    expect(one?.adapter.version).toBe("1")
    expect(await getAdapterVersion(ORG, "other-id", listed[0]?.id ?? "")).toBeNull()
  })

  it(`keeps the last ${ADAPTER_HISTORY_LIMIT} versions: 22 saves leave 20 rows, the oldest gone`, async () => {
    for (let i = 1; i <= 22; i++) {
      await upsertAdapterRow(ORG, "many", adapter({ version: String(i) }), USER)
    }
    const rows = await versionRows("many")
    expect(ADAPTER_HISTORY_LIMIT).toBe(20)
    expect(rows).toHaveLength(20)
    // 21 snapshots were taken (versions 1..21); the oldest (1) was pruned.
    expect(rows.map((r) => r.adapter.version)).toEqual(
      Array.from({ length: 20 }, (_, i) => String(i + 2)),
    )
  })

  it("deleting the connection deletes its history", async () => {
    await upsertAdapterRow(ORG, "gone", adapter({ version: "1" }), USER)
    await upsertAdapterRow(ORG, "gone", adapter({ version: "2" }), USER)
    expect(await versionRows("gone")).toHaveLength(1)
    expect(await deleteConnection(ORG, "gone")).toBe(true)
    expect(await versionRows("gone")).toEqual([])
  })

  it("a save pinned to a prior document refuses when the stored one changed", async () => {
    await upsertAdapterRow(ORG, "pinned", adapter({ version: "1" }), USER)
    const plan = await planAdapterSave(ORG, "pinned", adapter({ version: "2" }))
    if (!plan.ok) throw new Error("plan failed")
    await upsertAdapterRow(ORG, "pinned", adapter({ version: "1b" }), USER)
    await expect(
      upsertAdapterRow(ORG, "pinned", adapter({ version: "2" }), USER, {
        expectPriorHash: plan.priorHash,
      }),
    ).rejects.toBeInstanceOf(AdapterChangedError)
    const [row] = await sql<Array<{ adapter_version: string }>>`
      SELECT adapter_version FROM app_api_connector.adapters
      WHERE org_id = ${ORG} AND identifier = 'pinned'`
    expect(row?.adapter_version).toBe("1b")
  })
})

describe("credential-target pre-check (A4)", () => {
  it("a first save of a new identifier wipes nothing and needs no confirmation", async () => {
    const plan = await planAdapterSave(ORG, "brand-new", adapter())
    expect(plan).toMatchObject({
      ok: true,
      priorHash: null,
      priorTarget: null,
      credentialsPresent: false,
      wipesCredentials: false,
      removedOperations: [],
    })
  })

  it("an invalid document is refused with its issues", async () => {
    const plan = await planAdapterSave(ORG, "brand-new", { id: "x" })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.issues.length).toBeGreaterThan(0)
  })

  it("an unchanged target keeps the credentials", async () => {
    await upsertAdapterRow(ORG, "same-target", adapter(), USER)
    await storeToken("same-target")
    const next = adapter({ version: "2", description: "Edited." })
    const plan = await planAdapterSave(ORG, "same-target", next)
    expect(plan).toMatchObject({
      ok: true,
      credentialsPresent: true,
      credentialTargetChanged: false,
      wipesCredentials: false,
    })
    const result = await upsertAdapterRow(ORG, "same-target", next, USER)
    expect(result.credentialsCleared).toBe(false)
    expect(await resolveConnectionCredentials(ORG, USER, "same-target")).not.toBeNull()
  })

  it("a changed target with credentials stored is announced, then the save deletes them", async () => {
    await upsertAdapterRow(ORG, "moved", adapter(), USER)
    await storeToken("moved")
    const next = adapter({ version: "2", baseUrl: "https://other-crm.example.com" })
    const plan = await planAdapterSave(ORG, "moved", next)
    if (!plan.ok) throw new Error("plan failed")
    expect(plan).toMatchObject({
      credentialsPresent: true,
      credentialTargetChanged: true,
      wipesCredentials: true,
    })
    expect(plan.priorTarget).toContain("https://crm.example.com")
    expect(plan.newTarget).toContain("https://other-crm.example.com")
    const result = await upsertAdapterRow(ORG, "moved", next, USER)
    expect(result.credentialsCleared).toBe(true)
    expect(await resolveConnectionCredentials(ORG, USER, "moved")).toBeNull()
  })

  it("a target-moving save planned without credentials refuses once credentials exist", async () => {
    await upsertAdapterRow(ORG, "late", adapter(), USER)
    const next = adapter({ version: "2", baseUrl: "https://other-crm.example.com" })
    const plan = await planAdapterSave(ORG, "late", next)
    if (!plan.ok) throw new Error("plan failed")
    expect(plan.credentialsPresent).toBe(false)
    await storeToken("late")
    await expect(
      upsertAdapterRow(ORG, "late", next, USER, {
        expectPriorHash: plan.priorHash,
        expectCredentialsPresent: plan.credentialsPresent,
      }),
    ).rejects.toBeInstanceOf(CredentialsChangedError)
    expect(await resolveConnectionCredentials(ORG, USER, "late")).not.toBeNull()
  })

  it("lists the operations a save would remove", async () => {
    await upsertAdapterRow(ORG, "shrink", adapter(), USER)
    const plan = await planAdapterSave(
      ORG,
      "shrink",
      adapter({
        operations: [
          {
            name: "list_people",
            description: "People.",
            kind: "read",
            method: "GET",
            path: "/people",
            params: { type: "object", properties: {} },
            items: "/data",
            fields: ["id"],
          },
        ],
      }),
    )
    expect(plan).toMatchObject({ ok: true, removedOperations: ["list_companies"] })
  })
})
