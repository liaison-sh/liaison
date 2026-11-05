// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Deferred tab (/invoicing/deferred, the sidebar's "Deferred" row): Shopify orders whose
// invoice did not issue automatically, with why. A TAX REVIEW park never clears on its own, so its
// row offers the two decisions `deferred_tax_override` takes; both are gated, so a click files an
// approval and the row says so.

import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { app } from "@liaison/host"
import { tr } from "./i18n"
import { Button } from "./kit"

export interface DeferredItem {
  id: string
  status: string
  reason: string | null
  order_id: string | null
  order_number: string | null
  resolution_options?: Array<"shopify_reported" | "as_computed">
}

/** Open parks only, tax reviews first (they wait for a person; the rest retry on their own). */
export function visibleDeferredItems(items: DeferredItem[]): DeferredItem[] {
  const open = items.filter((i) => i.status !== "resolved" && i.status !== "permanent_failure")
  return [...open].sort(
    (a, b) => Number(!!b.resolution_options?.length) - Number(!!a.resolution_options?.length),
  )
}

/** The note a tax override click leaves on its row. */
export function taxOverrideNote(result: unknown): { text: string; isError: boolean } {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>
    if ("blocked" in r || r.status === "pending_approval") {
      return { text: tr("Sent for approval."), isError: false }
    }
    if (r.status === "error") {
      const e = r.error as { message?: string; code?: string } | undefined
      return { text: e?.message ?? e?.code ?? tr("The action failed."), isError: true }
    }
  }
  return { text: tr("Issued."), isError: false }
}

async function loadDeferred(): Promise<DeferredItem[]> {
  const res = await app.invokeTool<{ items: DeferredItem[] }>("deferred_list", { limit: 200 })
  return visibleDeferredItems(res?.items ?? [])
}

export const InvoicingDeferred: Component<{ entityId?: string }> = () => {
  const [items, { refetch }] = createResource(loadDeferred)
  const [notes, setNotes] = createSignal<Record<string, { text: string; isError: boolean }>>({})

  const decide = async (id: string, mode: "shopify_reported" | "as_computed") => {
    let note: { text: string; isError: boolean }
    try {
      note = taxOverrideNote(await app.invokeTool<unknown>("deferred_tax_override", { deferred_id: id, mode }))
    } catch (e) {
      note = { text: e instanceof Error ? e.message : tr("The action failed."), isError: true }
    }
    setNotes({ ...notes(), [id]: note })
    refetch()
  }

  return (
    <div data-testid="invoicing-deferred" class="flex flex-col gap-3 p-5">
      <h1 class="text-[15px] font-semibold text-text">{tr("Deferred")}</h1>
      <Show
        when={(items() ?? []).length > 0}
        fallback={<div class="text-[12.5px] text-text-tertiary">{tr("Nothing is waiting.")}</div>}
      >
        <ul class="flex flex-col gap-2">
          <For each={items()}>
            {(item) => (
              <li
                data-testid={`deferred-row-${item.id}`}
                class="flex flex-col gap-1.5 rounded-md border border-border-subtle bg-surface px-4 py-3 text-[12.5px]"
              >
                <div class="flex items-center gap-2">
                  <span class="font-medium text-text">
                    {tr("Order")} {item.order_number ?? item.order_id ?? "?"}
                  </span>
                  <span class="text-text-tertiary">{item.reason ?? item.status}</span>
                </div>
                <Show when={item.resolution_options?.length}>
                  <div class="text-text-secondary">
                    {tr("Its tax needs a decision before the invoice can be issued.")}
                  </div>
                  <div class="flex gap-2">
                    <Button onClick={() => void decide(item.id, "shopify_reported")}>
                      {tr("Issue with Shopify's tax")}
                    </Button>
                    <Button onClick={() => void decide(item.id, "as_computed")}>
                      {tr("Issue as computed")}
                    </Button>
                  </div>
                </Show>
                <Show when={notes()[item.id]}>
                  {(n) => (
                    <div class={n().isError ? "text-error" : "text-text-secondary"}>{n().text}</div>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
