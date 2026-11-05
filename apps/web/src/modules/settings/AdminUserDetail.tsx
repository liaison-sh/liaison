// SPDX-License-Identifier: FSL-1.1-ALv2

import { useLocation } from "@solidjs/router"
import { ChevronDown, Eye, Plus, X } from "lucide-solid"
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { roleDisplayName } from "~/lib/app-label"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { ContextualSaveBar } from "~/modules/shell/save-bar/ContextualSaveBar"
import { addToast } from "~/modules/shell/toast-store"
import { Input } from "~/ui/Input"
import {
  type DimensionCatalogEntry,
  type DimensionGrantState,
  DimensionPanels,
} from "./DimensionPanels"
import { PermissionGrid, type ScopeCatalogEntry } from "./PermissionGrid"

interface Role {
  id: string
  name: string
  description?: string | null
}

interface EffectiveScope {
  scope: string
  fromRoles: string[]
  direct: boolean
}

interface UserDetail {
  id: string
  email: string
  name: string
  avatarUrl?: string | null
  status: "active" | "suspended" | "deactivated"
  roles: Role[]
  effectiveScopes: EffectiveScope[]
  dimensions: Record<
    string,
    {
      direct: string[]
      inherited: Array<{ roleId: string; roleName: string; values: string[] }>
    }
  >
}

const STATUS_STYLES: Record<UserDetail["status"], string> = {
  active: "border-success-border bg-success-glow text-success",
  suspended: "border-warning-border bg-warning-glow text-warning",
  deactivated: "border-border-subtle bg-surface/60 text-text-tertiary",
}

const AdminUserDetail: Component = () => {
  const i18n = useI18n()
  const location = useLocation()
  const userId = createMemo(() => {
    const m = location.pathname.match(/\/settings\/admin\/users\/([^/?#]+)/)
    return m?.[1] ?? ""
  })
  const api = useApi()

  const [detail, { refetch }] = createResource(
    () => userId(),
    async (id) => {
      if (!id) return null
      const res = (await api.get(`/admin/users/${id}`)) as UserDetail | { data?: UserDetail }
      return ("data" in (res as any) ? (res as any).data : res) as UserDetail | null
    },
  )

  const [availableRoles] = createResource(async () => {
    const res = (await api.get("/admin/roles")) as Role[] | { data?: Role[] }
    return (Array.isArray(res) ? res : (res?.data ?? [])) as Role[]
  })

  const [catalog] = createResource(async () => {
    const res = (await api.get("/admin/scope-catalog")) as
      | ScopeCatalogEntry[]
      | { data?: ScopeCatalogEntry[] }
    return (Array.isArray(res) ? res : (res?.data ?? [])) as ScopeCatalogEntry[]
  })

  const [dimensionCatalog] = createResource(async () => {
    const res = (await api.get("/admin/dimension-catalog")) as
      | DimensionCatalogEntry[]
      | { data?: DimensionCatalogEntry[] }
    return (Array.isArray(res) ? res : (res?.data ?? [])) as DimensionCatalogEntry[]
  })

  // null = unedited (show original); string = actively edited value (may be "")
  const [nameDraft, setNameDraft] = createSignal<string | null>(null)
  const [scopesExpanded, setScopesExpanded] = createSignal(false)
  const [assignError, setAssignError] = createSignal<string | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [pendingRoleId, setPendingRoleId] = createSignal<string | null>(null)

  const assignedRoleIds = createMemo(() => new Set(detail()?.roles.map((r) => r.id) ?? []))

  const effectiveScopeNames = createMemo(() => detail()?.effectiveScopes.map((s) => s.scope) ?? [])

  const sourceForScope = createMemo(() => {
    const map = new Map<string, EffectiveScope>()
    for (const s of detail()?.effectiveScopes ?? []) map.set(s.scope, s)
    return (scope: string) => {
      const hit = map.get(scope)
      if (!hit) return undefined
      return { fromRoles: hit.fromRoles, direct: hit.direct }
    }
  })

  function originalName(): string {
    return detail()?.name ?? ""
  }
  function effectiveName(): string {
    const d = nameDraft()
    return d !== null ? d : originalName()
  }
  function dirty(): boolean {
    const d = nameDraft()
    return d !== null && d !== originalName()
  }

  async function handleSave() {
    if (!dirty()) return
    setSaving(true)
    try {
      // Send null to clear the name, or the new non-empty string
      const name = nameDraft()
      await api.patch(`/admin/users/${userId()}`, { name: name || null })
      setNameDraft(null)
      await refetch()
      addToast({ message: i18n.t("kernel.settingsUi.identityUpdated"), type: "success" })
    } catch {
      addToast({ message: i18n.t("kernel.settingsUi.failedToUpdateIdentity"), type: "error" })
    } finally {
      setSaving(false)
    }
  }

  function handleDiscard() {
    setNameDraft(null)
  }

  async function handleAssignRole(roleId: string) {
    setAssignError(null)
    setPendingRoleId(roleId)
    try {
      await api.post(`/admin/roles/${roleId}/users`, { userId: userId() })
      await refetch()
    } catch (err: any) {
      const status = err?.status
      if (status === 403) {
        setAssignError(i18n.t("kernel.settingsUi.youCanTAssignARole"))
      } else {
        setAssignError(err?.message ?? i18n.t("kernel.settingsUi.failedToAssignRole"))
      }
    } finally {
      setPendingRoleId(null)
    }
  }

  async function handleUnassignRole(roleId: string) {
    setPendingRoleId(roleId)
    try {
      await api.delete(`/admin/roles/${roleId}/users/${userId()}`)
      await refetch()
    } catch {
      addToast({ message: i18n.t("kernel.settingsUi.failedToRemoveRole"), type: "error" })
    } finally {
      setPendingRoleId(null)
    }
  }

  function toggleRole(roleId: string) {
    if (pendingRoleId() === roleId) return
    if (assignedRoleIds().has(roleId)) {
      void handleUnassignRole(roleId)
    } else {
      void handleAssignRole(roleId)
    }
  }

  async function handleSetDimensionValues(dimension: string, values: string[]) {
    if (values.length === 0) {
      await api.delete(`/admin/roles/users/${userId()}/dimensions/${encodeURIComponent(dimension)}`)
    } else {
      await api.post(`/admin/roles/users/${userId()}/dimensions`, { dimension, values })
    }
    await refetch()
  }

  function grantState(): Record<string, DimensionGrantState> {
    const detail_ = detail()
    if (!detail_) return {}
    const out: Record<string, DimensionGrantState> = {}
    for (const [key, info] of Object.entries(detail_.dimensions)) {
      out[key] = { direct: info.direct, inherited: info.inherited }
    }
    return out
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
            {i18n.t("kernel.settingsUi.userNotFound")}{" "}
            <a class="underline" href="/settings/admin/users">
              {i18n.t("kernel.settingsUi.backToUsers")}
            </a>
          </p>
        </Show>
      }
    >
      {(user) => (
        <div class="flex flex-col gap-8 pb-12">
          <ContextualSaveBar
            dirty={dirty()}
            saving={saving()}
            onSave={handleSave}
            onDiscard={handleDiscard}
          />

          {/* ── Identity ────────────────────────────────────────── */}
          <section data-testid="admin-user-section-identity" class="flex flex-col gap-3">
            <header class="flex items-baseline justify-between gap-3">
              <h2 class="font-display text-[15px] font-medium tracking-tight text-text">
                {i18n.t("kernel.settingsUi.identity")}
              </h2>
              <span
                class={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[10.5px] font-medium uppercase tracking-wider ${STATUS_STYLES[user().status]}`}
              >
                <span class="h-1.5 w-1.5 rounded-full bg-current opacity-80" aria-hidden />
                {user().status}
              </span>
            </header>
            <div class="grid gap-3 sm:grid-cols-2">
              <Input
                label={i18n.t("kernel.common.name")}
                value={effectiveName()}
                onInput={(e) => setNameDraft((e.currentTarget as HTMLInputElement).value)}
                data-testid="admin-user-name-input"
              />
              <div class="flex flex-col gap-1.5">
                <span class="text-[12.5px] font-medium text-text-secondary">
                  {i18n.t("kernel.email")}
                </span>
                <span class="rounded-sm border border-border-subtle bg-bg/40 px-3 py-[9px] font-mono text-[12px] text-text-secondary">
                  {user().email}
                </span>
              </div>
            </div>
          </section>

          {/* ── Roles ──────────────────────────────────────────── */}
          <section data-testid="admin-user-section-roles" class="flex flex-col gap-3">
            <header class="flex items-baseline justify-between gap-3">
              <h2 class="font-display text-[15px] font-medium tracking-tight text-text">
                {i18n.t("kernel.roles")}
              </h2>
              <p class="text-[11px] text-text-tertiary">
                {i18n.t("kernel.settingsUi.clickARoleToGrantOr")}
              </p>
            </header>

            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="admin-user-roles-list">
              <Show
                when={(availableRoles() ?? []).length > 0}
                fallback={
                  <p class="rounded-md border border-dashed border-border-subtle bg-surface/30 px-3 py-5 text-center text-[12px] text-text-tertiary sm:col-span-2">
                    {i18n.t("kernel.settingsUi.noRolesExistYetCreateOne")}
                  </p>
                }
              >
                <For each={availableRoles() ?? []}>
                  {(role) => {
                    const assigned = () => assignedRoleIds().has(role.id)
                    const pending = () => pendingRoleId() === role.id
                    return (
                      <button
                        type="button"
                        class={`group relative flex flex-col gap-1 rounded-lg border px-3.5 py-3 text-left transition-all duration-150 ${
                          assigned()
                            ? "border-accent-border bg-accent-glow"
                            : "border-border-subtle bg-surface/40 hover:border-border hover:bg-surface/70"
                        } ${pending() ? "opacity-60" : ""}`}
                        data-testid={`admin-user-role-card-${role.id}`}
                        data-assigned={assigned() ? "true" : "false"}
                        aria-pressed={assigned()}
                        disabled={pending()}
                        onClick={() => toggleRole(role.id)}
                      >
                        <div class="flex items-center gap-2">
                          <span
                            class={`font-display text-[13.5px] font-medium tracking-tight ${
                              assigned() ? "text-accent" : "text-text"
                            }`}
                          >
                            {roleDisplayName(role.name, i18n.t)}
                          </span>
                          <Show when={assigned()}>
                            <span
                              class="ml-auto inline-flex h-5 w-5 items-center justify-center rounded-full text-text-tertiary opacity-0 transition-opacity duration-150 hover:bg-surface-hover hover:text-text group-hover:opacity-100"
                              data-testid={`admin-user-unassign-${role.id}`}
                              role="presentation"
                            >
                              <X size={11} aria-hidden />
                            </span>
                          </Show>
                          <Show when={!assigned()}>
                            <span class="ml-auto inline-flex h-5 items-center gap-1 rounded-full border border-border-subtle px-2 text-[10px] uppercase tracking-wider text-text-tertiary opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                              <Plus size={9} aria-hidden /> {i18n.t("kernel.common.assign")}
                            </span>
                          </Show>
                        </div>
                        <p
                          class={`text-[11.5px] leading-snug ${
                            assigned() ? "text-text-secondary" : "text-text-tertiary"
                          }`}
                        >
                          <Show
                            when={role.description}
                            fallback={
                              <span class="italic">{i18n.t("kernel.aPermissionPreset")}</span>
                            }
                          >
                            {role.description}
                          </Show>
                        </p>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </div>
            <Show when={assignError()}>
              <p
                class="text-[11.5px] text-error"
                data-testid="admin-user-assign-error"
                role="alert"
              >
                {assignError()}
              </p>
            </Show>
          </section>

          {/* ── Effective permissions ───────────────────────────── */}
          <section data-testid="admin-user-section-effective-scopes" class="flex flex-col gap-3">
            <button
              type="button"
              class="group flex items-center gap-2 self-start text-left"
              onClick={() => setScopesExpanded(!scopesExpanded())}
              data-testid="admin-user-scopes-toggle"
              aria-expanded={scopesExpanded()}
            >
              <ChevronDown
                size={13}
                class={`text-text-tertiary transition-transform duration-150 ${scopesExpanded() ? "" : "-rotate-90"}`}
                aria-hidden
              />
              <Eye size={13} class="text-text-tertiary" aria-hidden />
              <span class="font-display text-[15px] font-medium tracking-tight text-text">
                {i18n.t("kernel.settingsUi.whatCanThisUserDo")}
              </span>
              <span class="rounded-full border border-border-subtle bg-surface/60 px-2 py-[1px] text-[10.5px] text-text-secondary">
                {user().effectiveScopes.length}{" "}
                {user().effectiveScopes.length === 1 ? "permission" : "permissions"}
              </span>
            </button>
            <Show when={scopesExpanded()}>
              <div data-testid="admin-user-scopes-list">
                <PermissionGrid
                  catalog={catalog() ?? []}
                  granted={effectiveScopeNames()}
                  loading={catalog.loading}
                  mode="readonly"
                  scopeSource={sourceForScope()}
                  testIdPrefix="admin-user-effective"
                />
              </div>
            </Show>
          </section>

          {/* ── Access by team / sensitivity / … ────────────────── */}
          <section data-testid="admin-user-section-dimensions" class="flex flex-col gap-3">
            <header class="flex items-baseline justify-between gap-3">
              <h2 class="font-display text-[15px] font-medium tracking-tight text-text">
                {i18n.t("kernel.access")}
              </h2>
              <p class="text-[11px] text-text-tertiary">
                {i18n.t("kernel.settingsUi.whichTeamsAndSensitivityLevels")}{" "}
                {user().name.split(" ")[0] || i18n.t("kernel.settingsUi.thisUser")}{" "}
                {i18n.t("kernel.settingsUi.canSeeOnTopOfThe")}
              </p>
            </header>
            <DimensionPanels
              catalog={dimensionCatalog() ?? []}
              catalogLoading={dimensionCatalog.loading}
              grants={grantState()}
              onSetValues={handleSetDimensionValues}
              testIdPrefix="admin-user"
            />
          </section>
        </div>
      )}
    </Show>
  )
}

export default AdminUserDetail
