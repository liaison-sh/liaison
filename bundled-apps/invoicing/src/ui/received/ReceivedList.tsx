// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Received tab (/invoicing/received): supplier e-invoices received through the e-invoicing
// platform, newest first, one row each (supplier, number, issue and due dates, total with its
// currency, status in words, received date), filtered by status, with a Refresh that checks the
// platform now. Calm: the list's order is the signal; a row carries at most one quiet note.
import { app, navigate } from "@liaison/host"
import { type Component, createEffect, createResource, createSignal, For, Match, on, Show, Switch } from "solid-js"
import { tr } from "../i18n"
import { Button, Segmented } from "../kit"
import { EMPTY_TEXT, FILTERS, listRows, localDateTime, type ReceivedListItem, type ReceivedStatus } from "./view"

interface ListResult {
  status: string
  items: ReceivedListItem[]
  has_more: boolean
  last_refreshed_at: string | null
  can_act?: boolean
  error?: { message?: string }
}

/** One page, or why it could not be read (a failure is never shown as "nothing yet"). */
type Loaded = { ok: true; result: ListResult } | { ok: false; message: string }

export const PAGE_SIZE = 50

async function fetchPage(filter: ReceivedStatus | "all", offset: number): Promise<Loaded> {
  try {
    const res = await app.invokeTool<ListResult>("received_einvoices_list", {
      ...(filter === "all" ? {} : { status: filter }),
      limit: PAGE_SIZE,
      offset,
    })
    if (res && res.status === "ok") return { ok: true, result: res }
    return { ok: false, message: res?.error?.message ?? tr("The received invoices could not be loaded.") }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : tr("The received invoices could not be loaded.") }
  }
}

export const InvoicingReceived: Component<{ entityId?: string }> = () => {
  const [filter, setFilter] = createSignal<ReceivedStatus | "all">("all")
  const [first, { refetch }] = createResource(filter, (f) => fetchPage(f, 0))
  // Later pages, appended by "Show more"; reset whenever the first page is read again.
  const [more, setMore] = createSignal<ReceivedListItem[]>([])
  const [moreHasMore, setMoreHasMore] = createSignal<boolean | null>(null)
  const [loadingMore, setLoadingMore] = createSignal(false)
  createEffect(
    on(first, () => {
      setMore([])
      setMoreHasMore(null)
    }),
  )
  const data = () => {
    const f = first()
    return f && f.ok ? f.result : null
  }
  const loadError = () => {
    const f = first()
    return f && !f.ok ? f.message : null
  }
  const items = () => [...(data()?.items ?? []), ...more()]
  const hasMore = () => moreHasMore() ?? data()?.has_more === true
  const canAct = () => data()?.can_act !== false
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<string | null>(null)

  const showMore = async () => {
    setLoadingMore(true)
    setNote(null)
    try {
      const page = await fetchPage(filter(), items().length)
      if (!page.ok) setNote(page.message)
      else {
        setMore([...more(), ...page.result.items])
        setMoreHasMore(page.result.has_more === true)
      }
    } finally {
      setLoadingMore(false)
    }
  }

  const refresh = async () => {
    setBusy(true)
    setNote(null)
    try {
      const r = await app.invokeTool<{ status: string; ingested?: number; failed?: number; error?: { message?: string } }>("received_einvoices_refresh", {})
      if (r?.status === "error") setNote(r.error?.message ?? tr("The platform could not be reached; try again later."))
      else if ((r?.failed ?? 0) > 0) setNote(tr("Some invoices could not be read from the platform; they are retried automatically."))
    } catch (e) {
      setNote(e instanceof Error ? e.message : tr("The platform could not be reached; try again later."))
    } finally {
      setBusy(false)
      refetch()
    }
  }

  const rows = () => listRows(items())

  return (
    <div data-testid="invoicing-received" class="flex h-full min-h-0 flex-col gap-3 p-5 text-[12.5px]">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-col gap-0.5">
          <h1 class="text-[15px] font-semibold text-text">{tr("Received")}</h1>
          <span class="text-text-tertiary">{tr("Supplier e-invoices received through the e-invoicing platform")}</span>
        </div>
        <div class="flex items-center gap-3">
          <Show when={data()?.last_refreshed_at}>
            <span data-testid="received-last-refreshed" class="text-text-tertiary">
              {tr("Checked {{at}}", { at: localDateTime(data()?.last_refreshed_at) })}
            </span>
          </Show>
          <Show when={canAct()}>
            <Button testid="received-refresh" variant="ghost" disabled={busy()} onClick={() => void refresh()}>
              {busy() ? tr("Checking…") : tr("Refresh")}
            </Button>
          </Show>
        </div>
      </div>
      <div data-testid="received-filter">
        <Segmented
          testidPrefix="received-filter"
          ariaLabel={tr("Status")}
          value={filter()}
          onChange={(v) => setFilter(v)}
          options={FILTERS.map((f) => ({ value: f.value, label: tr(f.label) }))}
        />
      </div>
      <Show when={note()}>
        <div data-testid="received-note" class="text-text-secondary">
          {note()}
        </div>
      </Show>
      <Switch>
        <Match when={loadError()}>
          {(message) => (
            <div data-testid="received-error" class="flex max-w-[60ch] flex-col items-start gap-2 text-text-secondary">
              <span>{tr("The received invoices could not be loaded: {{reason}}", { reason: message() })}</span>
              <Button testid="received-retry" variant="ghost" onClick={() => refetch()}>
                {tr("Try again")}
              </Button>
            </div>
          )}
        </Match>
        <Match when={!first()}>
          <div data-testid="received-loading" class="text-text-tertiary">
            {tr("Loading…")}
          </div>
        </Match>
        <Match when={rows().length === 0}>
          <div data-testid="received-empty" class="max-w-[60ch] text-text-tertiary">
            {filter() === "all" ? tr(EMPTY_TEXT) : tr("No invoice with this status.")}
          </div>
        </Match>
        <Match when={rows().length > 0}>
          <div class="min-h-0 flex-1 overflow-auto">
            <table data-testid="received-table" class="w-full border-collapse">
              <thead>
                <tr class="text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                  <th class="py-1.5 pr-3 font-medium">{tr("Supplier")}</th>
                  <th class="py-1.5 pr-3 font-medium">{tr("Number")}</th>
                  <th class="py-1.5 pr-3 font-medium">{tr("Issued")}</th>
                  <th class="py-1.5 pr-3 font-medium">{tr("Due")}</th>
                  <th class="py-1.5 pr-3 text-right font-medium">{tr("Total incl. tax")}</th>
                  <th class="py-1.5 pr-3 font-medium">{tr("Status")}</th>
                  <th class="py-1.5 font-medium">{tr("Received")}</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(r) => (
                    <tr
                      data-testid={`received-row-${r.id}`}
                      class="cursor-pointer border-t border-border-subtle hover:bg-surface"
                      onClick={() => navigate(`/invoicing/received/${r.id}`)}
                    >
                      <td class="py-2 pr-3 text-text">
                        <div class="font-medium">{r.supplier}</div>
                        <Show when={r.note}>
                          <div data-testid={`received-row-note-${r.id}`} class="text-[11.5px] text-text-tertiary">
                            {r.note}
                          </div>
                        </Show>
                      </td>
                      <td class="py-2 pr-3 text-text-secondary">{r.number}</td>
                      <td class="py-2 pr-3 font-mono tabular-nums text-text-secondary">{r.issued}</td>
                      <td class="py-2 pr-3 font-mono tabular-nums text-text-secondary">{r.due}</td>
                      <td class="py-2 pr-3 text-right font-mono tabular-nums text-text">
                        {r.total}
                        <span class="ml-1 text-text-tertiary">{r.currency}</span>
                      </td>
                      <td data-testid={`received-row-status-${r.id}`} class="py-2 pr-3 text-text-secondary">
                        {r.status}
                      </td>
                      <td class="py-2 font-mono tabular-nums text-text-tertiary">{r.received}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <Show when={hasMore()}>
              <div class="pt-2">
                <Button testid="received-more" variant="ghost" disabled={loadingMore()} onClick={() => void showMore()}>
                  {loadingMore() ? tr("Loading…") : tr("Show more")}
                </Button>
              </div>
            </Show>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
