// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The credentials a connection's adapter asks for, derived from its auth type:
// an API key, a bearer token, a username and password, or an OAuth client id
// and secret (the token URL is the adapter's, never typed here). They are typed
// in the host's own credential dialog, for this connection's slug and exactly
// these fields, and stored org-owned: nothing typed passes through this app.

import {
  AUTH_CREDENTIAL_FIELDS,
  type ConnectionSummary,
} from "@liaison/api-connector-core/contract"
import { type Component, createSignal, Show } from "solid-js"
import { enterCredentials } from "./api"
import { Button, useI18n } from "./kit"

export const CredentialsForm: Component<{
  connection: ConnectionSummary
  onSaved: () => void
}> = (props) => {
  const i18n = useI18n()
  const fields = () => {
    const auth = props.connection.auth
    return auth ? [...AUTH_CREDENTIAL_FIELDS[auth.type]] : []
  }
  const [saved, setSaved] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const [opening, setOpening] = createSignal(false)

  const authHint = () => {
    const auth = props.connection.auth
    if (!auth) return ""
    if (auth.type === "apiKey") {
      return i18n.t(
        auth.in === "query"
          ? "api-connector.settings.authApiKeyQuery"
          : "api-connector.settings.authApiKeyHeader",
        { name: auth.name ?? "" },
      )
    }
    return i18n.t(`api-connector.settings.auth.${auth.type}`)
  }

  async function open(): Promise<void> {
    setSaved(false)
    setFailed(false)
    setOpening(true)
    try {
      if (await enterCredentials(props.connection.identifier, fields())) {
        setSaved(true)
        props.onSaved()
      }
    } catch {
      setFailed(true)
    } finally {
      setOpening(false)
    }
  }

  return (
    <Show
      when={fields().length > 0}
      fallback={
        <p data-testid="api-connector-cred-unknown" class="text-xs text-text-secondary">
          {i18n.t("api-connector.settings.authUnknown")}
        </p>
      }
    >
      <div data-testid="api-connector-credentials-form" class="flex flex-col gap-3">
        <p class="text-xs text-text-secondary">{authHint()}</p>
        <Show when={failed()}>
          <p data-testid="api-connector-cred-error" class="text-xs text-error">
            {i18n.t("api-connector.settings.credFailed")}
          </p>
        </Show>
        <Show when={saved()}>
          <p data-testid="api-connector-cred-saved" class="text-xs text-text-secondary">
            {i18n.t("api-connector.settings.credSaved")}
          </p>
        </Show>
        <div>
          <Button
            size="sm"
            data-testid="api-connector-cred-save"
            loading={opening()}
            onClick={() => void open()}
          >
            {i18n.t("api-connector.settings.credSave")}
          </Button>
        </div>
      </div>
    </Show>
  )
}
