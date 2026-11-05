// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Who may change a config section through an agent tool: the scopes the REST
 * route (or kernel tool) doing the same change requires, per section and per
 * entry. A config tool checks the WHOLE union against the person it acts as
 * (the approver of a gated call, else the caller) before any provisioner runs:
 * the provisioners themselves write through privileged handles in places, so
 * this check is the authorization, not a courtesy.
 *
 *  roles          kernel:roles:admin (create_role / edit_role) + every scope
 *                 a declared role grants or would have revoked
 *  users          kernel:users:admin (invite)
 *  setup          kernel:org:admin (org settings: the chosen setup features)
 *  email          kernel:org:admin (org settings)
 *  mail           mail:accounts:admin; + kernel:apps:admin for a Google client
 *  tickets        tickets:inboxes:admin per inbox; + tickets:accounts:admin for
 *                 an inbox backed by a connection; tickets:settings:admin for
 *                 approveRepliesFromHome
 *  apps           kernel:apps:admin; + the connection's admin scope per
 *                 `connection`; + mail:accounts:admin when `providers` is set;
 *                 + each `settings` field's section adminScope
 *  apiConnectors  api-connector:admin
 *  knowledge      knowledge:documents:create per document,
 *                 knowledge:collections:manage per collection,
 *                 knowledge:sources:manage per source
 *  agents         kernel:agents:admin
 *  invoicing      invoicing:settings:write
 *  liaisonTeam    kernel:org:admin (the Settings > System switches; the provisioner
 *                 also needs the instance operator org)
 */
import type { ProvisioningConfig } from "~/cli/config/schema"
import { appSettingsAdminScopes } from "~/cli/provisioners/app-settings"
import { storedRoleScopes } from "~/cli/provisioners/roles"
import { withPrivilegedDb } from "~/db/privileged"
import { connectionAdminScope } from "~/modules/apps/connections/admin-scope"
import { hasScope } from "~/modules/permissions/permissions"
import type { ConfigToolSection } from "~/modules/provisioning/config-tool-input"

/** The scope a section's tool declares statically (its base scope). */
export const SECTION_BASE_SCOPE: Record<ConfigToolSection, string> = {
  roles: "kernel:roles:admin",
  users: "kernel:users:admin",
  setup: "kernel:org:admin",
  email: "kernel:org:admin",
  mail: "mail:accounts:admin",
  tickets: "tickets:inboxes:admin",
  apps: "kernel:apps:admin",
  apiConnectors: "api-connector:admin",
  knowledge: "knowledge:documents:create",
  agents: "kernel:agents:admin",
  invoicing: "invoicing:settings:write",
  liaisonTeam: "kernel:org:admin",
}

/** Every scope this section's data needs, deduplicated. */
export function requiredScopesFor(
  orgId: string,
  section: ConfigToolSection,
  config: ProvisioningConfig,
  opts: {
    /** The org's stored role scopes by role name (roles only): a scope a role
     *  holds now and the change drops is revoked, which needs holding it too. */
    storedRoleScopes?: ReadonlyMap<string, ReadonlySet<string>>
  } = {},
): string[] {
  const out = new Set<string>()
  switch (section) {
    case "mail": {
      out.add("mail:accounts:admin")
      if ((config.mail?.mailboxes ?? []).some((m) => m.google !== undefined)) {
        out.add("kernel:apps:admin")
      }
      break
    }
    case "tickets": {
      const tickets = config.tickets
      for (const inbox of tickets?.inboxes ?? []) {
        out.add("tickets:inboxes:admin")
        if (inbox.imap !== undefined || inbox.provider === "gmail") {
          out.add("tickets:accounts:admin")
        }
      }
      if (tickets?.approveRepliesFromHome !== undefined) out.add("tickets:settings:admin")
      if (out.size === 0) out.add(SECTION_BASE_SCOPE.tickets)
      break
    }
    case "apps": {
      out.add("kernel:apps:admin")
      for (const app of config.apps ?? []) {
        if (app.connection) out.add(connectionAdminScope(orgId, app.name, app.connection.name))
        if (app.providers) out.add("mail:accounts:admin")
        if (app.settings) {
          for (const scope of appSettingsAdminScopes(orgId, app.name, app.settings)) out.add(scope)
        }
      }
      break
    }
    case "knowledge": {
      const kb = config.knowledge
      if ((kb?.documents ?? []).length > 0) out.add("knowledge:documents:create")
      if ((kb?.collections ?? []).length > 0) out.add("knowledge:collections:manage")
      if ((kb?.sources ?? []).length > 0) out.add("knowledge:sources:manage")
      if (out.size === 0) out.add(SECTION_BASE_SCOPE.knowledge)
      break
    }
    case "roles": {
      // Granting a scope needs holding it: every scope a role declares is
      // checked against the approver up front, so one the approver lacks is
      // refused before the first role is written (the per-role apply is not
      // atomic across roles).
      out.add(SECTION_BASE_SCOPE.roles)
      for (const role of config.roles ?? []) {
        for (const scope of role.scopes) out.add(scope)
        const desired = new Set(role.scopes)
        for (const scope of opts.storedRoleScopes?.get(role.name) ?? []) {
          if (!desired.has(scope)) out.add(scope)
        }
      }
      break
    }
    default:
      out.add(SECTION_BASE_SCOPE[section])
  }
  return [...out]
}

/**
 * `requiredScopesFor` against the live org: for roles it reads the stored role
 * scopes so a scope the change would revoke is required as well, and the whole
 * set is checked before the first write (the roles apply is not atomic across
 * roles).
 */
export async function requiredScopesForChange(
  orgId: string,
  section: ConfigToolSection,
  config: ProvisioningConfig,
): Promise<string[]> {
  if (section !== "roles") return requiredScopesFor(orgId, section, config)
  const stored = await storedRoleScopes((reason, fn) => withPrivilegedDb(orgId, reason, fn), orgId)
  return requiredScopesFor(orgId, section, config, {
    storedRoleScopes: new Map([...stored.entries()].map(([name, r]) => [name, r.scopes] as const)),
  })
}

/** The scopes in `required` the actor does not hold (empty: allowed). */
export function missingScopes(required: readonly string[], actorScopes: string[]): string[] {
  return required.filter((s) => !hasScope(s, actorScopes))
}
