// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Google client this workspace signs in with and connects Gmail through
// (`/api/settings/integrations/google`, kernel:org:admin): the deployment's
// client, the workspace's own, or none yet, with the form that sets or
// replaces it. One card, shown by Security > Sign-in methods and by Mail's
// settings, so the two never disagree about which client is in use.
import { GOOGLE_OAUTH_CLIENT_ID_SUFFIX } from "@liaison/shared"
import { type Component, createResource, createSignal, Match, Show, Switch } from "solid-js"
import { onEntityChange } from "~/framework/entity-changes"
import { ApiError } from "~/lib/api-client"
import { noAutofill } from "~/lib/no-autofill"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

interface GoogleIntegrationSummary {
  provider: "google"
  configured: boolean
  configurationSource: "org" | "deployment" | null
  clientIdHint?: string
}

export const GoogleClientCard: Component<{
  /** Called after the client was saved or removed (Mail reloads its providers). */
  onChanged?: () => void | Promise<void>
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [clientId, setClientId] = createSignal("")
  const [clientSecret, setClientSecret] = createSignal("")
  const [savingCredentials, setSavingCredentials] = createSignal(false)
  const [resettingCredentials, setResettingCredentials] = createSignal(false)
  // The client id/secret form: open by itself only when there is no client at
  // all; over a deployment's or the org's client it opens on request.
  const [credentialsFormOpen, setCredentialsFormOpen] = createSignal(false)

  const clientIdInvalid = () => {
    const value = clientId().trim()
    return value.length > 0 && !value.endsWith(GOOGLE_OAUTH_CLIENT_ID_SUFFIX)
  }

  const [googleSummary, { refetch: refetchGoogleSummary }] = createResource(async () => {
    return api.get<GoogleIntegrationSummary>("/settings/integrations/google")
  })

  // The client saved or cleared elsewhere (a card in a conversation, the
  // agent, another tab) shows without a reload: the server announces it on the
  // `mail:provider` frame (integrations-routes.ts), as for the Gmail switch.
  onEntityChange(["mail:provider"], () => {
    void refetchGoogleSummary()
  })

  /** Where the Google client comes from; undefined while loading. An unreadable
   *  summary counts as none, so the form stays reachable. A refetch keeps the
   *  last answer on screen until the new one lands. */
  const googleSource = (): "org" | "deployment" | null | undefined => {
    if (googleSummary.state === "errored") return null
    if (googleSummary.state !== "ready" && googleSummary.state !== "refreshing") return undefined
    return googleSummary.latest?.configurationSource ?? null
  }
  const showCredentialsForm = () => credentialsFormOpen() || googleSource() === null

  async function saveGoogleCredentials(e: Event): Promise<void> {
    e.preventDefault()
    setSavingCredentials(true)
    try {
      const saved = await api.patch<{ reconnectToMove?: number }>("/settings/integrations/google", {
        clientId: clientId(),
        clientSecret: clientSecret(),
      })
      setClientId("")
      setClientSecret("")
      setCredentialsFormOpen(false)
      addToast({ message: i18n.t("mail.googleCredentialsSaved"), type: "success" })
      // Accounts connected with another client keep working on it until reconnected.
      const toMove = saved?.reconnectToMove ?? 0
      if (toMove > 0) {
        addToast({ message: i18n.t("mail.googleReconnectToMove", { count: toMove }), type: "info" })
      }
      await Promise.all([refetchGoogleSummary(), props.onChanged?.()])
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to save Google credentials"
      addToast({ message, type: "error" })
    } finally {
      setSavingCredentials(false)
    }
  }

  async function resetGoogleCredentials(): Promise<void> {
    setResettingCredentials(true)
    try {
      await api.delete("/settings/integrations/google")
      setCredentialsFormOpen(false)
      addToast({ message: i18n.t("mail.workspaceGoogleCredentialsRemoved"), type: "success" })
      await Promise.all([refetchGoogleSummary(), props.onChanged?.()])
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to remove Google credentials"
      addToast({ message, type: "error" })
    } finally {
      setResettingCredentials(false)
    }
  }

  const googleStatusText = () => {
    const summary = googleSummary.latest
    if (!summary) return null
    if (summary.configurationSource === "org") return i18n.t("mail.configuredForThisWorkspace")
    if (summary.configurationSource === "deployment") return i18n.t("mail.usingDeploymentDefault")
    return i18n.t("mail.setupRequired")
  }

  return (
    <div
      data-testid="google-client-card"
      class="rounded-lg border border-border bg-surface p-4 space-y-4"
    >
      <div class="flex items-center justify-between gap-4">
        <div>
          <h4 class="text-sm font-medium text-text">{i18n.t("mail.1GoogleCredentials")}</h4>
          <p class="text-xs text-text-secondary">
            {i18n.t("mail.addWorkspaceGoogleOauthCredentialsFor")}
          </p>
        </div>
        <Show when={googleStatusText()}>
          <span class="rounded bg-surface-hover px-2 py-1 text-xs text-text-secondary">
            {googleStatusText()}
          </span>
        </Show>
      </div>

      <Switch>
        <Match when={googleSource() === "deployment"}>
          <p data-testid="mail-google-deployment-client" class="text-xs text-text-secondary">
            {i18n.t("mail.googleClientFromDeployment")}{" "}
            <span class="font-mono text-text-tertiary">{googleSummary.latest?.clientIdHint}</span>
          </p>
          <Show when={!credentialsFormOpen()}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="mail-google-override-toggle"
              aria-expanded="false"
              onClick={() => setCredentialsFormOpen(true)}
            >
              {i18n.t("mail.useYourOwnGoogleClient")}
            </Button>
          </Show>
        </Match>
        <Match when={googleSource() === "org"}>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <p class="text-xs text-text-tertiary">
              {i18n.t("mail.currentClientId")}{" "}
              <span class="font-mono">{googleSummary.latest?.clientIdHint}</span>
            </p>
            <div class="flex items-center gap-2">
              <Show when={!credentialsFormOpen()}>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="mail-google-replace"
                  onClick={() => setCredentialsFormOpen(true)}
                >
                  {i18n.t("mail.replaceGoogleClient")}
                </Button>
              </Show>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="mail-google-credentials-reset"
                loading={resettingCredentials()}
                onClick={() => void resetGoogleCredentials()}
              >
                {i18n.t("mail.removeGoogleClient")}
              </Button>
            </div>
          </div>
        </Match>
      </Switch>

      <Show when={showCredentialsForm()}>
        <form onSubmit={saveGoogleCredentials} class="flex flex-col gap-3">
          <Input
            label={i18n.t("mail.clientId")}
            placeholder={i18n.t("mail.googleOauthClientId")}
            value={clientId()}
            {...noAutofill("google-oauth-client-id")}
            onInput={(e) => setClientId((e.currentTarget as HTMLInputElement).value)}
          />
          <Show when={clientIdInvalid()}>
            <p class="text-xs text-red-500" data-testid="mail-google-client-id-error">
              {i18n.t("mail.thisDoesnTLookLikeA")}
              {GOOGLE_OAUTH_CLIENT_ID_SUFFIX}
              {i18n.t("mail.findItInGoogleCloudConsole")}
            </p>
          </Show>
          <Input
            label={i18n.t("mail.clientSecret")}
            type="password"
            placeholder={i18n.t("mail.googleOauthClientSecret")}
            value={clientSecret()}
            {...noAutofill("google-oauth-client-secret", { secret: true })}
            onInput={(e) => setClientSecret((e.currentTarget as HTMLInputElement).value)}
          />
          <div class="flex items-center justify-end gap-3">
            <Show when={credentialsFormOpen()}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="mail-google-credentials-cancel"
                onClick={() => setCredentialsFormOpen(false)}
              >
                {i18n.t("kernel.common.cancel")}
              </Button>
            </Show>
            <Button
              type="submit"
              size="sm"
              loading={savingCredentials()}
              disabled={!clientId() || !clientSecret() || clientIdInvalid()}
            >
              {i18n.t("mail.saveGoogleCredentials")}
            </Button>
          </div>
        </form>
      </Show>
    </div>
  )
}
