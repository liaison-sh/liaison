// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Seed step of the boot-flat scenario (boot-flat.scenario.test.ts), run as a
 * one-shot over a role cell's data (`cell.runOneShot`):
 *
 *   bun src/tests/e2e/cell/boot-flat-seed.ts <count> <out.json>
 *
 * Creates `count` orgs through the seed engine's factories, in process: each
 * org and its admin by the provisioning CLI's org and admin provisioners (the
 * org factory), the org set up the way a running server sets an org up
 * (`ensureAppsForOrg`, so the setup stamp is written with this run's build
 * id), one org MCP connection by the MCP manager's own create service with a
 * stored tool list, and one recurring and one event routine (on; the boot
 * re-creates their triggers). The seed's events are then handled here, by the
 * server's own subscribers, so the orgs are at rest before any boot: an org
 * MCP connection's created event bumps every member's permission version,
 * which would otherwise refuse the tokens below on the first touch after a
 * booting worker handled it. Writes `[{ orgId, token }]` to `out.json`: an
 * access token per org admin, minted after that, for the scenario's
 * first-touch requests. Stdout carries the server logger, so the result goes
 * to a file.
 */
import { writeFileSync } from "node:fs"
import { eq } from "drizzle-orm"
import { makeMcpRepo } from "~/apps/mcp-manager/repo"
import { createMcpConnection } from "~/apps/mcp-manager/service/connections"
import { configSchema } from "~/cli/config/schema"
import { withPrivilegedDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { env } from "~/lib/env"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { seedContext } from "~/seed/context"
import { seedBaseAgent } from "~/seed/factories/agent/agents"
import { personalAgentOf } from "~/seed/factories/agent/presence"
import { seedRoutine } from "~/seed/factories/agent/routines"
import { provisionAdminAndRoles, provisionOrgShell } from "~/seed/factories/org/org"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { orgAdmin } from "~/seed/tiers/minimal"
import { drainOutbox } from "~/tests/helpers/outbox"

const WHO = "boot-flat-seed"
const TOKEN_SECONDS = 4 * 60 * 60
/** Orgs set up at once (the in-memory lane's width; the persistent half stays serial). */
const BATCH = 8

interface SeededOrg {
  orgId: string
  token: string
}

interface SetUpOrg {
  orgId: string
  adminUserId: string
  name: string
}

async function seedOne(i: number, runTag: string): Promise<SetUpOrg> {
  const name = `Boot flat admin ${i}`
  const config = configSchema.parse({
    org: {
      slug: `boot-flat-${runTag}-${i}`,
      name: `Boot flat ${i}`,
      credits: { currency: "EUR", initial: "20" },
    },
    admin: { email: `admin-${runTag}-${i}@boot-flat.test`, name },
  })
  const { orgId } = await provisionOrgShell(config, WHO, () => {})
  await provisionAdminAndRoles(config, WHO, () => {})
  const admin = await orgAdmin(orgId)

  // The org's setup, as a server's first touch does it: rows, roles, stamp.
  await ensureAppsForOrg(orgId)

  const ctx = seedContext({ orgId, now: new Date() })
  const actor = await actorFor(ctx, admin.id)
  const created = await asUser(actor, (tx) =>
    createMcpConnection({
      tx,
      orgId,
      actor,
      input: {
        slug: "inventory",
        displayName: "Inventory",
        transport: "http",
        httpUrl: "https://mcp.inventory.invalid/mcp",
      },
    }),
  )
  if (!created.ok) throw new Error(`${WHO}: MCP connection refused: ${created.error.message}`)
  // The tool list a dial would store; the server is never reached.
  await makeMcpRepo().saveToolList(created.connection.id, [
    {
      name: "list_items",
      description: "List inventory items",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ])

  const ownerAgentId =
    (await personalAgentOf(ctx, admin.id)) ?? (await seedBaseAgent(orgId)).agentId
  const routine = {
    ownerUserId: admin.id,
    ownerAgentId,
    scopes: ["kernel:threads:read"],
  }
  const seedOn = (spec: Parameters<typeof seedRoutine>[1]["routine"]) =>
    seedRoutine(ctx, {
      createdByUserId: admin.id,
      ownerScopes: actor.scopes ?? [],
      routine: spec,
      enabled: true,
    })
  await seedOn({
    ...routine,
    name: "Daily digest",
    description: "Boot flat recurring routine",
    kind: "recurring",
    cron: "0 7 * * *",
    timezone: "UTC",
    prompt: "Summarise yesterday.",
  })
  await seedOn({
    ...routine,
    name: "On new ticket",
    description: "Boot flat event routine",
    kind: "event",
    event: "tickets:ticket:created",
    prompt: "Triage the new ticket.",
  })

  return { orgId, adminUserId: admin.id, name }
}

/** An access token for the org's admin, with their versions as they stand now. */
async function mintToken({ orgId, adminUserId, name }: SetUpOrg): Promise<SeededOrg> {
  const { perms, versions } = await withPrivilegedDb(orgId, "boot-flat-seed-perms", async (tx) => {
    const [row] = await tx
      .select({ authVersion: users.authVersion, permissionVersion: users.permissionVersion })
      .from(users)
      .where(eq(users.id, adminUserId))
    if (!row) throw new Error(`${WHO}: admin ${adminUserId} not found`)
    return { perms: await loadEffectivePermissions(tx, adminUserId, orgId), versions: row }
  })
  const token = await signAccessToken(
    {
      userId: adminUserId,
      orgId,
      name,
      authVersion: versions.authVersion,
      permissionVersion: versions.permissionVersion,
      roles: perms.roles,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    env.JWT_SECRET,
    TOKEN_SECONDS,
  )
  return { orgId, token }
}

async function main(): Promise<void> {
  const count = Number(process.argv[2])
  const out = process.argv[3]
  if (!Number.isInteger(count) || count < 1 || !out) {
    throw new Error("usage: boot-flat-seed.ts <count> <out.json>")
  }
  const runTag = Date.now().toString(36)
  const setUp: SetUpOrg[] = []
  for (let start = 0; start < count; start += BATCH) {
    const batch = Array.from({ length: Math.min(BATCH, count - start) }, (_, k) => start + k)
    setUp.push(...(await Promise.all(batch.map((i) => seedOne(i, runTag)))))
  }
  registerEventSubscribers()
  await drainOutbox({ maxRounds: 10_000 })
  const seeded: SeededOrg[] = []
  for (const org of setUp) seeded.push(await mintToken(org))
  writeFileSync(out, JSON.stringify(seeded))
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
    process.exit(1)
  },
)
