// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `apiConnectors` provisioner: ensures each API connection of the config (an
 * adapter document plus its credentials) on the org.
 *
 *   apiConnectors:
 *     - identifier: crm
 *       adapter: ./adapters/crm.adapter.yaml   # relative to the config file, or inline
 *       credentials: { apiKey: "${CRM_API_KEY}" }
 *
 * `plan` (read only) loads and validates every adapter (a path-precise issue
 * list is exit 2), checks the credential fields against the adapter's auth
 * type, and reports create/update/unchanged per connection. `apply` writes
 * only what differs: the adapter row when its document changed, the
 * credentials when they changed (compared decrypted, never printed). A
 * credentials block whose values are all empty (`${VAR:-}`) is reported
 * pending, like a credentials app connection.
 *
 * An adapter whose credential target changed (origin, auth type, apiKey
 * placement, token URL or host: `credentialTarget`) has its stored
 * credentials deleted with the adapter write; apply then enters the config's
 * credentials again when it has them, and reports them pending otherwise.
 */

import { readFileSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  type Adapter,
  AUTH_CREDENTIAL_FIELDS,
  type ValidateResult,
} from "@liaison/api-connector-core"
import { parseAdapterDocument, validateAdapterDocument } from "~/apps/api-connector/adapter-policy"
import { invalidateConnectionCaches } from "~/apps/api-connector/cache"
import {
  API_CONNECTOR_APP,
  API_CONNECTOR_CONNECTION,
  credentialTarget,
  getAdapterRow,
  resolveConnectionCredentials,
  upsertAdapterRow,
} from "~/apps/api-connector/store"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import {
  connectingPersonOrFail,
  type PendingItem,
  type ProvisionContext,
  type Provisioner,
  type ProvisionPlan,
  type ProvisionResult,
} from "~/cli/provisioners/types"
import { canonicalJson } from "~/modules/apps/app-config"
import { createCredentialConnection } from "~/modules/apps/connections/service"

type Entry = NonNullable<ProvisioningConfig["apiConnectors"]>[number]

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
}

/** Load and validate one entry's adapter (exit 2 on any problem). */
export function loadEntryAdapter(configDir: string, entry: Entry): Adapter {
  const where = `apiConnectors[${entry.identifier}]`
  let result: ValidateResult
  if (typeof entry.adapter === "string") {
    if (isAbsolute(entry.adapter)) {
      throw new ConfigError(
        `${where}: adapter '${entry.adapter}' must be relative to the config file directory`,
      )
    }
    const base = resolve(configDir)
    const target = resolve(base, entry.adapter)
    if (!isInside(base, target)) {
      throw new ConfigError(
        `${where}: adapter '${entry.adapter}' escapes the config file directory`,
      )
    }
    let text: string
    try {
      text = readFileSync(target, "utf8")
    } catch (err) {
      throw new ConfigError(
        `${where}: cannot read adapter '${entry.adapter}': ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    result = parseAdapterDocument(text)
  } else {
    result = validateAdapterDocument(entry.adapter)
  }
  if (!result.ok) {
    const lines = result.issues.map((i) => `  ${i.path || "(root)"}: ${i.message}`).join("\n")
    throw new ConfigError(`${where}: invalid adapter\n${lines}`)
  }
  return result.adapter
}

/** The credentials to store, null when every value is empty (pending), exit 2 on wrong fields. */
function entryCredentials(entry: Entry, adapter: Adapter): Record<string, string> | null {
  const supplied = entry.credentials
  if (!supplied) return null
  const filled = Object.fromEntries(Object.entries(supplied).filter(([, v]) => v !== ""))
  if (Object.keys(filled).length === 0) return null
  const needed = AUTH_CREDENTIAL_FIELDS[adapter.auth.type]
  const where = `apiConnectors[${entry.identifier}].credentials`
  const missing = needed.filter((f) => !filled[f])
  if (missing.length > 0)
    throw new ConfigError(`${where}: the ${adapter.auth.type} auth needs ${missing.join(", ")}`)
  const extra = Object.keys(filled).filter((f) => !needed.includes(f))
  if (extra.length > 0)
    throw new ConfigError(`${where}: the ${adapter.auth.type} auth takes no ${extra.join(", ")}`)
  return filled
}

/** The adapter's top-level settings whose stored value differs (sorted names). */
function changedAdapterFields(stored: Adapter, declared: Adapter): string[] {
  const a = new Map<string, unknown>(Object.entries(stored))
  const b = new Map<string, unknown>(Object.entries(declared))
  const names = new Set([...a.keys(), ...b.keys()])
  return [...names]
    .filter((k) => canonicalJson(a.get(k) ?? null) !== canonicalJson(b.get(k) ?? null))
    .sort()
}

interface EntryState {
  adapter: Adapter
  adapterChanged: boolean
  /** The changed top-level adapter settings (empty for a new connection). */
  adapterFields: string[]
  /** The adapter write deletes the stored credentials (their target changed). */
  targetChanged: boolean
  credentials: Record<string, string> | null
  credentialsChanged: boolean
}

async function inspect(ctx: ProvisionContext, entry: Entry): Promise<EntryState> {
  const adapter = loadEntryAdapter(ctx.configDir, entry)
  const credentials = entryCredentials(entry, adapter)
  // Before the org exists (a dry run of a first apply) nothing is stored yet.
  const stored = ctx.orgId ? await getAdapterRow(ctx.orgId, entry.identifier) : null
  const adapterChanged = !stored || canonicalJson(stored.adapter) !== canonicalJson(adapter)
  const adapterFields =
    stored && adapterChanged ? changedAdapterFields(stored.adapter, adapter) : []
  const targetChanged =
    stored !== null && credentialTarget(stored.adapter) !== credentialTarget(adapter)
  let credentialsChanged = false
  if (credentials) {
    const current =
      ctx.orgId && !targetChanged
        ? await resolveConnectionCredentials(ctx.orgId, ctx.actor.userId, entry.identifier)
        : null
    credentialsChanged = !current || canonicalJson(current.values) !== canonicalJson(credentials)
  }
  return { adapter, adapterChanged, adapterFields, targetChanged, credentials, credentialsChanged }
}

export const apiConnectorsProvisioner: Provisioner<ProvisioningConfig> = {
  key: "apiConnectors",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const list = config.apiConnectors ?? []
    const seen = new Set<string>()
    const actions: string[] = []
    for (const entry of list) {
      if (seen.has(entry.identifier))
        throw new ConfigError(`apiConnectors: '${entry.identifier}' is declared twice`)
      seen.add(entry.identifier)
      const s = await inspect(ctx, entry)
      const fields = s.adapterFields.length > 0 ? `, ${s.adapterFields.join(", ")} changed` : ""
      const adapterAction = s.adapterChanged
        ? s.targetChanged
          ? `write (its API host or auth changed: stored credentials are deleted${fields})`
          : fields
            ? `write (${fields.slice(2)})`
            : "write"
        : "unchanged"
      actions.push(
        `api connection '${entry.identifier}': adapter ${adapterAction}, credentials ${
          s.credentials ? (s.credentialsChanged ? "write" : "unchanged") : "pending"
        }`,
      )
    }
    return { actions }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const changed: string[] = []
    const unchanged: string[] = []
    const pending: PendingItem[] = []
    for (const entry of config.apiConnectors ?? []) {
      const id = entry.identifier
      const s = await inspect(ctx, entry)
      let credentialsCleared = false
      if (s.adapterChanged) {
        credentialsCleared = (
          await upsertAdapterRow(ctx.orgId, id, s.adapter, ctx.actor.userId || null)
        ).credentialsCleared
        ctx.log(
          s.adapterFields.length > 0
            ? `api connection '${id}': adapter updated (${s.adapterFields.join(", ")} changed)`
            : `api connection '${id}': adapter written`,
        )
        changed.push(`apiConnectors.${id}.adapter`)
      } else unchanged.push(`apiConnectors.${id}.adapter`)
      if (!s.credentials) {
        pending.push({
          kind: "credentials",
          app: API_CONNECTOR_APP,
          connection: API_CONNECTOR_CONNECTION,
          identifier: id,
          action: `set the ${s.adapter.auth.type} credentials of '${id}' (${AUTH_CREDENTIAL_FIELDS[s.adapter.auth.type].join(", ")})`,
        })
      } else if (s.credentialsChanged || credentialsCleared) {
        const credentials = s.credentials
        // A stored credential names the person who connected it.
        const creator = connectingPersonOrFail(ctx, `apiConnectors: the credentials of '${id}'`)
        await ctx.priv("cli-api-connector-credentials", (tx) =>
          createCredentialConnection(
            tx,
            ctx.orgId,
            creator,
            API_CONNECTOR_APP,
            API_CONNECTOR_CONNECTION,
            {
              identifier: id,
              credentials,
              displayName: s.adapter.name,
              ownerType: "org",
            },
          ),
        )
        changed.push(`apiConnectors.${id}.credentials`)
      } else unchanged.push(`apiConnectors.${id}.credentials`)
      if (s.adapterChanged || s.credentialsChanged || credentialsCleared)
        await invalidateConnectionCaches(ctx.orgId, id)
    }
    return {
      section: { connections: (config.apiConnectors ?? []).map((e) => e.identifier) },
      ...(changed.length > 0 ? { changed } : {}),
      ...(unchanged.length > 0 ? { unchanged } : {}),
      ...(pending.length > 0 ? { pending } : {}),
    }
  },
}
