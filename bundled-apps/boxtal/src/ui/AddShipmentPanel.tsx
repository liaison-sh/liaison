// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Add shipment: a prep row for a parcel with NO Shopify order behind it.
//
// A repaired unit going back to its owner and a sample going to a dealer are real shipping work
// that the order-driven worklist cannot see, because there is no order. The operator describes the
// parcel here, the app issues its nominal proforma, and the row then behaves like every other row.
//
// Three steps, on one panel rather than a wizard: the operator is standing at a bench with the box
// in front of them and needs to see everything they typed at once.
//
// kit.tsx primitives only; no {...rest} spreads onto host elements.

import { app } from "@liaison/host"
import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { Button, cx, inputClass } from "./kit"
import { CATEGORY_LABELS, type PrepRow } from "./prep-row-logic"

/** What `prep_order_prefill` hands back. Named rather than inlined as a generic: the tool-closure
 *  oracle scans for the tool NAME next to invokeTool, and a nested generic hides it. */
interface OrderPrefillResult {
  recipient?: RecipientDraft | null
  items?: Array<{ name: string; quantity: number; external_id?: string | null }>
}

/** What `packages_list` hands back, trimmed to the fields the item picker needs. */
interface CatalogResult {
  profiles?: Array<{
    product_source?: string | null
    product_id?: string | null
    short_code?: string | null
  }>
  local_products?: Array<{ sku?: string | null; label?: string | null }>
}

/** One pickable catalog entry: a known (product_source, product_id) pair the package resolver can
 *  actually join a shipping profile against, labelled for the select. */
export interface CatalogOption {
  value: string
  label: string
  product_source: string
  product_id: string
}

/** Turns a `packages_list` response into the item picker's option list, de-duplicated by
 *  (product_source, product_id) and sorted by label. Pure, so it is testable without the tool
 *  call: local products win the label over a bare shipping profile for the same SKU, since a
 *  human-entered product name reads better than a profile's short code. */
export function catalogOptionsFrom(res: CatalogResult | null | undefined): CatalogOption[] {
  const byKey = new Map<string, CatalogOption>()
  for (const p of res?.profiles ?? []) {
    if (!p.product_source || !p.product_id) continue
    const key = `${p.product_source}:${p.product_id}`
    byKey.set(key, {
      value: key,
      product_source: p.product_source,
      product_id: p.product_id,
      label: p.short_code || key,
    })
  }
  for (const l of res?.local_products ?? []) {
    if (!l.sku) continue
    const key = `local:${l.sku}`
    byKey.set(key, {
      value: key,
      product_source: "local",
      product_id: l.sku,
      label: l.label || l.sku,
    })
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label))
}

interface ItemDraft {
  name: string
  quantity: number
  /** "" when the item is free-typed rather than picked from the catalog. */
  catalogValue: string
  external_id: string
  product_source: string
}

const BLANK_ITEM: ItemDraft = {
  name: "",
  quantity: 1,
  catalogValue: "",
  external_id: "",
  product_source: "",
}

interface RecipientDraft {
  name: string
  company: string
  email: string
  phone: string
  street: string
  city: string
  postalCode: string
  countryIsoCode: string
}

const EMPTY_RECIPIENT: RecipientDraft = {
  name: "",
  company: "",
  email: "",
  phone: "",
  street: "",
  city: "",
  postalCode: "",
  countryIsoCode: "",
}

/** The fields a carrier will not print a label without, in the order they are asked for. Email is
 *  in this list (not just a nicety) because the row's proforma is issued through invoicing, and
 *  invoicing REFUSES to issue any document without a non-blank recipient email
 *  (counterpartyCompletenessError, bundled-apps/invoicing/src/issue.ts) — submitting without one
 *  used to reach the server and fail with a 500 the operator could not have predicted from the
 *  form. Catching it here, before submit, keeps the failure a disabled button with a reason. */
export const REQUIRED_RECIPIENT_LABELS: ReadonlyArray<[keyof RecipientDraft, string]> = [
  ["name", "name"],
  ["street", "street"],
  ["city", "city"],
  ["postalCode", "postal code"],
  ["countryIsoCode", "country"],
  ["email", "email"],
]

/** What is still missing before this panel can submit, in operator words. Pure, so it is testable. */
export function missingRecipientFields(r: RecipientDraft): string[] {
  return REQUIRED_RECIPIENT_LABELS.filter(([field]) => !r[field].trim()).map(([, label]) => label)
}

export const AddShipmentPanel: Component<{
  onClose: () => void
  onCreated: (row: PrepRow) => void
}> = (props) => {
  const [orderNumber, setOrderNumber] = createSignal("")
  const [recipient, setRecipient] = createSignal<RecipientDraft>({ ...EMPTY_RECIPIENT })
  const [items, setItems] = createSignal<ItemDraft[]>([{ ...BLANK_ITEM }])
  const [category, setCategory] = createSignal<"repair" | "gift">("repair")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [catalog, setCatalog] = createSignal<CatalogOption[]>([])
  const [catalogError, setCatalogError] = createSignal<string | null>(null)

  // Load the catalog once, when the panel opens: the item picker offers what the resolver already
  // knows how to ship (a shipping profile or a local product), rather than a reference typed from
  // memory that has to happen to match one exactly, or the row lands needing a fix. The free-text
  // reference below stays as the escape hatch for a genuinely one-off item.
  onMount(() => {
    void (async () => {
      try {
        const res = await app.invokeTool<CatalogResult>("packages_list", {})
        setCatalog(catalogOptionsFrom(res))
      } catch (err) {
        setCatalogError(err instanceof Error ? err.message : String(err))
      }
    })()
  })

  const patchRecipient = (patch: Partial<RecipientDraft>): void => {
    setRecipient((r) => ({ ...r, ...patch }))
  }
  const patchItem = (i: number, patch: Partial<ItemDraft>): void => {
    setItems((list) => list.map((it, n) => (n === i ? { ...it, ...patch } : it)))
  }
  const pickCatalogItem = (i: number, value: string): void => {
    const picked = catalog().find((c) => c.value === value)
    if (!picked) {
      patchItem(i, { catalogValue: "", external_id: "", product_source: "" })
      return
    }
    const current = items()[i]
    patchItem(i, {
      catalogValue: picked.value,
      external_id: picked.product_id,
      product_source: picked.product_source,
      ...(current?.name.trim() === "" ? { name: picked.label } : {}),
    })
  }

  const filledItems = (): ItemDraft[] =>
    items().filter((i) => i.name.trim() !== "" && i.quantity > 0)
  const missing = (): string[] => missingRecipientFields(recipient())
  const canSubmit = (): boolean => !busy() && missing().length === 0 && filledItems().length > 0

  const submit = async (): Promise<void> => {
    if (!canSubmit()) return
    setBusy(true)
    setError(null)
    try {
      const r = recipient()
      const res = await app.invokeTool<{ row: PrepRow | null }>("prep_add_shipment", {
        category: category(),
        ...(orderNumber().trim() ? { from_order_number: orderNumber().trim() } : {}),
        recipient: {
          name: r.name,
          ...(r.company ? { company: r.company } : {}),
          ...(r.email ? { email: r.email } : {}),
          ...(r.phone ? { phone: r.phone } : {}),
          street: r.street,
          city: r.city,
          postalCode: r.postalCode,
          countryIsoCode: r.countryIsoCode.toUpperCase(),
        },
        items: filledItems().map((i) => ({
          name: i.name,
          quantity: i.quantity,
          ...(i.external_id
            ? { external_id: i.external_id, product_source: i.product_source || "shopify" }
            : {}),
        })),
      })
      if (res?.row) props.onCreated(res.row)
      else
        setError(
          "The shipment was created but its row could not be read back. Pull orders to see it.",
        )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // Prefill from an existing order: the same lookup the tool does, run early so the operator can
  // see and correct the address before submitting rather than after.
  const prefill = async (): Promise<void> => {
    const number = orderNumber().trim()
    if (!number || busy()) return
    setBusy(true)
    setError(null)
    try {
      const res = await app.invokeTool<OrderPrefillResult>("prep_order_prefill", {
        order_number: number,
      })
      if (res?.recipient) patchRecipient({ ...EMPTY_RECIPIENT, ...res.recipient })
      if (res?.items?.length) {
        const cat = catalog()
        setItems(
          res.items.map((i) => {
            const external_id = i.external_id ?? ""
            // A prefilled Shopify line already carries a catalog match when the catalog loaded in
            // time; select it so the item reads exactly like an operator-picked one.
            const matched = external_id
              ? cat.find((c) => c.product_source === "shopify" && c.product_id === external_id)
              : undefined
            return {
              name: i.name,
              quantity: i.quantity,
              external_id,
              product_source: matched ? matched.product_source : external_id ? "shopify" : "",
              catalogValue: matched ? matched.value : "",
            }
          }),
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      class="mx-4 mt-3 rounded-sm border border-border bg-surface px-4 py-3"
      data-testid="boxtal-prep-add-shipment-panel"
    >
      <div class="mb-2 flex items-center justify-between">
        <h2 class="text-[13px] font-semibold text-text">Add a shipment with no order</h2>
        <Button
          variant="ghost"
          testid="boxtal-prep-add-shipment-close"
          onClick={() => props.onClose()}
        >
          Close
        </Button>
      </div>

      <div class="flex flex-wrap items-end gap-2">
        <div class="w-48">
          <label class="mb-1 block text-[11px] text-text-tertiary" for="boxtal-add-order">
            Copy from order
          </label>
          <input
            id="boxtal-add-order"
            type="text"
            placeholder="#1042"
            class={inputClass}
            data-testid="boxtal-prep-add-order-number"
            value={orderNumber()}
            onInput={(e) => setOrderNumber(e.currentTarget.value)}
          />
        </div>
        <Button
          variant="secondary"
          disabled={busy() || orderNumber().trim() === ""}
          testid="boxtal-prep-add-prefill"
          title="Fill the address and the items from that order"
          onClick={() => void prefill()}
        >
          Prefill
        </Button>
        <div class="w-44">
          <label class="mb-1 block text-[11px] text-text-tertiary" for="boxtal-add-category">
            Category
          </label>
          <select
            id="boxtal-add-category"
            class={inputClass}
            data-testid="boxtal-prep-add-category"
            value={category()}
            onChange={(e) => setCategory(e.currentTarget.value as "repair" | "gift")}
          >
            <option value="repair">{CATEGORY_LABELS.repair}</option>
            <option value="gift">{CATEGORY_LABELS.gift}</option>
          </select>
        </div>
      </div>

      <div class="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <For
          each={
            [
              ["name", "Recipient name"],
              ["company", "Company"],
              ["street", "Street"],
              ["city", "City"],
              ["postalCode", "Postal code"],
              ["countryIsoCode", "Country code"],
              ["email", "Email"],
              ["phone", "Phone"],
            ] as ReadonlyArray<[keyof RecipientDraft, string]>
          }
        >
          {([field, label]) => (
            <div>
              <label class="mb-1 block text-[11px] text-text-tertiary" for={`boxtal-add-${field}`}>
                {label}
              </label>
              <input
                id={`boxtal-add-${field}`}
                type="text"
                class={inputClass}
                data-testid={`boxtal-prep-add-${field}`}
                value={recipient()[field]}
                onInput={(e) =>
                  patchRecipient({ [field]: e.currentTarget.value } as Partial<RecipientDraft>)
                }
              />
            </div>
          )}
        </For>
      </div>

      <div class="mt-3">
        <div class="mb-1 text-[11px] text-text-tertiary">What is in the parcel</div>
        <Show when={catalogError()}>
          <div class="mb-1 text-[11px] text-warning" data-testid="boxtal-prep-add-catalog-error">
            The catalog could not be loaded, so items can only be typed as a custom reference:{" "}
            {catalogError()}
          </div>
        </Show>
        <For each={items()}>
          {(item, i) => (
            <div class="mb-1 flex items-center gap-2">
              <input
                type="text"
                placeholder="Item"
                class={cx(inputClass, "!w-56")}
                data-testid={`boxtal-prep-add-item-name-${i()}`}
                value={item.name}
                onInput={(e) => patchItem(i(), { name: e.currentTarget.value })}
              />
              <input
                type="text"
                inputmode="numeric"
                placeholder="Qty"
                class={cx(inputClass, "!w-16")}
                data-testid={`boxtal-prep-add-item-qty-${i()}`}
                value={String(item.quantity)}
                onInput={(e) => patchItem(i(), { quantity: Number(e.currentTarget.value) || 0 })}
              />
              <select
                class={cx(inputClass, "!w-48")}
                data-testid={`boxtal-prep-add-item-catalog-${i()}`}
                title="Pick the product this item ships as, so it resolves to a shipping profile"
                value={item.catalogValue}
                onChange={(e) => pickCatalogItem(i(), e.currentTarget.value)}
              >
                <option value="">Custom (type a reference)</option>
                <For each={catalog()}>{(c) => <option value={c.value}>{c.label}</option>}</For>
              </select>
              <Show when={item.catalogValue === ""}>
                <input
                  type="text"
                  placeholder="Reference (optional)"
                  class={cx(inputClass, "!w-40")}
                  data-testid={`boxtal-prep-add-item-ref-${i()}`}
                  value={item.external_id}
                  onInput={(e) =>
                    patchItem(i(), {
                      external_id: e.currentTarget.value,
                      product_source: "shopify",
                    })
                  }
                />
              </Show>
            </div>
          )}
        </For>
        <Button
          variant="ghost"
          testid="boxtal-prep-add-item"
          onClick={() => setItems((list) => [...list, { ...BLANK_ITEM }])}
        >
          Add an item
        </Button>
      </div>

      <div class="mt-3 flex items-center gap-3">
        <Button
          variant="primary"
          disabled={!canSubmit()}
          testid="boxtal-prep-add-submit"
          title={
            missing().length > 0
              ? `The recipient is missing its ${missing().join(", ")}.`
              : filledItems().length === 0
                ? "List what is physically in the parcel."
                : "Create the row and issue its proforma"
          }
          onClick={() => void submit()}
        >
          {busy() ? "Working" : "Create shipment"}
        </Button>
        <Show when={missing().length > 0}>
          <span class="text-[11.5px] text-text-tertiary" data-testid="boxtal-prep-add-missing">
            {`Still needed: ${missing().join(", ")}`}
          </span>
        </Show>
        <Show when={error()}>
          <span class="text-[11.5px] text-error" data-testid="boxtal-prep-add-error">
            {error()}
          </span>
        </Show>
      </div>
    </div>
  )
}
