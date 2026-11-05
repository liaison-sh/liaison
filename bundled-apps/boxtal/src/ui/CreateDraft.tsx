// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CreateDraft — quote → review → approval-preview → submit. Thin glue over
// shipment_draft_create / quote / create_shipment. Two-gate framing: the draft
// must resolve (no unresolved lines, no blocked customs articles, complete
// recipient) AND a carrier offer must be picked before the submit posts to the
// approval gate. Restyled onto the shared Boxtal kit so it reads identically to
// the invoicing editor: quiet cards, one accent, tabular figures, real fields.
import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { app } from "@liaison/host"
import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import {
  Button,
  Card,
  cx,
  Field,
  formatWeight,
  inputClass,
  Money,
  PageHeader,
  SectionLabel,
} from "./kit"

interface DraftState {
  document_ref: string
  /** The invoice's number, the header's label; null while it has none. */
  document_number?: string | null
  parcels: Array<{ length: number; width: number; height: number; weight: number }>
  customsArticles: Array<{
    description: string
    quantity: number
    unitWeight: number | null
    tariffNumber: string | null
    blocked?: boolean
  }>
  unresolved: Array<{ reason: string }>
  recipient: string
  route: string
  recipient_country?: string | null
}

/** The structured recipient address the create form collects (B1). */
export interface RecipientAddressForm {
  name: string
  phone: string
  email: string
  street: string
  city: string
  postalCode: string
  countryIsoCode: string
}

/** The recipient address is complete enough to create when these are non-empty. */
export function recipientAddressComplete(a: RecipientAddressForm): boolean {
  return Boolean(
    a.phone.trim() &&
      a.street.trim() &&
      a.city.trim() &&
      a.postalCode.trim() &&
      a.countryIsoCode.trim() &&
      a.name.trim(),
  )
}

interface Offer {
  offer_code: string
  carrier: string
  price_ht: number
  price_ttc: number
  currency: string
  delivery_date: string | null
}

/**
 * A draft is submittable only when fully resolved, with no blocked articles AND
 * a complete recipient address (the backend hard-fails without one — B1).
 */
export function canSubmit(
  draft: DraftState | null,
  offerCode: string | null,
  recipient?: RecipientAddressForm,
): boolean {
  if (!draft || !offerCode) return false
  if (draft.unresolved.length > 0) return false
  if (draft.customsArticles.some((a) => a.blocked)) return false
  if (recipient && !recipientAddressComplete(recipient)) return false
  return true
}

const EMPTY_RECIPIENT: RecipientAddressForm = {
  name: "",
  phone: "",
  email: "",
  street: "",
  city: "",
  postalCode: "",
  countryIsoCode: "",
}

function fmtDeliveryDate(iso: string | null): string {
  if (!iso) return "-"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" })
}

export const CreateDraft: Component<{ entityId?: string; documentRef?: string }> = (props) => {
  const [draft, setDraft] = createSignal<DraftState | null>(null)
  const [offers, setOffers] = createSignal<Offer[]>([])
  const [selectedOffer, setSelectedOffer] = createSignal<string | null>(null)
  const [submitting, setSubmitting] = createSignal(false)
  const [recipient, setRecipient] = createSignal<RecipientAddressForm>({ ...EMPTY_RECIPIENT })
  // The server's own message for a failed step (a price that rose, a missing
  // sender address). Every call below used to swallow it, so a refused buy
  // looked like a click that did nothing.
  const [note, setNote] = createSignal<{ text: string; isError: boolean } | null>(null)
  const failed = (e: unknown, fallback: string) =>
    setNote({ text: e instanceof Error && e.message ? e.message : fallback, isError: true })

  // The kernel tab host passes the URL `:documentRef` param as `entityId` (the
  // framework runtime contract). Fall back to `documentRef` for direct/unit usage.
  const documentRef = (): string => props.entityId ?? props.documentRef ?? ""

  const setField = (k: keyof RecipientAddressForm, v: string) =>
    setRecipient((r) => ({ ...r, [k]: v }))

  const loadDraft = async () => {
    setNote(null)
    try {
      const d = await app.invokeTool<DraftState>("shipment_draft_create", {
        document_ref: documentRef(),
      })
      setDraft(d)
      // Pre-fill the recipient name + country from the invoice snapshot.
      setRecipient((r) => ({
        ...r,
        name: r.name || d.recipient || "",
        countryIsoCode: r.countryIsoCode || d.recipient_country || d.route || "",
      }))
    } catch (e) {
      setDraft(null)
      failed(e, "The draft could not be opened.")
    }
  }

  // Auto-load the draft on mount: navigating to /boxtal/create/:documentRef already
  // names the invoice to ship, so requiring a manual "Open draft" click left the
  // screen on a confusing "No draft loaded" empty state. shipment_draft_create is a
  // read (it derives parcels/customs/recipient from the invoice snapshot), so loading
  // it eagerly has no side effects. The "Open draft" button remains for an explicit reload.
  onMount(() => {
    if (documentRef()) void loadDraft()
  })

  const getQuotes = async () => {
    const d = draft()
    if (!d) return
    try {
      const r = recipient()
      // `from` (sender/ship-from) is org config — the server enriches an empty `from`
      // from the persisted sender address. `to` is this shipment's recipient: pass the
      // resolved destination so the live v1 cotation has a real route (an empty `to`
      // returns no offers). type → "particulier" (shipping to a consumer).
      const res = await app.invokeTool<{ offers: Offer[] }>("quote", {
        from: {},
        to: {
          country: r.countryIsoCode || d.recipient_country || d.route || "",
          postalCode: r.postalCode,
          city: r.city,
          type: "particulier",
        },
        parcels: d.parcels,
        content_code: "10120",
      })
      setOffers(res.offers ?? [])
    } catch (e) {
      setOffers([])
      failed(e, "The carrier quote failed.")
    }
  }

  const submit = async () => {
    const offer = selectedOffer()
    const r = recipient()
    if (!offer || !recipientAddressComplete(r)) return
    setSubmitting(true)
    setNote(null)
    try {
      const res = await app.invokeTool<{ status?: string }>("create_shipment", {
        draft_id: documentRef(),
        offer_code: offer,
        recipient_phone: r.phone,
        recipient_address: {
          name: r.name,
          email: r.email || undefined,
          phone: r.phone,
          street: r.street,
          city: r.city,
          postalCode: r.postalCode,
          countryIsoCode: r.countryIsoCode,
        },
      })
      setNote({
        text:
          res?.status === "pending_approval"
            ? "Sent for approval. No label is bought until it is approved."
            : "Shipment created.",
        isError: false,
      })
    } catch (e) {
      failed(e, "The shipment could not be created.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div class="flex h-full min-h-0 flex-col" data-testid="boxtal-create-draft">
      <PageHeader
        title="Create shipment"
        subtitle={draft()?.document_number ? `Invoice ${draft()?.document_number}` : "Invoice"}
        actions={
          <Button variant="primary" testid="boxtal-open-draft" onClick={loadDraft}>
            Open draft
          </Button>
        }
      />

      {/* pb-dock-runway: the scroll end leaves room to lift "Create shipment"
          above the desktop chat dock's bar (index.css). */}
      <div class="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-dock-runway [--dock-pad-base:1rem]">
        <Show
          when={draft()}
          fallback={
            <div class="flex flex-col items-center justify-center gap-2.5 px-6 py-16 text-center">
              <p class="text-[13px] font-medium text-text-secondary">No draft loaded</p>
              <p class="max-w-xs text-[12px] text-text-tertiary">
                Open the draft to pull parcels, customs articles, and the recipient from the invoice
                snapshot.
              </p>
              <Show when={note()?.isError ? note() : null}>
                {(n) => (
                  <p data-testid="boxtal-create-load-error" role="alert" class="max-w-xs text-[12px] text-error">
                    {n().text}
                  </p>
                )}
              </Show>
            </div>
          }
        >
          {(d) => (
            <div class="flex flex-col gap-4">
              {/* Gate A — unresolved lines block the whole flow. */}
              <Show when={d().unresolved.length > 0}>
                <Card class="border-warning-border bg-warning-glow p-4" >
                  <div data-testid="boxtal-unresolved-block" class="flex flex-col gap-2.5">
                    <SectionLabel class="text-warning">
                      {d().unresolved.length} line{d().unresolved.length === 1 ? "" : "s"} need a
                      shipping profile
                    </SectionLabel>
                    <ul class="flex flex-col gap-1.5">
                      <For each={d().unresolved}>
                        {(u) => (
                          <li class="flex items-start gap-2 text-[12px] leading-relaxed text-warning">
                            <span class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-warning" />
                            <span>{u.reason}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                    <p class="text-[11px] text-text-tertiary">
                      Resolve every line in the invoice before this draft can be quoted.
                    </p>
                  </div>
                </Card>
              </Show>

              {/* Resolved body — recipient + parcels + customs + quotes. */}
              <Show when={d().unresolved.length === 0}>
                <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {/* Recipient address. */}
                  <Card class="p-4">
                    <fieldset data-testid="boxtal-recipient-form" class="flex flex-col gap-3">
                      <SectionLabel>Recipient address</SectionLabel>
                      <Field label="Name">
                        <input
                          class={inputClass}
                          placeholder="Recipient name"
                          value={recipient().name}
                          onInput={(e) => setField("name", e.currentTarget.value)}
                          data-testid="boxtal-recipient-name"
                        />
                      </Field>
                      <div class="grid grid-cols-2 gap-3">
                        <Field label="Phone" hint="E.164, e.g. +33…">
                          <input
                            class={inputClass}
                            placeholder="+33…"
                            value={recipient().phone}
                            onInput={(e) => setField("phone", e.currentTarget.value)}
                            data-testid="boxtal-recipient-phone"
                          />
                        </Field>
                        <Field label="Email">
                          <input
                            class={inputClass}
                            placeholder="name@example.com"
                            value={recipient().email}
                            onInput={(e) => setField("email", e.currentTarget.value)}
                            data-testid="boxtal-recipient-email"
                          />
                        </Field>
                      </div>
                      <Field label="Street">
                        <input
                          class={inputClass}
                          placeholder="Street and number"
                          value={recipient().street}
                          onInput={(e) => setField("street", e.currentTarget.value)}
                          data-testid="boxtal-recipient-street"
                        />
                      </Field>
                      <div class="grid grid-cols-[5rem_1fr_4rem] gap-3">
                        <Field label="Postal">
                          <input
                            class={inputClass}
                            placeholder="00000"
                            value={recipient().postalCode}
                            onInput={(e) => setField("postalCode", e.currentTarget.value)}
                            data-testid="boxtal-recipient-postal"
                          />
                        </Field>
                        <Field label="City">
                          <input
                            class={inputClass}
                            placeholder="City"
                            value={recipient().city}
                            onInput={(e) => setField("city", e.currentTarget.value)}
                            data-testid="boxtal-recipient-city"
                          />
                        </Field>
                        <Field label="ISO">
                          <input
                            class={cx(inputClass, "uppercase")}
                            placeholder="FR"
                            value={recipient().countryIsoCode}
                            onInput={(e) => setField("countryIsoCode", e.currentTarget.value)}
                            data-testid="boxtal-recipient-country"
                          />
                        </Field>
                      </div>
                    </fieldset>
                  </Card>

                  {/* Parcels. */}
                  <Card class="p-4">
                    <div class="flex flex-col gap-3">
                      <SectionLabel>Parcels</SectionLabel>
                      <div class="overflow-hidden rounded-md border border-border-subtle">
                        <CardTable
                          rows={d().parcels.map((p, i) => ({ ...p, index: i }))}
                          rowKey={(p) => String(p.index)}
                          columns={[
                            {
                              key: "parcel",
                              header: "Parcel",
                              role: "anchor",
                              cell: (p) => `#${p.index + 1}`,
                            },
                            {
                              key: "dims",
                              header: "L × W × H",
                              role: "secondary",
                              cell: (p) => (
                                <span class="font-mono tabular-nums">
                                  {p.length} × {p.width} × {p.height} cm
                                </span>
                              ),
                            },
                            {
                              key: "weight",
                              header: "Weight",
                              role: "meta",
                              numeric: true,
                              align: "right",
                              cell: (p) => formatWeight(p.weight),
                            },
                          ]}
                        />
                      </div>
                    </div>
                  </Card>
                </div>

                {/* Customs articles. */}
                <Card class="p-4">
                  <div class="flex flex-col gap-3">
                    <SectionLabel>Customs articles</SectionLabel>
                    <Show
                      when={d().customsArticles.length > 0}
                      fallback={
                        <p class="text-[12px] text-text-tertiary">
                          No customs declaration required for this route.
                        </p>
                      }
                    >
                      <div class="overflow-hidden rounded-md border border-border-subtle">
                        <CardTable
                          rows={d().customsArticles.map((a, i) => ({ ...a, index: i }))}
                          rowKey={(a) => String(a.index)}
                          columns={[
                            {
                              key: "description",
                              header: "Description",
                              role: "anchor",
                              cell: (a) => <span class={cx(a.blocked && "text-warning")}>{a.description}</span>,
                            },
                            {
                              key: "qty",
                              header: "Qty",
                              role: "meta",
                              numeric: true,
                              align: "right",
                              cell: (a) => a.quantity,
                            },
                            {
                              key: "unit-weight",
                              header: "Unit weight",
                              role: "meta",
                              align: "right",
                              cell: (a) => formatWeight(a.unitWeight),
                            },
                            {
                              key: "hs-code",
                              header: "HS code",
                              role: "fold",
                              cell: (a) => a.tariffNumber ?? "-",
                            },
                          ]}
                        />
                      </div>
                    </Show>
                  </div>
                </Card>

                {/* Gate B — carrier selection. */}
                <Card class="p-4">
                  <div class="flex flex-col gap-3">
                    <div class="flex items-center justify-between gap-3">
                      <SectionLabel>Carrier offers</SectionLabel>
                      <Button variant="secondary" testid="boxtal-get-quotes" onClick={getQuotes}>
                        Get quotes
                      </Button>
                    </div>
                    <Show
                      when={offers().length > 0}
                      fallback={
                        <p class="text-[12px] text-text-tertiary">
                          Fetch quotes to pick a carrier: selecting one arms the approval gate.
                        </p>
                      }
                    >
                      <div class="flex flex-col gap-2">
                        <For each={offers()}>
                          {(o) => {
                            const active = () => selectedOffer() === o.offer_code
                            return (
                              <button
                                type="button"
                                data-testid={`boxtal-offer-${o.offer_code}`}
                                aria-pressed={active()}
                                onClick={() => setSelectedOffer(o.offer_code)}
                                class={cx(
                                  "flex items-center justify-between gap-4 rounded-md border px-3 py-2.5 text-left transition-colors",
                                  active()
                                    ? "border-accent-border bg-accent-tint"
                                    : "border-border-subtle bg-surface hover:bg-surface-hover hover:border-border-strong",
                                )}
                              >
                                <span class="flex items-center gap-2.5">
                                  <span
                                    class={cx(
                                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                                      active() ? "border-accent" : "border-border-strong",
                                    )}
                                  >
                                    <Show when={active()}>
                                      <span class="h-1.5 w-1.5 rounded-full bg-accent" />
                                    </Show>
                                  </span>
                                  <span class="flex flex-col gap-0.5">
                                    <span class="text-[12.5px] font-medium text-text">
                                      {o.carrier}
                                    </span>
                                    <span class="text-[11px] text-text-tertiary">
                                      Est. delivery {fmtDeliveryDate(o.delivery_date)}
                                    </span>
                                  </span>
                                </span>
                                <span class="flex flex-col items-end gap-0.5">
                                  <Money value={o.price_ttc} currency={o.currency} emphasis />
                                  <span class="font-mono text-[11px] tabular-nums text-text-tertiary">
                                    {o.price_ht.toFixed(2)} HT
                                  </span>
                                </span>
                              </button>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Card>
              </Show>

              <Show when={note()}>
                {(n) => (
                  <p
                    data-testid="boxtal-create-note"
                    role={n().isError ? "alert" : "status"}
                    class={`text-[12px] ${n().isError ? "text-error" : "text-text-secondary"}`}
                  >
                    {n().text}
                  </p>
                )}
              </Show>

              {/* Gated submit — pick carrier → posts to the approval gate. */}
              <div class="flex items-center justify-between gap-3 border-t border-border-subtle pt-4">
                <span class="text-[11px] text-text-tertiary">
                  Submitting opens an approval request. No label is bought until it is approved.
                </span>
                <Button
                  variant="primary"
                  testid="boxtal-create-submit"
                  disabled={!canSubmit(d(), selectedOffer(), recipient()) || submitting()}
                  onClick={submit}
                >
                  Create shipment
                </Button>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
