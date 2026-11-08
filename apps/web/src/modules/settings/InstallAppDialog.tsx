// SPDX-License-Identifier: FSL-1.1-ALv2
// Install / upgrade dialog for runtime apps.
//
// Two-step: enter a `.liaisonapp` URL → "Preflight" fetches the manifest →
// per-scope grant checkboxes. The admin sees exactly which scopes and
// connections the app requests and which tools depend on each scope.
//
// Installed apps are ALWAYS process-isolated — there is no "trusted" branch in
// this dialog. The trust posture line is unconditional.

import type { AppListing } from "@liaison/app-sdk"
import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

export interface AppManifestPreview {
  name: string
  version: string
  displayName?: string
  scopes: string[]
  /** The manifest's tool map, keyed by tool name. */
  tools?: Record<string, { requiredScopes?: string[] }>
  connections?: Array<{ name: string; type: string }>
  trusted?: unknown
  /** Kernel primitives the app declares; installing grants exactly these. */
  capabilities?: string[]
  /** Tools of other apps the app may call without the caller's own scopes. */
  cross_app_calls?: Array<{ target: string; reason?: string }>
  /** The legacy form of the same list; it authorizes the same dispatch. */
  dependencies?: { tools?: string[] }
  /** The package ships an interface (ui.js) that runs in the web page. */
  hasUiBundle?: boolean
  /** A trusted-publisher signature was verified (the interface needs no approval). */
  signatureVerified?: boolean
  /** The store listing, when the package has one (shown as plain text). */
  listing?: AppListing
  /** SPDX licence of the package. */
  license?: string
  /** The hosts its code may reach (network + connections); installing consents to them. */
  outboundDomains?: string[]
}

export interface UpgradePreview {
  manifest: AppManifestPreview
  newScopes: string[]
  removedScopes: string[]
  previouslyGranted: string[]
  newCapabilities?: string[]
  newCrossAppCalls?: string[]
  /** Outbound domains the running version was not granted: the upgrade consents to them. */
  newDomains?: string[]
}

export interface InstallAppDialogProps {
  mode?: "install" | "upgrade"
  /** Upgrade-mode: the previewed manifest + scope diff. */
  preview?: UpgradePreview
  /** Install-mode: the package URL to start from (a registry listing's). */
  initialUrl?: string
  /** Install-mode: fetch the manifest for a URL (the preflight call). */
  fetchManifest?: (url: string) => Promise<AppManifestPreview>
  /** Submit the install/upgrade with the admin-granted scopes. */
  onInstall?: (args: {
    url?: string
    grantedScopes: string[]
    grantedCapabilities: string[]
    grantedCrossAppCalls: string[]
    grantedDomains: string[]
    approveUiFullAccess: boolean
  }) => Promise<unknown>
  onClose: () => void
}

export const InstallAppDialog: Component<InstallAppDialogProps> = (props) => {
  const i18n = useI18n()
  const isUpgrade = () => props.mode === "upgrade"

  const [url, setUrl] = createSignal(props.initialUrl ?? "")
  const [manifest, setManifest] = createSignal<AppManifestPreview | null>(
    props.preview?.manifest ?? null,
  )
  const [error, setError] = createSignal<string | null>(null)
  const [granted, setGranted] = createSignal<Set<string>>(
    new Set(props.preview?.previouslyGranted ?? []),
  )

  const newScopes = createMemo(() => new Set(props.preview?.newScopes ?? []))
  // Every other app's tool the package may call: `cross_app_calls` plus the legacy
  // `dependencies.tools` list, which authorizes the same dispatch.
  const crossAppCalls = createMemo(() => {
    const m = manifest()
    const out = new Map<string, string | undefined>()
    for (const c of m?.cross_app_calls ?? []) out.set(c.target, c.reason)
    for (const t of m?.dependencies?.tools ?? []) if (!out.has(t)) out.set(t, undefined)
    return [...out].map(([target, reason]) => ({ target, reason }))
  })
  // The hosts this install or upgrade consents to: every declared one on an
  // install, the new ones on an upgrade (the running version's grant carries over).
  const consentDomains = createMemo(() =>
    isUpgrade() ? (props.preview?.newDomains ?? []) : (manifest()?.outboundDomains ?? []),
  )
  const [approveUi, setApproveUi] = createSignal(false)
  // The interface of an unsigned package runs in this page with the admin's session.
  const needsUiApproval = createMemo(
    () => manifest()?.hasUiBundle === true && manifest()?.signatureVerified !== true,
  )

  async function runPreflight(): Promise<void> {
    setError(null)
    if (!props.fetchManifest) return
    try {
      const m = await props.fetchManifest(url())
      setManifest(m)
      // All requested scopes default to granted on a fresh install.
      setGranted(new Set(m.scopes))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preflight failed")
    }
  }

  function toggleScope(scope: string): void {
    setGranted((prev) => {
      const next = new Set(prev)
      if (next.has(scope)) next.delete(scope)
      else next.add(scope)
      return next
    })
  }

  const toolEntries = createMemo(() => Object.entries(manifest()?.tools ?? {}))

  // A tool needs every one of its required scopes: missing any makes it unavailable.
  const toolLocked = (tool: { requiredScopes?: string[] }): boolean =>
    (tool.requiredScopes ?? []).some((scope) => !granted().has(scope))

  const disabledTools = createMemo(() =>
    toolEntries()
      .filter(([, tool]) => toolLocked(tool))
      .map(([name]) => name),
  )

  // Browse-only when no tool is left usable.
  const browseOnly = createMemo(() => {
    const entries = toolEntries()
    return entries.length > 0 && entries.every(([, tool]) => toolLocked(tool))
  })

  async function confirm(): Promise<void> {
    if (!props.onInstall) return
    try {
      await props.onInstall({
        url: isUpgrade() ? undefined : url(),
        grantedScopes: [...granted()],
        // Installing grants exactly what the manifest declares and the dialog lists.
        grantedCapabilities: manifest()?.capabilities ?? [],
        grantedCrossAppCalls: crossAppCalls().map((c) => c.target),
        grantedDomains: consentDomains(),
        approveUiFullAccess: needsUiApproval() && approveUi(),
      })
      props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Install failed")
    }
  }

  return (
    <div data-testid="install-app-dialog" class="flex flex-col gap-4 p-4">
      <h2 class="text-lg font-semibold text-text">
        {isUpgrade()
          ? i18n.t("kernel.settingsUi.upgradeApp")
          : i18n.t("kernel.settingsUi.installApp")}
      </h2>

      <Show when={!isUpgrade()}>
        <div class="flex items-start gap-2">
          <div class="flex-1">
            <Input
              data-testid="install-app-url"
              placeholder="https://…/my-app.liaisonapp"
              value={url()}
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
          </div>
          <Button data-testid="install-app-preflight" onClick={() => void runPreflight()}>
            {i18n.t("kernel.settingsUi.preflight")}
          </Button>
        </div>
      </Show>

      <Show when={error()}>
        <p data-testid="install-app-error" class="text-sm text-danger">
          {error()}
        </p>
      </Show>

      <Show when={manifest()}>
        {(m) => (
          <div class="flex flex-col gap-3">
            <p data-testid="install-app-trust-posture" class="text-sm text-text-secondary">
              {i18n.t("kernel.settingsUi.installTrustCopy")}
            </p>

            {/* The listing, as plain text (A12): a package without one is Unlisted (A11). */}
            <div class="flex flex-col gap-0.5 text-sm" data-testid="install-app-listing">
              <Show
                when={m().listing}
                fallback={
                  <span class="text-text-secondary">{i18n.t("kernel.appStore.unlisted")}</span>
                }
              >
                {(listing) => (
                  <>
                    <span class="text-text">{listing().summary}</span>
                    <Show when={listing().publisher}>
                      <span class="text-xs text-text-secondary">
                        {i18n.t("kernel.appStore.byPublisher", {
                          publisher: listing().publisher ?? "",
                        })}
                      </span>
                    </Show>
                    <span class="break-all font-mono text-xs text-text-secondary">
                      {listing().sourceRepository}
                    </span>
                  </>
                )}
              </Show>
              <Show when={m().license}>
                <span class="font-mono text-xs text-text-secondary">{m().license}</span>
              </Show>
            </div>

            <Show when={m().scopes.length > 0}>
              <div class="flex flex-col gap-1">
                <p class="text-xs font-medium text-text-secondary">
                  {i18n.t("kernel.settingsUi.requestedScopes")}
                </p>
                <For each={m().scopes}>
                  {(scope) => (
                    <label class="flex items-center gap-2 text-sm text-text">
                      <input
                        type="checkbox"
                        data-testid={`install-app-scope-${scope}`}
                        data-new={newScopes().has(scope) ? "true" : undefined}
                        checked={granted().has(scope)}
                        onChange={() => toggleScope(scope)}
                      />
                      <span classList={{ "text-accent": newScopes().has(scope) }}>{scope}</span>
                    </label>
                  )}
                </For>
              </div>
            </Show>

            <Show when={(m().capabilities ?? []).length > 0}>
              <div class="flex flex-col gap-1" data-testid="install-app-capabilities">
                <p class="text-xs font-medium text-text-secondary">
                  {i18n.t("kernel.settingsUi.requestedCapabilities")}
                </p>
                <For each={m().capabilities}>
                  {(cap) => (
                    <div class="text-sm text-text" data-testid={`install-app-capability-${cap}`}>
                      {cap}
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={crossAppCalls().length > 0}>
              <div class="flex flex-col gap-1" data-testid="install-app-cross-app-calls">
                <p class="text-xs font-medium text-text-secondary">
                  {i18n.t("kernel.settingsUi.requestedCrossAppCalls")}
                </p>
                <For each={crossAppCalls()}>
                  {(call) => (
                    <div
                      class="text-sm text-text"
                      data-testid={`install-app-cross-call-${call.target}`}
                    >
                      {call.target}
                      <Show when={call.reason}>
                        <span class="text-text-secondary">{` (${call.reason})`}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={consentDomains().length > 0}>
              <div class="flex flex-col gap-1" data-testid="install-app-outbound-domains">
                <p class="text-xs font-medium text-text-secondary">
                  {isUpgrade()
                    ? i18n.t("kernel.settingsUi.newOutboundDomains")
                    : i18n.t("kernel.settingsUi.requestedOutboundDomains")}
                </p>
                <For each={consentDomains()}>
                  {(domain) => (
                    <div
                      class="font-mono text-sm text-text"
                      data-testid={`install-app-outbound-domain-${domain}`}
                    >
                      {domain}
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={needsUiApproval()}>
              <label
                class="flex items-start gap-2 text-sm text-text"
                data-testid="install-app-ui-approval"
              >
                <input
                  type="checkbox"
                  data-testid="install-app-ui-approve"
                  checked={approveUi()}
                  onChange={(e) => setApproveUi(e.currentTarget.checked)}
                />
                <span>{i18n.t("kernel.settingsUi.approveUiFullAccess")}</span>
              </label>
            </Show>

            <Show when={(m().connections ?? []).length > 0}>
              <div class="flex flex-col gap-1">
                <p class="text-xs font-medium text-text-secondary">
                  {i18n.t("kernel.settingsUi.connections")}
                </p>
                <For each={m().connections}>
                  {(conn) => (
                    <div
                      data-testid={`install-app-connection-${conn.name}`}
                      class="text-sm text-text"
                    >
                      {conn.name} ({conn.type})
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={disabledTools().length > 0}>
              <p
                data-testid="install-app-disabled-tools-summary"
                class="text-xs text-text-secondary"
              >
                {i18n.t("kernel.settingsUi.withThisConfiguration")} {disabledTools().length}{" "}
                {i18n.t("kernel.settingsUi.of")} {toolEntries().length}{" "}
                {i18n.t("kernel.settingsUi.toolsWillBeUnavailable")} {disabledTools().join(", ")}.
              </p>
            </Show>
          </div>
        )}
      </Show>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => props.onClose()} data-testid="install-app-cancel">
          {i18n.t("kernel.common.cancel")}
        </Button>
        <Show when={manifest()}>
          <Button data-testid="install-app-confirm" onClick={() => void confirm()}>
            {browseOnly()
              ? i18n.t("kernel.settingsUi.installBrowseOnlyNoToolsEnabled")
              : isUpgrade()
                ? i18n.t("kernel.settingsUi.applyUpgrade")
                : i18n.t("kernel.settingsUi.install")}
          </Button>
        </Show>
      </div>
    </div>
  )
}
