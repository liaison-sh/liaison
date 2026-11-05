// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * SyncedSourceAddTab — full-tab create flow for synced sources.
 *
 * Per `[[feedback_no_popups_for_cognitive_work]]`: create/edit flows live in
 * tabs, not modals. The settings page lists existing sources; this tab is the
 * authoring surface so the agent panel stays reachable on the right.
 *
 * F1 fix: replaces the inline-form-on-settings-page version. The settings page
 * now opens this tab via `openTab({ type: "knowledge:synced-source-add", … })`.
 */

import { type Component, createSignal, Show } from "solid-js"
import { scopeGranted, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { closeTab, makeTabId, openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { createSyncedSource } from "./knowledge-api"

type Scope = "personal" | "organization"
type Sensitivity = "public" | "internal" | "confidential" | "restricted"

/**
 * I3: gate the "Shared with org" radio on caller scopes. The backend
 * (requireSourcesManage) is the source of truth; this is the UX hint, read the
 * way the backend's hasScope reads it, so the admin wildcard `*` and a parent
 * grant count.
 */
export function canCreateOrgSource(scopes: readonly string[] | undefined): boolean {
  if (!scopes) return false
  return (
    scopeGranted("knowledge:sources:manage", scopes) ||
    scopeGranted("knowledge:documents:admin", scopes)
  )
}

const SyncedSourceAddTab: Component<{ entityId: string }> = (_props) => {
  const i18n = useI18n()
  const api = useApi()
  const [folderRef, setFolderRef] = createSignal("")
  const [displayName, setDisplayName] = createSignal("")
  const [intervalMin, setIntervalMin] = createSignal(60)
  const [scope, setScope] = createSignal<Scope>("personal")
  const [sensitivity, setSensitivity] = createSignal<Sensitivity>("internal")
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const orgAllowed = canCreateOrgSource(userFromToken()?.scopes)

  const closeSelf = () => {
    // The tab's id is type:entityId; we always open with entityId="new".
    closeTab(makeTabId("knowledge:synced-source-add", "new"))
  }

  const onSubmit = async (ev: SubmitEvent) => {
    ev.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await createSyncedSource(api, {
        appName: "google-drive",
        folderRef: folderRef().trim(),
        displayName: displayName().trim(),
        syncIntervalSeconds: Math.max(60, intervalMin() * 60),
        scope: scope(),
        defaultSensitivity: scope() === "organization" ? sensitivity() : null,
      })
      addToast({ type: "info", message: i18n.t("knowledge.syncedSourceCreated") })
      // Hand the user back to the Settings list.
      openTab({
        type: "kernel:settings",
        entityId: "settings",
        label: i18n.t("kernel.common.settings"),
        routePath: "/settings/apps/knowledge",
      })
      closeSelf()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create source")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      data-testid="knowledge-synced-source-add-tab"
      class="mx-auto flex min-h-full max-w-2xl flex-col gap-4 px-8 pt-8 pb-dock-runway [--dock-pad-base:2rem]"
    >
      <header class="space-y-1">
        <h1 class="text-[20px] font-semibold text-text-primary">
          {i18n.t("knowledge.addSyncedSource")}
        </h1>
        <p class="text-[13px] text-text-tertiary">
          {i18n.t("knowledge.mountAnExternalFolderSoIts")}
        </p>
      </header>

      <form
        onSubmit={onSubmit}
        data-testid="synced-source-add-form"
        class="space-y-4 rounded border border-border-subtle bg-surface-recessed p-4"
      >
        <div>
          <label class="block text-[12px] font-medium text-text-secondary" for="ss-folder">
            {i18n.t("knowledge.driveFolderId")}
          </label>
          <input
            id="ss-folder"
            data-testid="synced-source-folder-ref"
            required
            value={folderRef()}
            onInput={(e) => setFolderRef(e.currentTarget.value)}
            class="mt-1 w-full rounded border border-border-subtle bg-surface px-2 py-1 text-[13px]"
            placeholder={i18n.t("knowledge.n0abXyz")}
          />
          <p class="mt-1 text-[11px] text-text-tertiary">
            {i18n.t("knowledge.openTheFolderInDriveAnd")}
            <em>{i18n.t("knowledge.thisPart")}</em>
            {i18n.t("knowledge.allowedCharactersLettersDigits")} <code>-</code>, <code>_</code>
            {i18n.t("knowledge.length8128")}
          </p>
        </div>

        <div>
          <label class="block text-[12px] font-medium text-text-secondary" for="ss-name">
            {i18n.t("knowledge.displayName")}
          </label>
          <input
            id="ss-name"
            data-testid="synced-source-display-name"
            required
            value={displayName()}
            onInput={(e) => setDisplayName(e.currentTarget.value)}
            class="mt-1 w-full rounded border border-border-subtle bg-surface px-2 py-1 text-[13px]"
            placeholder={i18n.t("knowledge.productManual")}
          />
        </div>

        <div class="flex items-center gap-3">
          <label class="block text-[12px] font-medium text-text-secondary" for="ss-interval">
            {i18n.t("knowledge.syncIntervalMinutes")}
          </label>
          <input
            id="ss-interval"
            data-testid="synced-source-interval"
            type="number"
            min="2"
            step="1"
            value={intervalMin()}
            onInput={(e) => setIntervalMin(Number(e.currentTarget.value))}
            class="w-20 rounded border border-border-subtle bg-surface px-2 py-1 text-[13px]"
          />
          <p data-testid="synced-source-interval-help" class="text-[11px] text-text-tertiary">
            {i18n.t("knowledge.effectiveMinimumIs2MinutesThe")}
          </p>
        </div>

        <div class="flex items-center gap-3">
          <span class="text-[12px] font-medium text-text-secondary">
            {i18n.t("knowledge.scope")}
          </span>
          <label class="inline-flex items-center gap-1 text-[12px] text-text-secondary">
            <input
              type="radio"
              name="ss-scope"
              value="personal"
              checked={scope() === "personal"}
              onChange={() => setScope("personal")}
              data-testid="synced-source-scope-personal"
            />
            {i18n.t("knowledge.personal")}
          </label>
          <label
            class="inline-flex items-center gap-1 text-[12px] text-text-secondary"
            title={orgAllowed ? undefined : i18n.t("knowledge.youDonTHaveKnowledgeSources")}
          >
            <input
              type="radio"
              name="ss-scope"
              value="organization"
              checked={scope() === "organization"}
              disabled={!orgAllowed}
              onChange={() => orgAllowed && setScope("organization")}
              data-testid="synced-source-scope-org"
              data-disabled={orgAllowed ? undefined : "true"}
            />
            <span class={orgAllowed ? "" : "opacity-50"}>{i18n.t("knowledge.sharedWithOrg")}</span>
          </label>
        </div>

        <Show when={scope() === "organization"}>
          <div>
            <label class="block text-[12px] font-medium text-text-secondary" for="ss-sens">
              {i18n.t("knowledge.sensitivity")}
            </label>
            <select
              id="ss-sens"
              data-testid="synced-source-sensitivity"
              value={sensitivity()}
              onChange={(e) => setSensitivity(e.currentTarget.value as Sensitivity)}
              class="mt-1 w-48 rounded border border-border-subtle bg-surface px-2 py-1 text-[13px]"
            >
              <option value="internal">{i18n.t("knowledge.internal")}</option>
              <option value="confidential">{i18n.t("knowledge.confidential")}</option>
              <option value="restricted">{i18n.t("knowledge.restricted")}</option>
              <option value="public">{i18n.t("knowledge.public")}</option>
            </select>
          </div>
        </Show>

        <Show when={error()}>
          <p
            data-testid="synced-source-add-error"
            class="text-[12px] text-red-600 dark:text-red-400"
          >
            {error()}
          </p>
        </Show>

        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="rounded px-3 py-1 text-[13px] text-text-secondary hover:bg-surface-hover"
            onClick={closeSelf}
            data-testid="synced-source-add-cancel"
          >
            {i18n.t("kernel.common.cancel")}
          </button>
          <button
            type="submit"
            disabled={submitting()}
            class="shrink-0 whitespace-nowrap rounded bg-accent px-3 py-1 text-[13px] font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-50"
            data-testid="synced-source-add-submit"
          >
            {submitting() ? i18n.t("knowledge.adding") : i18n.t("knowledge.addSource2")}
          </button>
        </div>
      </form>
    </div>
  )
}

export default SyncedSourceAddTab
