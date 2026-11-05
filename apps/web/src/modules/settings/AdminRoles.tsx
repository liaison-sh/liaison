// SPDX-License-Identifier: FSL-1.1-ALv2

import { useNavigate, useSearchParams } from "@solidjs/router"
import { type Component, createMemo, createResource, For, Show } from "solid-js"
import { roleDisplayName } from "~/lib/app-label"
import { seededCopy, useI18n } from "~/modules/i18n/i18n-context"
import {
  mcpScopeLabel,
  mcpServerHref,
  parseMcpScope,
  useMcpServersBySlug,
} from "~/modules/mcp-manager/mcp-scope-names"
import { useApi } from "~/modules/shell/ApiContext"

interface RoleRow {
  id: string
  name: string
  description?: string | null
  memberCount?: number
  scopeCount?: number
}

/**
 * Does a role grant touch the permission `filter`? It covers it (`*`, the scope
 * itself, a parent, an `app:*` wildcard) or is a narrower grant inside it (one
 * tool of an MCP server under `mcp:<slug>`).
 */
export function grantTouchesScope(grant: string, filter: string): boolean {
  if (grant === "*" || grant === filter) return true
  if (filter.startsWith(`${grant}:`)) return true
  if (grant.startsWith(`${filter}:`)) return true
  if (grant.endsWith(":*") && filter.startsWith(grant.slice(0, -1))) return true
  return false
}

const AdminRoles: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const navigate = useNavigate()

  const [roles] = createResource(async () => {
    const res = (await api.get("/admin/roles")) as RoleRow[] | { data?: RoleRow[] }
    return (Array.isArray(res) ? res : (res?.data ?? [])) as RoleRow[]
  })

  // `?scope=<permission>`: only the roles whose grants touch it (the MCP server
  // page's "Fine-tune in Roles & access" link sends `mcp:<slug>`).
  const [params] = useSearchParams()
  const scopeFilter = () => (typeof params.scope === "string" ? params.scope : "")
  const mcpServers = useMcpServersBySlug()
  const filterServer = createMemo(() => {
    const ref = parseMcpScope(scopeFilter())
    return ref ? mcpServers().get(ref.slug) : undefined
  })
  const filterName = () =>
    filterServer()?.displayName ??
    mcpScopeLabel(scopeFilter(), mcpServers(), i18n.t) ??
    scopeFilter()
  const [holders] = createResource(
    () => {
      const scope = scopeFilter()
      const list = roles()
      return scope && list ? { scope, list } : null
    },
    async ({ scope, list }) => {
      const touched = await Promise.all(
        list.map(async (role) => {
          const res = (await api.get(`/admin/roles/${role.id}`, { suppressGlobalError: true })) as
            | { scopes?: Array<{ scope: string }> }
            | { data?: { scopes?: Array<{ scope: string }> } }
          const detail =
            "data" in res && res.data ? res.data : (res as { scopes?: { scope: string }[] })
          const grants = (detail.scopes ?? []).map((g) => g.scope)
          return grants.some((g) => grantTouchesScope(g, scope)) ? role.id : null
        }),
      )
      return new Set(touched.filter((id): id is string => id !== null))
    },
  )
  const shownRoles = createMemo(() => {
    const list = roles() ?? []
    if (!scopeFilter()) return list
    const held = holders.latest
    return held ? list.filter((r) => held.has(r.id)) : []
  })

  return (
    <div>
      <Show when={scopeFilter()}>
        <div
          class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border-subtle bg-surface/40 px-3 py-2 text-[12.5px]"
          data-testid="admin-roles-scope-filter"
        >
          <span class="text-text">
            {i18n.t("kernel.mcpUi.rolesFilter", { name: filterName() })}
          </span>
          <Show when={filterServer()}>
            {(server) => (
              <a
                class="text-accent underline-offset-2 hover:underline"
                href={mcpServerHref(server().id)}
                data-testid="admin-roles-scope-filter-server"
              >
                {i18n.t("kernel.mcpUi.rolesFilterOpenServer", { name: server().displayName })}
              </a>
            )}
          </Show>
          <a
            class="ml-auto text-text-secondary underline-offset-2 hover:underline"
            href="/settings/admin/roles"
            data-testid="admin-roles-scope-filter-clear"
          >
            {i18n.t("kernel.mcpUi.rolesFilterClear")}
          </a>
        </div>
        <Show when={holders.latest && shownRoles().length === 0}>
          <p class="mb-3 text-sm text-text-secondary" data-testid="admin-roles-scope-filter-empty">
            {i18n.t("kernel.mcpUi.rolesFilterNone", { name: filterName() })}
          </p>
        </Show>
      </Show>
      <Show
        when={roles() && shownRoles().length > 0}
        fallback={
          <p class="text-sm text-text-secondary" hidden={!!scopeFilter() && !holders.loading}>
            {roles.loading || holders.loading
              ? i18n.t("kernel.common.loading2")
              : i18n.t("kernel.settingsUi.noRolesDefinedYet")}
          </p>
        }
      >
        <table class="w-full text-sm" data-testid="admin-roles-table">
          <thead>
            <tr class="border-b border-border-subtle text-left text-text-secondary">
              <th class="py-2">{i18n.t("kernel.name")}</th>
              <th class="py-2">{i18n.t("kernel.description")}</th>
              <th class="whitespace-nowrap py-2 pl-4 text-right">{i18n.t("kernel.members")}</th>
              <th class="whitespace-nowrap py-2 pl-4 text-right">{i18n.t("kernel.scopes")}</th>
            </tr>
          </thead>
          <tbody>
            <For each={shownRoles()}>
              {(role) => (
                <tr
                  class="cursor-pointer border-b border-border-subtle hover:bg-surface-hover"
                  data-testid={`admin-roles-row-${role.id}`}
                  onClick={() => navigate(`/settings/admin/roles/${role.id}`)}
                >
                  <td class="py-2 font-medium text-text">{roleDisplayName(role.name, i18n.t)}</td>
                  <td class="py-2 text-text-secondary">
                    {seededCopy(
                      role.description,
                      `kernel.roleDescriptions.${role.name.replace(/\./g, "__")}`,
                      i18n.t,
                    )}
                  </td>
                  <td class="py-2 pl-4 text-right text-text-secondary">{role.memberCount ?? 0}</td>
                  <td class="py-2 pl-4 text-right text-text-secondary">{role.scopeCount ?? 0}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  )
}

export default AdminRoles
