// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Pending Approval tab (/invoicing/pending-approval, the sidebar's "Pending Approval" row):
// the invoicing requests waiting for a decision, oldest first, through the app's own
// pending_approvals_list (the same rows the sidebar counts). A row that acts on a document opens
// it: a draft made from a card, a milestone or a retainer month is issued from its page, and
// issuing it there withdraws the request. Calm: one quiet list, no alarm colours.

import { app, navigate } from "@liaison/host"
import { type Component, createResource, For, Show } from "solid-js"
import { tr } from "./i18n"
import { Button } from "./kit"

export interface PendingRow {
  id: string
  tool_name: string
  summary: string
  created_at: string
  document_id: string | null
}

/** Oldest first: the request that has waited longest is read first. */
export function orderedPending(rows: PendingRow[]): PendingRow[] {
  return [...rows].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
}

/** The day a request was made, as YYYY-MM-DD. */
function dayOf(at: string): string {
  return String(at ?? "").slice(0, 10)
}

async function loadPending(): Promise<PendingRow[]> {
  const res = await app.invokeTool<{ items?: PendingRow[] } | PendingRow[]>(
    "pending_approvals_list",
    {},
  )
  const items = Array.isArray(res) ? res : (res?.items ?? [])
  return orderedPending(items)
}

export const InvoicingPendingApprovals: Component<{ entityId?: string }> = () => {
  const [rows] = createResource(loadPending)
  return (
    <div data-testid="invoicing-pending" class="flex flex-col gap-3 p-5">
      <h1 class="text-[15px] font-semibold text-text">{tr("Pending Approval")}</h1>
      <Show
        when={(rows() ?? []).length > 0}
        fallback={
          <div data-testid="invoicing-pending-empty" class="text-[12.5px] text-text-tertiary">
            {tr("Nothing is waiting.")}
          </div>
        }
      >
        <ul class="flex flex-col gap-2">
          <For each={rows()}>
            {(row) => (
              <li
                data-testid={`pending-row-${row.id}`}
                class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-subtle bg-surface px-4 py-3 text-[12.5px]"
              >
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="text-text">{row.summary || row.tool_name}</span>
                  <span class="text-[11.5px] text-text-tertiary">
                    {tr("Asked on {{day}}", { day: dayOf(row.created_at) })}
                  </span>
                </div>
                <Show when={row.document_id}>
                  {(docId) => (
                    <Button
                      testid={`pending-open-${row.id}`}
                      onClick={() => navigate(`/invoicing/document/${docId()}`)}
                    >
                      {tr("Open")}
                    </Button>
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
