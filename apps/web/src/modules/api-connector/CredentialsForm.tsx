// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The credentials a connection's adapter asks for, derived from its auth type:
// an API key, a bearer token, a username and password, or an OAuth client id
// and secret (the token URL is the adapter's, never typed here). Stored
// org-owned under the connection's slug through the generic credentials route.
// Write-only: what was typed is cleared on save and never shown back.

import {
  AUTH_CREDENTIAL_FIELDS,
  type ConnectionSummary,
} from "@liaison/api-connector-core/contract"
import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"
import { saveCredentials } from "./api-connector-api"

/** Fields that are secrets get a password input; the rest are plain. */
const SECRET_FIELDS = new Set(["apiKey", "token", "password", "clientSecret"])

export const CredentialsForm: Component<{
  connection: ConnectionSummary
  onSaved: () => void
}> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const fields = () => {
    const auth = props.connection.auth
    return auth ? AUTH_CREDENTIAL_FIELDS[auth.type] : []
  }
  const [values, setValues] = createSignal<Record<string, string>>({})
  const [missing, setMissing] = createSignal(false)
  const [saved, setSaved] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const [saving, setSaving] = createSignal(false)

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

  async function save(e: Event): Promise<void> {
    e.preventDefault()
    setSaved(false)
    setFailed(false)
    const entered = Object.fromEntries(
      fields().map((name) => [name, (values()[name] ?? "").trim()]),
    )
    if (Object.values(entered).some((v) => !v)) {
      setMissing(true)
      return
    }
    setMissing(false)
    setSaving(true)
    try {
      await saveCredentials(api, props.connection.identifier, entered)
      setValues({})
      setSaved(true)
      props.onSaved()
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
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
      <form
        data-testid="api-connector-credentials-form"
        class="flex flex-col gap-3"
        autocomplete="off"
        onSubmit={(e) => void save(e)}
      >
        <p class="text-xs text-text-secondary">{authHint()}</p>
        <For each={fields()}>
          {(name) => (
            <Input
              data-testid={`api-connector-cred-${name}`}
              name={name}
              type={SECRET_FIELDS.has(name) ? "password" : "text"}
              autocomplete={SECRET_FIELDS.has(name) ? "new-password" : "off"}
              label={i18n.t(`api-connector.settings.credField.${name}`)}
              value={values()[name] ?? ""}
              onInput={(e) => {
                const value = e.currentTarget.value
                setValues((v) => ({ ...v, [name]: value }))
              }}
            />
          )}
        </For>
        <Show when={missing()}>
          <p data-testid="api-connector-cred-missing" class="text-xs text-error">
            {i18n.t("api-connector.settings.credMissing")}
          </p>
        </Show>
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
          <Button type="submit" size="sm" data-testid="api-connector-cred-save" loading={saving()}>
            {i18n.t("api-connector.settings.credSave")}
          </Button>
        </div>
      </form>
    </Show>
  )
}
