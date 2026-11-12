// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The customer identity tab (/invoicing/identity/:contactId, or `document:<id>` for a draft
// linked to no contact): what an e-invoice needs to know about the buyer. Customer kind with
// plain-word help, SIREN / SIRET checked as typed, a registry lookup that lists candidates and
// never picks one, the registry name and head office city with where the SIREN came from, and
// the territory decision for a buyer the classifier cannot place. A SIREN that the registry does
// not confirm under the customer's own name is never written without a person confirming it:
// the tool files that confirmation and this tab says so.
import { app } from "@liaison/host"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { isValidSiren, isValidSiret } from "../../einvoicing/identity"
import {
  type ClassifyVerdict,
  CUSTOMER_KIND_OPTIONS,
  type CustomerKind,
} from "../einvoicing/blockers"
import { tr } from "../i18n"
import { Button, cx, Field, inputClass, SectionLabel } from "../kit"

export type IdentityTarget = { contact_id: string } | { document_id: string }

const DOCUMENT_PREFIX = "document:"

/** The tab's entityId: a contact id, or `document:<id>` for a draft linked to no contact. */
export function identityTarget(entityId: string | undefined): IdentityTarget | null {
  if (!entityId) return null
  if (entityId.startsWith(DOCUMENT_PREFIX)) {
    const id = entityId.slice(DOCUMENT_PREFIX.length)
    return id ? { document_id: id } : null
  }
  return { contact_id: entityId }
}

function digitsOf(v: string): string {
  return v.replace(/[\s.]/g, "")
}

/** Live SIREN check; the message names the field. */
export function sirenFieldError(value: string): string | null {
  const v = digitsOf(value)
  if (!v) return null
  if (!/^\d{9}$/.test(v)) return tr("SIREN: 9 digits expected.")
  if (!isValidSiren(v)) return tr("SIREN: this number fails its check digit.")
  return null
}

/** Live SIRET check against the SIREN beside it; the message names the field. */
export function siretFieldError(value: string, siren: string): string | null {
  const v = digitsOf(value)
  if (!v) return null
  if (!/^\d{14}$/.test(v)) return tr("SIRET: 14 digits expected.")
  const s = digitsOf(siren)
  if (s && !v.startsWith(s)) return tr("SIRET: it must start with the SIREN.")
  if (!isValidSiret(v)) return tr("SIRET: this number fails its check digit.")
  return null
}

export interface RegistryCandidateView {
  siren: string
  siret?: string | null
  name?: string | null
  legal_name?: string | null
  city?: string | null
  postcode?: string | null
  status?: string | null
  active?: boolean
  name_match?: boolean | null
}

interface LookupResult {
  status?: string
  reason?: string
  message?: string
  derived_siren?: string
  candidates?: RegistryCandidateView[]
  error?: { code?: string; message?: string }
}

/** The lookup as shown: candidates in registry order and NO selection, whatever their number.
 *  The person picks; the screen never does. */
export function lookupView(r: LookupResult | null | undefined): {
  candidates: RegistryCandidateView[]
  selected: null
  derived: boolean
  message: string | null
} {
  if (!r) return { candidates: [], selected: null, derived: false, message: null }
  if (r.status === "error") {
    return {
      candidates: [],
      selected: null,
      derived: false,
      message: r.error?.message ?? r.error?.code ?? tr("The lookup failed."),
    }
  }
  if (r.status === "registry_unconfirmed") {
    const message =
      r.reason === "no_result"
        ? tr("The registry returned no company for this search. Try another spelling or the SIREN.")
        : tr("The registry could not be reached. Try again in a moment.")
    return { candidates: [], selected: null, derived: !!r.derived_siren, message }
  }
  return {
    candidates: r.candidates ?? [],
    selected: null,
    derived: !!r.derived_siren,
    message: null,
  }
}

/** What a save (or a candidate pick) says afterwards. */
export function identitySetNote(result: unknown): { text: string; isError: boolean } {
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>
  if ("blocked" in r || r.status === "pending_approval") {
    return {
      text: tr("Sent for a person to confirm. Nothing is recorded until then."),
      isError: false,
    }
  }
  if (r.status === "error") {
    const e = r.error as { message?: string; code?: string } | undefined
    return { text: e?.message ?? e?.code ?? tr("The action failed."), isError: true }
  }
  const proposal = (r.proposal as { note?: string } | undefined)?.note
  return { text: proposal ? `${tr("Saved.")} ${proposal}` : tr("Saved."), isError: false }
}

const SOURCE_TEXT: Record<string, string> = {
  registry: "From the business registry",
  vat_derived: "Read from the French VAT number",
  agent_web: "Found on the web by the agent",
  manual: "Typed by a person",
}

const CONFIRMED_TEXT: Record<string, string> = {
  auto: "confirmed automatically",
  approval: "confirmed by a person",
}

export interface IdentityRowView {
  customer_kind?: string | null
  siren?: string | null
  siret?: string | null
  source?: string | null
  source_url?: string | null
  confirmed_via?: string | null
  registry_name?: string | null
  registry_city?: string | null
  registry_postcode?: string | null
  registry_status?: string | null
  registry_checked_at?: string | null
  territory_treatment?: string | null
  territory_reason?: string | null
}

/** Where the SIREN came from and how it was confirmed, in one sentence. */
export function provenanceLine(identity: IdentityRowView | null | undefined): string | null {
  if (!identity) return null
  const from = tr(SOURCE_TEXT[identity.source ?? ""] ?? "Recorded")
  const how = identity.confirmed_via
    ? tr(CONFIRMED_TEXT[identity.confirmed_via] ?? "confirmed")
    : tr("not confirmed yet")
  const checked = identity.registry_checked_at
    ? tr(", checked {{date}}", { date: String(identity.registry_checked_at).slice(0, 10) })
    : ""
  return `${from}, ${how}${checked}.`
}

/** The territory decision shows when the classifier needs one, or one is already recorded. */
export function territoryNeeded(
  verdict: Pick<ClassifyVerdict, "regime"> | null | undefined,
  identity: Pick<IdentityRowView, "territory_treatment"> | null | undefined,
): boolean {
  return verdict?.regime === "needs_review" || !!identity?.territory_treatment
}

interface IdentityGetResult {
  status?: string
  counterparty_name?: string | null
  identity?: IdentityRowView | null
  snapshot?: {
    customer_kind?: string | null
    buyer_siren?: string | null
    buyer_siret?: string | null
  } | null
  error?: { message?: string }
}

interface Loaded {
  name: string | null
  identity: IdentityRowView | null
  verdict: ClassifyVerdict | null
}

async function loadIdentity(target: IdentityTarget): Promise<Loaded> {
  const got = await app.invokeTool<IdentityGetResult>("counterparty_identity_get", target)
  if (got?.status === "error")
    throw new Error(got.error?.message ?? tr("The identity could not be loaded."))
  let verdict: ClassifyVerdict | null = null
  try {
    const v = await app.invokeTool<ClassifyVerdict>("einvoicing_classify", target)
    verdict = v && v.status !== "error" ? v : null
  } catch {
    verdict = null
  }
  const identity: IdentityRowView | null =
    got?.identity ??
    (got?.snapshot
      ? {
          customer_kind: got.snapshot.customer_kind ?? null,
          siren: got.snapshot.buyer_siren ?? null,
          siret: got.snapshot.buyer_siret ?? null,
        }
      : null)
  return { name: got?.counterparty_name?.trim() || null, identity, verdict }
}

const KIND_VALUES = new Set<string>(CUSTOMER_KIND_OPTIONS.map((o) => o.value))

export const InvoicingIdentity: Component<{ entityId?: string }> = (props) => {
  const target = () => identityTarget(props.entityId)
  const [loaded, { refetch }] = createResource(target, loadIdentity)
  const [kind, setKind] = createSignal<CustomerKind | null>(null)
  const [siren, setSiren] = createSignal("")
  const [siret, setSiret] = createSignal("")
  const [touched, setTouched] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [postcode, setPostcode] = createSignal("")
  const [lookup, setLookup] = createSignal<ReturnType<typeof lookupView> | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<{ text: string; isError: boolean } | null>(null)
  const [territoryReason, setTerritoryReason] = createSignal("")

  const identity = () => loaded()?.identity ?? null
  // The form starts from what is recorded until the person edits it.
  const shownKind = () =>
    touched()
      ? kind()
      : ((KIND_VALUES.has(identity()?.customer_kind ?? "")
          ? identity()?.customer_kind
          : null) as CustomerKind | null)
  const shownSiren = () => (touched() ? siren() : (identity()?.siren ?? ""))
  const shownSiret = () => (touched() ? siret() : (identity()?.siret ?? ""))
  const startEditing = () => {
    if (touched()) return
    setKind(shownKind())
    setSiren(shownSiren())
    setSiret(shownSiret())
    setTouched(true)
  }
  const sirenError = () => sirenFieldError(shownSiren())
  const siretError = () => siretFieldError(shownSiret(), shownSiren())

  const run = async (tool: string, params: Record<string, unknown>) => {
    setBusy(true)
    setNote(null)
    try {
      setNote(identitySetNote(await app.invokeTool<unknown>(tool, params)))
      setTouched(false)
      refetch()
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : tr("The action failed."), isError: true })
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    const t = target()
    if (!t || sirenError() || siretError()) return
    const typedSiren = digitsOf(shownSiren())
    const sirenChanged = !!typedSiren && typedSiren !== (identity()?.siren ?? "")
    void run("counterparty_identity_set", {
      ...t,
      customer_kind: shownKind(),
      siren: sirenChanged ? typedSiren : null,
      siret: digitsOf(shownSiret()) || null,
      source: sirenChanged ? "manual" : (identity()?.source ?? "manual"),
    })
  }

  const runLookup = async () => {
    const t = target()
    if (!t) return
    setBusy(true)
    setLookup(null)
    try {
      const params: Record<string, unknown> = {
        ...("contact_id" in t ? { contact_id: t.contact_id } : {}),
        query: query().trim() || null,
        postcode: postcode().trim() || null,
      }
      setLookup(
        lookupView(await app.invokeTool<LookupResult>("counterparty_identity_lookup", params)),
      )
    } catch (e) {
      setLookup({
        candidates: [],
        selected: null,
        derived: false,
        message: e instanceof Error ? e.message : tr("The lookup failed."),
      })
    } finally {
      setBusy(false)
    }
  }

  const pick = (c: RegistryCandidateView) => {
    const t = target()
    if (!t) return
    void run("counterparty_identity_set", {
      ...t,
      customer_kind: shownKind(),
      siren: c.siren,
      siret: c.siret ?? null,
      source: lookup()?.derived ? "vat_derived" : "registry",
    })
  }

  const decideTerritory = (treatment: "as_fr" | "as_foreign") => {
    const t = target()
    if (!t || !("contact_id" in t) || !territoryReason().trim()) return
    void run("counterparty_territory_set", {
      contact_id: t.contact_id,
      treatment,
      reason: territoryReason().trim(),
    })
  }

  return (
    <div data-testid="invoicing-identity" class="flex max-w-3xl flex-col gap-5 p-5 text-[12.5px]">
      <div class="flex flex-col gap-0.5">
        <h1 class="text-[15px] font-semibold text-text">{tr("Customer identity")}</h1>
        <Show when={loaded()?.name}>
          <span data-testid="identity-customer-name" class="text-text-secondary">
            {loaded()?.name}
          </span>
        </Show>
      </div>
      <Show when={!target()}>
        <div class="text-text-secondary">{tr("No customer is selected.")}</div>
      </Show>
      <Show when={loaded.error}>
        <div data-testid="identity-load-error" class="text-text-secondary">
          {tr("The identity could not be loaded.")}
        </div>
      </Show>

      <Show when={target() && !loaded.loading && !loaded.error}>
        {/* Registry facts and provenance */}
        <section class="flex flex-col gap-1.5">
          <SectionLabel>{tr("Registry")}</SectionLabel>
          <div data-testid="identity-registry-name" class="text-text">
            {identity()?.registry_name ?? tr("Not looked up yet")}
            <Show when={identity()?.registry_city}>
              <span class="text-text-secondary">
                {" "}
                {identity()?.registry_postcode ?? ""} {identity()?.registry_city}
              </span>
            </Show>
            <Show when={identity()?.registry_status === "C"}>
              <span class="text-text-secondary"> {tr("(ceased)")}</span>
            </Show>
          </div>
          <Show when={provenanceLine(identity()?.siren ? identity() : null)}>
            {(line) => (
              <div data-testid="identity-provenance" class="text-text-tertiary">
                {line()}
              </div>
            )}
          </Show>
        </section>

        {/* Customer kind */}
        <section class="flex flex-col gap-2">
          <SectionLabel>{tr("Customer type")}</SectionLabel>
          <div class="grid grid-cols-2 gap-2">
            <For each={CUSTOMER_KIND_OPTIONS}>
              {(o) => (
                <label
                  data-testid={`identity-kind-${o.value}`}
                  class={cx(
                    "flex cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2",
                    shownKind() === o.value ? "border-accent bg-surface" : "border-border-subtle",
                  )}
                >
                  <span class="flex items-center gap-2 text-text">
                    <input
                      type="radio"
                      name="identity-kind"
                      checked={shownKind() === o.value}
                      onChange={() => {
                        startEditing()
                        setKind(o.value)
                      }}
                    />
                    {tr(o.label)}
                  </span>
                  <span class="text-[11.5px] text-text-tertiary">{tr(o.help)}</span>
                </label>
              )}
            </For>
          </div>
        </section>

        {/* SIREN / SIRET */}
        <section class="grid grid-cols-2 gap-x-5 gap-y-3">
          <Field label={tr("SIREN")} error={!!sirenError()}>
            <input
              data-testid="identity-field-siren"
              value={shownSiren()}
              onInput={(e) => {
                startEditing()
                setSiren(e.currentTarget.value)
              }}
              placeholder={tr("9 digits")}
              class={cx(inputClass, "font-mono text-[11.5px]")}
            />
            <Show when={sirenError()}>
              <p data-testid="identity-field-siren-error" class="mt-1 text-[11px] text-error">
                {sirenError()}
              </p>
            </Show>
          </Field>
          <Field label={tr("SIRET (optional)")} error={!!siretError()}>
            <input
              data-testid="identity-field-siret"
              value={shownSiret()}
              onInput={(e) => {
                startEditing()
                setSiret(e.currentTarget.value)
              }}
              placeholder={tr("14 digits")}
              class={cx(inputClass, "font-mono text-[11.5px]")}
            />
            <Show when={siretError()}>
              <p data-testid="identity-field-siret-error" class="mt-1 text-[11px] text-error">
                {siretError()}
              </p>
            </Show>
          </Field>
          <div class="col-span-2 flex items-center gap-3">
            <Button
              variant="primary"
              testid="identity-save"
              disabled={busy() || !touched() || !!sirenError() || !!siretError()}
              onClick={save}
            >
              {tr("Save")}
            </Button>
            <span class="text-[11.5px] text-text-tertiary">
              {tr(
                "A SIREN the registry does not confirm under this customer's name goes to a person first.",
              )}
            </span>
          </div>
        </section>

        {/* Registry lookup: candidates only, the person picks */}
        <section class="flex flex-col gap-2">
          <SectionLabel>{tr("Look up in the business registry")}</SectionLabel>
          <div class="flex gap-2">
            {/* inputClass is full width: the boxes size the inputs, so the query takes the room. */}
            <div class="min-w-0 flex-1">
              <input
                data-testid="identity-lookup-query"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                placeholder={
                  loaded()?.name
                    ? tr("Company name or SIREN (empty: {{name}})", { name: loaded()?.name ?? "" })
                    : tr("Company name or SIREN (empty: the customer's name)")
                }
                class={inputClass}
              />
            </div>
            <div class="w-28 shrink-0">
              <input
                data-testid="identity-lookup-postcode"
                value={postcode()}
                onInput={(e) => setPostcode(e.currentTarget.value)}
                placeholder={tr("Postcode")}
                class={inputClass}
              />
            </div>
            <Button
              testid="identity-lookup-button"
              class="shrink-0 whitespace-nowrap"
              disabled={busy()}
              onClick={() => void runLookup()}
            >
              {tr("Look up")}
            </Button>
          </div>
          <Show when={lookup()?.message}>
            <div data-testid="identity-lookup-message" class="text-text-secondary">
              {lookup()?.message}
            </div>
          </Show>
          <ul class="flex flex-col gap-1.5">
            <For each={lookup()?.candidates ?? []}>
              {(c) => (
                <li
                  data-testid={`identity-candidate-${c.siren}`}
                  class="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2"
                >
                  <div class="flex flex-col gap-0.5">
                    <span class="text-text">{c.name ?? c.legal_name ?? c.siren}</span>
                    <span class="font-mono text-[11.5px] text-text-secondary">
                      {c.siren} {c.postcode ?? ""} {c.city ?? ""}
                    </span>
                    <span class="text-[11.5px] text-text-tertiary">
                      {c.active === false ? tr("Ceased") : tr("Active")}
                      {c.name_match === false
                        ? ` ${tr("(the name differs from the customer's)")}`
                        : ""}
                    </span>
                  </div>
                  <Button
                    testid={`identity-candidate-pick-${c.siren}`}
                    disabled={busy()}
                    onClick={() => pick(c)}
                  >
                    {tr("This is the customer")}
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </section>

        {/* Territory treatment (buyers the classifier cannot place) */}
        <Show
          when={
            territoryNeeded(loaded()?.verdict, identity()) &&
            target() &&
            "contact_id" in (target() as object)
          }
        >
          <section data-testid="identity-territory" class="flex flex-col gap-2">
            <SectionLabel>{tr("Territory")}</SectionLabel>
            <div class="text-text-secondary">
              {identity()?.territory_treatment === "as_fr"
                ? tr("Treated as France.")
                : identity()?.territory_treatment === "as_foreign"
                  ? tr("Treated as abroad.")
                  : tr(
                      "This buyer's territory is not decided automatically. Record a decision with its reason; a person approves it.",
                    )}
            </div>
            <input
              data-testid="identity-territory-reason"
              value={territoryReason()}
              onInput={(e) => setTerritoryReason(e.currentTarget.value)}
              placeholder={tr("Reason")}
              class={inputClass}
            />
            <div class="flex gap-2">
              <Button
                testid="identity-territory-as-fr"
                disabled={busy() || !territoryReason().trim()}
                onClick={() => decideTerritory("as_fr")}
              >
                {tr("Treat as France")}
              </Button>
              <Button
                testid="identity-territory-as-foreign"
                disabled={busy() || !territoryReason().trim()}
                onClick={() => decideTerritory("as_foreign")}
              >
                {tr("Treat as abroad")}
              </Button>
            </div>
          </section>
        </Show>

        <Show when={note()}>
          {(n) => (
            <div
              data-testid="identity-note"
              class={n().isError ? "text-error" : "text-text-secondary"}
            >
              {n().text}
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}
