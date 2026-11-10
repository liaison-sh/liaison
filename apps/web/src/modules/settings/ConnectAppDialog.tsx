// SPDX-License-Identifier: FSL-1.1-ALv2
// Generic credential-connect form for app connections. Drives entirely off a
// connection's public-safe config (T2 `GET /api/apps/:appName/connections`):
// renders one input per `credentialFields[]` for `type:"credentials"`
// connections, or an OAuth connect action for `type:"oauth2"`: one Connect
// button when a client is already configured (replacing it is an opt-in
// disclosure), the client fields up front when none is. There are no per-app
// branches beyond that split — the form is generic. Content-only:
// the parent (the connect dialog host) wraps it in <Dialog>/<Dialog.Content>.

import { type Component, createSignal, For, onMount, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { appLabel } from "~/lib/app-label"
import { appDisplayNames } from "~/lib/capability-copy"
import { cn } from "~/lib/cn"
import { noAutofill } from "~/lib/no-autofill"
import { canAccessScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { capLimitMessage } from "~/modules/settings/cap-limit-message"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"
import { type AppConnectionConfig, appsStore, type OAuthClientStatus } from "./apps-store"
import { billingMode } from "./BillingState"
import { connectWithOAuth } from "./oauth-connect"
import { SetupGuidePopover } from "./SetupGuidePopover"

export interface ConnectAppDialogProps {
  /** Undefined only in test/no-provider paths; submit no-ops with an inline error. */
  api: ApiClient | undefined
  appName: string
  connectionName: string
  connConfig: AppConnectionConfig
  onClose: () => void
  onSuccess?: () => void
  /** Called just before an OAuth sign-in leaves the page for the provider. */
  onRedirect?: () => void
  /** Template variables to start from (reconnecting a known store). */
  initialTemplateVars?: Record<string, string>
}

type ConnectMode = "personal" | "org"

/** Map a declared credential field type to an HTML input type. */
function inputType(fieldType: string): string {
  if (fieldType === "password") return "password"
  if (fieldType === "number") return "number"
  return "text"
}

export const ConnectAppDialog: Component<ConnectAppDialogProps> = (props) => {
  const i18n = useI18n()
  // Org-owned connections require `<app>:accounts:admin` (enforced server-side).
  // Only admins see the Personal/Organization toggle; they default to an
  // org-owned connection (the common case for configuring an integration from
  // Settings → Apps), everyone else gets a personal connection.
  const isAdmin = () => canAccessScope(`${props.appName}:accounts:admin`)
  // The app as the reader names it ("GitLab"), never its id.
  const appName = () => appLabel(props.appName, i18n.t, appDisplayNames()[props.appName])
  // The default is DERIVED, not captured once at mount. Reading `isAdmin()` into
  // the signal's initial value froze whatever the auth store happened to hold at
  // that instant — and the dialog can open before the session is restored (a deep
  // link, a hard refresh). An admin then silently got a PERSONAL connection while
  // believing they had configured the org one. That is a false green with teeth:
  // background jobs resolve the ORG connection, so the pane read "Connected" off
  // the operator's personal token while every routine kept failing on the old org
  // credential (prod GitLab, 2026-08-02). An explicit click still wins.
  const [modeOverride, setMode] = createSignal<ConnectMode | null>(null)
  const mode = (): ConnectMode => modeOverride() ?? (isAdmin() ? "org" : "personal")
  const [fields, setFields] = createSignal<Record<string, string>>(
    Object.fromEntries((props.connConfig.credentialFields ?? []).map((f) => [f.name, ""])),
  )
  const [displayName, setDisplayName] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)
  const [submitting, setSubmitting] = createSignal(false)
  const [reconciling, setReconciling] = createSignal(false)

  // OAuth2 state: the per-connection OAuth client (id/secret) + any per-store
  // template vars (e.g. Shopify `shop`). The client is provisioned before the
  // browser consent (or reused if already configured).
  const isOAuth = () => props.connConfig.type === "oauth2"
  const [clientStatus, setClientStatus] = createSignal<OAuthClientStatus | null>(null)
  const [clientId, setClientId] = createSignal("")
  const [clientSecret, setClientSecret] = createSignal("")
  const [templateVars, setTemplateVars] = createSignal<Record<string, string>>(
    Object.fromEntries(
      (props.connConfig.templateVars ?? []).map((k) => [k, props.initialTemplateVars?.[k] ?? ""]),
    ),
  )

  // The app supplies (or refuses) its own client: no client fields at all.
  const appManagedClient = () => clientStatus()?.appManaged === true
  const appClientRefused = () => appManagedClient() && !clientStatus()?.configured
  // A client is already in place (the org's own, the deployment's, or the
  // app's): connecting needs nothing typed, so the dialog is one Connect action.
  const clientReady = () => clientStatus()?.configured === true
  // A managed instance provides its client: nobody replaces the deployment's
  // client from here (an org-level client stays replaceable).
  const clientLocked = () => billingMode() === "managed" && clientStatus()?.source === "deployment"
  const [ownClientOpen, setOwnClientOpen] = createSignal(false)
  const [clientHidden, setClientHidden] = createSignal(false)
  // The client fields: up front when no client exists (once the status has
  // loaded), behind the disclosure when one does, never for an app-managed or
  // a locked client.
  const showClientFields = () => {
    const status = clientStatus()
    if (!status || appManagedClient()) return false
    if (!status.configured) return true
    return ownClientOpen() && !clientLocked()
  }

  onMount(() => {
    if (!isOAuth() || !props.api) return
    void appsStore
      .oauthClientStatus(props.api, props.appName, props.connectionName)
      .then(setClientStatus)
      .catch((err) => {
        // The client is an admin's to see or set. A member connects their own
        // account on whatever client exists; if none does, the sign-in says so.
        if (err instanceof ApiError && err.status === 403) {
          setClientHidden(true)
          setClientStatus({ configured: true })
        } else setClientStatus({ configured: false })
      })
  })

  const requiredFields = () =>
    (props.connConfig.credentialFields ?? []).filter((f) => f.required !== false)

  async function submitCredentials(): Promise<void> {
    setError(null)
    const missing = requiredFields().find((f) => !fields()[f.name]?.trim())
    if (missing) {
      setError(`${missing.label} is required.`)
      return
    }
    if (!props.api) {
      setError("API unavailable")
      return
    }
    setSubmitting(true)
    try {
      await props.api.post(`/connections/${props.appName}/${props.connectionName}/credentials`, {
        mode: mode(),
        displayName: displayName().trim() || undefined,
        credentials: fields(),
      })
      props.onSuccess?.()
      props.onClose()
    } catch (err) {
      setError(
        capLimitMessage((k, p) => i18n.t(k, p), (err as { code?: unknown } | null)?.code) ??
          (err instanceof Error ? err.message : "Connection failed"),
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function connectOAuth(): Promise<void> {
    setError(null)
    if (!props.api) {
      setError("API unavailable")
      return
    }
    // A client the app resolves itself is never typed here (it would be ignored),
    // nor one hidden behind a closed disclosure.
    const id = showClientFields() ? clientId().trim() : ""
    const secret = showClientFields() ? clientSecret() : ""
    // A client must exist: either already configured, or provide BOTH now.
    if (!clientStatus()?.configured && !(id && secret)) {
      setError("Enter the OAuth app's client ID and client secret first.")
      return
    }
    if ((id && !secret) || (!id && secret)) {
      setError("Provide both the client ID and client secret to set the OAuth client.")
      return
    }
    // Any declared template vars (e.g. Shopify `shop`) are required to build the
    // per-store authorize URL.
    const missingVar = (props.connConfig.templateVars ?? []).find((k) => !templateVars()[k]?.trim())
    if (missingVar) {
      setError(`${missingVar} is required.`)
      return
    }
    setSubmitting(true)
    try {
      // Provision/replace the OAuth client first when new credentials were entered.
      if (id && secret) {
        await appsStore.setOAuthClient(props.api, props.appName, props.connectionName, {
          clientId: id,
          clientSecret: secret,
        })
      }
      const outcome = await connectWithOAuth(
        props.api,
        `/connections/${props.appName}/${props.connectionName}/authorize`,
        { mode: mode(), ...templateVars() },
        {
          navigate: (url) => {
            props.onRedirect?.()
            window.location.href = url
          },
        },
      )
      if (outcome === "no-redirect") setError("No authorization URL returned by the server.")
      if (outcome === "connected") props.onSuccess?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authorization failed")
    } finally {
      setSubmitting(false)
    }
  }

  // Repair an already-connected-but-half-initialised integration WITHOUT a full
  // re-OAuth. The one-shot `connected_account:create` event that runs an app's
  // post-connect setup (metadata rows, provider webhooks) can be lost to a
  // boot/redeploy race and never replays — leaving the app "connected" yet
  // broken. This re-drives that setup idempotently server-side.
  async function reconcile(): Promise<void> {
    setError(null)
    if (!props.api) {
      setError("API unavailable")
      return
    }
    setReconciling(true)
    try {
      await props.api.post(`/connections/${props.appName}/${props.connectionName}/reconcile`, {})
      addToast({
        message: i18n.t("kernel.settingsUi.reranSetup", { app: appName() }),
        type: "success",
      })
      props.onSuccess?.()
      props.onClose()
    } catch (err) {
      setError(
        err instanceof Error
          ? /no active/i.test(err.message)
            ? "No active connection to repair. Connect it first."
            : err.message
          : "Repair failed",
      )
    } finally {
      setReconciling(false)
    }
  }

  const modeButtonClass = (m: ConnectMode): string =>
    cn(
      "rounded-sm border px-2.5 py-1 text-xs font-medium",
      mode() === m
        ? "border-accent-border bg-accent-glow text-accent"
        : "border-border text-text-secondary hover:bg-surface-hover",
    )

  return (
    <div data-testid="connect-app-dialog" class="flex flex-col gap-4">
      <div>
        <div class="flex items-center gap-2">
          <h2 class="text-lg font-semibold text-text">
            {i18n.t("kernel.common.connect")} {appName()}
          </h2>
          <SetupGuidePopover
            guide={props.connConfig.setupGuide}
            label={i18n.t("kernel.settingsUi.howToConnect", { app: appName() })}
          />
        </div>
        <Show when={props.connConfig.description}>
          <p class="mt-1 text-sm text-text-secondary">{props.connConfig.description}</p>
        </Show>
      </div>

      <Show when={isAdmin()}>
        <div class="flex gap-2" data-testid="connect-mode-toggle">
          <button
            type="button"
            data-testid="connect-mode-personal"
            class={modeButtonClass("personal")}
            onClick={() => setMode("personal")}
          >
            {i18n.t("kernel.settingsUi.personal")}
          </button>
          <button
            type="button"
            data-testid="connect-mode-org"
            class={modeButtonClass("org")}
            onClick={() => setMode("org")}
          >
            {i18n.t("kernel.settingsUi.organization")}
          </button>
        </div>
      </Show>

      <Show
        when={props.connConfig.type === "credentials"}
        fallback={
          <div class="flex flex-col gap-3" data-testid="connect-oauth-form">
            <Show when={appManagedClient()}>
              <Show
                when={!appClientRefused()}
                fallback={
                  <p data-testid="oauth-client-unavailable" class="text-xs text-text-secondary">
                    {clientStatus()?.reason ?? i18n.t("kernel.settingsUi.oauthClientUnavailable")}
                  </p>
                }
              >
                <p data-testid="oauth-client-app-managed" class="text-xs text-text-secondary">
                  {i18n.t("kernel.settingsUi.oauthClientProvidedByApp", {
                    hint: clientStatus()?.clientIdHint ?? "",
                  })}
                </p>
              </Show>
            </Show>
            <Show when={clientReady() && !appManagedClient()}>
              <p data-testid="oauth-connect-account" class="text-sm text-text-secondary">
                {mode() === "org"
                  ? i18n.t("kernel.settingsUi.oauthConnectAccountOrg", { app: appName() })
                  : i18n.t("kernel.settingsUi.oauthConnectAccountPersonal", { app: appName() })}
              </p>
            </Show>
            <Show when={clientStatus()?.configured === false && !appManagedClient()}>
              <p class="text-xs text-text-secondary">
                {i18n.t("kernel.settingsUi.provideThisAppSOauthClient")}
              </p>
            </Show>
            <Show when={showClientFields()}>
              <Show when={clientReady()}>
                <p data-testid="oauth-client-replace-hint" class="text-xs text-text-secondary">
                  {i18n.t("kernel.settingsUi.oauthReplaceClientHint")}
                </p>
              </Show>
              <Input
                data-testid="oauth-client-id"
                type="text"
                {...noAutofill("oauth-client-id")}
                label={i18n.t("kernel.settingsUi.clientId")}
                value={clientId()}
                onInput={(e) => setClientId(e.currentTarget.value)}
              />
              <Input
                data-testid="oauth-client-secret"
                type="password"
                {...noAutofill("oauth-client-secret", { secret: true })}
                label={i18n.t("kernel.settingsUi.clientSecret")}
                value={clientSecret()}
                onInput={(e) => setClientSecret(e.currentTarget.value)}
              />
            </Show>
            <For each={props.connConfig.templateVars ?? []}>
              {(key) => (
                <Input
                  data-testid={`oauth-var-${key}`}
                  type="text"
                  {...noAutofill(`oauth-var-${key}`)}
                  label={key}
                  value={templateVars()[key] ?? ""}
                  onInput={(e) => setTemplateVars((v) => ({ ...v, [key]: e.currentTarget.value }))}
                />
              )}
            </For>
            <Button
              fullWidth
              data-testid="connect-oauth"
              disabled={submitting() || appClientRefused()}
              onClick={() => void connectOAuth()}
            >
              {clientReady()
                ? i18n.t("kernel.common.connect")
                : i18n.t("kernel.settingsUi.connectViaOauth")}
            </Button>
            <Show
              when={
                clientReady() &&
                !appManagedClient() &&
                !clientLocked() &&
                !clientHidden() &&
                !ownClientOpen()
              }
            >
              <button
                type="button"
                data-testid="oauth-client-replace-toggle"
                class="self-start text-xs text-text-secondary underline hover:text-text"
                onClick={() => setOwnClientOpen(true)}
              >
                {i18n.t("kernel.settingsUi.oauthUseOwnClient")}
              </button>
            </Show>
          </div>
        }
      >
        <div class="flex flex-col gap-3">
          <For each={props.connConfig.credentialFields ?? []}>
            {(field) => (
              <Input
                data-testid={`connect-field-${field.name}`}
                type={inputType(field.type)}
                {...noAutofill(`connection-${field.name}`, { secret: field.type === "password" })}
                label={field.label}
                value={fields()[field.name] ?? ""}
                onInput={(e) => setFields((f) => ({ ...f, [field.name]: e.currentTarget.value }))}
              />
            )}
          </For>
          <Input
            data-testid="connect-display-name"
            type="text"
            {...noAutofill("connection-display-name")}
            label={i18n.t("kernel.settingsUi.displayNameOptional")}
            value={displayName()}
            onInput={(e) => setDisplayName(e.currentTarget.value)}
          />
        </div>
      </Show>

      <Show when={error()}>
        <p data-testid="connect-error" class="text-sm text-danger">
          {error()}
        </p>
      </Show>

      <div class="flex items-center justify-between gap-2">
        <Show when={isAdmin()} fallback={<span />}>
          <Button
            data-testid="connect-reconcile"
            variant="ghost"
            size="sm"
            disabled={reconciling()}
            loading={reconciling()}
            onClick={() => void reconcile()}
          >
            {i18n.t("kernel.settingsUi.repairConnection")}
          </Button>
        </Show>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => props.onClose()}>
            {i18n.t("kernel.common.cancel")}
          </Button>
          <Show when={props.connConfig.type === "credentials"}>
            <Button
              data-testid="connect-submit"
              size="sm"
              disabled={submitting()}
              onClick={() => void submitCredentials()}
            >
              {i18n.t("kernel.common.connect")}
            </Button>
          </Show>
        </div>
      </div>
    </div>
  )
}
