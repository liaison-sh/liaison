// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The prep row's "Address differs" chip and its inline fold: the order's own ship-to and the
// customer's verified delivery address side by side, and a pick between them. Shown only when the
// two differ (prep-row-logic.ts addressDiffers); a customer with no verified address never sees
// any of it. The pick runs prep_set_address_choice; until it is made the row cannot ship.
//
// Bundling rule (kit.tsx): explicit props only, no spread onto a host element.
import { type Component, For, Show } from "solid-js"
import { tr } from "./i18n"
import { Badge, Button, cx } from "./kit"
import type { PrepAddress, PrepAddressPick, PrepRow } from "./prep-row-logic"

function addressLines(a: PrepAddress | null | undefined): string[] {
  if (!a) return []
  const who = [a.company, a.name].filter((v) => v && v.trim()).join(" / ")
  const locality = [a.postalCode, a.city].filter((v) => v && v.trim()).join(" ")
  return [who, a.street ?? "", locality, [a.state, a.countryIsoCode].filter((v) => v && v.trim()).join(" ")].filter(
    (l) => l.trim() !== "",
  )
}

/** The chip: a button that opens the fold. Warning tone until a person picks. */
export const AddressDiffersChip: Component<{ row: PrepRow; open: boolean; onToggle: () => void }> = (props) => {
  const picked = () => props.row.address_check?.choice?.pick ?? null
  return (
    <button
      type="button"
      class="inline-flex rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent-tint"
      data-testid={`boxtal-prep-address-differs-${props.row.order_key}`}
      aria-expanded={props.open}
      title={tr("The order's address and the customer's verified address are not the same place")}
      onClick={() => props.onToggle()}
    >
      <Badge tone={picked() ? "neutral" : "warning"} dot>
        {picked() === "order"
          ? tr("Address differs: order's")
          : picked() === "verified"
            ? tr("Address differs: verified")
            : tr("Address differs")}
      </Badge>
    </button>
  )
}

/** The fold: both addresses side by side and the two buttons. */
export const AddressDiffersFold: Component<{
  row: PrepRow
  busy: boolean
  onPick: (pick: PrepAddressPick) => void
}> = (props) => {
  const check = () => props.row.address_check
  const picked = () => check()?.choice?.pick ?? null
  const side = (pick: PrepAddressPick) => ({
    pick,
    title: pick === "order" ? tr("Order address") : tr("Verified address"),
    lines: addressLines(pick === "order" ? check()?.order_address : check()?.verified_address),
    action: pick === "order" ? tr("Use order address") : tr("Use verified address"),
  })
  return (
    <div
      class="flex flex-col gap-2 px-1.5 py-2"
      data-testid={`boxtal-prep-address-fold-${props.row.order_key}`}
    >
      <p class="text-[11.5px] text-text-secondary">
        {picked()
          ? tr("A person picked the address below. It holds until either address changes.")
          : tr("The order's address and the customer's verified address differ. Pick the one this parcel goes to.")}
      </p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <For each={[side("order"), side("verified")]}>
          {(s) => (
            <div
              class={cx(
                "flex flex-col gap-1 rounded-md border p-2",
                picked() === s.pick ? "border-accent-border" : "border-border-subtle",
              )}
              data-testid={`boxtal-prep-address-${s.pick}-${props.row.order_key}`}
            >
              <span class="text-[11px] font-medium text-text-tertiary">{s.title}</span>
              <For each={s.lines}>{(l) => <span class="text-[12px] leading-[1.35] text-text">{l}</span>}</For>
              <Show when={s.pick === "verified" && check()?.verified_address?.verified_at}>
                <span class="text-[10.5px] text-text-tertiary">
                  {check()?.verified_address?.verified_by_name
                    ? tr("Verified {{date}} by {{who}}", {
                        date: (check()?.verified_address?.verified_at ?? "").slice(0, 10),
                        who: check()?.verified_address?.verified_by_name ?? "",
                      })
                    : tr("Verified {{date}}", { date: (check()?.verified_address?.verified_at ?? "").slice(0, 10) })}
                </span>
              </Show>
              <div class="pt-1">
                <Button
                  variant={picked() === s.pick ? "primary" : "secondary"}
                  class="px-2 py-1 text-[11.5px]"
                  disabled={props.busy || picked() === s.pick}
                  testid={`boxtal-prep-address-use-${s.pick}-${props.row.order_key}`}
                  onClick={() => props.onPick(s.pick)}
                >
                  {s.action}
                </Button>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
