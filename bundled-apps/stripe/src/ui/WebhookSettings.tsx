// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Apps > Stripe > Webhook: the address to paste in Stripe, the events to select, whether
// the endpoint's signing secret is saved (yes or no, never the secret), and a write-only field to
// save it. A new secret replaces the old one, which keeps verifying for 24 hours. The read and the
// write are webhook-settings-model.ts; the field is cleared as soon as it is sent.
import { fetch as hostFetch } from "@liaison/host"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { CONTROL } from "./HomeStates"
import { tr, uiLocale } from "./i18n"
import {
  type HostFetchFn,
  loadWebhookSettings,
  saveSigningSecret,
  signingSecretProblem,
} from "./webhook-settings-model"

const PRIMARY = `${CONTROL} border border-transparent bg-accent text-bg hover:bg-accent-hover disabled:opacity-60`
const SECONDARY = `${CONTROL} border border-border bg-surface text-text hover:bg-surface-hover`

const fetchFn: HostFetchFn = (path, init) => hostFetch(path, init)

function untilLabel(iso: string): string {
  return new Date(iso).toLocaleString(uiLocale(), { dateStyle: "medium", timeStyle: "short" })
}

export const StripeWebhookSettings: Component = () => {
  const [settings, { refetch }] = createResource(() => loadWebhookSettings(fetchFn))
  const [value, setValue] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [saved, setSaved] = createSignal<string | null>(null)
  const [copied, setCopied] = createSignal(false)

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  const save = async (e: Event) => {
    e.preventDefault()
    setSaved(null)
    const problem = signingSecretProblem(value())
    if (problem) {
      setError(problem)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const out = await saveSigningSecret(fetchFn, value())
      setValue("")
      setSaved(
        out.rolled
          ? tr("Saved. The previous secret keeps working for 24 hours.")
          : tr("Saved. Stripe deliveries are now verified."),
      )
      await refetch()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : tr("Could not save the secret."))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      class="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 text-[13px]"
      data-testid="stripe-webhook-settings"
    >
      <Show when={settings.error}>
        <p class="text-text-secondary" data-testid="stripe-webhook-load-error">
          {tr("Could not read the webhook settings.")}
        </p>
      </Show>
      <Show when={settings()}>
        {(s) => (
          <>
            <div class="flex flex-col gap-1">
              <span class="font-medium">{tr("Endpoint URL")}</span>
              <Show
                when={s().address}
                fallback={
                  <span class="text-text-secondary">{tr("This server names no address yet.")}</span>
                }
              >
                {(address) => (
                  <div class="flex flex-wrap items-center gap-2">
                    <code
                      class="min-w-0 break-all rounded bg-surface-hover px-2 py-1 text-[12px]"
                      data-testid="stripe-webhook-address"
                    >
                      {address()}
                    </code>
                    <button
                      type="button"
                      class={SECONDARY}
                      data-testid="stripe-webhook-copy"
                      onClick={() => copy(address())}
                    >
                      {copied() ? tr("Copied") : tr("Copy")}
                    </button>
                  </div>
                )}
              </Show>
              <span class="text-text-secondary">
                {tr("In Stripe: Developers, Webhooks, Add endpoint. Paste this address.")}
              </span>
            </div>

            <details class="flex flex-col gap-1" data-testid="stripe-webhook-events">
              <summary class="cursor-pointer font-medium">
                {tr("Events to select ({{count}})", { count: s().events.length })}
              </summary>
              <ul class="mt-1 grid gap-0.5 font-mono text-[12px] md:grid-cols-2">
                <For each={s().events}>{(ev) => <li>{ev}</li>}</For>
              </ul>
            </details>

            <form class="flex flex-col gap-2" onSubmit={save}>
              <label class="font-medium" for="stripe-webhook-secret">
                {tr("Webhook signing secret")}
              </label>
              <span class="text-text-secondary" data-testid="stripe-webhook-secret-state">
                {s().secretSet ? tr("Set.") : tr("Not set yet.")}
                <Show when={s().previousUntil}>
                  {(until) => (
                    <>
                      {" "}
                      {tr("The previous secret keeps working until {{until}}.", {
                        until: untilLabel(until()),
                      })}
                    </>
                  )}
                </Show>
              </span>
              <div class="flex flex-wrap items-center gap-2">
                <input
                  id="stripe-webhook-secret"
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  class="min-h-11 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-[13px] md:min-h-8"
                  placeholder="whsec_…"
                  value={value()}
                  onInput={(e) => setValue(e.currentTarget.value)}
                  data-testid="stripe-webhook-secret-input"
                />
                <button
                  type="submit"
                  class={PRIMARY}
                  disabled={saving() || value().trim() === ""}
                  data-testid="stripe-webhook-secret-save"
                >
                  {s().secretSet ? tr("Replace") : tr("Save")}
                </button>
              </div>
              <span class="text-text-secondary">
                {tr(
                  "On the endpoint in Stripe, reveal its Signing secret and paste it here. It is never shown again, here or to the agent.",
                )}
              </span>
              <Show when={error()}>
                <span class="text-error" data-testid="stripe-webhook-secret-error">
                  {error()}
                </span>
              </Show>
              <Show when={saved()}>
                <span data-testid="stripe-webhook-secret-saved">{saved()}</span>
              </Show>
            </form>
          </>
        )}
      </Show>
    </div>
  )
}
