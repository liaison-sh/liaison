// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bought labels of the shipping worklist (Queues.tsx): every label the carrier has not
// collected yet, the print station. Print label + invoice, tick the parcel packed (which fulfils
// the Shopify order), or attach the pair to a ticket reply.
//
// They are rows of the ONE worklist table (PrepGrid.tsx), beside the orders still to prepare, with
// their state on every row. This file owns their data (createReadyWorklist) and their row
// (ReadyRowView); it composes only the shared Boxtal kit and the kernel's theme tokens.
import { type Component, createSignal, onCleanup, onMount, Show, untrack } from "solid-js"
import { app } from "@liaison/host"
import { ConfirmDialog } from "@liaison/app-ui/kit"
import { PrintDocuments } from "@liaison/app-ui/print-documents"
import {
  Button,
  CategoryBadge,
  cx,
  formatQueueDate,
  formatQueueParcels,
  formatQueueTimestamp,
  formatWeight,
  Money,
  OrderStatusBadge,
} from "./kit"
import { loadFileInto, openPreparingTab } from "./file-open"
import { keepUnchangedRows, rowTintClass } from "./prep-row-logic"
import { countryName } from "./country"
import { packedToggleAction, READY_STATE_LABELS, readyRowClass, readyRowState } from "./worklist-logic"

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

// ── Bought-label rows ─────────────────────────────────────────────────────────
export interface ReadyRow {
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

/**
 * The bought labels of the shipping worklist, and every action a bought-label row carries (print
 * pack, label, invoice, the packed tick, the typed tracking number, the batch print). Created ONCE
 * by the worklist page, which keeps it alive under every filter: the filter bar counts come from
 * these rows. The rows themselves render inside the one worklist table (PrepGrid) as ReadyRowView.
 */
export function createReadyWorklist() {
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
  // A label bought from a To prepare row lands in the worklist without a page reload: refresh when
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
  // Rows whose tick was refused for want of a tracking number: they offer a field for the number
  // printed on the label, so an unreadable label is never a dead end.
  const [trackingAsk, setTrackingAsk] = createSignal<Record<string, boolean>>({})
  const [typedTracking, setTypedTracking] = createSignal<Record<string, string>>({})
  const togglePacked = async (row: ReadyRow, confirmed = false, typed?: string) => {
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
        ...(action.kind === "pack" && typed ? { tracking_number: typed } : {}),
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
      const askNumber = res.error?.code === "no_tracking" || res.error?.code === "invalid_tracking_number"
      setTrackingAsk((m) => ({ ...m, [row.id]: askNumber }))
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
  /** The selected rows among those on screen (a row filtered away is never printed). */
  const selectedIds = (visible: ReadyRow[]): string[] => visible.map((r) => r.id).filter((id) => selected()[id])
  const allSelected = (visible: ReadyRow[]): boolean =>
    visible.length > 0 && selectedIds(visible).length === visible.length
  const toggleRow = (id: string) => setSelected((m) => ({ ...m, [id]: !m[id] }))
  const toggleAll = (visible: ReadyRow[]) => {
    const next = !allSelected(visible)
    setSelected(next ? Object.fromEntries(visible.map((r) => [r.id, true])) : {})
  }
  const [batchBusy, setBatchBusy] = createSignal(false)
  const [batchStatus, setBatchStatus] = createSignal<string | null>(null)

  const runBatchPrint = async (visible: ReadyRow[]) => {
    const ids = selectedIds(visible)
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
  return {
    rows,
    all,
    error: (): unknown => rows.error,
    patchReadyRow,
    packStatus,
    packBusy,
    packedBusy,
    unpackAsk,
    setUnpackAsk,
    trackingAsk,
    typedTracking,
    setTypedTracking,
    togglePacked,
    selected,
    setSelected,
    selectedIds,
    allSelected,
    toggleRow,
    toggleAll,
    batchBusy,
    batchStatus,
    runBatchPrint,
    runPrintPack,
    retrieveDoc,
  }
}

export type ReadyWorklist = ReturnType<typeof createReadyWorklist>

/** Unticking a fulfilled row asks in the app's own dialog (a framed screen has no browser
 *  confirm: the sandbox gives it no modal dialogs). */
export const ReadyUnpackDialog: Component<{ ready: ReadyWorklist }> = (props) => (
  <ConfirmDialog
    open={props.ready.unpackAsk() !== null}
    title="Untick this order?"
    body={props.ready.unpackAsk()?.message ?? ""}
    confirmLabel="Untick"
    danger
    testid="boxtal-unpack-confirm"
    cancelTestid="boxtal-unpack-cancel"
    onCancel={() => props.ready.setUnpackAsk(null)}
    onConfirm={() => {
      const ask = props.ready.unpackAsk()
      props.ready.setUnpackAsk(null)
      if (ask) void props.ready.togglePacked(ask.row, true)
    }}
  />
)

/** Select all over the bought labels on screen, and the batch print once something is selected. */
export const ReadySelectionBar: Component<{ ready: ReadyWorklist; visible: ReadyRow[] }> = (props) => {
  const r = props.ready
  return (
    <div class="flex flex-wrap items-center gap-3 border-b border-border-subtle px-5 py-1.5 text-[11px] text-text-secondary">
      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          data-testid="boxtal-ready-select-all"
          aria-label="Select every bought label"
          title="Select rows to print as one batch"
          checked={r.allSelected(props.visible)}
          onChange={() => r.toggleAll(props.visible)}
        />
        Select all
      </label>
      {/* Batch bar: only there when something is selected, so the resting screen is unchanged. */}
      <Show when={r.selectedIds(props.visible).length > 0}>
        <div data-testid="boxtal-ready-batch-bar" class="flex items-center gap-3 text-[12.5px]">
          <span class="text-text">{r.selectedIds(props.visible).length} selected</span>
          <Button
            variant="primary"
            testid="boxtal-ready-batch-print"
            disabled={r.batchBusy()}
            title="Print the selection as two documents: every label in one, every invoice in one"
            onClick={() => void r.runBatchPrint(props.visible)}
          >
            <PrinterIcon />
            <span>{r.batchBusy() ? "Preparing" : `Print ${r.selectedIds(props.visible).length} packs`}</span>
          </Button>
          <Button variant="ghost" testid="boxtal-ready-batch-clear" onClick={() => r.setSelected({})}>
            Clear
          </Button>
          <Show when={r.batchStatus()}>
            <span class="text-text-secondary">{r.batchStatus()}</span>
          </Show>
        </div>
      </Show>
    </div>
  )
}

/**
 * One bought-label row of the worklist table, in the table's own columns (PREP_GRID_COLUMNS):
 * State, Order, Client, Country, Products, Total, Category, Document, Actions. Its actions
 * are the print station's: print pack, label, invoice, attach, the packed tick, the org's
 * documents and the typed tracking number.
 */
export const ReadyRowView: Component<{
  ready: ReadyWorklist
  row: ReadyRow
  /** The table's cell class, so both kinds of row share one rhythm. */
  cellClass: string
  /** Column keys the phone keeps on screen (the others fold behind the row's expand). */
  survivesPhone: (key: string) => boolean
  actionsSticky: boolean
}> = (props) => {
  const r = props.ready
  const row = props.row
  const [phoneExpanded, setPhoneExpanded] = createSignal(false)
  const phoneCell = (key: string) =>
    props.survivesPhone(key) ? "" : phoneExpanded() ? "block md:table-cell" : "hidden md:table-cell"
  const state = () => readyRowState(props.row)
  return (
    <tr
      data-testid={`boxtal-ready-row-${row.id}`}
      // State marker on the row itself: a packed parcel must be readable as done from the row,
      // not only from its toggle. Defensive: a row from an older server build carries no `packed`.
      data-packed={String(props.row.packed === true)}
      data-state={state()}
      // The whole row carries its state: packed and fulfilled is light green and stays green, a
      // failed fulfillment is red, on hold is red and wins.
      class={cx("group hover:bg-surface-hover", readyRowClass(props.row))}
    >
      <td class={cx(props.cellClass, phoneCell("status"))} data-phone-column="status">
        {/* The State column: where the parcel is (Label bought, Packed...). Wraps inside the
            column's width (the To prepare rows' status select sets it) instead of widening it. */}
        <span class="flex max-w-[96px] items-start gap-1.5">
          <input
            type="checkbox"
            class="mt-0.5"
            data-testid={`boxtal-ready-select-${row.id}`}
            aria-label={`Select ${row.recipient}`}
            checked={r.selected()[row.id] === true}
            onClick={(e) => e.stopPropagation()}
            onChange={() => r.toggleRow(row.id)}
          />
          <span
            data-testid={`boxtal-ready-state-${row.id}`}
            class={cx(
              "text-[11px] font-medium leading-[1.3]",
              state() === "fulfillment_failed" ? "text-error" : "",
              state() === "packed_fulfilled" ? "text-success" : "",
              state() === "awaiting_approval" ? "text-warning" : "",
            )}
          >
            {READY_STATE_LABELS[state()]}
          </span>
        </span>
      </td>
      <td class={props.cellClass}>
        <span class="flex flex-col leading-[1.3]">
          <span class="whitespace-nowrap font-mono text-text">{row.order_name ?? row.invoice_ref ?? "-"}</span>
          <Show when={row.order_created_at}>
            <span class="whitespace-nowrap font-mono text-[10.5px] tabular-nums text-text-tertiary">
              {formatQueueDate(row.order_created_at)}
            </span>
          </Show>
        </span>
      </td>
      <td class={props.cellClass}>
        {/* A held parcel must look held on every row it appears on (the prep grid's rule). */}
        <span
          class={cx("block max-w-[92px] truncate text-text", props.row.status === "on_hold" ? rowTintClass(props.row.status, false) : "")}
          title={row.recipient}
        >
          {row.recipient}
        </span>
      </td>
      <td
        class={cx(props.cellClass, "font-mono text-text-secondary", phoneCell("country"))}
        data-phone-column="country"
      >
        <span data-testid={`boxtal-ready-country-${row.id}`} title={countryName(props.row.destination)}>
          {props.row.destination || "-"}
        </span>
      </td>
      <td class={cx(props.cellClass, "text-text-secondary", phoneCell("products"))} data-phone-column="products">
        <span class="flex flex-wrap items-center gap-1">
          <span class="flex flex-col leading-[1.3]">
            <span class="tabular-nums">{props.row.items ?? "-"}</span>
            <Show when={props.row.products}>
              <span class="whitespace-nowrap font-mono text-[10.5px] text-text-tertiary">{props.row.products}</span>
            </Show>
          </span>
          {/* The paperwork mark: a customs declaration nobody knew was needed becomes a week of
              hold, and the one moment it can still be acted on is while the parcel is open on the
              bench. The hover lists what is required; the mark never claims any of it exists. */}
          <Show when={props.row.attention}>
            <span
              data-testid={`boxtal-ready-attention-${row.id}`}
              title={props.row.attention!.summary}
              aria-label={props.row.attention!.summary}
              class="inline-flex shrink-0 cursor-help items-center gap-1 rounded-md border border-warning-border bg-warning-glow px-1.5 py-0.5 text-[10.5px] font-medium leading-none text-warning"
            >
              <AlertIcon />
              <span>{props.row.attention!.documents.length || ""}</span>
            </span>
          </Show>
        </span>
      </td>
      <td class={cx(props.cellClass, "text-right", phoneCell("total"))} data-phone-column="total">
        <div class="flex flex-col items-end gap-0.5 leading-[1.3]">
          <span class="whitespace-nowrap font-mono tabular-nums text-text">
            <Money value={props.row.cost} currency="EUR" />
          </span>
          <span class="whitespace-nowrap text-[11px] text-text-secondary">{props.row.carrier}</span>
          {/* The carrier number when it exists, else Boxtal's own shipment reference. A carrier
              only issues its number once it acknowledges the parcel, which can be hours after the
              label prints; an empty cell in that window looks like a broken sync and leaves the
              operator unable to match the row to Boxtal's list. */}
          <span class="whitespace-nowrap text-[11px]">
            <Show
              when={props.row.tracking_number}
              fallback={
                <Show
                  when={!props.row.tracking_to_confirm}
                  fallback={
                    <span
                      data-testid={`boxtal-ready-tracking-to-confirm-${row.id}`}
                      class="text-text-secondary"
                      title="The label was read but its tracking number could not be confirmed. Check the label, or wait for the carrier's first scan."
                    >
                      Tracking to confirm
                      <Show when={props.row.shipment_ref}>
                        <span class="ml-1 font-mono text-[10.5px] text-text-tertiary">({props.row.shipment_ref})</span>
                      </Show>
                    </span>
                  }
                >
                  <Show when={props.row.shipment_ref} fallback={<span class="text-text-tertiary">{"-"}</span>}>
                    <span
                      class="font-mono text-text-tertiary"
                      title="Boxtal shipment reference. The carrier tracking number appears once the carrier acknowledges the parcel."
                    >
                      {props.row.shipment_ref}
                      <span class="ml-1 not-italic text-[10.5px]">(Boxtal ref)</span>
                    </span>
                  </Show>
                </Show>
              }
            >
              <span class="font-mono">{props.row.tracking_number}</span>
            </Show>
          </span>
          <Show when={props.row.package_count}>
            <span class="font-mono text-[10.5px] tabular-nums text-text-tertiary">
              {`${props.row.package_count} · ${formatQueueParcels(props.row.parcels)}`}
              <Show when={props.row.weight != null}>{` · ${formatWeight(props.row.weight as number)}`}</Show>
            </span>
          </Show>
        </div>
      </td>
      <td class={cx(props.cellClass, phoneCell("category"))} data-phone-column="category">
        <CategoryBadge category={props.row.category} testid={`boxtal-ready-${row.id}-category`} />
      </td>
      <td class={cx(props.cellClass, phoneCell("document"))} data-phone-column="document">
        <span class="flex flex-col items-start gap-0.5 leading-[1.3]">
          <OrderStatusBadge status={props.row.order_status} testid={`boxtal-ready-status-${row.id}`} />
          <span class="whitespace-nowrap font-mono text-text">{props.row.invoice_ref || "-"}</span>
          <Show when={props.row.requested_at}>
            <span class="whitespace-nowrap text-[10.5px] text-text-tertiary" title="Requested">
              {formatQueueTimestamp(props.row.requested_at)}
            </span>
          </Show>
        </span>
      </td>
      <td
        class={cx(
          props.cellClass,
          props.actionsSticky ? "sticky right-0 z-10 bg-bg group-hover:bg-surface-hover" : "",
        )}
      >
        <div class="flex flex-col items-end gap-1">
          <div class="flex flex-wrap items-center justify-end gap-1">
            <button
              type="button"
              class="min-h-11 min-w-11 rounded-md text-text-secondary md:hidden"
              data-testid={`boxtal-ready-row-phone-expand-${row.id}`}
              aria-expanded={phoneExpanded()}
              aria-label={phoneExpanded() ? "Hide columns" : "Show columns"}
              onClick={() => setPhoneExpanded(!phoneExpanded())}
            >
              {phoneExpanded() ? "−" : "+"}
            </button>
            <Button
              variant="secondary"
              testid={`boxtal-print-${row.id}`}
              title="Print pack: label (normalized, label printer) and invoice (A4, route copy count) as two separate jobs"
              disabled={r.packBusy()[row.id] === true}
              onClick={() => void r.runPrintPack(props.row)}
            >
              <PrinterIcon />
              <span>{r.packBusy()[row.id] ? "Preparing" : "Print pack"}</span>
            </Button>
            <Button
              variant="ghost"
              testid={`boxtal-download-label-${row.id}`}
              disabled={r.packBusy()[row.id] === true}
              title="Open the shipping label in a new tab"
              onClick={() => void r.retrieveDoc(props.row, "label")}
            >
              Label
            </Button>
            <Button
              variant="ghost"
              testid={`boxtal-download-invoice-${row.id}`}
              disabled={r.packBusy()[row.id] === true}
              title="Open the invoice in a new tab"
              onClick={() => void r.retrieveDoc(props.row, "invoice")}
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
            {/* The packed mark closes the row: everything before it is work to do on the parcel,
                this says the parcel is done and on the pickup pallet. A raw button rather than
                the kit Button so it can carry aria-pressed, which is what makes a toggle a toggle
                for a screen reader. */}
            <button
              type="button"
              data-testid={`boxtal-ready-packed-${row.id}`}
              aria-pressed={props.row.packed}
              aria-label={props.row.packed ? "Packed" : "Not packed yet"}
              aria-busy={r.packedBusy()[row.id] === true}
              disabled={r.packedBusy()[row.id] === true}
              title={
                props.row.packed
                  ? "Untick: cancels the Shopify fulfillment after you confirm"
                  : "Packed: fulfils the Shopify order with this tracking number"
              }
              onClick={(e) => {
                e.stopPropagation()
                void r.togglePacked(props.row)
              }}
              class={cx(
                "inline-flex items-center justify-center rounded-md px-2 py-1.5",
                "transition-colors outline-none hover:bg-surface-active",
                "focus-visible:ring-2 focus-visible:ring-accent-tint",
                "disabled:cursor-not-allowed disabled:opacity-50",
                props.row.packed ? "text-success" : "text-text-tertiary",
              )}
            >
              <Show when={props.row.packed} fallback={<PackedOffIcon />}>
                <PackedOnIcon />
              </Show>
            </button>
          </div>
          {/* The org's own documents for this parcel (customs declarations, certificates, a
              thank-you letter), printed from its document templates. Those the document rules ask
              for are pre-ticked and marked Needed. An inline fold, never a modal. */}
          <PrintDocuments
            app="boxtal"
            entity="shipment"
            recordId={row.id}
            neededTemplateIds={props.row.needed_template_ids ?? []}
            testid={`boxtal-print-documents-${row.id}`}
          />
          <Show when={r.packStatus()[row.id]}>
            <div data-testid={`boxtal-print-status-${row.id}`} class="text-[11px] text-text-tertiary">
              {r.packStatus()[row.id]}
            </div>
          </Show>
          {/* The fulfillment's own failure, explicit on the row: the box refused to stay ticked,
              and this says why. */}
          <Show when={props.row.fulfillment_error}>
            <div data-testid={`boxtal-ready-fulfillment-error-${row.id}`} role="alert" class="text-[11px] font-medium text-error">
              {props.row.fulfillment_error}
            </div>
          </Show>
          {/* No tracking number to fulfil with (the label could not be read, or its read was not
              confirmed): the operator types the number printed on the label. */}
          <Show
            when={
              !props.row.packed &&
              !props.row.tracking_number &&
              (r.trackingAsk()[row.id] === true || props.row.tracking_to_confirm === true)
            }
          >
            <form
              data-testid={`boxtal-ready-typed-tracking-${row.id}`}
              class="flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                const typed = (r.typedTracking()[row.id] ?? "").trim()
                if (typed) void r.togglePacked(props.row, false, typed)
              }}
            >
              <input
                data-testid={`boxtal-ready-typed-tracking-input-${row.id}`}
                type="text"
                inputmode="text"
                autocomplete="off"
                aria-label="Tracking number printed on the label"
                placeholder="Tracking number on the label"
                value={r.typedTracking()[row.id] ?? ""}
                onInput={(e) => {
                  const v = e.currentTarget.value
                  r.setTypedTracking((m) => ({ ...m, [row.id]: v }))
                }}
                onClick={(e) => e.stopPropagation()}
                class="h-7 w-44 rounded-md border border-border-subtle bg-surface px-2 font-mono text-[11.5px] text-text placeholder:text-text-tertiary focus:border-accent focus:outline-none"
              />
              <button
                data-testid={`boxtal-ready-typed-tracking-submit-${row.id}`}
                type="submit"
                disabled={r.packedBusy()[row.id] === true || !(r.typedTracking()[row.id] ?? "").trim()}
                onClick={(e) => e.stopPropagation()}
                class="h-7 rounded-md px-2 text-[11.5px] font-medium hover:bg-surface-active disabled:cursor-not-allowed disabled:opacity-50"
              >
                Pack with this number
              </button>
            </form>
          </Show>
        </div>
      </td>
    </tr>
  )
}
