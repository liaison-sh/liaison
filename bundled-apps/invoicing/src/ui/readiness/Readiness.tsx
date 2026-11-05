// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The e-invoicing readiness tab (/invoicing/readiness): only what blocks an e-invoice, one card
// per customer (or document) listing each blocker, each with exactly one action that opens the
// tab where it is fixed. Read from `einvoicing_readiness`; its blocker codes are the issue gate's
// codes.
import { app, navigate } from "@liaison/host"
import { type Component, createResource, For, Show } from "solid-js"
import { identityHref } from "../einvoicing/blockers"
import { contactLabel, loadContact } from "../ContactPicker"
import { tr } from "../i18n"

export const READINESS_EMPTY =
  "Nothing blocks e-invoicing: every French business customer has what an e-invoice needs."

/** A blocker in plain words, by gate code. */
const BLOCKER_TEXT: Record<string, string> = {
  einvoice_data_missing: "E-invoicing data is missing.",
  customer_kind_missing: "The customer type is not recorded.",
  siren_invalid: "The SIREN is not valid.",
  siren_inactive: "The SIREN is ceased in the business registry.",
  einvoice_needs_review: "The territory needs a decision.",
  operation_category_missing: "The operation type is not stated.",
  registry_unconfirmed: "The SIREN is not confirmed against the business registry.",
  imported_original_missing: "The imported original is missing.",
}

export interface ReadinessItem {
  subject?: { contact_id?: string | null; document_id?: string | null; label?: string | null } | null
  blocker_code: string
  action?: { tool?: string | null; label?: string | null; params_hint?: unknown } | null
  last_document_date?: string | null
}

export interface ReadinessRow {
  key: string
  subjectKey: string
  label: string
  blocker: string
  lastDocumentDate: string | null
  action: { href: string; label: string }
}

const IDENTITY_TOOLS = new Set([
  "counterparty_identity_set",
  "counterparty_identity_lookup",
  "counterparty_territory_set",
])

function rowAction(item: ReadinessItem): { href: string; label: string } {
  const contactId = item.subject?.contact_id ?? null
  const documentId = item.subject?.document_id ?? null
  const tool = item.action?.tool ?? ""
  const label = item.action?.label ?? null
  if (documentId && tool === "drafts_update") {
    return { href: `/invoicing/editor/${documentId}`, label: label ?? tr("Open the draft") }
  }
  if (documentId && tool === "documents_update") {
    return { href: `/invoicing/document/${documentId}`, label: label ?? tr("Open the document") }
  }
  const identity = identityHref({ contactId, documentId })
  if (identity && (IDENTITY_TOOLS.has(tool) || contactId)) {
    return { href: identity, label: label ?? tr("Open the customer identity") }
  }
  if (documentId) return { href: `/invoicing/document/${documentId}`, label: label ?? tr("Open the document") }
  return { href: "/invoicing/documents/all", label: label ?? tr("Open the documents") }
}

/** Contact id -> the name a person reads, for the contacts that resolved. */
export type ContactNames = ReadonlyMap<string, string>

/** A customer's name, never its id: the contact's own name when it resolves, else the name stored
 *  on its documents (the item's label), else a plain placeholder. */
export function readinessLabel(item: ReadinessItem, names?: ContactNames): string {
  const contactId = item.subject?.contact_id ?? null
  const resolved = contactId ? names?.get(contactId) : undefined
  if (resolved) return resolved
  const stored = item.subject?.label?.trim()
  if (stored) return stored
  return contactId ? tr("Customer (name not recorded)") : tr("Document {{id}}", { id: item.subject?.document_id ?? "?" })
}

export function readinessRows(
  result: { items?: ReadinessItem[] } | null | undefined,
  names?: ContactNames,
): ReadinessRow[] {
  const items = result?.items ?? []
  return items.map((item, i) => {
    const contactId = item.subject?.contact_id ?? null
    const documentId = item.subject?.document_id ?? null
    const label = readinessLabel(item, names)
    const subjectKey = String(contactId ?? documentId ?? i)
    return {
      key: `${subjectKey}:${item.blocker_code}:${i}`,
      subjectKey,
      label,
      blocker: tr(BLOCKER_TEXT[item.blocker_code] ?? "E-invoicing data is missing."),
      lastDocumentDate: item.last_document_date ? String(item.last_document_date).slice(0, 10) : null,
      action: rowAction(item),
    }
  })
}

export interface ReadinessGroup {
  key: string
  label: string
  lastDocumentDate: string | null
  rows: ReadinessRow[]
}

/** The rows of one customer (or document) together, in first-seen order, so a customer with two
 *  gaps reads as one customer with two things to fix. */
export function readinessGroups(rows: ReadinessRow[]): ReadinessGroup[] {
  const groups = new Map<string, ReadinessGroup>()
  for (const row of rows) {
    const g = groups.get(row.subjectKey)
    if (g) {
      g.rows.push(row)
      if (row.lastDocumentDate && (!g.lastDocumentDate || row.lastDocumentDate > g.lastDocumentDate)) {
        g.lastDocumentDate = row.lastDocumentDate
      }
    } else {
      groups.set(row.subjectKey, {
        key: row.subjectKey,
        label: row.label,
        lastDocumentDate: row.lastDocumentDate,
        rows: [row],
      })
    }
  }
  return [...groups.values()]
}

async function loadReadiness(): Promise<ReadinessRow[]> {
  const r = await app.invokeTool<{ items?: ReadinessItem[]; status?: string; error?: { message?: string } }>(
    "einvoicing_readiness",
    { limit: 200 },
  )
  if (r && r.status === "error") throw new Error(r.error?.message ?? tr("Readiness could not be loaded."))
  // Resolve each contact as the signed-in user (kernel contacts, RLS applies); one that does not
  // resolve keeps its stored name.
  const ids = [...new Set((r?.items ?? []).map((i) => i.subject?.contact_id).filter((x): x is string => !!x))]
  const names = new Map<string, string>()
  await Promise.all(
    ids.map(async (id) => {
      const c = await loadContact(id)
      if (c) names.set(id, contactLabel(c))
    }),
  )
  return readinessRows(r, names)
}

export const InvoicingReadiness: Component<{ entityId?: string }> = () => {
  const [rows] = createResource(loadReadiness)
  return (
    <div data-testid="invoicing-readiness" class="flex flex-col gap-3 p-5 text-[12.5px]">
      <h1 class="text-[15px] font-semibold text-text">{tr("E-invoicing readiness")}</h1>
      <Show when={rows.error}>
        <div data-testid="invoicing-readiness-unavailable" class="text-text-secondary">
          {tr("Readiness could not be loaded.")}
        </div>
      </Show>
      <Show when={!rows.loading && !rows.error}>
        <Show
          when={(rows() ?? []).length > 0}
          fallback={
            <div data-testid="invoicing-readiness-empty" class="text-text-tertiary">
              {tr(READINESS_EMPTY)}
            </div>
          }
        >
          <ul class="flex flex-col gap-2">
            <For each={readinessGroups(rows() ?? [])}>
              {(group) => (
                <li
                  data-testid={`readiness-group-${group.key}`}
                  class="flex flex-col gap-2 rounded-md border border-border-subtle bg-surface px-4 py-3"
                >
                  <div class="flex items-baseline justify-between gap-3">
                    <span class="font-medium text-text">{group.label}</span>
                    <Show when={group.lastDocumentDate}>
                      <span class="shrink-0 text-[11.5px] text-text-tertiary">
                        {tr("Last document {{date}}", { date: group.lastDocumentDate ?? "" })}
                      </span>
                    </Show>
                  </div>
                  <For each={group.rows}>
                    {(row) => (
                      <div data-testid={`readiness-row-${row.key}`} class="flex items-center justify-between gap-3">
                        <span class="text-text-secondary">{row.blocker}</span>
                        <a
                          data-testid="readiness-row-action"
                          class="shrink-0 cursor-pointer text-accent hover:underline"
                          href={row.action.href}
                          onClick={(e) => {
                            e.preventDefault()
                            navigate(row.action.href)
                          }}
                        >
                          {row.action.label}
                        </a>
                      </div>
                    )}
                  </For>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}
