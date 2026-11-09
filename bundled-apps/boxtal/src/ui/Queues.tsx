// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Queues: the shipping worklist, ONE page (ticket-10508).
//
// An order goes from To prepare (no label yet), to Label bought, to Packed and fulfilled, on the
// same page, with its state on every row and a filter on top. The two halves:
//
// (A) To prepare: the order-prep grid (PrepGrid.tsx), orders that still need a label.
//
// (B) Ready to ship: every bought label the carrier has not collected yet, the print station.
//     Print label + invoice, tick the parcel packed (which fulfils the Shopify order), or attach
//     the pair to a ticket reply.
//
// The retired /boxtal/queue/to-prepare and /boxtal/queue/ready routes open this same page with
// their filter preset.
//
// Both surfaces compose ONLY the shared Boxtal kit (kit.tsx) and style with the
// kernel's charcoal theme tokens, so they read pixel-for-pixel like invoicing.
import { type Component, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js"
import { app, currentPath } from "@liaison/host"
import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import { ConfirmDialog } from "@liaison/app-ui/kit"
import { PrintDocuments } from "@liaison/app-ui/print-documents"
import {
  Button,
  CategoryBadge,
  cx,
  EmptyState,
  formatQueueDate,
  formatQueueParcels,
  formatQueueTimestamp,
  formatWeight,
  Money,
  OrderStatusBadge,
  PageHeader,
} from "./kit"
import { loadFileInto, openPreparingTab } from "./file-open"
import { PrepGrid } from "./PrepGrid"
import { keepUnchangedRows, rowTintClass } from "./prep-row-logic"
import { usePathname } from "./sidebar"
import { countryName, countryOptions, matchesCountry, nextCountrySort, sortByCountry } from "./country"
import {
  packedToggleAction,
  READY_STATE_LABELS,
  readyRowClass,
  readyRowMatches,
  readyRowState,
  WORKLIST_FILTERS,
  type WorklistFilter,
  worklistFilterCounts,
  worklistSections,
  worklistFilterForRoute,
} from "./worklist-logic"

// ── Icons (inline, theme-colored via currentColor) ────────────────────────────
const PrinterIcon: Component = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="6 9 6 2 18 2 18 9" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <rect x="6" y="14" width="12" height="8" />
  </svg>
)

const PaperclipIcon: Component = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
)

/** The attention mark's glyph: a triangle, the one shape that already means "check this". */
const AlertIcon: Component = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
)

const InboxIcon: Component = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
    <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
)

/** The packed mark, OFF: the operator's own box-with-a-check artwork, empty. Drawn in
 *  currentColor (the source SVG's hard-coded hex fills are dropped) so the charcoal theme
 *  drives the colour: muted here, success green once the row is packed. */
const PackedOffIcon: Component = () => (
  <svg width="13" height="13" viewBox="0 0 255.12 255.1" fill="currentColor" aria-hidden="true">
    <path d="M181.28,247.92H16.19c-4.96,0-9.01-2.76-9.01-8.09V70.45S67.59,9.64,67.59,9.64c1.2-1.21,3.72-2.06,5.65-2.46l167.52.05c4.1,0,7.16,4.16,7.16,7.99v169.64s-60.39,60.57-60.39,60.57c-1.3,1.31-3.53,2.02-6.26,2.49ZM98.31,71.36l47.69-48.18-68.79-.11-47.93,48.27,69.03.02ZM178.18,71.34l48.21-48.19-68.97-.04-48.01,48.21,68.77.03ZM183.8,225.83l48.05-47.82-.07-148.81-48.07,47.8.09,148.83ZM23.24,79.37v152.61h152.5V79.37H23.24Z" />
    <path d="M159.81,155.62c0,33.28-26.98,60.25-60.25,60.25s-60.25-26.98-60.25-60.25,26.98-60.25,60.25-60.25,60.25,26.98,60.25,60.25ZM143.55,155.83c0-24.43-19.8-44.23-44.23-44.23s-44.23,19.8-44.23,44.23,19.8,44.23,44.23,44.23,44.23-19.8,44.23-44.23Z" />
    <path d="M89.22,174.84l-12.81-12.43c-1.06-1.02-1.24-4.02-.47-5.19s4.74-2.03,5.89-.88l9.77,9.75,24.62-24.92c1.51-1.53,3.9-2.45,5.75-1.56,1.64.79,2.49,4.81,1.04,6.26l-28.64,28.68c-.94.94-4.14,1.3-5.16.31Z" />
  </svg>
)

/** The packed mark, ON: the same artwork with the carton FILLED, so a packed row reads as done
 *  from across the bench. The fill rides on currentColor at low opacity, which is what lets the
 *  theme's success token colour the whole glyph. */
const PackedOnIcon: Component = () => (
  <svg width="13" height="13" viewBox="0 0 255.12 255.1" fill="currentColor" aria-hidden="true">
    <path fill-opacity="0.3" d="M181.28,247.92H16.19c-4.96,0-9.01-2.76-9.01-8.09V70.45S67.59,9.64,67.59,9.64c1.2-1.21,3.72-2.06,5.65-2.46l167.52.05c4.1,0,7.16,4.16,7.16,7.99v169.64s-60.39,60.57-60.39,60.57c-1.3,1.31-3.53,2.02-6.26,2.49Z" />
    <path d="M181.28,247.92H16.19c-4.96,0-9.01-2.76-9.01-8.09V70.45S67.59,9.64,67.59,9.64c1.2-1.21,3.72-2.06,5.65-2.46l167.52.05c4.1,0,7.16,4.16,7.16,7.99v169.64s-60.39,60.57-60.39,60.57c-1.3,1.31-3.53,2.02-6.26,2.49ZM98.31,71.36l47.69-48.18-68.79-.11-47.93,48.27,69.03.02ZM178.18,71.34l48.21-48.19-68.97-.04-48.01,48.21,68.77.03ZM183.8,225.83l48.05-47.82-.07-148.81-48.07,47.8.09,148.83ZM23.24,79.37v152.61h152.5V79.37H23.24Z" />
    <path d="M159.81,155.62c0,33.28-26.98,60.25-60.25,60.25s-60.25-26.98-60.25-60.25,26.98-60.25,60.25-60.25,60.25,26.98,60.25,60.25ZM143.55,155.83c0-24.43-19.8-44.23-44.23-44.23s-44.23,19.8-44.23,44.23,19.8,44.23,44.23,44.23,44.23-19.8,44.23-44.23Z" />
    <path d="M89.22,174.84l-12.81-12.43c-1.06-1.02-1.24-4.02-.47-5.19s4.74-2.03,5.89-.88l9.77,9.75,24.62-24.92c1.51-1.53,3.9-2.45,5.75-1.56,1.64.79,2.49,4.81,1.04,6.26l-28.64,28.68c-.94.94-4.14,1.3-5.16.31Z" />
  </svg>
)

// ── (B) Ready-to-ship ───────────────────────────────────────────────────────────
interface ReadyRow {
  id: string
  recipient: string
  carrier: string
  tracking_number: string
  cost: number
  order_status: string
  has_label: boolean
  invoice_ref: string
  /** Boxtal's shipment reference, shown while no carrier tracking number exists yet. */
  shipment_ref: string | null
  /** ISO-2 country of the recipient (buy-time snapshot). */
  destination: string | null
  /** The label was read and gave no number we could accept: an operator confirms it. */
  tracking_to_confirm?: boolean
  /** The operator's status on the order (on_hold tints the whole row red, as on the prep grid). */
  status: "to_prepare" | "validated" | "on_hold" | null
  /** The packer's bench mark: this parcel is boxed and waiting for the carrier pickup. Greys the
   *  row out, so what is left to do stands out from what is done. Packed is not shipped. */
  packed: boolean
  /** When it was packed, kept so the mark carries its own history. Null while still to do. */
  packed_at: string | null
  /** The Shopify fulfillment of the parcel (fulfilled, pending_approval, failed, cancelled). */
  fulfillment_state: string | null
  /** Why the last fulfillment attempt failed, shown on the row. */
  fulfillment_error: string | null
  /** Extra paperwork this parcel needs, from the data-driven attention rules. Null when none. */
  attention: {
    rules: string[]
    documents: Array<{ name: string; note?: string | null; template_id?: string | null }>
    knowledge_refs: string[]
    summary: string
  } | null
  /** The org's document templates this parcel needs (kernel document rules): pre-ticked and
   *  badged in the row's Print documents control. Absent on an older server. */
  needed_template_ids?: string[]
  /** Everything every Boxtal worklist shows about a parcel: request time, order, category,
   *  units, weight, cartons. Rendered by the shared QueueFactCells (kit.tsx) so this list and
   *  Returns cannot drift apart. */
  requested_at: string | null
  order_name: string | null
  order_created_at: string | null
  category: string | null
  items: number | null
  products: string | null
  weight: number | null
  package_count: number | null
  parcels: Array<{ length: number; width: number; height: number; weight: number }>
}

// Same no-swallow discipline as fetchToPrepare — errors surface, not blank out.
async function fetchReady(): Promise<ReadyRow[]> {
  const res = await app.invokeTool<{ rows: ReadyRow[] }>("ready_list", {})
  return res.rows ?? []
}

// ── Batch print: the same two jobs, merged one document per job ──────────────
interface PrintPackBatchToolResult {
  labels: { file_id: string; filename: string; shipment_count: number } | null
  invoices: { file_id: string; filename: string; shipment_count: number; page_copies: number } | null
  skipped: Array<{ shipment_id: string; what: string; reason: string }>
  error?: { code: string; message: string }
}

/** Operator-facing status line for a batch run. Names both documents and what was left out, so a
 *  row whose label is not ready cannot be discovered at the packing bench. Pure (unit-tested).
 *  No dash punctuation. */
export function printPackBatchSummary(res: PrintPackBatchToolResult): string {
  if (res.error) return res.error.message
  const parts: string[] = []
  parts.push(
    res.labels
      ? `Labels: ${res.labels.shipment_count} in one document (label printer)`
      : "Labels: none available",
  )
  parts.push(
    res.invoices
      ? `Invoices: ${res.invoices.shipment_count} in one document, ${res.invoices.page_copies} ${res.invoices.page_copies === 1 ? "copy" : "copies"} on A4`
      : "Invoices: none available",
  )
  if (res.skipped.length > 0) {
    const rows = new Set(res.skipped.map((s) => s.shipment_id))
    parts.push(`${rows.size} ${rows.size === 1 ? "row" : "rows"} incomplete: ${res.skipped[0]!.reason}`)
  }
  return `${parts.join(". ")}.`
}

// ── Print pack: TWO separate print jobs, never one combined PDF ──────────────
interface PrintPackToolResult {
  label: { file_id: string; filename: string } | null
  label_error?: string
  invoice: { file_id: string | null; copies: 1 | 3; reason: "eu_or_domestic" | "export_non_eu" }
  invoice_error?: string
  error?: { code: string; message: string }
}

/** Operator-facing status line for a print-pack run. Names BOTH jobs and the
 *  invoice copy count so the print station knows what to load where. Pure
 *  (unit-tested in ui-logic.test.tsx). No dash punctuation. */
export function printPackSummary(res: PrintPackToolResult): string {
  if (res.error) return res.error.message
  const labelPart = res.label ? "Label: opened (label printer)" : `Label: ${res.label_error ?? "not ready"}`
  const invoicePart = res.invoice.file_id
    ? `Invoice: opened, print ${res.invoice.copies} ${res.invoice.copies === 1 ? "copy" : "copies"} on A4 (${res.invoice.reason === "export_non_eu" ? "export outside EU" : "EU or domestic"})`
    : `Invoice: ${res.invoice_error ?? "unavailable"}`
  return `${labelPart}. ${invoicePart}.`
}

export const ReadyToShip: Component<{
  /** The worklist filter (all rows when absent). */
  filter?: WorklistFilter
  /** Called with every row loaded, so the worklist header can count them. */
  onRows?: (rows: ReadyRow[]) => void
  /** Reset the worklist filter (the "clear filters" action of an empty filtered list). */
  onClearFilter?: () => void
}> = (props) => {
  // A refresh (window focus, the minute timer, the host's resync) keeps every unchanged row's
  // object, so the table updates in place instead of rebuilding every row.
  // The previous rows are read after the await: the first call runs inside createResource itself.
  const [rows, { mutate, refetch }] = app.createResource(async () => {
    const fresh = await fetchReady()
    return keepUnchangedRows(latestRows(), fresh, (r) => r.id)
  })
  // `.latest`, never `rows()`: the accessor re-suspends the tab's <Suspense> on every refetch, so
  // each background refresh blanked the whole worklist (both halves) and dropped its scroll.
  // HostResource's TS shape omits `.latest`; the runtime object is a Solid resource (PrepGrid
  // reads it the same way). A failed plain resource throws from `.latest`: read as no rows.
  const readLatest = (): ReadyRow[] | undefined => {
    try {
      return (rows as unknown as { latest?: ReadyRow[] }).latest
    } catch {
      return undefined
    }
  }
  const latestRows = (): ReadyRow[] | undefined => untrack(readLatest)
  const all = (): ReadyRow[] => readLatest() ?? []
  // Country filter and sort: the queue's own order (oldest request first) until the operator
  // sorts by country; ties keep that order.
  const [country, setCountry] = createSignal("")
  const [countrySort, setCountrySort] = createSignal<"asc" | "desc" | null>(null)
  const list = (): ReadyRow[] =>
    sortByCountry(
      all().filter((r) => readyRowMatches(r, props.filter ?? "all") && matchesCountry(r.destination, country())),
      (r) => r.destination,
      countrySort(),
    )
  createEffect(() => props.onRows?.(all()))
  // A label bought from the To prepare grid above lands here without a page reload: refresh when
  // the operator comes back to the tab and once a minute while it is visible. One bounded read.
  onMount(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") void refetch()
    }
    window.addEventListener("focus", refresh)
    const timer = setInterval(refresh, 60_000)
    onCleanup(() => {
      window.removeEventListener("focus", refresh)
      clearInterval(timer)
    })
  })
  // Per-row print-pack status line ("Label: opened. Invoice: print 3 copies...").
  const [packStatus, setPackStatus] = createSignal<Record<string, string>>({})
  const [packBusy, setPackBusy] = createSignal<Record<string, boolean>>({})
  // Per-row in-flight guard for the packed toggle, so a row cannot be double written while its
  // own write is still out. Keyed by row id: only THAT button is disabled, never the queue.
  const [packedBusy, setPackedBusy] = createSignal<Record<string, boolean>>({})

  /**
   * Patch ONE row in the loaded list, leaving every other row object referentially identical so
   * the table re-renders that row alone. The same rule prep-row-logic's `mutationPlan` encodes for
   * the prep grid: a ROW ACTION PATCHES ONE ROW, it never re-lists the queue. Re-running
   * ready_list here would re-read every shipment, re-resolve the attention rules and reflow the
   * table under the operator's hand for what is a one-field toggle.
   */
  const patchReadyRow = (id: string, patch: Partial<ReadyRow>): void => {
    const current = latestRows()
    if (!current) return
    mutate(current.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  /**
   * The packed toggle. Ticking FULFILS the Shopify order, so it is not optimistic: the row only
   * turns packed (and green) once the server says the fulfillment succeeded. A failure leaves the
   * box unticked and puts the reason on the row. Unticking a fulfilled row asks first, then
   * cancels the Shopify fulfillment; a refused cancellation leaves the row ticked.
   */
  // Unticking a fulfilled row asks in the app's own dialog (a framed screen has no
  // browser confirm: the sandbox gives it no modal dialogs).
  const [unpackAsk, setUnpackAsk] = createSignal<{ row: ReadyRow; message: string } | null>(null)
  const togglePacked = async (row: ReadyRow, confirmed = false) => {
    if (packedBusy()[row.id] === true) return
    const action = packedToggleAction(row)
    if (action.kind === "confirm_unpack" && !confirmed) {
      setUnpackAsk({ row, message: action.message })
      return
    }
    setPackedBusy((m) => ({ ...m, [row.id]: true }))
    setPackStatus((m) => ({ ...m, [row.id]: "" }))
    try {
      const res = await app.invokeTool<{
        shipment_id: string
        packed: boolean
        packed_at: string | null
        fulfillment_state: string | null
        fulfillment_error: string | null
        tracking_number: string | null
        notice?: string
        error?: { code: string; message: string }
      }>("ready_set_packed", {
        shipment_id: row.id,
        packed: action.kind === "pack",
        ...(action.kind === "confirm_unpack" ? { confirm_unfulfill: true } : {}),
      })
      // Land the server's state whatever happened: on a refusal it is the unchanged row plus the
      // reason, so the box shows what is true, never what was clicked.
      patchReadyRow(row.id, {
        packed: res.packed,
        packed_at: res.packed_at,
        fulfillment_state: res.fulfillment_state ?? null,
        fulfillment_error: res.error ? res.error.message : (res.fulfillment_error ?? null),
        ...(res.tracking_number ? { tracking_number: res.tracking_number } : {}),
      })
      if (res.notice) setPackStatus((m) => ({ ...m, [row.id]: res.notice as string }))
    } catch (err) {
      patchReadyRow(row.id, {
        fulfillment_error: `Not saved: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      setPackedBusy((m) => ({ ...m, [row.id]: false }))
    }
  }

  // ── Batch print (ticket-10505) ─────────────────────────────────────────────
  // Selection lives in the component, not the URL: it is a transient "these ones now", and a
  // selection that survived a reload would be a selection the operator did not make.
  const [selected, setSelected] = createSignal<Record<string, boolean>>({})
  const selectedIds = (): string[] => list().map((r) => r.id).filter((id) => selected()[id])
  const allSelected = (): boolean => list().length > 0 && selectedIds().length === list().length
  const toggleRow = (id: string) => setSelected((m) => ({ ...m, [id]: !m[id] }))
  const toggleAll = () => {
    const next = !allSelected()
    setSelected(next ? Object.fromEntries(list().map((r) => [r.id, true])) : {})
  }
  const [batchBusy, setBatchBusy] = createSignal(false)
  const [batchStatus, setBatchStatus] = createSignal<string | null>(null)

  const runBatchPrint = async () => {
    const ids = selectedIds()
    if (ids.length === 0) return
    // Pre-open both tabs inside the click gesture so the popup blocker allows them, exactly as
    // the per-row print does; navigate them once the merge resolves.
    const labelWin = openPreparingTab()
    const invoiceWin = openPreparingTab()
    setBatchBusy(true)
    setBatchStatus(null)
    try {
      const res = await app.invokeTool<PrintPackBatchToolResult>("print_pack_batch", {
        shipment_ids: ids,
      })
      if (res.labels?.file_id) await loadFileInto(res.labels.file_id, labelWin, "labels")
      else labelWin?.close()
      if (res.invoices?.file_id) await loadFileInto(res.invoices.file_id, invoiceWin, "invoices")
      else invoiceWin?.close()
      setBatchStatus(printPackBatchSummary(res))
    } catch (err) {
      labelWin?.close()
      invoiceWin?.close()
      setBatchStatus(`Batch print failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBatchBusy(false)
    }
  }

  const runPrintPack = async (row: ReadyRow) => {
    // Pre-open BOTH tabs synchronously (still inside the click gesture) so the
    // popup-blocker allows them; navigate them once print_pack resolves.
    const labelWin = openPreparingTab()
    const invoiceWin = openPreparingTab()
    setPackBusy((m) => ({ ...m, [row.id]: true }))
    try {
      const res = await app.invokeTool<PrintPackToolResult>("print_pack", { shipment_id: row.id })
      // TWO SEPARATE openings — one per print job. Never a combined document:
      // the label goes to the self-adhesive label printer, the invoice to A4.
      if (res.label?.file_id) await loadFileInto(res.label.file_id, labelWin, "label")
      else labelWin?.close()
      if (res.invoice?.file_id) await loadFileInto(res.invoice.file_id, invoiceWin, "invoice")
      else invoiceWin?.close()
      setPackStatus((m) => ({ ...m, [row.id]: printPackSummary(res) }))
    } catch (err) {
      labelWin?.close()
      invoiceWin?.close()
      setPackStatus((m) => ({
        ...m,
        [row.id]: `Print pack failed: ${err instanceof Error ? err.message : String(err)}`,
      }))
    } finally {
      setPackBusy((m) => ({ ...m, [row.id]: false }))
    }
  }

  // Retrieve + open ONE document (the individual Label / Invoice row buttons).
  // print_pack prepares both (normalized label + route-copy invoice); we open
  // only the requested one. The tab is pre-opened in the gesture (popup-safe),
  // so this works even while `has_label` is a stale cache — retrieval is live.
  const retrieveDoc = async (row: ReadyRow, which: "label" | "invoice") => {
    const win = openPreparingTab()
    setPackBusy((m) => ({ ...m, [row.id]: true }))
    try {
      const res = await app.invokeTool<PrintPackToolResult>("print_pack", { shipment_id: row.id })
      const fileId = which === "label" ? res.label?.file_id : res.invoice?.file_id
      if (!fileId) {
        win?.close()
        throw new Error(
          which === "label" ? (res.label_error ?? "label not ready") : (res.invoice_error ?? "invoice unavailable"),
        )
      }
      await loadFileInto(fileId, win, which)
      setPackStatus((m) => ({ ...m, [row.id]: printPackSummary(res) }))
    } catch (err) {
      win?.close()
      setPackStatus((m) => ({
        ...m,
        [row.id]: `${which === "label" ? "Label" : "Invoice"} failed: ${err instanceof Error ? err.message : String(err)}`,
      }))
    } finally {
      setPackBusy((m) => ({ ...m, [row.id]: false }))
    }
  }

  return (
    <div data-testid="boxtal-ready-to-ship" class="flex h-full min-h-0 flex-col">
      <ConfirmDialog
        open={unpackAsk() !== null}
        title="Untick this order?"
        body={unpackAsk()?.message ?? ""}
        confirmLabel="Untick"
        danger
        testid="boxtal-unpack-confirm"
        cancelTestid="boxtal-unpack-cancel"
        onCancel={() => setUnpackAsk(null)}
        onConfirm={() => {
          const ask = unpackAsk()
          setUnpackAsk(null)
          if (ask) void togglePacked(ask.row, true)
        }}
      />
      <PageHeader
        title="Ready to ship"
        count={list().length}
        subtitle="Oldest request first: print, pack, tick to fulfil the order"
      />
      {/* Batch bar: only there when something is selected, so the resting screen is unchanged. */}
      <Show when={selectedIds().length > 0}>
        <div
          data-testid="boxtal-ready-batch-bar"
          class="flex items-center gap-3 border-b border-border bg-surface px-4 py-2 text-[12.5px]"
        >
          <span class="text-text">
            {selectedIds().length} selected
          </span>
          <Button
            variant="primary"
            testid="boxtal-ready-batch-print"
            disabled={batchBusy()}
            title="Print the selection as two documents: every label in one, every invoice in one"
            onClick={() => void runBatchPrint()}
          >
            <PrinterIcon />
            <span>{batchBusy() ? "Preparing" : `Print ${selectedIds().length} packs`}</span>
          </Button>
          <Button variant="ghost" testid="boxtal-ready-batch-clear" onClick={() => setSelected({})}>
            Clear
          </Button>
          <Show when={batchStatus()}>
            <span class="text-text-secondary">{batchStatus()}</span>
          </Show>
        </div>
      </Show>
      <Show
        when={!rows.error}
        fallback={
          <EmptyState icon={<InboxIcon />} title="Couldn't load queue" testid="boxtal-ready-error">
            {String(rows.error?.message ?? rows.error ?? "Unknown error")}
          </EmptyState>
        }
      >
      <Show
        when={all().length > 0}
        fallback={
          <EmptyState icon={<InboxIcon />} title="Nothing ready" testid="boxtal-ready-empty">
            Shipments with a bought label will appear here, ready for the print station.
          </EmptyState>
        }
      >
        <div class="flex-1 overflow-auto" data-testid="boxtal-ready-table">
          {/* Select-all lives above the table (CardTable's header cells are plain
              strings, not JSX) but keeps its original testid and behavior. */}
          <Show when={list().length > 0}>
          <label class="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-[11px] text-text-secondary">
            <input
              type="checkbox"
              data-testid="boxtal-ready-select-all"
              aria-label="Select every row"
              title="Select rows to print as one batch"
              checked={allSelected()}
              onChange={toggleAll}
            />
            Select all
          </label>
          </Show>
          <div class="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5 text-[11px] text-text-secondary">
            <select
              data-testid="boxtal-ready-country-filter"
              aria-label="Filter by country"
              class="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px]"
              value={country()}
              onChange={(e) => setCountry(e.currentTarget.value)}
            >
              <option value="">All countries</option>
              <For each={countryOptions(all().map((r) => r.destination))}>
                {(c) => (
                  <option value={c} title={countryName(c)}>
                    {c}
                  </option>
                )}
              </For>
            </select>
            <button
              type="button"
              data-testid="boxtal-ready-sort-country"
              data-active={countrySort() ?? undefined}
              title="Sort by country"
              class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 uppercase tracking-wider hover:bg-surface-hover hover:text-text"
              classList={{ "text-text": countrySort() !== null }}
              onClick={() => setCountrySort((cur) => nextCountrySort(cur))}
            >
              <span>Country</span>
              <span aria-hidden="true" class="font-mono text-[9px]" classList={{ "opacity-40": countrySort() === null }}>
                {countrySort() === "desc" ? "▼" : "▲"}
              </span>
            </button>
          </div>
          <Show
            when={list().length > 0}
            fallback={
              <EmptyState icon={<InboxIcon />} title="No rows match these filters" testid="boxtal-ready-no-match">
                <Button
                  variant="ghost"
                  testid="boxtal-ready-clear-filters"
                  onClick={() => {
                    setCountry("")
                    props.onClearFilter?.()
                  }}
                >
                  Clear filters
                </Button>
              </EmptyState>
            }
          >
          <CardTable
            rows={list()}
            rowKey={(row) => row.id}
            columns={readyColumns()}
            // State marker on the row itself, the way the hand written table carried it: a packed
            // parcel must be readable as done from the row, not only from its toggle.
            rowAttrs={(row) => ({
              // Defensive: a row from an older server build carries no `packed` at all.
              "data-packed": String(row.packed === true),
              "data-state": readyRowState(row),
            })}
            // The whole row carries its state: packed and fulfilled is light green and stays green,
            // a failed fulfillment is red, on hold is red and wins.
            rowClass={(row) => readyRowClass(row)}
          />
          </Show>
        </div>
      </Show>
      </Show>
    </div>
  )

  function readyColumns(): Array<CardTableColumn<ReadyRow>> {
    return [
      {
        key: "recipient",
        header: "Recipient",
        role: "anchor",
        cell: (row) => (
          // Whole-row treatment, the SAME rule the prep grid uses (rowTintClass): a parcel put on
          // hold must look held on every screen it appears on, and a packed one must read as done.
          // On hold red still wins: a held parcel must never look done.
          <span class={cx("flex items-center gap-2", row.status === "on_hold" ? rowTintClass(row.status, false) : "")}>
            <input
              type="checkbox"
              data-testid={`boxtal-ready-select-${row.id}`}
              aria-label={`Select ${row.recipient}`}
              checked={selected()[row.id] === true}
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggleRow(row.id)}
            />
            <span class="truncate">{row.recipient}</span>
          </span>
        ),
      },
      {
        key: "state",
        header: "State",
        role: "secondary",
        cell: (row) => (
          <span
            data-testid={`boxtal-ready-state-${row.id}`}
            class={cx(
              "text-[11.5px] font-medium",
              readyRowState(row) === "fulfillment_failed" ? "text-error" : "",
              readyRowState(row) === "packed_fulfilled" ? "text-success" : "",
              readyRowState(row) === "awaiting_approval" ? "text-warning" : "",
            )}
          >
            {READY_STATE_LABELS[readyRowState(row)]}
          </span>
        ),
      },
      {
        key: "country",
        header: "Country",
        role: "secondary",
        fit: true,
        cell: (row) => (
          <span data-testid={`boxtal-ready-country-${row.id}`} class="font-mono" title={countryName(row.destination)}>
            {row.destination || "-"}
          </span>
        ),
      },
      { key: "carrier", header: "Carrier", role: "secondary", cell: (row) => row.carrier },
      {
        key: "tracking",
        header: "Tracking",
        role: "secondary",
        cell: (row) => (
          // The carrier number when it exists, else Boxtal's own shipment reference. A
          // carrier only issues its number once it acknowledges the parcel, which can be
          // hours after the label prints; an empty cell in that window looks like a broken
          // sync and leaves the operator unable to match the row to Boxtal's list.
          <Show
            when={row.tracking_number}
            fallback={
              <Show
                when={!row.tracking_to_confirm}
                fallback={
                  <span
                    data-testid={`boxtal-ready-tracking-to-confirm-${row.id}`}
                    class="text-text-secondary"
                    title="The label was read but its tracking number could not be confirmed. Check the label, or wait for the carrier's first scan."
                  >
                    Tracking to confirm
                    <Show when={row.shipment_ref}>
                      <span class="ml-1 font-mono text-[10.5px] text-text-tertiary">({row.shipment_ref})</span>
                    </Show>
                  </span>
                }
              >
              <Show when={row.shipment_ref} fallback={<span class="text-text-tertiary">{"-"}</span>}>
                <span
                  class="font-mono text-text-tertiary"
                  title="Boxtal shipment reference. The carrier tracking number appears once the carrier acknowledges the parcel."
                >
                  {row.shipment_ref}
                  <span class="ml-1 not-italic text-[10.5px]">(Boxtal ref)</span>
                </span>
              </Show>
              </Show>
            }
          >
            <span class="font-mono">{row.tracking_number}</span>
          </Show>
        ),
      },
      {
        key: "cost",
        header: "Cost",
        role: "meta",
        numeric: true,
        align: "right",
        cell: (row) => <Money value={row.cost} currency="EUR" />,
      },
      {
        key: "status",
        header: "Status",
        role: "meta",
        cell: (row) => <OrderStatusBadge status={row.order_status} testid={`boxtal-ready-status-${row.id}`} />,
      },
      {
        key: "attention",
        header: "Paperwork",
        role: "meta",
        cell: (row) => (
          // The paperwork mark: a customs declaration nobody knew was needed becomes a week
          // of hold, and the one moment it can still be acted on is while the parcel is open
          // on the bench. The hover lists what is required; the mark never claims any of it
          // exists.
          <Show when={row.attention} fallback={<span class="text-text-tertiary">{"-"}</span>}>
            <span
              data-testid={`boxtal-ready-attention-${row.id}`}
              title={row.attention!.summary}
              aria-label={row.attention!.summary}
              class="inline-flex shrink-0 cursor-help items-center gap-1 rounded-md border border-warning-border bg-warning-glow px-1.5 py-0.5 text-[10.5px] font-medium leading-none text-warning"
            >
              <AlertIcon />
              <span>{row.attention!.documents.length || ""}</span>
            </span>
          </Show>
        ),
      },
      {
        key: "requested",
        header: "Requested",
        role: "fold",
        cell: (row) => formatQueueTimestamp(row.requested_at),
      },
      {
        key: "order",
        header: "Order",
        role: "fold",
        cell: (row) => (
          <span class="flex flex-col leading-[1.3]">
            <span class="font-mono text-text">{row.order_name ?? "-"}</span>
            <Show when={row.order_created_at}>
              <span class="font-mono text-[10.5px] tabular-nums text-text-tertiary">
                {formatQueueDate(row.order_created_at)}
              </span>
            </Show>
          </span>
        ),
      },
      {
        key: "category",
        header: "Type",
        role: "fold",
        cell: (row) => <CategoryBadge category={row.category} testid={`boxtal-ready-${row.id}-category`} />,
      },
      {
        key: "items",
        header: "Items",
        role: "fold",
        cell: (row) => (
          <span class="flex flex-col leading-[1.3]">
            <span class="tabular-nums">{row.items ?? "-"}</span>
            <Show when={row.products}>
              <span class="whitespace-nowrap text-[10.5px] text-text-tertiary">{row.products}</span>
            </Show>
          </span>
        ),
      },
      {
        key: "weight",
        header: "Weight",
        role: "fold",
        numeric: true,
        align: "right",
        cell: (row) => (row.weight == null ? "-" : formatWeight(row.weight)),
      },
      {
        key: "packages",
        header: "Packages",
        role: "fold",
        cell: (row) => (
          <Show when={row.package_count} fallback={<span class="text-text-tertiary">{"-"}</span>}>
            <span class="flex flex-col leading-[1.3]">
              <span>{row.package_count}</span>
              <span class="font-mono text-[10.5px] tabular-nums text-text-tertiary">
                {formatQueueParcels(row.parcels)}
              </span>
            </span>
          </Show>
        ),
      },
      {
        key: "documents",
        header: "Documents",
        role: "fold",
        cell: (row) => (
          <div class="flex flex-col items-start gap-1">
            <div class="flex flex-wrap items-center gap-1">
              <Button
                variant="secondary"
                testid={`boxtal-print-${row.id}`}
                title="Print pack: label (normalized, label printer) and invoice (A4, route copy count) as two separate jobs"
                disabled={packBusy()[row.id] === true}
                onClick={() => void runPrintPack(row)}
              >
                <PrinterIcon />
                <span>{packBusy()[row.id] ? "Preparing" : "Print pack"}</span>
              </Button>
              <Button
                variant="ghost"
                testid={`boxtal-download-label-${row.id}`}
                disabled={packBusy()[row.id] === true}
                title="Open the shipping label in a new tab"
                onClick={() => void retrieveDoc(row, "label")}
              >
                Label
              </Button>
              <Button
                variant="ghost"
                testid={`boxtal-download-invoice-${row.id}`}
                disabled={packBusy()[row.id] === true}
                title="Open the invoice in a new tab"
                onClick={() => void retrieveDoc(row, "invoice")}
              >
                Invoice
              </Button>
              <Button
                variant="ghost"
                testid={`boxtal-attach-ticket-${row.id}`}
                title="Attach to a ticket reply"
                ariaLabel="Attach to a ticket reply"
              >
                <PaperclipIcon />
              </Button>
              {/* The packed mark closes the row: everything before it is work to do on the
                  parcel, this says the parcel is done and on the pickup pallet. A raw button
                  rather than the kit Button so it can carry aria-pressed, which is what makes a
                  toggle a toggle for a screen reader. */}
              <button
                type="button"
                data-testid={`boxtal-ready-packed-${row.id}`}
                aria-pressed={row.packed}
                aria-label={row.packed ? "Packed" : "Not packed yet"}
                aria-busy={packedBusy()[row.id] === true}
                disabled={packedBusy()[row.id] === true}
                title={
                  row.packed
                    ? "Untick: cancels the Shopify fulfillment after you confirm"
                    : "Packed: fulfils the Shopify order with this tracking number"
                }
                onClick={(e) => {
                  e.stopPropagation()
                  void togglePacked(row)
                }}
                class={cx(
                  "inline-flex items-center justify-center rounded-md px-2 py-1.5",
                  "transition-colors outline-none hover:bg-surface-active",
                  "focus-visible:ring-2 focus-visible:ring-accent-tint",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  row.packed ? "text-success" : "text-text-tertiary",
                )}
              >
                <Show when={row.packed} fallback={<PackedOffIcon />}>
                  <PackedOnIcon />
                </Show>
              </button>
            </div>
            {/* The org's own documents for this parcel (customs declarations, certificates, a
                thank-you letter), printed from its document templates. Those the document rules
                ask for are pre-ticked and marked Needed. An inline fold, never a modal. */}
            <PrintDocuments
              app="boxtal"
              entity="shipment"
              recordId={row.id}
              neededTemplateIds={row.needed_template_ids ?? []}
              testid={`boxtal-print-documents-${row.id}`}
            />
            <Show when={packStatus()[row.id]}>
              <div data-testid={`boxtal-print-status-${row.id}`} class="text-[11px] text-text-tertiary">
                {packStatus()[row.id]}
              </div>
            </Show>
            {/* The fulfillment's own failure, explicit on the row: the box refused to stay
                ticked, and this says why. */}
            <Show when={row.fulfillment_error}>
              <div data-testid={`boxtal-ready-fulfillment-error-${row.id}`} role="alert" class="text-[11px] font-medium text-error">
                {row.fulfillment_error}
              </div>
            </Show>
          </div>
        ),
      },
    ]
  }
}

// ── Router — pick the queue from props.queueId or the URL last segment ─────────
function queueIdFromLocation(): string {
  try {
    const segs = currentPath().replace(/\?.*$/, "").split("/").filter(Boolean)
    return segs[segs.length - 1] ?? ""
  } catch {
    return ""
  }
}

/** Pick the live queue id. The URL is the source of truth: the sidebar rows
 *  navigate via history.pushState and NOTHING updates the singleton tab's
 *  entityId on in-tab navigation, so props.entityId only reflects the queue
 *  the tab was FIRST opened on. `pathname` must be the REACTIVE pathname
 *  signal value (usePathname), never a one-shot window.location read: a plain
 *  read froze the first-mounted queue forever (Ready to ship rendered the
 *  To-prepare grid). Props are the fallback for tests/direct mounts. */
export function resolveQueueId(
  pathname: string | undefined,
  entityId?: string,
  queueId?: string,
): string {
  if (pathname) {
    const segs = (pathname.split("?")[0] ?? "").split("/").filter(Boolean)
    // Only trust the URL when it is actually a queue route; the tab can stay
    // mounted while another tab's URL is active.
    const qIdx = segs.indexOf("queue")
    const queueSeg = qIdx >= 0 ? segs[qIdx + 1] : undefined
    if (queueSeg) return queueSeg
  }
  return entityId ?? queueId ?? queueIdFromLocation()
}

/** The one shipping worklist: To prepare above, Ready to ship below, one filter over both. */
export const ShippingWorklist: Component<{ initialFilter: WorklistFilter }> = (props) => {
  const [filter, setFilter] = createSignal<WorklistFilter>(props.initialFilter)
  // A sidebar click on another route lands here with a new preset: follow it. Through a memo, so
  // a URL change that leaves the preset as it was (the prep grid writing its own query state)
  // never resets the filter the operator picked.
  const preset = createMemo(() => props.initialFilter)
  createEffect(on(preset, (f) => setFilter(f), { defer: true }))
  const [readyRows, setReadyRows] = createSignal<ReadyRow[]>([])
  const counts = createMemo(() => worklistFilterCounts(readyRows()))
  const count = (f: WorklistFilter): number | null =>
    f === "ready" || f === "to_pack" || f === "packed" ? counts()[f] : null
  const sections = () => worklistSections(filter())
  return (
    <div data-testid="boxtal-worklist" class="flex h-full min-h-0 flex-col">
      <div
        role="toolbar"
        aria-label="Filter the shipping worklist"
        data-testid="boxtal-worklist-filter"
        class="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2"
      >
        <span class="mr-2 text-[12.5px] font-semibold text-text">Shipping worklist</span>
        <For each={WORKLIST_FILTERS}>
          {(f) => (
            <button
              type="button"
              data-testid={`boxtal-worklist-filter-${f.id}`}
              aria-pressed={filter() === f.id}
              onClick={() => setFilter(f.id)}
              class={cx(
                "rounded-md px-2 py-1 text-[12px] transition-colors outline-none",
                "focus-visible:ring-2 focus-visible:ring-accent-tint",
                filter() === f.id ? "bg-surface-active text-text" : "text-text-secondary hover:bg-surface-hover",
              )}
            >
              {f.label}
              <Show when={count(f.id) != null}>
                <span class="ml-1 tabular-nums text-text-tertiary">{count(f.id)}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
      <Show when={sections().toPrepare.mounted}>
        <section
          data-testid="boxtal-worklist-to-prepare"
          class={cx(
            // Scrolls its own content: an open Add shipment panel taller than the half the
            // section gets must not draw over Ready to ship (it took the panel's clicks).
            "flex min-h-0 flex-col overflow-y-auto",
            sections().ready.visible ? "flex-1 border-b border-border" : "flex-1",
          )}
        >
          <PrepGrid />
        </section>
      </Show>
      {/* Mounted under every filter, hidden when not shown: it loads the labels the counts above
          are computed from, so the counts are the same whichever route opened the page. */}
      <Show when={sections().ready.mounted}>
        <section
          data-testid="boxtal-worklist-ready"
          hidden={!sections().ready.visible}
          class={cx("min-h-0 flex-1 flex-col", sections().ready.visible ? "flex" : "hidden")}
        >
          <ReadyToShip filter={filter()} onRows={setReadyRows} onClearFilter={() => setFilter("all")} />
        </section>
      </Show>
    </div>
  )
}

export const BoxtalQueue: Component<{ queueId?: string; entityId?: string }> = (props) => {
  const pathname = usePathname()
  const which = (): string => resolveQueueId(pathname(), props.entityId, props.queueId)
  const search = (): string => {
    const p = pathname() ?? ""
    const i = p.indexOf("?")
    return i >= 0 ? p.slice(i) : ""
  }
  return <ShippingWorklist initialFilter={worklistFilterForRoute(which(), search())} />
}
