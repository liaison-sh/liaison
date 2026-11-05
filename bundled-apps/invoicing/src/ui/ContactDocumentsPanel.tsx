// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ContactDocumentsPanel — slot contribution for the kernel's contact_detail
// page (K5). Lists all invoicing documents that reference the contact, plus
// an inline relationship editor (customer/vendor/both/other) and a quick
// "+ Create document" CTA that opens the editor pre-filled with the
// contact id.
//
// Slot wiring. Declared in app.manifest.json under
// `slots.contact_detail.panels[]` with visibility_scope
// "invoicing:documents:read"; the kernel filters out the contribution when
// the viewer lacks the scope. Component bundle-load failure renders the
// kernel's "Panel unavailable" placeholder (handled by the K5 slot host
// upstream — this component is the happy path).
//
// Relationship conflict (spec §10). When the row's relationship is sourced
// 'inferred' but a manual override has subsequently been set, the panel
// shows a small "manual vs inferred" attention badge so the user can
// decide whether to keep the inferred classification.
import { tr } from "./i18n"
import {
  createResource,
  createSignal,
  For,
  Show,
  type Component,
} from "solid-js"
import { app, navigate } from "@liaison/host"
import { loadViewerAccess } from "./access"
import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import { documentRollup, formatMoneyMinor, lineSubtotal } from "../money"

export interface ContactDocumentsPanelProps {
  /** The kernel `contact_detail` slot host (SlotPanels) mounts every slot panel
   *  with the contact id in the `entityId` prop — that is the runtime contract. */
  entityId?: string
  /** Direct/unit usage may pass the contact id as `contactId` instead. */
  contactId?: string
  /** Optional callback fired after a write (relationship change, create
   *  document) so the host (contact detail page) can refresh. */
  onMutate?: () => void
}

export type Relationship = "customer" | "vendor" | "both" | "other"
export const RELATIONSHIP_OPTIONS: Relationship[] = [
  "customer",
  "vendor",
  "both",
  "other",
]

/** A draft's own line, as `documents_search({ include_lines: true })` returns it (documents_get
 *  shape) — only the fields the totals roll-up needs. */
export interface DocumentLineRow {
  quantity: string
  unit_price_minor: string | number
  tax_rate_bp: number
}

export interface DocumentRow {
  id: string
  type: string
  number?: string | null
  status: string
  payment_status?: string
  currency: string
  grand_total_minor: string | number
  issued_at?: string | null
  due_at?: string | null
  /** Present when loaded with `include_lines: true` — used to derive the displayed total for a
   *  draft row, whose `grand_total_minor` is legitimately 0 (computed only at issue). */
  lines?: DocumentLineRow[]
}

interface RelationshipRow {
  contact_id: string
  relationship: Relationship
  source: "manual" | "inferred"
  /** True when the inferred classification has been overridden by a
   *  manual entry (spec §10). The panel uses this to show the conflict
   *  badge so the user can review. */
  has_inferred_conflict?: boolean
}

// Exported for the cross-boundary regression test (apps/api) that drives this
// real loader against a real-DB-backed host to pin the bare-array tool-result
// contract. The component itself is the only in-app caller.
export async function loadPanel(contactId: string): Promise<{
  documents: DocumentRow[]
  relationship: RelationshipRow | null
}> {
  const [docs, draftDocs, rel] = await Promise.all([
    // documents_search returns a bare DocumentHeader[] (the route wraps it as
    // { data: [...] } and the api-client unwraps `.data`, so the resolved
    // tool result IS the array — there is no `.items` envelope here, unlike
    // the settings_* list reads).
    app
      .invokeTool<DocumentRow[]>("documents_search", { contact_id: contactId, limit: 100 })
      .catch(() => [] as DocumentRow[]),
    // A draft's grand_total_minor is legitimately 0 (computed at issue, not on save), so
    // displayTotal derives it from the lines instead — but that is the ONLY row shape that
    // needs them. `include_lines` costs one extra host round trip PER ROW (reads.ts
    // documentsSearch's include_lines branch), so asking for it on the full page (up to 100
    // rows) for a handful of drafts turned "the lines a few drafts need" into "a lines fetch for
    // every row on the page". Scope the include_lines call to `status: "draft"` alone -- a
    // contact typically carries a handful of open drafts, not a hundred -- and merge those rows
    // (now carrying `lines`) over the lines-free full list by id.
    app
      .invokeTool<DocumentRow[]>("documents_search", {
        contact_id: contactId,
        status: "draft",
        limit: 100,
        include_lines: true,
      })
      .catch(() => [] as DocumentRow[]),
    app
      .invokeTool<RelationshipRow | { item: RelationshipRow | null }>(
        "contact_relationships_get",
        { contact_id: contactId },
      )
      .catch(() => null),
  ])
  const relationship =
    rel == null
      ? null
      : "item" in (rel as object)
        ? ((rel as { item: RelationshipRow | null }).item ?? null)
        : (rel as RelationshipRow)
  const draftById = new Map(
    (Array.isArray(draftDocs) ? draftDocs : []).map((d) => [d.id, d] as const),
  )
  const documents = (Array.isArray(docs) ? docs : []).map((d) => draftById.get(d.id) ?? d)
  return {
    documents,
    relationship,
  }
}

function fmtMoney(minor: string | number | undefined, currency: string): string {
  if (minor == null) return "-"
  const n = typeof minor === "string" ? Number(minor) : minor
  if (!Number.isFinite(n)) return "-"
  return formatMoneyMinor(BigInt(Math.round(n)), currency)
}

/**
 * The displayed total for a document row. A draft stores 0 for `grand_total_minor` (it is only
 * computed at issue — mutations.ts insertDraftRow / issue.ts), so showing it raw always read
 * "0.00" for a draft, even one carrying real priced lines. Derive it from the lines instead, the
 * way EditorSummary's totals panel does for the open Editor. The lines here are already NET
 * (drafts_create/drafts_update net a typed gross price at the write boundary, same as the issue
 * path), so this is a plain roll-up — no included-tax division, that already happened once.
 */
export function displayTotal(row: DocumentRow): string {
  if (row.status !== "draft") return fmtMoney(row.grand_total_minor, row.currency)
  const lines = row.lines ?? []
  if (lines.length === 0) return fmtMoney(row.grand_total_minor, row.currency)
  const rollup = documentRollup(
    lines.map((l) => ({
      subtotal_minor: lineSubtotal({
        quantity: l.quantity,
        unit_price_minor: BigInt(l.unit_price_minor || 0),
      }),
      tax_rate_bp: l.tax_rate_bp,
    })),
  )
  return fmtMoney(rollup.grand_total_minor.toString(), row.currency)
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "-"
  return iso.slice(0, 10)
}

export const ContactDocumentsPanel: Component<ContactDocumentsPanelProps> = (props) => {
  // The kernel slot host passes the contact id as `entityId`; direct/unit usage
  // passes `contactId`. Previously this only read `contactId`, so on the real
  // contact-detail page (which forwards `entityId`) the panel mounted with no
  // contact id → no data ever loaded.
  const cid = (): string => props.entityId ?? props.contactId ?? ""
  const [data, { refetch }] = createResource(() => cid() || undefined, loadPanel)
  // "+ Create document" opens the editor, a write: offered only to a viewer who may create one.
  const [access] = createResource(loadViewerAccess)
  const [saving, setSaving] = createSignal(false)

  const setRelationship = async (r: Relationship) => {
    setSaving(true)
    try {
      await app.invokeTool("contact_relationships_set", {
        contact_id: cid(),
        relationship: r,
        source: "manual",
      })
      props.onMutate?.()
      refetch()
    } finally {
      setSaving(false)
    }
  }

  const onCreate = () => {
    navigate(`/invoicing/editor/new?contact_id=${encodeURIComponent(cid())}`)
  }

  return (
    <section
      data-testid="contact-documents-panel"
      class="flex flex-col gap-3 px-4 py-3 text-[12.5px]"
    >
      {/* Relationship editor */}
      <div class="flex items-center justify-between gap-2 border-b border-border-subtle pb-2">
        <div class="flex items-center gap-2">
          <span class="text-text-tertiary">{tr("Relationship")}</span>
          <select
            data-testid="contact-documents-panel-relationship"
            disabled={saving()}
            value={data()?.relationship?.relationship ?? "other"}
            onChange={(e) => void setRelationship(e.currentTarget.value as Relationship)}
            class="rounded-md border border-border-subtle bg-surface px-2 py-1 text-text"
          >
            <For each={RELATIONSHIP_OPTIONS}>
              {(r) => <option value={r}>{r}</option>}
            </For>
          </select>
          <Show when={data()?.relationship?.has_inferred_conflict}>
            <span
              data-testid="contact-documents-panel-conflict"
              class="rounded bg-warning/20 px-2 py-0.5 text-[11px] text-warning"
              title={tr("A manual override differs from the inferred relationship: review and confirm.")}
            >
              {tr("manual vs inferred")}
            </span>
          </Show>
        </div>
        <Show when={access()?.documents_write}>
          <button
            type="button"
            data-testid="contact-documents-panel-create"
            onClick={onCreate}
            class="rounded-md border border-border-subtle bg-surface px-3 py-1 text-[12px] text-text hover:bg-surface-hover"
          >
            {tr("+ Create document")}
          </button>
        </Show>
      </div>

      {/* Documents list */}
      <Show
        when={(data()?.documents.length ?? 0) > 0}
        fallback={
          <div data-testid="contact-documents-panel-empty" class="text-text-tertiary">
            {tr("No documents yet for this contact.")}
          </div>
        }
      >
        <div data-testid="contact-documents-panel-table">
          <CardTable
            rows={data()?.documents ?? []}
            rowKey={(row) => row.id}
            rowTestid={(row) => `contact-documents-panel-row-${row.id}`}
            onRowClick={(row) => navigate(`/invoicing/document/${row.id}`)}
            columns={[
              {
                key: "number",
                header: "#",
                role: "anchor",
                cell: (row) => <span class="font-mono">{row.number ?? "(draft)"}</span>,
              },
              { key: "type", header: tr("Type"), role: "secondary", cell: (row) => row.type },
              { key: "date", header: tr("Date"), role: "meta", cell: (row) => fmtDate(row.issued_at) },
              { key: "status", header: tr("Status"), role: "meta", cell: (row) => row.status },
              {
                key: "total",
                header: tr("Total"),
                role: "meta",
                numeric: true,
                align: "right",
                cell: (row) => displayTotal(row),
              },
            ] as Array<CardTableColumn<DocumentRow>>}
          />
        </div>
      </Show>
    </section>
  )
}
