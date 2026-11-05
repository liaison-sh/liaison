// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What is left to set up in a workspace, read from its rows.
 *
 * There is no "onboarded" flag and no stored step status: each item is true
 * exactly when the row that proves it exists (a usable model key, an enabled
 * app, an active mailbox, a second person or an invitation, a knowledge
 * document, a finished import, a role the org made, an API connector with its
 * credentials). Undoing the thing undoes the item. The agent reads this
 * through `kernel__setup_state` and the conversation shows it as a checklist;
 * it never enters the system prompt.
 *
 * Counts and booleans only: no name, address, key or document title leaves
 * here, so the result is safe to show any member and to keep in a message.
 *
 * `connections` adds, for each OAuth connection of an app that is on, the next
 * thing to do: a client card when no client exists (neither the workspace's own
 * nor one the instance provides), a consent card when a client exists but nothing
 * is connected yet, or nothing (connected). A connected one also names the protected
 * scopes (approval-gated at the provider) its grant lacks, so the agent can drive
 * the request, the setting and the reconnect.
 */
import { type OAuthClientSource, orgKernelSettingsSchema } from "@liaison/shared"
import { and, count, sql as drizzleSql, eq, inArray, notInArray, notLike } from "drizzle-orm"
import {
  API_CONNECTOR_APP,
  API_CONNECTOR_CONNECTION,
  listAdapterRows,
} from "~/apps/api-connector/store"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts, importRuns, invitations, roles, users } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { getOrgKernelSettings } from "~/lib/settings"
import { hasUsableModelKey } from "~/modules/agent/credits/credit-meter"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { oauthConnectionKey, resolveOAuthClient } from "~/modules/apps/connections/oauth-client"
import { connectionTurnedOff } from "~/modules/apps/connections/oauth-client-config"
import {
  loadOptedInScopes,
  type ProtectedScope,
  protectedScopesOf,
  recordedGrant,
} from "~/modules/apps/connections/protected-scopes"
import { getEnabledApps } from "~/modules/apps/enabled-apps"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { canManageInstanceApps } from "~/modules/apps/operator-org"
import { buildFeaturePlan, type FeaturePlan } from "~/modules/connection-guides/setup-features"
import { liaisonTeamEndpoint } from "~/modules/liaison-team/outbox"
import { loadSharing } from "~/modules/liaison-team/settings"
import { DEFAULT_ROLES } from "~/modules/permissions/default-roles"

const log = rootLogger.child({ module: "setup-state" })

/** The checklist, in the order the agent proposes it. */
export const SETUP_ITEM_KEYS = [
  "aiKey",
  "apps",
  "mail",
  "team",
  "knowledge",
  "import",
  "roles",
  "connector",
] as const
/**
 * The Liaison team opt-ins (register, forward bug reports): an optional item
 * after the others, listed only where the question may be asked (sharing is
 * available and the asking org is the instance operator's), so a demo
 * visitor's setup agent never raises it. Done once either answer is recorded.
 */
export const LIAISON_TEAM_ITEM = "liaisonTeam"
export type SetupItemKey = (typeof SETUP_ITEM_KEYS)[number] | typeof LIAISON_TEAM_ITEM

const OPTIONAL: ReadonlySet<SetupItemKey> = new Set([
  "import",
  "roles",
  "connector",
  LIAISON_TEAM_ITEM,
])

export interface SetupItem {
  key: SetupItemKey
  done: boolean
  optional: boolean
  /** A count behind the answer, never a name: "2 apps enabled". */
  detail: string
}

/** The next step of one OAuth connection. */
export type ConnectionNextStep = "turn_on" | "client_card" | "consent_card" | "connected"

export interface SetupConnection {
  app: string
  connection: string
  /** Where its OAuth client comes from: the workspace's own, the instance's, or none. */
  client: OAuthClientSource
  /** An active account is connected. */
  connected: boolean
  next: ConnectionNextStep
  /** `turn_on`: the workspace switched the connection off (Gmail mailboxes);
   *  what turns it on. Its Connect card is refused until then. */
  turnOn?: string
  /** Protected scopes (approval-gated at the provider, protected-scopes.ts) that a
   *  connected account's recorded grant lacks, with whether the org turned on the
   *  setting that asks for them. Absent when every account holds them. */
  missingProtectedScopes?: Array<{ scope: string; setting: string; settingOn: boolean }>
}

export interface SetupState {
  items: SetupItem[]
  /** The OAuth connections of the apps that are on, each with its next step. */
  connections: SetupConnection[]
  /** The first required item not done, or null when every required item is. */
  next: SetupItemKey | null
  /** What is left of the features the person chose (setup.features), and the
   *  rest as a menu with times (connection-guides/setup-features.ts). */
  features: FeaturePlan
  asOf: string
}

/** Users created by an import to stand for a person who has no account. */
const IMPORT_PLACEHOLDER_EMAIL = "%@import.invalid"

/** The name shape of a role an app seeds for itself (`tickets.agent`). */
const APP_ROLE_NAME = "^[a-z0-9][a-z0-9_-]*\\.[a-z0-9][a-z0-9_-]*$"

/** The mail apps whose active connected account means "mail is connected". */
const MAIL_APPS = ["mail", "tickets"]

interface Counts {
  activeMailboxes: number
  people: number
  invitations: number
  doneImports: number
  ownRoles: number
  activeConnectorCredentials: string[]
}

async function readKernelCounts(orgId: string): Promise<Counts> {
  return withPrivilegedDb(orgId, "setup-state-read", async (tx) => {
    const [mail] = await tx
      .select({ n: count() })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          inArray(connectedAccounts.appName, MAIL_APPS),
          eq(connectedAccounts.status, "active"),
        ),
      )
    const [people] = await tx
      .select({ n: count() })
      .from(users)
      .where(
        and(
          eq(users.orgId, orgId),
          eq(users.status, "active"),
          notLike(users.email, IMPORT_PLACEHOLDER_EMAIL),
        ),
      )
    const [invites] = await tx
      .select({ n: count() })
      .from(invitations)
      .where(eq(invitations.orgId, orgId))
    const [imports] = await tx
      .select({ n: count() })
      .from(importRuns)
      .where(and(eq(importRuns.orgId, orgId), eq(importRuns.status, "done")))
    const [ownRoles] = await tx
      .select({ n: count() })
      .from(roles)
      .where(
        and(
          eq(roles.orgId, orgId),
          eq(roles.systemManaged, false),
          notInArray(
            roles.name,
            DEFAULT_ROLES.map((r) => r.name),
          ),
          // An app's own roles are seeded at registration as `<app>.<role>`
          // (apps/runtime.ts seedManifestRoles): not something the org made.
          drizzleSql`${roles.name} !~ ${APP_ROLE_NAME}`,
        ),
      )
    const connectorCredentials = await tx
      .select({ identifier: connectedAccounts.identifier })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, API_CONNECTOR_APP),
          eq(connectedAccounts.connectionName, API_CONNECTOR_CONNECTION),
          eq(connectedAccounts.status, "active"),
        ),
      )
    return {
      activeMailboxes: mail?.n ?? 0,
      people: people?.n ?? 0,
      invitations: invites?.n ?? 0,
      doneImports: imports?.n ?? 0,
      ownRoles: ownRoles?.n ?? 0,
      activeConnectorCredentials: connectorCredentials.map((r) => r.identifier),
    }
  })
}

/**
 * Documents in the knowledge app. An org whose knowledge app tables are absent
 * (not installed on this deployment) has none: read as not done, never thrown.
 */
async function countKnowledgeDocuments(orgId: string): Promise<number> {
  try {
    return await withPrivilegedDb(orgId, "setup-state-knowledge", async (tx) => {
      const [row] = extractRows<{ n: number | string }>(
        await tx.execute(drizzleSql`
          SELECT count(*) AS n FROM ${knowledgeRel("documents")}
          WHERE org_id = ${orgId}::uuid`),
      )
      return Number(row?.n ?? 0)
    })
  } catch (err) {
    log.warn({ err, orgId }, "setup state: knowledge documents unreadable, counted as none")
    return 0
  }
}

/** Adapters that also hold active credentials: a connector that can be called. */
async function countUsableConnectors(orgId: string, credentialed: string[]): Promise<number> {
  if (credentialed.length === 0) return 0
  try {
    const adapters = await listAdapterRows(orgId)
    const withCredentials = new Set(credentialed)
    return adapters.filter((a) => withCredentials.has(a.identifier)).length
  } catch (err) {
    log.warn({ err, orgId }, "setup state: API connector adapters unreadable, counted as none")
    return 0
  }
}

/** Every connection of an app that is on (`app/connection`), and those with an active account. */
async function readConnectionFacts(
  orgId: string,
  enabledApps: string[],
): Promise<{ available: Set<string>; connected: Set<string> }> {
  const enabled = new Set(enabledApps)
  const available = new Set<string>()
  for (const [[org, app, connection]] of connectionConfigRegistry.entriesOf(orgId)) {
    if (org === orgId && enabled.has(app)) available.add(`${app}/${connection}`)
  }
  const rows = await withPrivilegedDb(orgId, "setup-state-connected", (tx) =>
    tx
      .select({ app: connectedAccounts.appName, connection: connectedAccounts.connectionName })
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.orgId, orgId), eq(connectedAccounts.status, "active"))),
  )
  return { available, connected: new Set(rows.map((r) => `${r.app}/${r.connection}`)) }
}

/** The next step of a connection, from its client and whether it is connected. */
export function connectionNextStep(
  client: OAuthClientSource,
  connected: boolean,
): ConnectionNextStep {
  if (connected) return "connected"
  return client === "none" ? "client_card" : "consent_card"
}

/** Each OAuth connection of the apps that are on, with its client and next step. */
async function readConnections(orgId: string, enabledApps: string[]): Promise<SetupConnection[]> {
  if (enabledApps.length === 0) return []
  try {
    await ensureAppsForOrg(orgId)
  } catch (err) {
    log.warn({ err, orgId }, "setup state: apps not registered, connections unread")
    return []
  }
  const enabled = new Set(enabledApps)
  const declared: Array<{ app: string; connection: string; protectedScopes: ProtectedScope[] }> = []
  for (const [[org, app, connection], config] of connectionConfigRegistry.entriesOf(orgId)) {
    if (org !== orgId || !enabled.has(app) || config.type !== "oauth2") continue
    declared.push({ app, connection, protectedScopes: protectedScopesOf(config) })
  }
  if (declared.length === 0) return []
  declared.sort((a, b) =>
    oauthConnectionKey(a.app, a.connection).localeCompare(oauthConnectionKey(b.app, b.connection)),
  )
  const active = await withPrivilegedDb(orgId, "setup-state-connections", (tx) =>
    tx
      .select({
        app: connectedAccounts.appName,
        connection: connectedAccounts.connectionName,
        metadata: connectedAccounts.metadata,
      })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          inArray(connectedAccounts.appName, [...enabled]),
          eq(connectedAccounts.status, "active"),
        ),
      ),
  )
  const connectedKeys = new Set(active.map((r) => oauthConnectionKey(r.app, r.connection)))
  const out: SetupConnection[] = []
  for (const { protectedScopes, ...d } of declared) {
    const key = oauthConnectionKey(d.app, d.connection)
    const client = (await resolveOAuthClient(orgId, key)).source
    const connected = connectedKeys.has(key)
    const grants = active
      .filter((r) => oauthConnectionKey(r.app, r.connection) === key)
      .map((r) => recordedGrant(r.metadata))
    const missing = await missingProtected(orgId, d.app, protectedScopes, grants)
    const off = connected ? null : await connectionTurnedOff(orgId, d.app, d.connection)
    out.push({
      ...d,
      client,
      connected,
      next: off ? "turn_on" : connectionNextStep(client, connected),
      ...(off ? { turnOn: off.turnOn } : {}),
      ...(missing.length > 0 ? { missingProtectedScopes: missing } : {}),
    })
  }
  return out
}

/** The protected scopes some connected account's recorded grant lacks (an
 *  unrecorded grant is not counted: it may hold them). */
async function missingProtected(
  orgId: string,
  appName: string,
  declared: readonly ProtectedScope[],
  grants: ReadonlyArray<string[] | "unknown">,
): Promise<Array<{ scope: string; setting: string; settingOn: boolean }>> {
  const lacking = declared.filter((p) =>
    grants.some((g) => g !== "unknown" && !g.includes(p.scope)),
  )
  if (lacking.length === 0) return []
  const on = await withPrivilegedDb(orgId, "setup-state-protected-scopes", (tx) =>
    loadOptedInScopes(tx, orgId, appName, lacking),
  )
  return lacking.map((p) => ({
    scope: p.scope,
    setting: p.setting,
    settingOn: on.includes(p.scope),
  }))
}

/**
 * The Liaison team item, or null where the question must not be asked: sharing
 * unavailable (no endpoint) or an org that is not the instance operator's.
 * Done once an admin has answered, whichever way (`decidedAt`).
 */
async function liaisonTeamFact(orgId: string): Promise<{ done: boolean; detail: string } | null> {
  if (liaisonTeamEndpoint() === null) return null
  if (!(await canManageInstanceApps(orgId))) return null
  const sharing = await loadSharing()
  if (sharing.decidedAt === null) return { done: false, detail: "not asked yet" }
  return {
    done: true,
    detail: sharing.register
      ? `registered, bug report forwarding ${sharing.forwardBugReports ? "on" : "off"}`
      : "not registered",
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export async function computeSetupState(orgId: string): Promise<SetupState> {
  const settings = await withPrivilegedDb(orgId, "setup-state-settings", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  const [aiKey, enabledApps, counts, documents] = await Promise.all([
    hasUsableModelKey(orgId, settings),
    getEnabledApps(orgId),
    readKernelCounts(orgId),
    countKnowledgeDocuments(orgId),
  ])
  const [connectors, connections] = await Promise.all([
    countUsableConnectors(orgId, counts.activeConnectorCredentials),
    readConnections(orgId, enabledApps),
  ])

  const itemFacts: Record<(typeof SETUP_ITEM_KEYS)[number], { done: boolean; detail: string }> = {
    aiKey: {
      done: aiKey,
      detail: aiKey ? "a model key is usable" : "no usable model key",
    },
    apps: {
      done: enabledApps.length > 0,
      detail: `${plural(enabledApps.length, "app", "apps")} enabled`,
    },
    mail: {
      done: counts.activeMailboxes > 0,
      detail: `${plural(counts.activeMailboxes, "mailbox", "mailboxes")} connected`,
    },
    team: {
      done: counts.people > 1 || counts.invitations > 0,
      detail: `${plural(counts.people, "person", "people")}, ${plural(counts.invitations, "invitation", "invitations")}`,
    },
    knowledge: {
      done: documents > 0,
      detail: plural(documents, "document", "documents"),
    },
    import: {
      done: counts.doneImports > 0,
      detail: `${plural(counts.doneImports, "import", "imports")} finished`,
    },
    roles: {
      done: counts.ownRoles > 0,
      detail: `${plural(counts.ownRoles, "role", "roles")} beyond the presets`,
    },
    connector: {
      done: connectors > 0,
      detail: `${plural(connectors, "API connector", "API connectors")} with credentials`,
    },
  }

  const items: SetupItem[] = SETUP_ITEM_KEYS.map((key) => ({
    key,
    done: itemFacts[key].done,
    optional: OPTIONAL.has(key),
    detail: itemFacts[key].detail,
  }))
  const team = await liaisonTeamFact(orgId)
  if (team) {
    items.push({
      key: LIAISON_TEAM_ITEM,
      done: team.done,
      optional: true,
      detail: team.detail,
    })
  }
  const next = items.find((i) => !i.optional && !i.done)?.key ?? null
  // After readConnections: it registered the org's apps, so the registry lists them.
  const facts = await readConnectionFacts(orgId, enabledApps)
  const features = buildFeaturePlan(settings.chosenFeatures ?? null, {
    available: (ref) => facts.available.has(ref),
    connected: (ref) => facts.connected.has(ref),
    itemDone: (key) => itemFacts[key].done,
  })
  return { items, connections, next, features, asOf: new Date().toISOString() }
}
