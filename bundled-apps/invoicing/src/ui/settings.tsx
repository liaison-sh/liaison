// SPDX-License-Identifier: FSL-1.1-ALv2
//
// InvoicingIssuerProfiles: the "Issuer profiles" block of the declarative
// settings page (manifest `settings`, /settings/apps/invoicing). The list of
// issuer profiles with a create / edit form (legal name, country, VAT id,
// address, IBAN/SWIFT, logo upload, default currency, language, Net N days,
// prefixes, approval thresholds, two-eyes and auto-email toggles), over the
// app's own gated tools settings_issuer_profile_{list,create,update,delete}.
// The shop mappings, tax regimes and HS code library are read-only list blocks
// and the e-invoicing settings plain fields of the same page.
//
// Pure helpers (emitVatWarning / isInvalidIban / canDelete / canCreate)
// are extracted so the bundled-app bun:test suite can pin every branch
// without jsdom.

import { CardTable } from "@liaison/app-ui/card-table"
import { app, fetchBlob, fetch as hostFetch } from "@liaison/host"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { CHOSEN_UTC, DEFAULT_ZONE, issuerTimezoneUnset } from "../issue-date"
import { tr } from "./i18n"
import { Badge, Button, cx, inputClass } from "./kit"

// ─────────────────────────────────────────────────────────────────────────
// Types & enums.
// ─────────────────────────────────────────────────────────────────────────
export type Language = "en" | "fr" | "de"

export interface IssuerProfileDraft {
  id?: string
  legal_name: string
  country: string
  vat_id?: string | null
  tax_registration_id?: string | null
  address?: string | null
  iban?: string | null
  swift_bic?: string | null
  bank_name?: string | null
  logo_file_id?: string | null
  default_currency: string
  default_language: Language
  default_payment_terms_days: number
  prefix_invoice: string
  prefix_quote: string
  prefix_proforma: string
  prefix_po: string
  invoice_approval_threshold_minor?: string | null
  po_approval_threshold_minor?: string | null
  require_two_eyes?: boolean
  auto_email_enabled?: boolean
  /** Typed unit prices are gross (tax included). Mirrors the Shopify shop's
   *  "include tax in prices" setting for a profile mapped to a shop. */
  prices_include_tax?: boolean
  /** IANA zone of issue dates. The column default `UTC` means nobody chose (see issue-date.ts). */
  timezone?: string | null
  email_templates?: Record<string, string>
  archived_at?: string | null
}

export interface IssuerProfileRow extends IssuerProfileDraft {
  id: string
  /** Number of documents referencing this profile (drives canDelete). */
  reference_count: number
}

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers.
// ─────────────────────────────────────────────────────────────────────────
const EU_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
])

/** The only issuer-profile columns the save tools accept (the manifest params allowlist);
 *  the row the form edits also carries id / reference_count / timestamps. */
const ISSUER_SAVE_FIELDS = [
  "id",
  "legal_name",
  "country",
  "vat_id",
  "tax_registration_id",
  "address",
  "iban",
  "swift_bic",
  "bank_name",
  "logo_file_id",
  "default_currency",
  "default_language",
  "default_payment_terms_days",
  "prefix_invoice",
  "prefix_quote",
  "prefix_proforma",
  "prefix_po",
  "invoice_approval_threshold_minor",
  "po_approval_threshold_minor",
  "require_two_eyes",
  "auto_email_enabled",
  "prices_include_tax",
  "mail_account_id",
  "timezone",
  "email_templates",
  "shopify_shop_id",
] as const

export function pickIssuerSaveFields(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ISSUER_SAVE_FIELDS) if (row[k] !== undefined) out[k] = row[k]
  // The column default, untouched: resending it would read as someone choosing UTC.
  if (issuerTimezoneUnset(out)) delete out.timezone
  return out
}

export function emitVatWarning(d: IssuerProfileDraft): boolean {
  return EU_COUNTRIES.has(d.country) && !d.vat_id
}

export function isInvalidIban(iban: string | null | undefined): boolean {
  if (!iban) return false
  // IBAN: 15–34 alphanumeric chars, starting with two letters + two digits.
  // Soft check; we strip spaces before validating.
  const cleaned = iban.replace(/\s+/g, "").toUpperCase()
  if (cleaned.length < 15 || cleaned.length > 34) return true
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(cleaned)) return true
  return false
}

export function canDelete(d: { reference_count: number }): boolean {
  return d.reference_count === 0
}

export function canCreate(d: IssuerProfileDraft): boolean {
  if (!d.legal_name?.trim()) return false
  if (!d.country?.trim()) return false
  if (!d.default_currency?.trim()) return false
  if (!d.prefix_invoice?.trim()) return false
  return true
}

// ─────────────────────────────────────────────────────────────────────────
// Logo upload — pure client-side validation + the upload/confirm flow.
// ─────────────────────────────────────────────────────────────────────────
export const LOGO_MAX_BYTES = 2 * 1024 * 1024 // 2MB
export const LOGO_ACCEPTED_MIME_TYPES = ["image/png", "image/jpeg"] as const

export interface LogoValidationResult {
  ok: boolean
  error?: string
}

/** Client-side pre-check before uploading a logo file — mime + size only (the
 *  server enforces its own quota/size limits; this just gives immediate
 *  feedback and avoids a wasted round trip for an obviously-bad file). */
export function validateLogoFile(file: { type: string; size: number }): LogoValidationResult {
  if (!LOGO_ACCEPTED_MIME_TYPES.includes(file.type as (typeof LOGO_ACCEPTED_MIME_TYPES)[number])) {
    return { ok: false, error: "Logo must be a PNG or JPEG image." }
  }
  if (file.size > LOGO_MAX_BYTES) {
    return { ok: false, error: "Logo must be 2MB or smaller." }
  }
  return { ok: true }
}

interface UploadUrlResponse {
  uploadUrl: string
  fileToken: string
  storageKey: string
}

/** Upload a logo file for an EXISTING issuer profile: presign → PUT bytes →
 *  confirm. Returns the confirmed file's id, or throws with a message
 *  suitable for the settings error banner. Mirrors the host-app
 *  `uploadFile` flow (apps/web/src/modules/files/file-service.ts) through the
 *  host's JSON fetch (a sandboxed bundled-app UI has no `ApiClient`). */
export async function uploadIssuerLogo(file: File, issuerProfileId: string): Promise<string> {
  // Kernel calls go through the host (bound server + bearer): a page-relative
  // fetch lands on the desktop or mobile shell's own index.html.
  let presign: UploadUrlResponse
  try {
    presign = await hostFetch<UploadUrlResponse>("/api/files/upload-url", {
      method: "POST",
      body: JSON.stringify({
        app: "invoicing",
        entityType: "issuer_profile",
        entityId: issuerProfileId,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
      }),
    })
  } catch (e) {
    throw new Error(`Could not start the upload (${errorStatus(e)}).`)
  }

  // The presigned URL is absolute (object storage) and carries its own auth.
  const put = await window.fetch(presign.uploadUrl, {
    // purity-allow: absolute-url
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  })
  if (!put.ok) {
    throw new Error(`Logo upload failed (${put.status}).`)
  }

  let confirmed: { id: string }
  try {
    confirmed = await hostFetch<{ id: string }>("/api/files/confirm", {
      method: "POST",
      body: JSON.stringify({ fileToken: presign.fileToken }),
    })
  } catch (e) {
    throw new Error(`Could not finalize the logo upload (${errorStatus(e)}).`)
  }
  return confirmed.id
}

function errorStatus(e: unknown): string {
  const status = (e as { status?: unknown } | null)?.status
  return typeof status === "number" ? String(status) : "network"
}

/** Fetch a file's bytes (bearer-authenticated) and resolve a blob URL, for
 *  rendering the current logo thumbnail. Returns null on any failure. */
export async function fetchLogoBlobUrl(fileId: string): Promise<string | null> {
  try {
    const blob = await fetchBlob(`/api/files/${fileId}/inline`)
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Display helpers.
// ─────────────────────────────────────────────────────────────────────────
async function loadIssuers(): Promise<IssuerProfileRow[]> {
  try {
    const r = await app.invokeTool<{ items: IssuerProfileRow[] }>(
      "settings_issuer_profile_list",
      {},
    )
    return r?.items ?? []
  } catch {
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Component.
// ─────────────────────────────────────────────────────────────────────────
export const InvoicingIssuerProfiles: Component = () => {
  const [issuers, { refetch: refetchIssuers }] = app.createResource(loadIssuers)

  const [editing, setEditing] = createSignal<IssuerProfileDraft | null>(null)
  const [logoError, setLogoError] = createSignal<string | null>(null)
  const [logoUploading, setLogoUploading] = createSignal(false)
  // The current logo's blob URL for the thumbnail preview — reloaded whenever
  // `editing().logo_file_id` changes (new upload / different profile opened).
  const [logoThumbUrl, { refetch: refetchLogoThumb }] = createResource(
    () => editing()?.logo_file_id ?? null,
    (fileId) => fetchLogoBlobUrl(fileId),
  )

  const startCreate = () => {
    setEditing({
      legal_name: "",
      country: "FR",
      vat_id: "",
      default_currency: "EUR",
      default_language: "fr",
      default_payment_terms_days: 30,
      prefix_invoice: "INV-{YYYY}-",
      prefix_quote: "QUO-{YYYY}-",
      prefix_proforma: "PRO-{YYYY}-",
      prefix_po: "PO-{YYYY}-",
      prices_include_tax: false,
    })
  }

  const startEdit = (row: IssuerProfileRow) => {
    setEditing({ ...row })
  }

  const onSave = async () => {
    const d = editing()
    if (!d || !canCreate(d)) return
    const tool = d.id ? "settings_issuer_profile_update" : "settings_issuer_profile_create"
    try {
      await app.invokeTool(tool, pickIssuerSaveFields(d as unknown as Record<string, unknown>))
      setEditing(null)
      refetchIssuers()
    } catch {
      // surfaced via kernel toast
    }
  }

  const onDelete = async (row: IssuerProfileRow) => {
    if (!canDelete(row)) return
    try {
      await app.invokeTool("settings_issuer_profile_delete", { id: row.id })
      refetchIssuers()
    } catch {
      // surfaced via kernel toast
    }
  }

  /** Logo upload — only reachable for an EXISTING profile (needs an entityId
   *  for the file's parent). Uploads, then persists logo_file_id via
   *  settings_issuer_profile_update so the change survives a page reload. */
  const onLogoSelected = async (file: File | undefined) => {
    setLogoError(null)
    const d = editing()
    if (!file || !d?.id) return
    const check = validateLogoFile(file)
    if (!check.ok) {
      setLogoError(check.error ?? tr("Invalid logo file."))
      return
    }
    setLogoUploading(true)
    try {
      const fileId = await uploadIssuerLogo(file, d.id)
      const result = await app.invokeTool<
        Record<string, unknown> | { status: "error"; error: { code: string; message: string } }
      >("settings_issuer_profile_update", { id: d.id, logo_file_id: fileId })
      if (result && typeof result === "object" && "status" in result && result.status === "error") {
        const err = (result as { error?: { code?: string; message?: string } }).error
        setLogoError(err?.message ?? err?.code ?? tr("Could not save the logo."))
        return
      }
      setEditing({ ...d, logo_file_id: fileId })
      refetchLogoThumb()
      refetchIssuers()
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : tr("Logo upload failed."))
    } finally {
      setLogoUploading(false)
    }
  }

  const onLogoRemove = async () => {
    setLogoError(null)
    const d = editing()
    if (!d?.id) return
    try {
      const result = await app.invokeTool<
        Record<string, unknown> | { status: "error"; error: { code: string; message: string } }
      >("settings_issuer_profile_update", { id: d.id, logo_file_id: null })
      if (result && typeof result === "object" && "status" in result && result.status === "error") {
        const err = (result as { error?: { code?: string; message?: string } }).error
        setLogoError(err?.message ?? err?.code ?? tr("Could not remove the logo."))
        return
      }
      setEditing({ ...d, logo_file_id: null })
      refetchLogoThumb()
      refetchIssuers()
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : tr("Could not remove the logo."))
    }
  }

  return (
    <div data-testid="invoicing-settings" class="flex flex-col gap-6 text-[12.5px]">
      <section data-testid="settings-panel-issuer-profiles" class="flex flex-col gap-2">
        <header class="flex items-center justify-end">
          <Button variant="secondary" testid="settings-issuer-profile-create" onClick={startCreate}>
            {tr("+ New issuer profile")}
          </Button>
        </header>

        <Show when={editing()}>
          {(d) => {
            const showVatWarn = () => emitVatWarning(d())
            const showIbanWarn = () => isInvalidIban(d().iban)
            return (
              <div
                data-testid="settings-issuer-profile-form"
                class="flex flex-col gap-2 rounded-md border border-border-subtle bg-surface p-3"
              >
                <div class="grid grid-cols-2 gap-2">
                  <label class="flex items-center gap-2">
                    <span class="w-32 text-text-tertiary">{tr("Legal name *")}</span>
                    <input
                      data-testid="settings-issuer-profile-field-legal_name"
                      value={d().legal_name}
                      onInput={(e) => setEditing({ ...d(), legal_name: e.currentTarget.value })}
                      class={cx(inputClass, "flex-1 [color-scheme:dark]")}
                    />
                  </label>
                  <label class="flex items-center gap-2">
                    <span class="w-32 text-text-tertiary">{tr("Country *")}</span>
                    <input
                      data-testid="settings-issuer-profile-field-country"
                      value={d().country}
                      onInput={(e) => setEditing({ ...d(), country: e.currentTarget.value })}
                      placeholder={tr("ISO 2-letter")}
                      class={cx(inputClass, "flex-1 [color-scheme:dark]")}
                    />
                  </label>
                  <label class="flex items-center gap-2">
                    <span class="w-32 text-text-tertiary">{tr("VAT ID")}</span>
                    <input
                      data-testid="settings-issuer-profile-field-vat_id"
                      value={d().vat_id ?? ""}
                      onInput={(e) => setEditing({ ...d(), vat_id: e.currentTarget.value || null })}
                      class={cx(
                        "w-full flex-1 rounded-md border bg-surface px-2.5 py-1.5 text-[12.5px] text-text outline-none transition-colors",
                        "placeholder:text-text-tertiary focus:ring-2 focus:ring-accent-tint",
                        showVatWarn()
                          ? "border-warning focus:border-warning"
                          : "border-border focus:border-accent-border",
                      )}
                    />
                  </label>
                  <label class="flex items-center gap-2">
                    <span class="w-32 text-text-tertiary">{tr("IBAN")}</span>
                    <input
                      data-testid="settings-issuer-profile-field-iban"
                      value={d().iban ?? ""}
                      onInput={(e) => setEditing({ ...d(), iban: e.currentTarget.value || null })}
                      class={cx(
                        "w-full flex-1 rounded-md border bg-surface px-2.5 py-1.5 text-[12.5px] text-text outline-none transition-colors",
                        "placeholder:text-text-tertiary focus:ring-2 focus:ring-accent-tint",
                        showIbanWarn()
                          ? "border-warning focus:border-warning"
                          : "border-border focus:border-accent-border",
                      )}
                    />
                  </label>
                  <label class="flex items-center gap-2">
                    <span class="w-32 text-text-tertiary">{tr("Time zone")}</span>
                    <input
                      data-testid="settings-issuer-profile-field-timezone"
                      value={issuerTimezoneUnset(d()) ? "" : (d().timezone ?? "")}
                      placeholder={tr("Not chosen, for example Europe/Paris")}
                      title={tr(
                        "Issue dates and number years use this zone. Not chosen: they follow the organization's time zone, or UTC when it has none.",
                      )}
                      onChange={(e) => {
                        const typed = e.currentTarget.value.trim()
                        const zone = !typed
                          ? DEFAULT_ZONE
                          : typed === DEFAULT_ZONE
                            ? CHOSEN_UTC
                            : typed
                        setEditing({ ...d(), timezone: zone })
                      }}
                      class={inputClass}
                    />
                  </label>
                  <label class="flex items-center gap-2">
                    <span class="w-32 text-text-tertiary">{tr("Default currency *")}</span>
                    <input
                      data-testid="settings-issuer-profile-field-currency"
                      value={d().default_currency}
                      onInput={(e) =>
                        setEditing({ ...d(), default_currency: e.currentTarget.value })
                      }
                      class={cx(inputClass, "flex-1 [color-scheme:dark]")}
                    />
                  </label>
                  <label class="flex items-center gap-2">
                    <span class="w-32 text-text-tertiary">{tr("Default language")}</span>
                    <select
                      data-testid="settings-issuer-profile-field-language"
                      value={d().default_language}
                      onChange={(e) =>
                        setEditing({ ...d(), default_language: e.currentTarget.value as Language })
                      }
                      class={cx(inputClass, "flex-1 [color-scheme:dark]")}
                    >
                      <option value="en">{tr("en")}</option>
                      <option value="fr">{tr("fr")}</option>
                      <option value="de">{tr("de")}</option>
                    </select>
                  </label>
                </div>

                {/* Tax-inclusive pricing — the invoicing mirror of the Shopify shop's
                    "include tax in prices" setting. */}
                <label class="flex items-start gap-2 border-t border-border-subtle pt-2">
                  <input
                    type="checkbox"
                    data-testid="issuer-prices-include-tax"
                    checked={!!d().prices_include_tax}
                    onChange={(e) =>
                      setEditing({ ...d(), prices_include_tax: e.currentTarget.checked })
                    }
                    class="mt-0.5"
                  />
                  <span class="flex flex-col gap-0.5">
                    <span class="text-text">{tr("Prices include tax")}</span>
                    <span class="text-text-tertiary">
                      {tr(
                        "Match your Shopify tax setting. On: prices you type are tax inclusive and the document shows the net amount plus VAT. Off: prices are net and VAT is added.",
                      )}
                    </span>
                  </span>
                </label>

                {/* Logo row — upload only reachable once the profile is persisted (needs an
                    entityId for the file's parent). */}
                <div class="flex items-center gap-3 border-t border-border-subtle pt-2">
                  <span class="w-32 shrink-0 text-text-tertiary">{tr("Logo")}</span>
                  <Show
                    when={d().id}
                    fallback={
                      <span class="text-text-tertiary">
                        {tr("Save the profile first, then upload a logo.")}
                      </span>
                    }
                  >
                    <div class="flex flex-1 items-center gap-3">
                      <Show when={logoThumbUrl()}>
                        {(url) => (
                          <img
                            data-testid="settings-logo-thumb"
                            src={url()}
                            alt={tr("Issuer logo")}
                            class="max-h-12 rounded border border-border-subtle bg-surface object-contain"
                          />
                        )}
                      </Show>
                      <input
                        data-testid="settings-logo-input"
                        type="file"
                        accept="image/png,image/jpeg"
                        disabled={logoUploading()}
                        onChange={(e) => void onLogoSelected(e.currentTarget.files?.[0])}
                        class="flex-1 text-text-secondary"
                      />
                      <Show when={d().logo_file_id}>
                        <button
                          type="button"
                          data-testid="settings-logo-remove"
                          onClick={() => void onLogoRemove()}
                          class="text-error hover:opacity-90"
                        >
                          {tr("Remove")}
                        </button>
                      </Show>
                    </div>
                  </Show>
                </div>
                <Show when={logoError()}>
                  <div data-testid="settings-logo-error" class="text-error">
                    {logoError()}
                  </div>
                </Show>

                <Show when={showVatWarn()}>
                  <div data-testid="settings-issuer-profile-warn-vat" class="text-warning">
                    {tr("VAT ID is required by law on invoices issued from EU countries.")}
                  </div>
                </Show>
                <Show when={showIbanWarn()}>
                  <div data-testid="settings-issuer-profile-warn-iban" class="text-warning">
                    {tr("IBAN looks invalid: check the length and characters.")}
                  </div>
                </Show>

                <div class="flex items-center justify-end gap-2 pt-2">
                  <Button
                    variant="ghost"
                    testid="settings-issuer-profile-cancel"
                    onClick={() => setEditing(null)}
                  >
                    {tr("Cancel")}
                  </Button>
                  <Button
                    variant="primary"
                    testid="settings-issuer-profile-save"
                    disabled={!canCreate(d())}
                    onClick={() => void onSave()}
                  >
                    {tr("Save")}
                  </Button>
                </div>
              </div>
            )
          }}
        </Show>

        <Show
          when={(issuers()?.length ?? 0) > 0}
          fallback={<div class="text-text-tertiary">{tr("No issuer profiles yet.")}</div>}
        >
          <div data-testid="settings-issuer-profile-table">
            <CardTable
              rows={(issuers() ?? []).filter((row) => !row.archived_at)}
              rowKey={(row) => row.id}
              rowTestid={(row) => `settings-issuer-profile-row-${row.id}`}
              // The settings pane is ~576 px wide. Only the legal name wraps;
              // the country, VAT ID, reference count and the Edit/Delete
              // buttons hold their content width, so the row's actions stay in
              // view instead of behind a sideways scroll.
              floor="flexible"
              columns={[
                {
                  key: "legal-name",
                  header: tr("Legal name"),
                  role: "anchor",
                  cell: (row) => <span title={row.legal_name}>{row.legal_name}</span>,
                },
                {
                  key: "country",
                  header: tr("Country"),
                  role: "secondary",
                  fit: true,
                  cell: (row) => row.country,
                },
                {
                  key: "timezone",
                  header: tr("Time zone"),
                  role: "secondary",
                  fit: true,
                  cell: (row) => (issuerTimezoneUnset(row) ? tr("Not chosen") : row.timezone),
                },
                {
                  key: "vat-id",
                  header: tr("VAT ID"),
                  role: "meta",
                  fit: true,
                  cell: (row) => <span class="font-mono">{row.vat_id ?? "-"}</span>,
                },
                {
                  key: "refs",
                  header: tr("Refs"),
                  role: "meta",
                  numeric: true,
                  align: "right",
                  cell: (row) => row.reference_count,
                },
              ]}
              actions={(row) =>
                canDelete(row)
                  ? [
                      { label: tr("Edit"), onSelect: () => startEdit(row) },
                      { label: tr("Delete"), tone: "danger", onSelect: () => void onDelete(row) },
                    ]
                  : [{ label: tr("Edit"), onSelect: () => startEdit(row) }]
              }
            />
            {/* CardTable's shared actions column has no per-action testid, so the
                delete-blocked affordance (with its own testid) stays a small strip
                under the table rather than living inside the row itself. */}
            <For each={(issuers() ?? []).filter((row) => !row.archived_at && !canDelete(row))}>
              {(row) => (
                <div class="flex items-center gap-2 px-4 py-1 text-[11px] text-text-tertiary">
                  <span>{row.legal_name}</span>
                  <Badge tone="muted" testid={`settings-issuer-profile-delete-blocked-${row.id}`}>
                    {tr("Cannot delete: referenced by")} {row.reference_count}
                  </Badge>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </div>
  )
}
