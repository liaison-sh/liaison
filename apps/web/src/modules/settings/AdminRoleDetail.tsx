// SPDX-License-Identifier: FSL-1.1-ALv2

import { useLocation } from "@solidjs/router"
import { Trash2, Users, X } from "lucide-solid"
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { roleDisplayName } from "~/lib/app-label"
import { seededCopy, useI18n } from "~/modules/i18n/i18n-context"
import {
  mcpScopeLabel,
  mcpServerHref,
  parseMcpScope,
  useMcpServersBySlug,
} from "~/modules/mcp-manager/mcp-scope-names"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Avatar } from "~/ui/AvatarStack"
import { Button } from "~/ui/Button"
import { RoleAppsSection } from "./app-management/RoleAppsSection"
import { PermissionGrid, type ScopeCatalogEntry } from "./PermissionGrid"

interface ScopeRow {
  scope: string
  grantedAt?: string | null
}

interface MemberRow {
  id: string
  name: string
  email: string
}

interface RoleDetail {
  id: string
  name: string
  description?: string | null
  scopes: ScopeRow[]
  dimensionGrants: Array<{ dimensionKey: string; values: string[] }>
  members: MemberRow[]
}

const AdminRoleDetail: Component = () => {
  const i18n = useI18n()
  const location = useLocation()
  const roleId = createMemo(() => {
    const m = location.pathname.match(/\/settings\/admin\/roles\/([^/?#]+)/)
    return m?.[1] ?? ""
  })
  const api = useApi()

  const [detail, { refetch }] = createResource(
    () => roleId(),
    async (id) => {
      if (!id) return null
      const res = (await api.get(`/admin/roles/${id}`)) as RoleDetail | { data?: RoleDetail }
      return ("data" in (res as any) ? (res as any).data : res) as RoleDetail | null
    },
  )

  const [catalog] = createResource(async () => {
    const res = (await api.get("/admin/scope-catalog")) as
      | ScopeCatalogEntry[]
      | { data?: ScopeCatalogEntry[] }
    return (Array.isArray(res) ? res : (res?.data ?? [])) as ScopeCatalogEntry[]
  })

  const [scopeError, setScopeError] = createSignal<string | null>(null)
  const [deleteModalOpen, setDeleteModalOpen] = createSignal(false)

  const grantedScopes = createMemo(() => detail()?.scopes.map((s) => s.scope) ?? [])
  // MCP server grants read as the server's name, with a link to its page.
  const mcpServers = useMcpServersBySlug()
  const mcpGrants = createMemo(() =>
    grantedScopes().flatMap((scope) => {
      const ref = parseMcpScope(scope)
      if (!ref) return []
      const server = mcpServers().get(ref.slug)
      return [{ scope, ref, server }]
    }),
  )

  async function addScope(scope: string) {
    setScopeError(null)
    try {
      await api.post(`/admin/roles/${roleId()}/scopes`, { scope })
      await refetch()
    } catch (err: any) {
      setScopeError(err?.message ?? i18n.t("kernel.settingsUi.failedToAddScope"))
      addToast({ message: i18n.t("kernel.settingsUi.failedToGrantPermission"), type: "error" })
    }
  }

  async function removeScope(scope: string) {
    setScopeError(null)
    try {
      await api.delete(`/admin/roles/${roleId()}/scopes/${encodeURIComponent(scope)}`)
      await refetch()
    } catch (err: any) {
      setScopeError(err?.message ?? i18n.t("kernel.settingsUi.failedToRemoveScope"))
      addToast({ message: i18n.t("kernel.settingsUi.failedToRevokePermission"), type: "error" })
    }
  }

  async function handleDelete() {
    try {
      await api.delete(`/admin/roles/${roleId()}`)
      addToast({ message: i18n.t("kernel.settingsUi.roleDeleted"), type: "success" })
      window.location.assign("/settings/admin/roles")
    } catch (err: any) {
      addToast({
        message: err?.message ?? i18n.t("kernel.settingsUi.cannotDeleteRoleWithActiveMembers"),
        type: "error",
      })
      setDeleteModalOpen(false)
    }
  }

  return (
    <Show
      when={detail()}
      fallback={
        <Show
          when={!detail.loading}
          fallback={<p class="text-sm text-text-secondary">{i18n.t("kernel.loading")}</p>}
        >
          <p class="text-sm text-text-secondary">
            {i18n.t("kernel.settingsUi.roleNotFound")}{" "}
            <a class="underline" href="/settings/admin/roles">
              {i18n.t("kernel.settingsUi.backToRoles")}
            </a>
          </p>
        </Show>
      }
    >
      {(role) => (
        <div class="flex flex-col gap-8 pb-12">
          {/* ── Header ──────────────────────────────────────────── */}
          <header class="flex items-start justify-between gap-6">
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-3">
                <h1 class="font-display text-[26px] font-semibold tracking-tight text-text">
                  {roleDisplayName(role().name, i18n.t)}
                </h1>
                <span class="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface/60 px-2.5 py-[3px] text-[11px] text-text-secondary">
                  <Users size={11} aria-hidden />
                  {role().members.length} {role().members.length === 1 ? "member" : "members"}
                </span>
              </div>
              <p class="max-w-2xl text-[13px] leading-relaxed text-text-secondary">
                <Show
                  when={role().description}
                  fallback={
                    <span class="italic text-text-tertiary">
                      {i18n.t("kernel.settingsUi.aPermissionPresetTickTheCapabilities")}
                    </span>
                  }
                >
                  {seededCopy(
                    role().description,
                    `kernel.roleDescriptions.${role().name.replace(/\./g, "__")}`,
                    i18n.t,
                  )}
                </Show>
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteModalOpen(true)}
              data-testid="admin-role-delete-button"
            >
              <Trash2 size={12} aria-hidden /> {i18n.t("kernel.settingsUi.deleteRole")}
            </Button>
          </header>

          {/* ── Permissions ─────────────────────────────────────── */}
          <section data-testid="admin-role-section-scopes" class="flex flex-col gap-3">
            <header class="flex items-baseline justify-between gap-3">
              <h2 class="font-display text-[15px] font-medium tracking-tight text-text">
                {i18n.t("kernel.settingsUi.permissions")}
              </h2>
              <p class="text-[11.5px] text-text-tertiary">
                {grantedScopes().length} {i18n.t("kernel.settingsUi.of")} {catalog()?.length ?? 0}{" "}
                {i18n.t("kernel.settingsUi.granted")}
              </p>
            </header>
            <PermissionGrid
              catalog={catalog() ?? []}
              granted={grantedScopes()}
              loading={catalog.loading}
              mode="edit"
              testIdPrefix="admin-role"
              searchInputTestId="admin-role-scope-input"
              scopeLabels={(scope) => mcpScopeLabel(scope, mcpServers(), i18n.t)}
              onAdd={addScope}
              onRemove={removeScope}
            />
            <Show when={scopeError()}>
              <p
                class="text-[11.5px] text-danger"
                data-testid="admin-role-scope-error"
                role="alert"
              >
                {scopeError()}
              </p>
            </Show>
          </section>

          {/* ── MCP servers this role's grants reach ─────────────── */}
          <Show when={mcpGrants().length > 0}>
            <section data-testid="admin-role-section-mcp" class="flex flex-col gap-2">
              <header class="flex flex-col gap-0.5">
                <h2 class="font-display text-[15px] font-medium tracking-tight text-text">
                  {i18n.t("kernel.mcpUi.roleServersTitle")}
                </h2>
                <p class="text-[11.5px] text-text-tertiary">
                  {i18n.t("kernel.mcpUi.roleServersHint")}
                </p>
              </header>
              <ul class="flex flex-col gap-1">
                <For each={mcpGrants()}>
                  {(g) => (
                    <li class="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-surface/40 px-3 py-2 text-[12.5px]">
                      <span class="text-text" title={g.scope}>
                        {g.server?.displayName ?? g.ref.slug}
                        <span class="ml-2 text-[11px] text-text-tertiary">
                          {g.ref.tool
                            ? i18n.t("kernel.mcpUi.roleServerOneTool", { tool: g.ref.tool })
                            : i18n.t("kernel.mcpUi.roleServerAllTools")}
                        </span>
                      </span>
                      <Show when={g.server}>
                        {(server) => (
                          <a
                            class="text-[11.5px] text-accent underline-offset-2 hover:underline"
                            href={mcpServerHref(server().id)}
                            data-testid={`admin-role-mcp-link-${g.ref.slug}`}
                          >
                            {i18n.t("kernel.mcpUi.rolesFilterOpenServer", {
                              name: server().displayName,
                            })}
                          </a>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>

          {/* ── Members ─────────────────────────────────────────── */}
          <section data-testid="admin-role-section-members" class="flex flex-col gap-3">
            <header class="flex items-baseline justify-between gap-3">
              <h2 class="font-display text-[15px] font-medium tracking-tight text-text">
                {i18n.t("kernel.members")}
              </h2>
              <p class="text-[11px] text-text-tertiary">
                {role().members.length === 0
                  ? i18n.t("kernel.settingsUi.noOneHasThisRole")
                  : role().members.length === 1
                    ? i18n.t("kernel.settingsUi.roleMembersOne")
                    : i18n.t("kernel.settingsUi.roleMembersMany", { count: role().members.length })}
              </p>
            </header>
            <Show
              when={role().members.length > 0}
              fallback={
                <div class="rounded-md border border-dashed border-border-subtle bg-surface/30 px-3 py-5 text-center text-[11.5px] text-text-tertiary">
                  {i18n.t("kernel.settingsUi.assignThisRoleToUsersFrom")}
                </div>
              }
            >
              <ul class="flex flex-col gap-1">
                <For each={role().members}>
                  {(m) => (
                    <li class="flex items-center gap-3 rounded-md border border-border-subtle bg-surface/40 px-3 py-2">
                      <Avatar user={{ id: m.id, name: m.name, avatarUrl: null }} size="sm" />
                      <div class="flex min-w-0 flex-col">
                        <span class="truncate text-[12.5px] text-text">{m.name}</span>
                        <span class="truncate text-[11px] text-text-tertiary">{m.email}</span>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>

          {/* ── Apps this role can use (S20) ──────────────────────── */}
          <RoleAppsSection roleId={role().id} roleName={role().name} />

          {/* ── Delete modal ─────────────────────────────────────── */}
          <Show when={deleteModalOpen()}>
            <div
              class="fixed inset-0 z-40 flex items-center justify-center bg-overlay backdrop-blur-sm"
              data-testid="admin-role-delete-modal"
              onClick={(e) => {
                if (e.target === e.currentTarget) setDeleteModalOpen(false)
              }}
            >
              <div class="w-96 rounded-lg border border-border bg-elevated p-5 shadow-popover">
                <div class="flex items-start gap-3">
                  <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-error-border bg-error-glow">
                    <Trash2 size={14} class="text-error" aria-hidden />
                  </div>
                  <div class="flex flex-col gap-1">
                    <h3 class="font-display text-[14px] font-medium tracking-tight text-text">
                      {i18n.t("kernel.settingsUi.deleteRole2")}
                    </h3>
                    <p class="text-[12px] leading-relaxed text-text-secondary">
                      <Show when={role().members.length > 0}>
                        {i18n.t("kernel.settingsUi.cannotDeleteARoleWithActive")}{" "}
                        {role().members.length} {role().members.length === 1 ? "person" : "people"}{" "}
                        {i18n.t("kernel.settingsUi.whoHoldThisRoleFirst")}
                      </Show>
                      <Show when={role().members.length === 0}>
                        {i18n.t("kernel.settingsUi.thisActionCannotBeUndonePermissions")}
                      </Show>
                    </p>
                  </div>
                  <button
                    type="button"
                    class="ml-auto rounded-md p-1 text-text-tertiary hover:bg-surface-hover hover:text-text"
                    onClick={() => setDeleteModalOpen(false)}
                    aria-label={i18n.t("kernel.close")}
                  >
                    <X size={14} aria-hidden />
                  </button>
                </div>
                <div class="mt-4 flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setDeleteModalOpen(false)}>
                    {i18n.t("kernel.common.cancel")}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={handleDelete}
                    disabled={role().members.length > 0}
                    data-testid="admin-role-confirm-delete"
                  >
                    {i18n.t("kernel.settingsUi.deleteRole")}
                  </Button>
                </div>
              </div>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}

export default AdminRoleDetail
