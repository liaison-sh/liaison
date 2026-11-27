// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Website access", a block of the issuer settings section: the server keys a shop's own website
// lists its signed-in buyers' invoices with (the buyer invoices API). One key reads one issuer
// profile's invoices and credit notes and nothing else. A key is created by a person's click and
// shown once; at most two are active per profile, so a website can move to a new key before the
// old one is revoked. Revoking stops the key and its download links at once.
import { app, fetch as hostFetch } from "@liaison/host"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { tr } from "./i18n"
import { Button, inputClass } from "./kit"

export interface WebsiteKeyRow {
  id: string
  label: string
  key_prefix: string
  created_at: string
  revoked_at: string | null
  last_used_at: string | null
}

interface IssuerOption {
  id: string
  legal_name: string
}

async function loadIssuers(): Promise<IssuerOption[]> {
  try {
    const r = await app.invokeTool<{ items: IssuerOption[] }>("settings_issuer_profile_list", {})
    return r?.items ?? []
  } catch {
    return []
  }
}

/** The active keys first, newest first; revoked keys after them. */
export function sortKeys(rows: readonly WebsiteKeyRow[]): WebsiteKeyRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(a.revoked_at !== null) - Number(b.revoked_at !== null) ||
      b.created_at.localeCompare(a.created_at),
  )
}

export function activeCount(rows: readonly WebsiteKeyRow[]): number {
  return rows.filter((r) => r.revoked_at === null).length
}

function day(v: string | null): string {
  return v ? v.slice(0, 10) : ""
}

const IssuerKeys: Component<{ issuer: IssuerOption }> = (p) => {
  const base = "/api/invoicing/buyer-keys"
  const [keys, { refetch }] = createResource(async () => {
    try {
      const rows = await hostFetch<WebsiteKeyRow[]>(
        `${base}?issuerProfileId=${encodeURIComponent(p.issuer.id)}`,
      )
      return sortKeys(Array.isArray(rows) ? rows : [])
    } catch {
      return null
    }
  })
  const [label, setLabel] = createSignal("")
  const [shown, setShown] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  const create = async () => {
    setError(null)
    try {
      const r = await hostFetch<{ key: string }>(base, {
        method: "POST",
        body: JSON.stringify({
          issuerProfileId: p.issuer.id,
          label: label().trim() || tr("Website"),
        }),
      })
      setShown(r?.key ?? null)
      setLabel("")
      refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("The key was not created."))
    }
  }

  const revoke = async (row: WebsiteKeyRow) => {
    if (
      !window.confirm(
        tr("The website stops reading invoices with this key, and its open links stop working."),
      )
    )
      return
    setError(null)
    try {
      await hostFetch(`${base}/${row.id}/revoke`, { method: "POST" })
      refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("Nothing was changed."))
    }
  }

  return (
    <section class="space-y-2" data-testid={`website-access-${p.issuer.id}`}>
      <p class="text-sm text-[var(--color-text)]">{p.issuer.legal_name}</p>
      <Show
        when={keys() !== null}
        fallback={
          <p class="text-xs text-[var(--color-text-secondary)]">
            {tr("You need the issuer admin permission to see these keys.")}
          </p>
        }
      >
        <For each={keys() ?? []}>
          {(row) => (
            <div class="flex items-center gap-3 text-sm" data-testid={`website-key-${row.id}`}>
              <span class="text-[var(--color-text)]">{row.label}</span>
              <span class="font-mono text-xs text-[var(--color-text-meta)]">{row.key_prefix}…</span>
              <span class="text-xs text-[var(--color-text-meta)]">
                <Show when={row.revoked_at} fallback={`${tr("Created")} ${day(row.created_at)}`}>
                  {`${tr("Revoked")} ${day(row.revoked_at)}`}
                </Show>
              </span>
              <Show when={!row.revoked_at}>
                <Button
                  onClick={() => void revoke(row)}
                  data-testid={`website-key-revoke-${row.id}`}
                >
                  {tr("Revoke")}
                </Button>
              </Show>
            </div>
          )}
        </For>
        <Show when={shown()}>
          {(k) => (
            <div class="space-y-1" data-testid="website-key-shown">
              <p class="text-xs text-[var(--color-text-secondary)]">
                {tr(
                  "Copy this key into your website's server settings now: it is shown only once.",
                )}
              </p>
              <code class="block break-all text-xs text-[var(--color-text)]">{k()}</code>
              <Button onClick={() => setShown(null)}>{tr("Done")}</Button>
            </div>
          )}
        </Show>
        <Show when={activeCount(keys() ?? []) < 2}>
          <div class="flex items-center gap-2">
            <input
              class={inputClass}
              value={label()}
              placeholder={tr("Key name, for example Website")}
              onInput={(e) => setLabel(e.currentTarget.value)}
              data-testid={`website-key-label-${p.issuer.id}`}
            />
            <Button onClick={() => void create()} data-testid={`website-key-create-${p.issuer.id}`}>
              {tr("Create key")}
            </Button>
          </div>
        </Show>
      </Show>
      <Show when={error()}>
        <p class="text-xs text-[var(--color-text-secondary)]">{error()}</p>
      </Show>
    </section>
  )
}

export const InvoicingWebsiteAccess: Component = () => {
  const [issuers] = app.createResource(loadIssuers)
  return (
    <div class="space-y-4" data-testid="invoicing-website-access">
      <div>
        <h3 class="text-sm font-medium text-[var(--color-text)]">{tr("Website access")}</h3>
        <p class="text-xs text-[var(--color-text-secondary)]">
          {tr(
            "Your website's server lists a signed-in buyer's invoices and credit notes with a key. A key reads one issuer profile only.",
          )}
        </p>
      </div>
      <For each={issuers() ?? []}>{(issuer) => <IssuerKeys issuer={issuer} />}</For>
    </div>
  )
}
