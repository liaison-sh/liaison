// SPDX-License-Identifier: FSL-1.1-ALv2

import { isImportPlaceholderEmail } from "@liaison/shared"
import { useNavigate } from "@solidjs/router"
import { type Component, createResource, createSignal, For, Show, Suspense } from "solid-js"
import { registerBulkUiSelection } from "~/framework/app-registry"
import { roleDisplayName } from "~/lib/app-label"
import { useI18n } from "~/modules/i18n/i18n-context"
import { capLimitMessage } from "~/modules/settings/cap-limit-message"
import { useApi } from "~/modules/shell/ApiContext"
import { BulkActionToolbar } from "~/modules/shell/bulk/BulkActionToolbar"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"
import { MergeImportedUserDialog } from "./MergeImportedUserDialog"

interface Role {
  id: string
  name: string
}

interface UserRow {
  id: string
  email: string
  name: string
  status: "active" | "suspended" | "deactivated"
  roles: Role[]
}

/** `people` are real accounts; `imported` are import placeholders (history authors). */
type UsersView = "people" | "imported"

const PAGE_LIMIT = 100
// A safety stop for the page walk; 50 pages of 100 is far beyond any org here.
const MAX_PAGES = 50

interface InviteError {
  code?: string
  message: string
  existingUserId?: string
}

const AdminUsers: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const navigate = useNavigate()

  const [inviteDialogOpen, setInviteDialogOpen] = createSignal(false)
  const [inviteEmail, setInviteEmail] = createSignal("")
  const [inviteRoleId, setInviteRoleId] = createSignal("")
  const [inviteLoading, setInviteLoading] = createSignal(false)
  const [inviteError, setInviteError] = createSignal<InviteError | null>(null)
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set())
  const [confirmDeactivate, setConfirmDeactivate] = createSignal<UserRow | null>(null)
  const [confirmReactivate, setConfirmReactivate] = createSignal<UserRow | null>(null)
  // The imported author being linked to a real person (Imported view).
  const [mergeSource, setMergeSource] = createSignal<UserRow | null>(null)

  const [view, setView] = createSignal<UsersView>("people")

  // The API pages its list (and orders it: active first, then by name). Walk
  // every page so nobody hides behind page one.
  async function loadUsers(kind: UsersView): Promise<UserRow[]> {
    const all: UserRow[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await api.getEnvelope<UserRow[]>(
        `/admin/users?kind=${kind}&limit=${PAGE_LIMIT}&page=${page}`,
      )
      const rows = Array.isArray(res?.data) ? res.data : []
      all.push(...rows)
      const total = typeof res?.meta?.total === "number" ? res.meta.total : all.length
      if (rows.length < PAGE_LIMIT || all.length >= total) break
    }
    return all
  }

  const [users, { refetch: refetchUsers }] = createResource(view, loadUsers)

  // How many import placeholders exist, for the "Imported (N)" filter.
  const [importedCount, { refetch: refetchImportedCount }] = createResource(async () => {
    const res = await api.getEnvelope<UserRow[]>("/admin/users?kind=imported&limit=1")
    const total = res?.meta?.total
    return typeof total === "number" ? total : Array.isArray(res?.data) ? res.data.length : 0
  })

  function switchView(next: UsersView) {
    if (next === view()) return
    setSelectedIds(new Set<string>())
    setView(next)
  }

  /** Reactivation is offered to real people only, never to an import placeholder. */
  const canReactivate = (user: UserRow) =>
    user.status === "deactivated" && !isImportPlaceholderEmail(user.email)

  const [availableRoles] = createResource(
    () => (inviteDialogOpen() ? true : undefined),
    async () => {
      const res = (await api.get("/admin/roles")) as Role[] | { data?: Role[] }
      return (Array.isArray(res) ? res : (res?.data ?? [])) as Role[]
    },
  )

  // Register bulk UI selection for kernel:users synchronously so <BulkActionToolbar>
  // sees the accessor on first render.
  registerBulkUiSelection("kernel", "users", {
    accessor: () => Array.from(selectedIds()),
    clear: () => setSelectedIds(new Set()),
    // Import placeholders are not selectable: there is nothing to do to them.
    all: () => (view() === "people" ? (users()?.map((u) => u.id) ?? []) : []),
  })

  function toggleSelection(id: string) {
    const next = new Set(selectedIds())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  async function handleInvite(e: Event) {
    e.preventDefault()
    setInviteError(null)

    const email = inviteEmail().trim()
    if (!email) {
      setInviteError({ message: i18n.t("kernel.settingsUi.pleaseEnterAnEmailAddress") })
      return
    }
    // Basic RFC 5322 surface-level check — the server validates fully.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInviteError({ message: i18n.t("kernel.settingsUi.pleaseEnterAValidEmailAddress") })
      return
    }
    if (!inviteRoleId()) {
      setInviteError({ message: i18n.t("kernel.settingsUi.pleaseSelectARole") })
      return
    }
    setInviteLoading(true)
    try {
      await api.post("/admin/invites", { email, roleId: inviteRoleId() })
      addToast({ message: i18n.t("kernel.settingsUi.inviteSent", { email }), type: "success" })
      setInviteDialogOpen(false)
      setInviteEmail("")
      setInviteRoleId("")
      await refetchUsers()
    } catch (err: any) {
      const body = err?.body ?? err
      const code = body?.error?.code ?? body?.code
      const message =
        capLimitMessage((k, p) => i18n.t(k, p), code) ??
        body?.error?.message ??
        body?.message ??
        "Failed to send invitation"
      setInviteError({
        code,
        message,
        existingUserId: body?.error?.existingUserId ?? body?.existingUserId,
      })
    } finally {
      setInviteLoading(false)
    }
  }

  async function handleDeactivate(userId: string) {
    try {
      await api.post(`/admin/users/${userId}/deactivate`, {})
      addToast({ message: i18n.t("kernel.settingsUi.userDeactivated"), type: "success" })
      await refetchUsers()
    } catch {
      addToast({ message: i18n.t("kernel.settingsUi.failedToDeactivateUser"), type: "error" })
    }
  }

  async function handleReactivate(userId: string) {
    try {
      await api.post(`/admin/users/${userId}/reactivate`, {})
      addToast({ message: i18n.t("kernel.settingsUi.userReactivated"), type: "success" })
      await refetchUsers()
    } catch (err: any) {
      const code = err?.code ?? err?.body?.error?.code
      addToast({
        message:
          code === "IMPORT_PLACEHOLDER"
            ? i18n.t("kernel.settingsUi.importedUserCannotBeReactivated")
            : (capLimitMessage((k, p) => i18n.t(k, p), code) ??
              i18n.t("kernel.settingsUi.failedToReactivateUser")),
        type: "error",
      })
    }
  }

  return (
    <div>
      <div class="mb-6 flex items-center justify-between">
        <h1 class="text-lg font-semibold text-text">{i18n.t("kernel.users")}</h1>
        <Button
          size="sm"
          onClick={() => setInviteDialogOpen(true)}
          data-testid="admin-users-invite-button"
        >
          {i18n.t("kernel.settingsUi.inviteUser")}
        </Button>
      </div>

      <div class="mb-4 flex flex-wrap items-center gap-2">
        <For each={["people", "imported"] as const}>
          {(kind) => (
            <button
              type="button"
              class="rounded-md border px-3 py-1.5 text-sm hover:bg-surface-hover"
              classList={{
                "border-accent text-text": view() === kind,
                "border-border-subtle text-text-secondary": view() !== kind,
              }}
              aria-pressed={view() === kind}
              data-testid={`admin-users-view-${kind}`}
              onClick={() => switchView(kind)}
            >
              {kind === "people"
                ? i18n.t("kernel.settingsUi.usersViewPeople")
                : i18n.t("kernel.settingsUi.usersViewImported", {
                    count: String(importedCount() ?? 0),
                  })}
            </button>
          )}
        </For>
      </div>

      <Show when={view() === "imported"}>
        <p class="mb-4 text-xs text-text-secondary" data-testid="admin-users-imported-note">
          {i18n.t("kernel.settingsUi.importedUsersExplainer")}
        </p>
      </Show>

      <Suspense
        fallback={<p class="text-sm text-text-secondary">{i18n.t("kernel.loadingUsers")}</p>}
      >
        {/* Scrolls sideways on a narrow screen instead of squeezing columns into each other. */}
        <div class="overflow-x-auto" data-testid="admin-users-table-scroll">
          <table class="w-full min-w-[40rem] text-left text-sm" data-testid="admin-users-table">
            <thead>
              <tr class="border-b border-border-subtle text-left text-text-secondary">
                <th class="w-8 py-2 pr-2" />
                <th class="py-2 pr-4">{i18n.t("kernel.name")}</th>
                <th class="py-2 pr-4">{i18n.t("kernel.email")}</th>
                <th class="py-2 pr-4">{i18n.t("kernel.roles")}</th>
                <th class="whitespace-nowrap py-2 pr-4">{i18n.t("kernel.status")}</th>
                <th class="whitespace-nowrap py-2 text-right">{i18n.t("kernel.actions")}</th>
              </tr>
            </thead>
            <tbody>
              <For each={users() ?? []}>
                {(user) => (
                  <tr
                    class="border-b border-border-subtle hover:bg-surface-hover"
                    data-testid={`admin-users-row-${user.id}`}
                  >
                    <td class="py-2 pr-2">
                      <Show when={view() === "people"}>
                        <input
                          type="checkbox"
                          checked={selectedIds().has(user.id)}
                          onChange={() => toggleSelection(user.id)}
                          data-testid={`admin-users-checkbox-${user.id}`}
                          aria-label={i18n.t("kernel.settingsUi.selectUser", { name: user.name })}
                        />
                      </Show>
                    </td>
                    <td class="py-2 pr-4">
                      <button
                        type="button"
                        class="text-left text-text hover:underline"
                        onClick={() => navigate(`/settings/admin/users/${user.id}`)}
                        data-testid={`admin-users-name-${user.id}`}
                      >
                        {user.name}
                      </button>
                    </td>
                    <td class="break-all py-2 pr-4 text-text-secondary">{user.email}</td>
                    <td class="py-2 pr-4">
                      <div
                        class="flex flex-wrap gap-1"
                        data-testid={`admin-users-roles-${user.id}`}
                      >
                        <For
                          each={user.roles}
                          fallback={
                            <span class="text-xs text-text-tertiary">
                              {i18n.t("kernel.settingsUi.noRole")}
                            </span>
                          }
                        >
                          {(role) => (
                            <span class="rounded bg-surface px-2 py-0.5 text-xs text-text-secondary">
                              {roleDisplayName(role.name, i18n.t)}
                            </span>
                          )}
                        </For>
                      </div>
                    </td>
                    <td class="whitespace-nowrap py-2 pr-4">
                      <span
                        class="text-xs text-text-secondary"
                        data-testid={`admin-users-status-${user.id}`}
                      >
                        {isImportPlaceholderEmail(user.email)
                          ? i18n.t("kernel.settingsUi.userStatus.imported")
                          : i18n.t(`kernel.settingsUi.userStatus.${user.status}`)}
                      </span>
                    </td>
                    <td class="whitespace-nowrap py-2 text-right">
                      <Show when={user.status === "active"}>
                        <button
                          type="button"
                          class="text-xs text-text-secondary hover:text-text"
                          data-testid={`admin-users-deactivate-${user.id}`}
                          onClick={() => setConfirmDeactivate(user)}
                        >
                          {i18n.t("kernel.settingsUi.deactivate")}
                        </button>
                      </Show>
                      <Show when={isImportPlaceholderEmail(user.email)}>
                        <button
                          type="button"
                          class="text-xs text-text-secondary hover:text-text"
                          data-testid={`admin-users-merge-${user.id}`}
                          onClick={() => setMergeSource(user)}
                        >
                          {i18n.t("kernel.settingsUi.mergeImportedUser")}
                        </button>
                      </Show>
                      <Show when={canReactivate(user)}>
                        <button
                          type="button"
                          class="text-xs text-text-secondary hover:text-text"
                          data-testid={`admin-users-reactivate-${user.id}`}
                          onClick={() => setConfirmReactivate(user)}
                        >
                          {i18n.t("kernel.settingsUi.reactivate")}
                        </button>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Suspense>

      <BulkActionToolbar app="kernel" viewId="users" />

      <MergeImportedUserDialog
        placeholder={mergeSource()}
        loadPeople={() => loadUsers("people")}
        onClose={() => setMergeSource(null)}
        onMerged={() => {
          void refetchUsers()
          void refetchImportedCount()
        }}
      />

      <Dialog
        open={inviteDialogOpen()}
        onOpenChange={(v) => {
          setInviteDialogOpen(v)
          if (!v) setInviteError(null)
        }}
      >
        <Dialog.Content>
          <Dialog.Title>{i18n.t("kernel.inviteUser")}</Dialog.Title>
          <Dialog.Description>
            {i18n.t("kernel.settingsUi.sendAnInvitationEmailToAdd")}
          </Dialog.Description>
          <form onSubmit={handleInvite} class="mt-4 flex flex-col gap-3">
            <Input
              type="email"
              label={i18n.t("kernel.settingsUi.emailAddress")}
              placeholder="user@example.com"
              value={inviteEmail()}
              onInput={(e) => setInviteEmail((e.currentTarget as HTMLInputElement).value)}
            />
            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium text-text-secondary">{i18n.t("kernel.role")}</label>
              <Suspense
                fallback={
                  <select
                    aria-label={i18n.t("kernel.role")}
                    class="rounded-sm border border-border bg-bg px-3 py-2 text-sm text-text-tertiary outline-none"
                    disabled
                  >
                    <option>{i18n.t("kernel.loadingRoles")}</option>
                  </select>
                }
              >
                <select
                  aria-label={i18n.t("kernel.role")}
                  value={inviteRoleId()}
                  onChange={(e) => setInviteRoleId(e.currentTarget.value)}
                  class="rounded-sm border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-border-strong"
                  required
                  data-testid="admin-users-invite-role"
                >
                  <option value="">{i18n.t("kernel.selectARole")}</option>
                  <For each={availableRoles() ?? []}>
                    {(role) => (
                      <option value={role.id}>{roleDisplayName(role.name, i18n.t)}</option>
                    )}
                  </For>
                </select>
              </Suspense>
            </div>
            <Show when={inviteError()}>
              {(err) => (
                <div class="text-xs text-danger" data-testid="admin-users-invite-error">
                  <p>{err().message}</p>
                  <Show when={err().code === "SCOPE_ESCALATION"}>
                    <p class="text-text-secondary">
                      {i18n.t("kernel.settingsUi.youCanTAssignARole")}
                    </p>
                  </Show>
                  <Show when={err().existingUserId}>
                    <button
                      type="button"
                      class="mt-1 underline"
                      onClick={() => navigate(`/settings/admin/users/${err().existingUserId}`)}
                    >
                      {i18n.t("kernel.settingsUi.viewExistingUser")}
                    </button>
                  </Show>
                </div>
              )}
            </Show>
            <Button fullWidth type="submit" loading={inviteLoading()}>
              {i18n.t("kernel.settingsUi.sendInvitation")}
            </Button>
          </form>
        </Dialog.Content>
      </Dialog>

      <Dialog
        open={confirmDeactivate() !== null}
        onOpenChange={(v) => {
          if (!v) setConfirmDeactivate(null)
        }}
      >
        <Dialog.Content>
          <Dialog.Title>{i18n.t("kernel.settingsUi.deactivateUser")}</Dialog.Title>
          <Dialog.Description>
            {i18n.t("kernel.settingsUi.areYouSureYouWantTo2")}{" "}
            <strong>{confirmDeactivate()?.name ?? i18n.t("kernel.settingsUi.thisUser")}</strong>
            {i18n.t("kernel.settingsUi.theyWillLoseAccessToThe")}
          </Dialog.Description>
          <div class="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDeactivate(null)}>
              {i18n.t("kernel.common.cancel")}
            </Button>
            <Button
              variant="danger"
              data-testid="admin-users-deactivate-confirm"
              onClick={async () => {
                const u = confirmDeactivate()
                if (u) await handleDeactivate(u.id)
                setConfirmDeactivate(null)
              }}
            >
              {i18n.t("kernel.settingsUi.deactivate")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>

      <Dialog
        open={confirmReactivate() !== null}
        onOpenChange={(v) => {
          if (!v) setConfirmReactivate(null)
        }}
      >
        <Dialog.Content>
          <Dialog.Title>{i18n.t("kernel.settingsUi.reactivateUser")}</Dialog.Title>
          <Dialog.Description>
            {i18n.t("kernel.settingsUi.areYouSureYouWantTo3")}{" "}
            <strong>{confirmReactivate()?.name ?? i18n.t("kernel.settingsUi.thisUser")}</strong>
            {i18n.t("kernel.settingsUi.theyWillRegainAccessToThe")}
          </Dialog.Description>
          <div class="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmReactivate(null)}>
              {i18n.t("kernel.common.cancel")}
            </Button>
            <Button
              data-testid="admin-users-reactivate-confirm"
              onClick={async () => {
                const u = confirmReactivate()
                if (u) await handleReactivate(u.id)
                setConfirmReactivate(null)
              }}
            >
              {i18n.t("kernel.settingsUi.reactivate")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}

export default AdminUsers
