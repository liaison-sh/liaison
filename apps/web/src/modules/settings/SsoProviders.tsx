// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Security > Sign-in methods > Single sign-on (settings overhaul S16): the
// organisation's OIDC providers with their status, connect and disconnect,
// and the form that adds one. It joined the former SSO Providers page (the
// add form) and the provider cards of the former Integrations page; that
// page's MCP servers row moved to the Connectors page.
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { apiUrl } from "~/lib/env"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"

interface OAuthProviderSummary {
  id: string
  name: string
  issuerUrl: string
  scopes: string | null
  autoProvision: boolean
  configured: boolean
  connectedAccountCount: number
}

const SsoProviders: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [disconnectingProvider, setDisconnectingProvider] =
    createSignal<OAuthProviderSummary | null>(null)
  const [isDisconnecting, setIsDisconnecting] = createSignal(false)

  const [providers, { refetch }] = createResource(async () => {
    return api.get<OAuthProviderSummary[]>("/admin/oauth-providers")
  })

  const [addOpen, setAddOpen] = createSignal(false)
  const [providerName, setProviderName] = createSignal("")
  const [issuerUrl, setIssuerUrl] = createSignal("")
  const [clientId, setClientId] = createSignal("")
  const [clientSecret, setClientSecret] = createSignal("")
  const [adding, setAdding] = createSignal(false)

  async function addProvider(e: Event) {
    e.preventDefault()
    setAdding(true)
    try {
      await api.post("/admin/oauth-providers", {
        name: providerName(),
        issuerUrl: issuerUrl(),
        clientId: clientId(),
        clientSecret: clientSecret(),
      })
      addToast({ message: i18n.t("kernel.settingsUi.ssoProviderAdded"), type: "success" })
      setAddOpen(false)
      setProviderName("")
      setIssuerUrl("")
      setClientId("")
      setClientSecret("")
      await refetch()
    } catch {
      addToast({ message: i18n.t("kernel.settingsUi.failedToAddSsoProvider"), type: "error" })
    } finally {
      setAdding(false)
    }
  }

  async function disconnectProvider() {
    const provider = disconnectingProvider()
    if (!provider) return

    setIsDisconnecting(true)
    try {
      await api.delete(`/admin/oauth-providers/${provider.id}`)
      addToast({ message: `${provider.name} disconnected`, type: "success" })
      setDisconnectingProvider(null)
      await refetch()
    } catch {
      addToast({
        message: i18n.t("kernel.settingsUi.disconnectFailed", { provider: provider.name }),
        type: "error",
      })
    } finally {
      setIsDisconnecting(false)
    }
  }

  return (
    <div data-testid="sso-providers">
      <p class="mb-3 text-xs text-text-secondary">
        {i18n.t("kernel.configureOidcProvidersForSingleSign")}
      </p>
      <div class="space-y-3">
        <Show when={!providers.loading && (providers()?.length ?? 0) === 0}>
          <div class="rounded-lg border border-border bg-surface p-4">
            <h3 class="text-sm font-medium text-text">
              {i18n.t("kernel.noOauthProvidersConfigured")}
            </h3>
            <p class="mt-1 text-sm text-text-secondary">
              {i18n.t("kernel.settingsUi.addAProviderBeforeUsersCan")}
            </p>
          </div>
        </Show>

        <For each={providers() ?? []}>
          {(provider) => (
            <div
              data-testid={`sso-provider-${provider.id}`}
              class="rounded-lg border border-border bg-surface p-4 space-y-4"
            >
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-sm font-medium text-text">{provider.name}</h3>
                  <p class="mt-1 text-xs text-text-secondary">{provider.issuerUrl}</p>
                </div>
                <span class="rounded bg-surface-hover px-2 py-1 text-xs text-text-secondary">
                  {provider.configured
                    ? i18n.t("kernel.settingsUi.configured")
                    : i18n.t("kernel.settingsUi.setupRequired")}
                </span>
              </div>

              <dl class="grid gap-2 text-xs text-text-secondary sm:grid-cols-3">
                <div>
                  <dt class="text-text-tertiary">{i18n.t("kernel.connectedAccounts")}</dt>
                  <dd>{provider.connectedAccountCount}</dd>
                </div>
                <div>
                  <dt class="text-text-tertiary">{i18n.t("kernel.autoProvision")}</dt>
                  <dd>
                    {provider.autoProvision
                      ? i18n.t("kernel.common.enabled")
                      : i18n.t("kernel.common.disabled")}
                  </dd>
                </div>
                <div>
                  <dt class="text-text-tertiary">{i18n.t("kernel.scopes")}</dt>
                  <dd>{provider.scopes || i18n.t("kernel.settingsUi.openidEmailProfile")}</dd>
                </div>
              </dl>

              <div class="flex flex-wrap items-center gap-2">
                <a
                  href={apiUrl(`/auth/oauth/${provider.id}/authorize`)}
                  class="inline-flex items-center justify-center rounded-sm bg-accent px-2.5 py-1 text-xs font-semibold text-bg transition-colors duration-150 hover:bg-accent-hover"
                >
                  {i18n.t("kernel.common.connect")}
                </a>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDisconnectingProvider(provider)}
                >
                  {i18n.t("kernel.common.disconnect")}
                </Button>
              </div>
            </div>
          )}
        </For>
      </div>

      <div class="mt-3">
        <Button
          size="sm"
          variant="outline"
          data-testid="sso-provider-add"
          onClick={() => setAddOpen(true)}
        >
          {i18n.t("kernel.settingsUi.addProvider")}
        </Button>
      </div>

      <Dialog open={addOpen()} onOpenChange={setAddOpen}>
        <Dialog.Content>
          <Dialog.Title>{i18n.t("kernel.addSsoProvider")}</Dialog.Title>
          <form onSubmit={addProvider} class="mt-4 flex flex-col gap-3">
            <Input
              label={i18n.t("kernel.settingsUi.providerName")}
              placeholder={i18n.t("kernel.eGGoogle")}
              value={providerName()}
              onInput={(e) => setProviderName((e.currentTarget as HTMLInputElement).value)}
            />
            <Input
              label={i18n.t("kernel.settingsUi.issuerUrl")}
              placeholder="https://accounts.google.com"
              value={issuerUrl()}
              onInput={(e) => setIssuerUrl((e.currentTarget as HTMLInputElement).value)}
            />
            <Input
              label={i18n.t("kernel.settingsUi.clientId")}
              value={clientId()}
              onInput={(e) => setClientId((e.currentTarget as HTMLInputElement).value)}
            />
            <Input
              label={i18n.t("kernel.settingsUi.clientSecret")}
              type="password"
              value={clientSecret()}
              onInput={(e) => setClientSecret((e.currentTarget as HTMLInputElement).value)}
            />
            <Button fullWidth type="submit" loading={adding()}>
              {i18n.t("kernel.settingsUi.addProvider")}
            </Button>
          </form>
        </Dialog.Content>
      </Dialog>

      <Dialog
        open={!!disconnectingProvider()}
        onOpenChange={(open) => !open && setDisconnectingProvider(null)}
      >
        <Dialog.Content>
          <Dialog.Title>{i18n.t("kernel.disconnectOauthProvider")}</Dialog.Title>
          <p class="mt-3 text-sm text-text-secondary">
            {i18n.t("kernel.common.disconnect")} {disconnectingProvider()?.name}
            {i18n.t("kernel.settingsUi.existingOauthAccountLinksForThis")}
          </p>
          <div class="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDisconnectingProvider(null)}>
              {i18n.t("kernel.common.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={isDisconnecting()}
              onClick={() => void disconnectProvider()}
            >
              {i18n.t("kernel.settingsUi.confirmDisconnect")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}

export default SsoProviders
