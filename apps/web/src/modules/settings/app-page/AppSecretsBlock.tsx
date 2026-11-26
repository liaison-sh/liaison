// SPDX-License-Identifier: FSL-1.1-ALv2
// An `appSecrets` block: the secrets a person gives one connection (its manifest
// `appSecretFields`, such as a webhook endpoint's signing secret), drawn by the kernel. It says
// whether each is set (never its value), takes a new one in a write-only field, and shows the
// app's webhook addresses to paste at the provider. The write goes through the kernel's own
// client: an app's UI bundle never reaches the route (framework/person-only-actions.ts), so no
// app can plant a secret another app verifies with.
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { labelOf } from "./page-model"
import type { SettingsAppSecretsBlock } from "./types"

const P = "kernel.settingsPage.appSecrets"

export interface AppSecretStatusView {
  key: string
  label: string
  labelKey?: string
  help?: string
  set: boolean
  previousUntil: string | null
}

export interface AppSecretsRead {
  secrets: AppSecretStatusView[]
  webhooks: Array<{ endpoint: string; url: string }>
}

export function appSecretsPath(app: string, connection: string): string {
  return `/connections/${encodeURIComponent(app)}/${encodeURIComponent(connection)}/app-secrets`
}

const SecretField: Component<{
  app: string
  connection: string
  secret: AppSecretStatusView
  onSaved: () => void
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [value, setValue] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const id = () => `app-secret-${props.app}-${props.connection}-${props.secret.key}`
  const label = () => labelOf(i18n.t, props.secret.labelKey, props.secret.label)

  async function save(e: Event): Promise<void> {
    e.preventDefault()
    const typed = value().trim()
    if (typed === "") {
      setError(i18n.t(`${P}.empty`))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const out = await api.put<{ rolled?: boolean; unchanged?: boolean }>(
        `${appSecretsPath(props.app, props.connection)}/${encodeURIComponent(props.secret.key)}`,
        { value: typed },
        { suppressGlobalError: true },
      )
      setValue("")
      addToast({
        message: out?.unchanged
          ? i18n.t(`${P}.unchanged`)
          : out?.rolled
            ? i18n.t(`${P}.savedRolled`)
            : i18n.t(`${P}.saved`),
        type: "success",
      })
      props.onSaved()
    } catch (err) {
      // The route's refusal says what the value should look like; it never holds the value.
      setError(err instanceof Error && err.message ? err.message : i18n.t(`${P}.failed`))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      class="flex flex-col gap-1.5"
      onSubmit={save}
      data-testid={`settings-app-secret-${props.secret.key}`}
    >
      <label class="text-[13px] font-medium" for={id()}>
        {label()}
      </label>
      <span
        class="text-[12.5px] text-text-secondary"
        data-testid={`settings-app-secret-state-${props.secret.key}`}
      >
        {props.secret.set ? i18n.t(`${P}.set`) : i18n.t(`${P}.notSet`)}
        <Show when={props.secret.previousUntil}>
          {(until) => (
            <>
              {" "}
              {i18n.t(`${P}.previousUntil`, {
                until: new Date(until()).toLocaleString(i18n.locale(), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </>
          )}
        </Show>
      </span>
      <div class="flex flex-wrap items-center gap-2">
        <input
          id={id()}
          type="password"
          autocomplete="off"
          spellcheck={false}
          class="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-[13px] md:min-h-8"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          data-testid={`settings-app-secret-input-${props.secret.key}`}
        />
        <Button
          type="submit"
          disabled={saving() || value().trim() === ""}
          data-testid={`settings-app-secret-save-${props.secret.key}`}
        >
          {props.secret.set ? i18n.t(`${P}.replace`) : i18n.t(`${P}.save`)}
        </Button>
      </div>
      <span class="text-[12px] text-text-tertiary">
        {props.secret.help ? `${props.secret.help} ` : ""}
        {i18n.t(`${P}.neverShown`)}
      </span>
      <Show when={error()}>
        <span
          class="text-[12.5px] text-error"
          data-testid={`settings-app-secret-error-${props.secret.key}`}
        >
          {error()}
        </span>
      </Show>
    </form>
  )
}

export const AppSecretsBlock: Component<{ app: string; block: SettingsAppSecretsBlock }> = (
  props,
) => {
  const i18n = useI18n()
  const api = useApi()
  const [read, { refetch }] = createResource(() =>
    api.get<AppSecretsRead>(appSecretsPath(props.app, props.block.connection), {
      suppressGlobalError: true,
    }),
  )
  const [copied, setCopied] = createSignal<string | null>(null)
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(url)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setCopied(null)
    }
  }

  return (
    <div
      class="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
      data-testid={`settings-app-secrets-${props.block.connection}`}
    >
      <Show when={read.error}>
        <span class="text-[12.5px] text-text-secondary" data-testid="settings-app-secrets-error">
          {i18n.t(`${P}.loadFailed`)}
        </span>
      </Show>
      <Show when={read()}>
        {(r) => (
          <>
            <For each={r().webhooks}>
              {(w) => (
                <div class="flex flex-col gap-1">
                  <span class="text-[13px] font-medium">{i18n.t(`${P}.webhookAddress`)}</span>
                  <div class="flex flex-wrap items-center gap-2">
                    <code
                      class="min-w-0 break-all rounded bg-surface-hover px-2 py-1 text-[12px]"
                      data-testid={`settings-app-secrets-webhook-${w.endpoint}`}
                    >
                      {w.url}
                    </code>
                    <Button
                      variant="outline"
                      onClick={() => copy(w.url)}
                      data-testid={`settings-app-secrets-copy-${w.endpoint}`}
                    >
                      {copied() === w.url ? i18n.t(`${P}.copied`) : i18n.t(`${P}.copy`)}
                    </Button>
                  </div>
                  <span class="text-[12px] text-text-tertiary">
                    {i18n.t(`${P}.webhookAddressHint`)}
                  </span>
                </div>
              )}
            </For>
            <For each={r().secrets}>
              {(s) => (
                <SecretField
                  app={props.app}
                  connection={props.block.connection}
                  secret={s}
                  onSaved={() => void refetch()}
                />
              )}
            </For>
          </>
        )}
      </Show>
    </div>
  )
}
