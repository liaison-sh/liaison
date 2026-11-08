// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shipments — master/detail over the search index. The left pane is a dense,
// filterable list (recipient + carrier, with stacked order/tracking badges);
// the right pane is the detail panel: the two status badges, a carrier/cost/
// tracking grid, a tracking timeline, and document links (re-fetched live on
// view via get_documents, never a stored URL). Status badges + document labels
// come from the shared kit so this surface stays pixel-identical to invoicing.
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { app, currentPath } from "@liaison/host"
import { CardTable, type CardTableColumn, createMediaMatch } from "@liaison/app-ui/card-table"
import {
  Button,
  cx,
  documentTypeLabel,
  EmptyState,
  inputClass,
  Money,
  OrderStatusBadge,
  PageHeader,
  SectionLabel,
  Segmented,
  TrackingStatusBadge,
} from "./kit"
import { createDebouncedSearch } from "./debounced-search"
import { loadFileInto, openPreparingTab } from "./file-open"
import { usePathname } from "./sidebar"

// ── Types ────────────────────────────────────────────────────────────────────
interface TrackingEvent {
  status?: string | null
  label?: string | null
  at?: string | null
  location?: string | null
}

interface ShipmentAttributes {
  order_status: string | null
  tracking_status: string | null
  carrier: string | null
  // Declared parcel VALUE (customs/insurance), NOT the carrier shipping cost — see search.ts SearchHit.
  declared_value: number | null
  currency?: string | null
  document_ref: string | null
  /** The linked invoice's number; the id in `document_ref` is never shown. */
  document_number?: string | null
  tracking_number?: string | null
  tracking_events?: TrackingEvent[] | null
}

export interface ShipmentRow {
  id: string
  title: string
  attributes: ShipmentAttributes
}

interface ShipmentDocument {
  type: string
  format: string
}

type StatusFilter = "all" | "in-transit" | "delivered"

const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "in-transit", label: "In transit" },
  { value: "delivered", label: "Delivered" },
]

const STATUS_VALUES: ReadonlySet<string> = new Set(STATUS_OPTIONS.map((o) => o.value))

// Tracking statuses that count as "in transit" for the segmented filter.
const IN_TRANSIT = new Set(["SHIPPED", "IN_TRANSIT", "OUT_FOR_DELIVERY"])

/**
 * The URL is the source of truth for the status filter, exactly as it is for the
 * queue id (see Queues.tsx resolveQueueId). The sidebar's "In transit" and
 * "Delivered" rows navigate to `/boxtal/shipments?status=<filter>`, but this tab
 * is a SINGLETON pinned to the bare `/boxtal/shipments` pattern: nothing
 * re-mounts it and nothing updates its entityId on in-tab navigation. Reading
 * the filter from a plain local signal therefore ignored those links entirely --
 * both rows rendered the unfiltered "All" list, which is what made them look
 * dead. Deriving from the REACTIVE pathname (usePathname) instead makes the
 * links, the segmented control and the back button all agree.
 *
 * Pure so it is unit-testable. An absent or unknown status reads as "all".
 */
export function resolveStatusFilter(pathname: string | undefined): StatusFilter {
  if (!pathname) return "all"
  const search = pathname.split("?")[1]
  if (!search) return "all"
  for (const pair of search.split("&")) {
    const [rawKey, rawValue = ""] = pair.split("=")
    if (rawKey !== "status") continue
    const value = decodeURIComponent(rawValue)
    return STATUS_VALUES.has(value) ? (value as StatusFilter) : "all"
  }
  return "all"
}

/**
 * The path+search a status choice should live at. "all" drops the param rather
 * than writing `?status=all`, so the canonical list URL stays clean and matches
 * the sidebar's "All shipments" href exactly (otherwise that row never lights up
 * as active).
 */
export function shipmentsHrefForStatus(filter: StatusFilter): string {
  return filter === "all" ? "/boxtal/shipments" : `/boxtal/shipments?status=${filter}`
}

/** Classify a row against the segmented filter (pure — unit-testable). */
export function matchesStatusFilter(row: ShipmentRow, filter: StatusFilter): boolean {
  if (filter === "all") return true
  const t = row.attributes.tracking_status ?? ""
  if (filter === "in-transit") return IN_TRANSIT.has(t)
  return t === "DELIVERED"
}

// ── Data ─────────────────────────────────────────────────────────────────────
// Fetchers deliberately do NOT swallow errors: a thrown rejection lands in the
// resource's `.error`, and the surface renders a visible failure state. The old
// `catch { return [] }` made every backend failure indistinguishable from a
// genuinely empty list — an undiagnosable blank page.
async function fetchShipments(query: string): Promise<ShipmentRow[]> {
  const res = await app.invokeTool<{ results: ShipmentRow[] }>("search", { query, limit: 50 })
  return res.results ?? []
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err ?? "Unknown error")
}

async function fetchDocuments(id: string): Promise<ShipmentDocument[]> {
  const res = await app.invokeTool<{ documents: ShipmentDocument[] }>("get_documents", { id })
  return res.documents ?? []
}

/**
 * Resolve which shipment's detail to show: the explicitly-clicked id, else the
 * first visible row (master/detail default), else none. Pure so the component's
 * `effectiveSelectedId` memo + the row highlight stay in sync and it's unit-testable.
 */
export function resolveSelectedShipmentId(
  explicit: string | null,
  visible: ShipmentRow[],
): string | null {
  return explicit ?? visible[0]?.id ?? null
}

// ── Import box ───────────────────────────────────────────────────────────────
// Boxtal's API has no order-list endpoint (v3 or v1) — an account's existing
// order history cannot be enumerated. Shipments created through Liaison appear
// here automatically; anything else is importable only by naming its Boxtal
// order id. This box is that path.
interface ImportSummary {
  imported: number
  updated: number
  failed: number
  rows: Array<{ id: string; outcome: string; message?: string }>
  notice: string
}

const ImportBox: Component<{ onDone: () => void }> = (props) => {
  const [ids, setIds] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<string | null>(null)

  const run = async () => {
    const list = ids().split(/[\s,;]+/).filter(Boolean)
    if (list.length === 0 || busy()) return
    setBusy(true)
    setResult(null)
    try {
      const res = await app.invokeTool<ImportSummary>("import_shipments", { ids: list })
      const firstProblem = res.rows.find((r) => r.message)
      setResult(
        `Imported ${res.imported}, updated ${res.updated}, failed ${res.failed}.` +
          (firstProblem ? ` ${firstProblem.id}: ${firstProblem.message}` : ""),
      )
      if (res.imported + res.updated > 0) props.onDone()
    } catch (err) {
      setResult(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="flex flex-col gap-2 border-b border-border-subtle bg-surface px-4 py-3" data-testid="boxtal-import-box">
      <p class="text-[11px] text-text-tertiary">
        Paste Boxtal order ids (comma or newline separated). Only orders created through this API
        application are fetchable. Boxtal has no API to list web-interface orders.
      </p>
      <div class="flex items-center gap-2">
        <input
          type="text"
          data-testid="boxtal-import-ids"
          class={inputClass}
          placeholder="e.g. 6f9c1e2a-…, 8a41d0b7-…"
          value={ids()}
          onInput={(e) => setIds(e.currentTarget.value)}
        />
        <Button variant="primary" testid="boxtal-import-run" disabled={busy()} onClick={() => void run()}>
          {busy() ? "Importing…" : "Import"}
        </Button>
      </div>
      <Show when={result()}>
        <p class="text-[11px] text-text-secondary" data-testid="boxtal-import-result">{result()}</p>
      </Show>
    </div>
  )
}

// ── Master list ──────────────────────────────────────────────────────────────
export const Shipments: Component = () => {
  const pathname = usePathname()
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [showImport, setShowImport] = createSignal(false)
  // Debounced, never suspending: typing keeps the box focused and the current
  // list on screen while the next search loads (see debounced-search.ts).
  const search = createDebouncedSearch({ fetch: fetchShipments })
  const rows = search.results

  // Derived from the URL, never a local signal -- see resolveStatusFilter.
  const filter = (): StatusFilter => resolveStatusFilter(pathname())

  /** Clicking a segment navigates; the pathname signal then drives `filter`.
   *  pushState (not replaceState) so the browser back button walks the filter
   *  history the way it walks the sidebar links. */
  const setFilter = (next: StatusFilter): void => {
    const href = shipmentsHrefForStatus(next)
    if (currentPath() === href) return
    window.history.pushState({}, "", href)
  }

  const visible = createMemo<ShipmentRow[]>(() => {
    const f = filter()
    return (rows() ?? []).filter((r) => matchesStatusFilter(r, f))
  })

  // Master/detail default: when nothing is explicitly selected, show the FIRST
  // visible shipment's detail (Linear-style) rather than an empty "No shipment
  // selected" panel beside a populated list. Derived (not a signal write in an
  // effect) so the highlight + detail stay in sync; an explicit click still wins.
  const effectiveSelectedId = createMemo<string | null>(() =>
    resolveSelectedShipmentId(selectedId(), visible()),
  )

  // What the agent is told is open: the row the person clicked, still listed. The
  // first row filling the pane by itself is not one. Below the kit's 640 px tier
  // the detail pane is not on screen, so nothing is.
  const hasDetailPane = createMediaMatch("(min-width: 640px)")
  app.trackOpenRecord("shipment", () =>
    hasDetailPane() && selectedId() === effectiveSelectedId() ? selectedId() : null,
  )

  const selected = createMemo<ShipmentRow | null>(() => {
    const id = effectiveSelectedId()
    if (!id) return null
    return (rows() ?? []).find((r) => r.id === id) ?? null
  })

  return (
    <div data-testid="boxtal-shipments" class="flex h-full min-h-0">
      {/* A hard `w-[440px]` is 50 px wider than the phone surface, so the cards'
          money column and status pills were sliced off the right edge. Below the
          kit's 640 px tier the list IS the screen; the detail pane steps aside
          until there is room for both. */}
      <div
        data-testid="boxtal-shipments-list"
        class="flex w-full shrink-0 min-h-0 flex-col border-r border-border-subtle sm:w-[440px]"
      >
        <PageHeader
          title="Shipments"
          count={visible().length}
          testid="boxtal-shipments-header"
          actions={
            <div class="flex items-center gap-2">
              <Segmented
                options={STATUS_OPTIONS}
                value={filter()}
                onChange={setFilter}
                testidPrefix="boxtal-status-filter"
                ariaLabel="Filter shipments by status"
              />
              <Button
                variant="secondary"
                testid="boxtal-import-toggle"
                onClick={() => setShowImport((v) => !v)}
              >
                Import
              </Button>
            </div>
          }
        />
        <Show when={showImport()}>
          <ImportBox onDone={() => search.refetch()} />
        </Show>
        <div class="border-b border-border-subtle px-4 py-2.5">
          <input
            type="search"
            data-testid="boxtal-shipments-search"
            class={inputClass}
            placeholder="Search shipments…"
            value={search.query()}
            onInput={(e) => search.setQuery(e.currentTarget.value)}
          />
        </div>
        <div
          class="min-h-0 flex-1 overflow-auto"
          data-testid="boxtal-shipments-results"
          aria-busy={search.loading()}
        >
          <Show
            when={search.error() === undefined}
            fallback={
              <EmptyState testid="boxtal-shipments-error" title="Couldn't load shipments">
                {errorText(search.error())}
              </EmptyState>
            }
          >
          <Show
            when={rows() !== undefined}
            fallback={
              /* A slow first search must read as LOADING, never as an empty
                 fleet — "No shipments" during a 10 s cold fetch is a lie that
                 sends the operator away (field report 2026-08-04). */
              <EmptyState testid="boxtal-shipments-loading" title="Loading shipments">
                Fetching the shipment index…
              </EmptyState>
            }
          >
          <Show
            when={visible().length > 0}
            fallback={
              <EmptyState testid="boxtal-shipments-empty" title="No shipments">
                Shipments created through Liaison appear here automatically. Boxtal's API cannot
                list orders made in its web interface. Use Import to pull in orders you have the
                Boxtal order id for.
              </EmptyState>
            }
          >
            <div data-testid="boxtal-shipments-table">
              <CardTable
                rows={visible()}
                rowKey={(row) => row.id}
                rowTestid={(row) => `boxtal-shipment-row-${row.id}`}
                onRowClick={(row) => setSelectedId(row.id)}
                columns={shipmentColumns()}
              />
            </div>
          </Show>
          </Show>
          </Show>
        </div>
      </div>

      <div class="hidden min-h-0 flex-1 overflow-auto sm:block">
        <Show
          when={selected()}
          fallback={
            <EmptyState testid="boxtal-shipment-detail-empty" title="No shipment selected">
              Pick a shipment to see tracking + documents.
            </EmptyState>
          }
        >
          {(s) => <ShipmentDetailPanel shipment={s()} />}
        </Show>
      </div>
    </div>
  )

}

/**
 * The Shipments list's columns, exported so the column CONTRACT is testable
 * without a DOM: which columns exist, and which of them must take their own
 * content width instead of being squeezed with the rest.
 */
export function shipmentColumns(): Array<CardTableColumn<ShipmentRow>> {
  return [
    {
      key: "recipient",
      header: "Recipient",
      role: "anchor",
      cell: (row) => <span class="truncate">{row.title}</span>,
    },
    {
      key: "carrier",
      header: "Carrier",
      role: "secondary",
      cell: (row) => row.attributes.carrier ?? "No carrier",
    },
    // VALUE, ORDER AND TRACKING ARE ATOMS. This list lives in a narrow
    // master pane beside the detail panel, and an auto layout table squeezed
    // all five columns alike: a declared value read "918.0" (a different
    // number, not a shorter one) and the two status badges were crushed to
    // nothing, so the list showed two headers over empty cells. `fit` gives
    // each of them its content width and lets the recipient column, which
    // truncates honestly, take the remainder.
    {
      key: "value",
      header: "Value",
      role: "meta",
      numeric: true,
      fit: true,
      align: "right",
      cell: (row) => (
        <Money value={row.attributes.declared_value} currency={row.attributes.currency ?? "EUR"} />
      ),
    },
    {
      key: "order-status",
      header: "Order",
      role: "meta",
      fit: true,
      cell: (row) => (
        <OrderStatusBadge status={row.attributes.order_status} testid={`boxtal-row-order-${row.id}`} />
      ),
    },
    {
      key: "tracking-status",
      header: "Tracking",
      role: "meta",
      fit: true,
      cell: (row) => (
        <TrackingStatusBadge
          status={row.attributes.tracking_status}
          testid={`boxtal-row-tracking-${row.id}`}
        />
      ),
    },
  ]
}

// ── Detail panel ─────────────────────────────────────────────────────────────
export const ShipmentDetailPanel: Component<{ shipment: ShipmentRow }> = (props) => {
  const [docs] = createResource(() => props.shipment.id, fetchDocuments)

  const events = createMemo<TrackingEvent[]>(() => {
    const raw = props.shipment.attributes.tracking_events
    return Array.isArray(raw) ? raw : []
  })

  const isPending = () => props.shipment.attributes.order_status === "PENDING"
  // Never `docs()` in render: that registers the read on the tab's <Suspense>,
  // so every change of shipment (a click, or a search moving the first row)
  // blanked the whole page until the documents came back. `latest` once
  // resolved reads the value without suspending; while the next shipment's
  // documents load, its panel says so instead of showing the previous ones.
  const docList = (): ShipmentDocument[] => (docs.state === "ready" ? (docs.latest ?? []) : [])
  // The label opens as the To prepare queue opens it: print_pack's upright label file, shown by
  // the host when the screen is framed, else in a tab opened inside the click.
  const [docError, setDocError] = createSignal<string | null>(null)
  const openLabel = (): void => {
    setDocError(null)
    const win = openPreparingTab()
    void (async () => {
      try {
        const res = await app.invokeTool<{ label?: { file_id: string } | null; label_error?: string }>(
          "print_pack",
          { shipment_id: props.shipment.id },
        )
        if (res?.label?.file_id) await loadFileInto(res.label.file_id, win, "label")
        else {
          win?.close()
          setDocError(res?.label_error ?? "The label is not available yet.")
        }
      } catch (err) {
        win?.close()
        setDocError(err instanceof Error ? err.message : String(err))
      }
    })()
  }

  return (
    <div data-testid="boxtal-shipment-detail" class="flex min-h-0 flex-col">
      <header class="border-b border-border-subtle px-5 py-4">
        <h2 class="text-[15px] font-semibold text-text">{props.shipment.title}</h2>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <OrderStatusBadge
            status={props.shipment.attributes.order_status}
            testid="boxtal-detail-order-status"
          />
          <TrackingStatusBadge
            status={props.shipment.attributes.tracking_status}
            testid="boxtal-detail-tracking-status"
          />
        </div>
      </header>

      <div class="flex flex-col gap-6 px-5 py-5">
        {/* Summary grid. */}
        <dl class="grid grid-cols-2 gap-x-6 gap-y-4 text-[12.5px]" data-testid="boxtal-detail-grid">
          <div class="flex flex-col gap-1">
            <dt class="text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary">Carrier</dt>
            <dd class="text-text">{props.shipment.attributes.carrier ?? "-"}</dd>
          </div>
          <div class="flex flex-col gap-1">
            <dt class="text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary">Declared value</dt>
            <dd>
              <Money
                value={props.shipment.attributes.declared_value}
                currency={props.shipment.attributes.currency ?? "EUR"}
              />
            </dd>
          </div>
          <div class="flex flex-col gap-1">
            <dt class="text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary">Tracking #</dt>
            <dd class="font-mono tabular-nums text-text" data-testid="boxtal-detail-tracking-number">
              {props.shipment.attributes.tracking_number ?? "-"}
            </dd>
          </div>
          <div class="flex flex-col gap-1">
            <dt class="text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary">Linked invoice</dt>
            <dd class="text-text" data-testid="boxtal-detail-invoice-ref">
              {props.shipment.attributes.document_number ?? "-"}
            </dd>
          </div>
        </dl>

        {/* Tracking timeline. */}
        <section class="flex flex-col gap-2.5" data-testid="boxtal-detail-tracking">
          <SectionLabel>Tracking</SectionLabel>
          <Show
            when={events().length > 0}
            fallback={
              <p class="text-[12px] text-text-tertiary">
                No tracking events yet: the carrier has not scanned this parcel.
              </p>
            }
          >
            <ol class="flex flex-col gap-0">
              <For each={events()}>
                {(ev, i) => (
                  <li
                    data-testid={`boxtal-tracking-event-${i()}`}
                    class="relative flex gap-3 pb-4 pl-4 last:pb-0"
                  >
                    <span class="absolute left-0 top-1 h-1.5 w-1.5 rounded-full bg-accent" />
                    <span
                      class={cx(
                        "absolute left-[2.5px] top-2.5 w-px bg-border-subtle",
                        i() === events().length - 1 ? "h-0" : "h-full",
                      )}
                    />
                    <div class="flex flex-1 flex-col gap-0.5">
                      <span class="text-[12.5px] text-text">
                        {ev.label ?? ev.status ?? "Update"}
                      </span>
                      <span class="text-[11px] text-text-tertiary">
                        {[ev.location, ev.at].filter(Boolean).join(" · ") || "-"}
                      </span>
                    </div>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </section>

        {/* Documents. */}
        <section class="flex flex-col gap-2.5" data-testid="boxtal-detail-documents">
          <SectionLabel>Documents</SectionLabel>
          <Show when={!docs.error} fallback={
            <p class="text-[12px] text-warning" data-testid="boxtal-detail-docs-error">
              Couldn't load documents: {String(docs.error?.message ?? docs.error ?? "Unknown error")}
            </p>
          }>
          <Show
            when={docList().length > 0}
            fallback={
              <Show when={!docs.loading} fallback={
                <p class="text-[12px] text-text-tertiary" data-testid="boxtal-detail-docs-loading">
                  Loading documents…
                </p>
              }>
              <Show
                when={isPending()}
                fallback={
                  <p class="text-[12px] text-text-tertiary">No documents available for this shipment.</p>
                }
              >
                <p class="text-[12px] text-text-tertiary" data-testid="boxtal-detail-docs-generating">
                  Label generating, you'll be notified when it's ready.
                </p>
              </Show>
              </Show>
            }
          >
            <ul class="divide-y divide-border-subtle rounded-lg border border-border-subtle">
              <For each={docList()}>
                {(doc) => (
                  <li class="flex items-center justify-between gap-3 px-3 py-2">
                    <span class="text-[12.5px] text-text">{documentTypeLabel(doc.type)}</span>
                    <Show when={doc.type === "LABEL"}>
                      <Button variant="ghost" testid={`boxtal-doc-${doc.type}`} onClick={openLabel}>
                        Download
                      </Button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <Show when={docError()}>
              <p class="text-[12px] text-warning" data-testid="boxtal-detail-doc-open-error">
                {docError()}
              </p>
            </Show>
          </Show>
          </Show>
        </section>
      </div>
    </div>
  )
}
