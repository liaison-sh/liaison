// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  type Component,
  createMemo,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { cn } from "~/lib/cn"
import { disambiguatedLabel, markAmbiguousNames } from "~/lib/name-collision"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import {
  type DimensionDef,
  type DimensionValue,
  dimensionGrantStore,
  loadDimensions,
  loadGrantsForUser,
  loadUsers,
  loadValues,
  selectUser,
  toggleGrant,
} from "./dimension-grant-store"

const DimensionGrantPage: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [pendingToggle, setPendingToggle] = createSignal<{
    dimensionKey: string
    value: string
  } | null>(null)
  const [deepLinkTarget, setDeepLinkTarget] = createSignal<{
    dimension: string
    value: string
  } | null>(null)
  const selectedUser = () =>
    dimensionGrantStore.users.find((user) => user.id === dimensionGrantStore.selectedUserId)
  // Two teammates named "Dana Reyes" are unremarkable; the strip only needs
  // her email when both of them are in it.
  const markedUsers = createMemo(() =>
    markAmbiguousNames(dimensionGrantStore.users, (user) => user.name ?? user.email ?? user.id),
  )

  onMount(async () => {
    const params = new URLSearchParams(window.location.search)
    const dimension = params.get("dimension")
    const value = params.get("value")
    if (dimension && value) setDeepLinkTarget({ dimension, value })

    await Promise.all([loadDimensions(api), loadUsers(api)])
    // Only a dimension the server names a value source for has values to ask for
    // (`valueSource`); asking for any other answered 404 and threw an uncaught
    // "Unknown dimension or no value source" on every visit to the page. A
    // membership dimension without one lists its declared values, when it has them.
    for (const def of dimensionGrantStore.dimensionDefs) {
      if (def.type === "membership" && def.valueSource && !dimensionGrantStore.valuesByKey[def.key])
        void loadValues(api, def.key)
    }
    if (dimensionGrantStore.selectedUserId)
      void loadGrantsForUser(api, dimensionGrantStore.selectedUserId)
  })

  async function chooseUser(userId: string): Promise<void> {
    selectUser(userId)
    await loadGrantsForUser(api, userId)
  }

  /** A membership dimension's values: fetched from its value source, else the ones it declares. */
  function membershipValues(def: DimensionDef): DimensionValue[] {
    const fetched = dimensionGrantStore.valuesByKey[def.key]
    if (fetched) return fetched
    return (def.values ?? def.order ?? []).map((value) => ({ value, label: value }))
  }

  function checked(def: DimensionDef, value: string): boolean {
    const userId = dimensionGrantStore.selectedUserId
    if (!userId) return false
    return dimensionGrantStore.grantsByUser[userId]?.[def.key]?.effective.includes(value) ?? false
  }

  function isDerivedOnly(def: DimensionDef, value: string): boolean {
    const userId = dimensionGrantStore.selectedUserId
    if (!userId) return false
    const row = dimensionGrantStore.grantsByUser[userId]?.[def.key]
    if (!row) return false
    return !row.direct.includes(value) && row.derived.some((entry) => entry.values.includes(value))
  }

  function isDeepLinkTarget(def: DimensionDef, value: string): boolean {
    const target = deepLinkTarget()
    return target?.dimension === def.key && target.value === value
  }

  async function applyToggle(def: DimensionDef, value: string, on: boolean): Promise<void> {
    const userId = dimensionGrantStore.selectedUserId
    if (!userId) return
    await toggleGrant(api, userId, def.key, value, on)
  }

  function handleCheckbox(def: DimensionDef, value: string, on: boolean): void {
    if (
      !on &&
      def.key === "mail:inbox" &&
      dimensionGrantStore.selectedUserId === userFromToken()?.userId
    ) {
      setPendingToggle({ dimensionKey: def.key, value })
      return
    }
    void applyToggle(def, value, on)
  }

  return (
    <div data-testid="dimension-grant-page">
      <Show
        when={dimensionGrantStore.users.length > 0}
        fallback={
          <div class="rounded-lg border border-border bg-surface p-4">
            <h2 class="font-medium text-text">{i18n.t("kernel.noTeammatesYet")}</h2>
            <a
              href="/settings/admin/users"
              class="mt-2 inline-block text-sm text-accent hover:underline"
            >
              {i18n.t("kernel.settingsUi.inviteTeammates")}
            </a>
          </div>
        }
      >
        <div class="mb-4 flex flex-wrap gap-2">
          <For each={markedUsers()}>
            {({ candidate: user, ambiguous }) => (
              <Button
                type="button"
                variant={user.id === dimensionGrantStore.selectedUserId ? "primary" : "outline"}
                size="sm"
                onClick={() => void chooseUser(user.id)}
              >
                {disambiguatedLabel(user.name ?? user.email ?? user.id, user.email, ambiguous)}
              </Button>
            )}
          </For>
        </div>

        <Show when={selectedUser()?.isActive === false}>
          <div class="mb-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-text-secondary">
            {i18n.t("kernel.settingsUi.thisTeammateIsDeactivatedExistingGrants")}
          </div>
        </Show>

        <div class="space-y-4">
          <For each={dimensionGrantStore.dimensionDefs}>
            {(def) => (
              <section class="rounded-lg border border-border bg-surface p-4">
                <div class="mb-3">
                  <h2 class="text-sm font-semibold text-text">{def.label}</h2>
                  <p class="text-xs uppercase tracking-wide text-text-tertiary">{def.app}</p>
                </div>
                <Switch
                  fallback={
                    <p class="text-sm text-text-tertiary">{i18n.t("kernel.notYetSupported")}</p>
                  }
                >
                  <Match when={def.type === "membership" && membershipValues(def).length > 0}>
                    <div class="space-y-2">
                      <For each={membershipValues(def)}>
                        {(value) => (
                          <label
                            data-testid={
                              isDeepLinkTarget(def, value.value)
                                ? "dimension-grant-target-value"
                                : undefined
                            }
                            aria-current={isDeepLinkTarget(def, value.value) ? "true" : undefined}
                            class={cn(
                              "flex items-center gap-2 text-sm text-text-secondary",
                              isDeepLinkTarget(def, value.value) &&
                                "rounded-md bg-accent-wash px-2 py-1 text-text",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked(def, value.value)}
                              disabled={isDerivedOnly(def, value.value)}
                              onChange={(event) =>
                                handleCheckbox(def, value.value, event.currentTarget.checked)
                              }
                            />
                            <span>{value.label}</span>
                            <Show when={isDerivedOnly(def, value.value)}>
                              <span class="ml-auto rounded bg-surface px-1.5 py-0.5 text-[11px] text-text-tertiary">
                                {i18n.t("kernel.settingsUi.fromRole")}
                              </span>
                            </Show>
                          </label>
                        )}
                      </For>
                    </div>
                  </Match>
                  <Match when={def.type === "level"}>
                    <div class="space-y-2">
                      <For each={def.order ?? def.values ?? []}>
                        {(value) => (
                          <label class="flex items-center gap-2 text-sm text-text-secondary">
                            <input
                              type="radio"
                              name={def.key}
                              checked={checked(def, value)}
                              disabled={isDerivedOnly(def, value)}
                              onChange={() => void applyToggle(def, value, true)}
                            />
                            <span>{value}</span>
                            <Show when={isDerivedOnly(def, value)}>
                              <span class="ml-auto rounded bg-surface px-1.5 py-0.5 text-[11px] text-text-tertiary">
                                {i18n.t("kernel.settingsUi.fromRole")}
                              </span>
                            </Show>
                          </label>
                        )}
                      </For>
                    </div>
                  </Match>
                </Switch>
                <Show when={dimensionGrantStore.error}>
                  <p class="mt-2 text-sm text-error">{dimensionGrantStore.error}</p>
                </Show>
              </section>
            )}
          </For>
        </div>
      </Show>

      <Dialog open={!!pendingToggle()} onOpenChange={(open) => !open && setPendingToggle(null)}>
        <Dialog.Content>
          <Dialog.Title>{i18n.t("kernel.revokeInboxAccess")}</Dialog.Title>
          <Dialog.Description>
            {i18n.t("kernel.settingsUi.youWillLoseAccessToThis")}
          </Dialog.Description>
          <div class="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setPendingToggle(null)}>
              {i18n.t("kernel.common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                const pending = pendingToggle()
                const userId = dimensionGrantStore.selectedUserId
                if (pending && userId)
                  void toggleGrant(api, userId, pending.dimensionKey, pending.value, false)
                setPendingToggle(null)
              }}
            >
              {i18n.t("kernel.settingsUi.revokeAccess")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}

export default DimensionGrantPage
