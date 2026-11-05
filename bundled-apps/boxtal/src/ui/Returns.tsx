// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Returns — the inbound return-shipment worklist. Parcels coming BACK to us,
// most often agent-initiated against a proforma invoice. The return label is
// gated by the user, so agent-prepared rows surface a subtle accent left-border
// and stay in "Awaiting approval" until someone authorises the label.
//
// Composes only the shared Boxtal kit (kit.tsx) and the kernel charcoal theme
// tokens — visually identical to the invoicing app. Data flows through the
// host bridge (app.invokeTool) wrapped in a safe empty shape.
import { type Component, Show } from "solid-js"
import { app } from "@liaison/host"
import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import {
  Badge,
  Button,
  cx,
  EmptyState,
  formatQueueDate,
  formatQueueParcels,
  formatQueueTimestamp,
  formatWeight,
  CategoryBadge,
  OrderStatusBadge,
  PageHeader,
  TrackingStatusBadge,
} from "./kit"

interface ReturnRow {
  id: string
  customer: string | null
  reason: string | null
  proforma_ref: string | null
  /** The proforma's number; null when it could not be resolved (the id is never shown). */
  proforma_number: string | null
  order_status: string | null
  tracking_status: string | null
  label_ready: boolean
  created_by: "agent" | "user"
  /** The facts every Boxtal worklist shows, rendered by the shared QueueFactCells (kit.tsx):
   *  a return is a parcel like any other and the operator needs the same numbers for it. */
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

async function fetchReturns(): Promise<ReturnRow[]> {
  try {
    const res = await app.invokeTool<{ rows: ReturnRow[] }>("returns_list", {})
    return res.rows ?? []
  } catch {
    return []
  }
}

export const Returns: Component = () => {
  const [rows] = app.createResource(fetchReturns)
  const list = () => rows() ?? []

  return (
    <div class="flex h-full min-h-0 flex-col" data-testid="boxtal-returns">
      <PageHeader
        title="Returns"
        count={list().length}
        subtitle="Inbound return shipments"
        testid="boxtal-returns-header"
        actions={
          <Button variant="primary" testid="boxtal-prepare-return">
            Prepare return
          </Button>
        }
      />

      <div class="min-h-0 flex-1 overflow-auto">
        <Show
          when={list().length > 0}
          fallback={
            <EmptyState title="No returns in progress" testid="boxtal-returns-empty">
              No returns in progress. Ask the agent to prepare one, or click Prepare return.
            </EmptyState>
          }
        >
          <div data-testid="boxtal-returns-table">
            <CardTable
              rows={list()}
              rowKey={(row) => row.id}
              rowTestid={(row) => `boxtal-return-row-${row.id}`}
              columns={returnColumns()}
            />
          </div>
        </Show>
      </div>
    </div>
  )

  function returnColumns(): Array<CardTableColumn<ReturnRow>> {
    const isAgent = (row: ReturnRow) => row.created_by === "agent"
    return [
      {
        key: "customer",
        header: "Customer",
        role: "anchor",
        cell: (row) => (
          <span class={cx(isAgent(row) && "border-l-2 border-l-accent pl-2")}>
            {row.customer ?? "-"}
          </span>
        ),
      },
      { key: "reason", header: "Reason", role: "secondary", cell: (row) => row.reason ?? "-" },
      {
        key: "status",
        header: "Status",
        role: "meta",
        cell: (row) => (
          <span class="flex flex-wrap items-center gap-1.5">
            <OrderStatusBadge status={row.order_status} testid={`boxtal-return-order-status-${row.id}`} />
            <TrackingStatusBadge
              status={row.tracking_status}
              testid={`boxtal-return-tracking-status-${row.id}`}
            />
          </span>
        ),
      },
      {
        key: "created-by",
        header: "Created by",
        role: "meta",
        cell: (row) => (
          <Show
            when={isAgent(row)}
            fallback={
              <Badge tone="neutral" testid={`boxtal-return-creator-${row.id}`}>
                User
              </Badge>
            }
          >
            <Badge tone="accent" dot testid={`boxtal-return-creator-${row.id}`}>
              Agent
            </Badge>
          </Show>
        ),
      },
      {
        key: "label",
        header: "Label",
        role: "meta",
        cell: (row) => (
          <Show
            when={row.label_ready}
            fallback={
              <Badge tone="warning" dot testid={`boxtal-return-label-pending-${row.id}`}>
                Awaiting approval
              </Badge>
            }
          >
            <Button
              variant="ghost"
              testid={`boxtal-return-label-${row.id}`}
              class="px-2 py-1"
              title="Download return label"
            >
              Download label
            </Button>
          </Show>
        ),
      },
      {
        key: "proforma",
        // The document the return is anchored on: a proforma, an invoice or a credit note.
        header: "Document",
        role: "fold",
        cell: (row) => (
          <Show when={row.proforma_ref} fallback={<span class="text-text-tertiary">-</span>}>
            <Button
              variant="ghost"
              testid={`boxtal-return-proforma-${row.id}`}
              class="px-2 py-1 font-mono"
              title="Open document"
            >
              {row.proforma_number ?? "Open"}
            </Button>
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
        cell: (row) => <CategoryBadge category={row.category} testid={`boxtal-return-${row.id}-category`} />,
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
          <Show when={row.package_count} fallback={<span class="text-text-tertiary">-</span>}>
            <span class="flex flex-col leading-[1.3]">
              <span>{row.package_count}</span>
              <span class="font-mono text-[10.5px] tabular-nums text-text-tertiary">
                {formatQueueParcels(row.parcels)}
              </span>
            </span>
          </Show>
        ),
      },
    ]
  }
}
