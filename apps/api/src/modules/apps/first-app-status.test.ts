// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An org's first row for an app, written by registration against the real
// database. In the managed edition an app the operator installed for the whole
// instance starts removed for the other workspaces until their admin adds it;
// everything else starts On (app-org-scope.ts, `firstAppStatus`).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { resetAppRegistries, webhookHandlers } from "~/modules/apps/app-registries"
import { addOrgApp } from "~/modules/apps/org-app-admin"
import { registerApps } from "~/modules/apps/runtime"
import { seedCustomAppInstall } from "~/seed/factories/org/platform-rows"
import { seedOrgRow } from "~/seed/factories/org/rows"

const OPERATOR = "00000000-0000-0000-0000-0000000fa001"
const TENANT = "00000000-0000-0000-0000-0000000fa002"
const OTHER_TENANT = "00000000-0000-0000-0000-0000000fa003"
const ADDING_TENANT = "00000000-0000-0000-0000-0000000fa004"
const INSTANCE_APP = "fastinstance"
const PLAIN_APP = "fastplain"

function manifest(name: string) {
  return {
    name,
    version: "1.0.0",
    _format: "manifest" as const,
    _bundlePath: `/apps/${name}/handlers.js`,
    schema: { items: { fields: { title: "string" } } },
    tools: {
      listItems: {
        description: "List items",
        requiredScopes: [`${name}:items:read`],
        handler: "listItems",
      },
    },
    events: { emits: ["items:created"] },
    roles: { member: { description: "m", scopes: [`${name}:items:read`] } },
  }
}

async function statusOf(orgId: string, name: string): Promise<string | undefined> {
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM kernel.apps WHERE org_id = ${orgId} AND name = ${name}`
  return rows[0]?.status
}

const savedOperator = env.LIAISON_OPERATOR_ORG_ID
const setOperator = (id: string | undefined) => {
  ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = id
}

describe("an org's first app row", () => {
  beforeAll(async () => {
    for (const [id, slug] of [
      [OPERATOR, "fas-operator"],
      [TENANT, "fas-tenant"],
      [OTHER_TENANT, "fas-other"],
      [ADDING_TENANT, "fas-adding"],
    ] as const) {
      await seedOrgRow({ id, name: slug, slug }, { onConflict: "skip" })
    }
    await seedCustomAppInstall({
      name: INSTANCE_APP,
      version: "1.0.0",
      sourceUrl: "file:///x",
      updateUrl: null,
      sha256: "x",
      installedBy: OPERATOR,
    })
    setOperator(OPERATOR)
  })

  afterEach(() => {
    _setEdition(null)
    resetAppRegistries()
  })

  afterAll(async () => {
    setOperator(savedOperator)
    await sql`DELETE FROM kernel.apps_installed WHERE name IN (${INSTANCE_APP}, ${PLAIN_APP})`
    for (const app of [INSTANCE_APP, PLAIN_APP]) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "app_${app}" CASCADE`)
      await sql.unsafe(`DROP SCHEMA IF EXISTS "app_${app}_untrusted" CASCADE`)
      await sql`DELETE FROM kernel.apps WHERE name = ${app}`
    }
    for (const id of [OPERATOR, TENANT, OTHER_TENANT, ADDING_TENANT]) {
      await sql`DELETE FROM kernel.roles WHERE org_id = ${id}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${id}`
    }
  })

  it("managed: an instance app starts removed for a workspace and On for the operator, and a re-register keeps both", async () => {
    _setEdition("managed")
    const descs = [manifest(INSTANCE_APP), manifest(PLAIN_APP)] as never[]

    expect((await registerApps(descs, TENANT)).failedApps).toEqual([])
    expect((await registerApps(descs, OPERATOR)).failedApps).toEqual([])

    expect(await statusOf(TENANT, INSTANCE_APP)).toBe("removed")
    expect(await statusOf(OPERATOR, INSTANCE_APP)).toBe("active")
    // Not an instance install: On for everyone.
    expect(await statusOf(TENANT, PLAIN_APP)).toBe("active")

    resetAppRegistries()
    await registerApps(descs, TENANT)
    expect(await statusOf(TENANT, INSTANCE_APP)).toBe("removed")
  })

  it("managed: a row already there stays, and adding a removed app turns it On for good", async () => {
    _setEdition("managed")
    const plain = [manifest(PLAIN_APP)] as never[]
    await registerApps(plain, TENANT)
    expect(await statusOf(TENANT, PLAIN_APP)).toBe("active")
    // The operator installs it for the whole instance later: the workspace keeps it.
    await seedCustomAppInstall({
      name: PLAIN_APP,
      version: "1.0.0",
      sourceUrl: "file:///x",
      updateUrl: null,
      sha256: "x",
      installedBy: OPERATOR,
    })
    resetAppRegistries()
    await registerApps(plain, TENANT)
    expect(await statusOf(TENANT, PLAIN_APP)).toBe("active")

    // A workspace that starts without it adds it.
    const instance = [manifest(INSTANCE_APP)] as never[]
    await registerApps(instance, ADDING_TENANT)
    expect(await statusOf(ADDING_TENANT, INSTANCE_APP)).toBe("removed")
    await addOrgApp(ADDING_TENANT, INSTANCE_APP, { actorId: null, actorType: "system" })
    expect(await statusOf(ADDING_TENANT, INSTANCE_APP)).toBe("active")
    resetAppRegistries()
    await registerApps(instance, ADDING_TENANT)
    expect(await statusOf(ADDING_TENANT, INSTANCE_APP)).toBe("active")
  })

  it("a webhook's declared budget reaches the handler registry", async () => {
    _setEdition(null)
    const name = "fastbudget"
    const desc = {
      ...manifest(name),
      webhooks: {
        hook: { handler: "hook", verify: "verifyHook", timeoutMs: 18_000 },
        plain: { handler: "hook", verify: "verifyHook" },
      },
      webhookHealth: { probe: null, reason: "test" },
    }
    try {
      expect((await registerApps([desc] as never[], OPERATOR)).failedApps).toEqual([])
      expect(webhookHandlers.get([OPERATOR, name, "hook"])?.timeoutMs).toBe(18_000)
      expect(webhookHandlers.get([OPERATOR, name, "plain"])?.timeoutMs).toBeUndefined()
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "app_${name}" CASCADE`)
      await sql.unsafe(`DROP SCHEMA IF EXISTS "app_${name}_untrusted" CASCADE`)
      await sql`DELETE FROM kernel.apps WHERE name = ${name}`
    }
  })

  it("self-hosted: the same app starts On", async () => {
    _setEdition(null)
    await registerApps([manifest(INSTANCE_APP)] as never[], OTHER_TENANT)
    expect(await statusOf(OTHER_TENANT, INSTANCE_APP)).toBe("active")
  })
})
