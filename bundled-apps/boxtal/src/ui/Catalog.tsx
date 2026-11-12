// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Catalog surface — shipping profiles, packs (compound, with a stale-ref guard),
// and local products. Thin presentation glue over the `packages_list` catalog
// tool, composed entirely from the shared Boxtal UI kit so it stays visually
// identical to the invoicing app.

import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import { app } from "@liaison/host"
import { type Component, createSignal, For, Show } from "solid-js"
import { tr } from "./i18n"
import {
  Badge,
  Button,
  Card,
  EmptyState,
  formatWeight,
  inputClass,
  PageHeader,
  SectionLabel,
} from "./kit"

interface VariantRef {
  product_source: string
  product_id: string
}
/** One shared shipping profile with the variants that use it. */
interface ProfileRow {
  id: string
  label?: string | null
  short_code?: string | null
  unit_weight: number
  variants: VariantRef[]
  /** Its short codes' sync onto the products: null when in sync. */
  short_code_sync?: { state: "pending" | "conflict"; skus: string[]; detail: string | null } | null
}
/** A variant a resolved row found with no profile. */
interface UnprofiledRow extends VariantRef {
  description: string | null
  rows: number
}
interface PackRow {
  id: string
  name: string
  gross_weight: number
  stale: boolean
  components: Array<{
    product_source: string
    product_id: string
    quantity: number
    label: string | null
  }>
}
interface LocalRow {
  id: string
  sku: string
  label: string
}
interface CatalogData {
  shared_profiles: ProfileRow[]
  unprofiled_variants: UnprofiledRow[]
  packs: PackRow[]
  local_products: LocalRow[]
}

/** A pack/profile validation flag the resolver depends on. */
export function profileHasWeight(p: { unit_weight: number | null | undefined }): boolean {
  return typeof p.unit_weight === "number" && p.unit_weight > 0
}

async function fetchCatalog(): Promise<CatalogData> {
  try {
    const res = await app.invokeTool<CatalogData>("packages_list", {})
    return {
      shared_profiles: res.shared_profiles ?? [],
      unprofiled_variants: res.unprofiled_variants ?? [],
      packs: res.packs ?? [],
      local_products: res.local_products ?? [],
    }
  } catch {
    return { shared_profiles: [], unprofiled_variants: [], packs: [], local_products: [] }
  }
}

/** What a profile is called in the catalog: its label, else its short code, else its first variant. */
export function profileName(p: ProfileRow): string {
  return p.label || p.short_code || p.variants[0]?.product_id || p.id
}

/** "Link to existing profile" on one unprofiled variant: inline, a profile picker and a Link button. */
const LinkVariant: Component<{
  variant: UnprofiledRow
  profiles: ProfileRow[]
  onLinked: () => void
}> = (props) => {
  const [open, setOpen] = createSignal(false)
  const [choice, setChoice] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  // Set when the variant turned out to use another profile already: the tool previewed the move.
  const [movePreview, setMovePreview] = createSignal<string[] | null>(null)
  const key = () => `${props.variant.product_source}-${props.variant.product_id}`
  const link = async (confirm = false) => {
    if (!choice()) return
    setBusy(true)
    setError(null)
    try {
      const res = await app.invokeTool<{
        preview?: boolean
        differences?: Array<{ field: string }>
      }>("product_profile_link", {
        product_source: props.variant.product_source,
        product_id: props.variant.product_id,
        profile_id: choice(),
        ...(confirm ? { confirm: true } : {}),
      })
      if (res.preview) {
        setMovePreview((res.differences ?? []).map((d) => d.field))
        return
      }
      setMovePreview(null)
      setOpen(false)
      props.onLinked()
    } catch (e) {
      setError(
        tr("Could not save: {{message}}", { message: e instanceof Error ? e.message : String(e) }),
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Show
      when={open()}
      fallback={
        <Button
          variant="ghost"
          testid={`boxtal-unprofiled-link-${key()}`}
          onClick={() => setOpen(true)}
        >
          {tr("Link to existing profile")}
        </Button>
      }
    >
      <span class="flex flex-wrap items-center gap-2">
        <select
          class={inputClass}
          data-testid={`boxtal-unprofiled-select-${key()}`}
          aria-label={tr("Choose a profile")}
          value={choice()}
          onChange={(e) => setChoice(e.currentTarget.value)}
        >
          <option value="">{tr("Choose a profile")}</option>
          <For each={props.profiles}>
            {(p) => (
              <option value={p.id}>
                {profileName(p)} · {formatWeight(p.unit_weight)}
              </option>
            )}
          </For>
        </select>
        <Button
          variant="primary"
          testid={`boxtal-unprofiled-confirm-${key()}`}
          disabled={!choice() || busy()}
          onClick={() => void link()}
        >
          {tr("Link")}
        </Button>
        <Show when={movePreview()}>
          {(fields) => (
            <span
              class="flex flex-wrap items-center gap-2"
              data-testid={`boxtal-unprofiled-move-${key()}`}
            >
              <span class="text-[11.5px] text-text-secondary">
                {fields().length > 0
                  ? tr(
                      "This variant already uses another profile. Moving it changes {{fields}} and puts it in the chosen profile's packs.",
                      { fields: fields().join(", ") },
                    )
                  : tr(
                      "This variant already uses another profile. Moving it puts it in the chosen profile's packs.",
                    )}
              </span>
              <Button
                variant="primary"
                testid={`boxtal-unprofiled-move-confirm-${key()}`}
                disabled={busy()}
                onClick={() => void link(true)}
              >
                {tr("Move it")}
              </Button>
            </span>
          )}
        </Show>
        <Button
          variant="ghost"
          testid={`boxtal-unprofiled-cancel-${key()}`}
          onClick={() => setOpen(false)}
        >
          {tr("Cancel")}
        </Button>
        <Show when={error()}>
          <span class="text-[11.5px] text-error" data-testid={`boxtal-unprofiled-error-${key()}`}>
            {error()}
          </span>
        </Show>
      </span>
    </Show>
  )
}

/** Delete an unused profile, confirmed inline. */
const DeleteProfile: Component<{ profile: ProfileRow; onDeleted: () => void }> = (props) => {
  const [confirming, setConfirming] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const remove = async () => {
    setError(null)
    try {
      await app.invokeTool("product_profile_delete", { profile_id: props.profile.id })
      props.onDeleted()
    } catch (e) {
      setError(
        tr("Could not save: {{message}}", { message: e instanceof Error ? e.message : String(e) }),
      )
    }
  }
  return (
    <Show
      when={confirming()}
      fallback={
        <Button
          variant="ghost"
          testid={`boxtal-profile-delete-${props.profile.id}`}
          onClick={() => setConfirming(true)}
        >
          {tr("Delete")}
        </Button>
      }
    >
      <span class="flex items-center gap-2">
        <span class="text-[11.5px] text-text-secondary">{tr("Delete this profile?")}</span>
        <Button
          variant="primary"
          testid={`boxtal-profile-delete-confirm-${props.profile.id}`}
          onClick={() => void remove()}
        >
          {tr("Delete")}
        </Button>
        <Button
          variant="ghost"
          testid={`boxtal-profile-delete-cancel-${props.profile.id}`}
          onClick={() => setConfirming(false)}
        >
          {tr("Cancel")}
        </Button>
        <Show when={error()}>
          <span class="text-[11.5px] text-error">{error()}</span>
        </Show>
      </span>
    </Show>
  )
}

export const Catalog: Component = () => {
  const [data, { refetch }] = app.createResource(fetchCatalog)
  const profiles = () => data()?.shared_profiles ?? []
  const unprofiled = () => data()?.unprofiled_variants ?? []
  const reload = () => void refetch()
  const packs = () => data()?.packs ?? []
  const locals = () => data()?.local_products ?? []

  return (
    <div class="flex h-full min-h-0 flex-col" data-testid="boxtal-catalog">
      <PageHeader
        title="Catalog"
        subtitle="Shipping profiles, packs & local products"
        testid="boxtal-catalog-header"
        actions={
          <Button variant="primary" testid="boxtal-new-pack">
            + New pack
          </Button>
        }
      />

      <div class="flex-1 space-y-4 overflow-auto p-5" data-testid="boxtal-catalog-body">
        {/* ── 1) Product shipping profiles ───────────────────────────────── */}
        <Card>
          <div class="border-b border-border-subtle px-4 py-2.5">
            <SectionLabel>{tr("Product shipping profiles")}</SectionLabel>
          </div>
          <Show
            when={profiles().length > 0}
            fallback={
              <EmptyState testid="boxtal-catalog-profiles-empty" title={tr("No shipping profiles")}>
                {tr("Profiles carry a product's unit weight so packs and quotes can be priced.")}
              </EmptyState>
            }
          >
            <div data-testid="boxtal-catalog-profiles-table">
              <CardTable
                rows={profiles()}
                rowKey={(p) => p.id}
                // A profile with no unit weight cannot price a quote. The marker
                // rides the row itself, so the row is identifiable as broken
                // without reading the badge text.
                rowAttrs={(p) => ({ "data-invalid": String(!profileHasWeight(p)) })}
                columns={[
                  {
                    key: "product",
                    header: tr("Profile"),
                    role: "anchor",
                    cell: (p) => (
                      <span class="flex items-center gap-2">
                        <span class="text-text">{profileName(p)}</span>
                        <Show when={p.short_code && p.short_code !== profileName(p)}>
                          <span class="font-mono text-text-tertiary">{p.short_code}</span>
                        </Show>
                      </span>
                    ),
                  },
                  {
                    key: "variants",
                    header: tr("Variants"),
                    role: "secondary",
                    cell: (p) => (
                      <span
                        class="flex flex-wrap gap-1.5"
                        data-testid={`boxtal-profile-variants-${p.id}`}
                      >
                        <For each={p.variants}>
                          {(v) => (
                            <span class="inline-flex items-center gap-1.5">
                              <span class="font-mono">{v.product_id}</span>
                              <Badge tone="accent">{v.product_source}</Badge>
                            </span>
                          )}
                        </For>
                      </span>
                    ),
                  },
                  {
                    key: "weight",
                    header: tr("Unit weight"),
                    role: "meta",
                    numeric: true,
                    align: "right",
                    cell: (p) => formatWeight(p.unit_weight),
                  },
                  {
                    key: "missing-weight",
                    header: tr("Status"),
                    role: "meta",
                    cell: (p) => (
                      <span class="flex items-center gap-2">
                        <Show when={!profileHasWeight(p)}>
                          <Badge tone="warning" dot>
                            {tr("Missing weight")}
                          </Badge>
                          <Button variant="ghost" testid={`boxtal-profile-fix-${p.id}`}>
                            {tr("Fix")}
                          </Button>
                        </Show>
                        <Show when={p.short_code_sync}>
                          {(sync) => (
                            <span
                              data-testid={`boxtal-profile-code-sync-${p.id}`}
                              data-state={sync().state}
                              title={[sync().skus.join(", "), sync().detail]
                                .filter(Boolean)
                                .join(": ")}
                            >
                              <Badge tone="neutral">
                                {sync().state === "conflict"
                                  ? tr("Short code conflicts with another profile")
                                  : tr("Short code not synced yet")}
                              </Badge>
                            </span>
                          )}
                        </Show>
                        <Show when={p.variants.length === 0}>
                          <Badge tone="neutral">{tr("Unused")}</Badge>
                          <DeleteProfile profile={p} onDeleted={reload} />
                        </Show>
                      </span>
                    ),
                  },
                ]}
              />
            </div>
          </Show>
        </Card>

        {/* ── 1b) Variants a resolved row found with no profile ──────────── */}
        <Show when={unprofiled().length > 0}>
          <Card>
            <div class="border-b border-border-subtle px-4 py-2.5">
              <SectionLabel>{tr("Variants without a shipping profile")}</SectionLabel>
            </div>
            <div class="space-y-2 p-4" data-testid="boxtal-catalog-unprofiled">
              <For each={unprofiled()}>
                {(v) => (
                  <div
                    class="flex flex-wrap items-center justify-between gap-3"
                    data-testid={`boxtal-unprofiled-${v.product_source}-${v.product_id}`}
                  >
                    <span class="flex flex-col">
                      <span class="text-[13px] text-text">{v.description ?? v.product_id}</span>
                      <span class="font-mono text-[11.5px] text-text-tertiary">
                        {v.product_id} · {tr("Seen on {{count}} row(s)", { count: v.rows })}
                      </span>
                    </span>
                    <LinkVariant variant={v} profiles={profiles()} onLinked={reload} />
                  </div>
                )}
              </For>
              <p class="text-[11.5px] text-text-tertiary">
                {tr("Rows already resolved keep their parcels until the next sync.")}
              </p>
            </div>
          </Card>
        </Show>

        {/* ── 2) Packs (compound) ─────────────────────────────────────────── */}
        <Card>
          <div class="border-b border-border-subtle px-4 py-2.5">
            <SectionLabel>Packs (compound)</SectionLabel>
          </div>
          <Show
            when={packs().length > 0}
            fallback={
              <EmptyState testid="boxtal-catalog-packs-empty" title="No packs">
                Packs bundle several products into one shippable parcel with a combined gross
                weight.
              </EmptyState>
            }
          >
            <div class="space-y-3 p-4" data-testid="boxtal-catalog-packs-list">
              <For each={packs()}>
                {(pk) => (
                  <Card class="bg-elevated">
                    <div data-stale={pk.stale}>
                      <div class="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2">
                        <div class="flex items-center gap-2">
                          <span class="text-[13px] font-medium text-text">{pk.name}</span>
                          <Show when={pk.stale}>
                            <Badge tone="error" dot>
                              Stale ref
                            </Badge>
                          </Show>
                        </div>
                        <span class="font-mono tabular-nums text-[12.5px] text-text-secondary">
                          {formatWeight(pk.gross_weight)}
                        </span>
                      </div>
                      <div class="flex flex-wrap gap-1.5 px-3 py-2.5">
                        <Show
                          when={pk.components.length > 0}
                          fallback={
                            <span class="text-[11.5px] text-text-tertiary">No components</span>
                          }
                        >
                          <For each={pk.components}>
                            {(c) => (
                              <span class="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface px-2 py-0.5 text-[11.5px] text-text-secondary">
                                <span class="font-mono tabular-nums text-text-tertiary">
                                  {c.quantity}×
                                </span>
                                <span class="text-text">{c.label ?? c.product_id}</span>
                              </span>
                            )}
                          </For>
                        </Show>
                      </div>
                    </div>
                  </Card>
                )}
              </For>
            </div>
          </Show>
        </Card>

        {/* ── 3) Local products ───────────────────────────────────────────── */}
        <Card>
          <div class="border-b border-border-subtle px-4 py-2.5">
            <SectionLabel>Local products</SectionLabel>
          </div>
          <Show
            when={locals().length > 0}
            fallback={
              <EmptyState testid="boxtal-catalog-locals-empty" title="No local products">
                Local products are catalog entries created in Boxtal that don't map to an external
                source.
              </EmptyState>
            }
          >
            <div data-testid="boxtal-catalog-locals-table">
              <CardTable
                rows={locals()}
                rowKey={(l) => l.id}
                columns={[
                  {
                    key: "sku",
                    header: "SKU",
                    role: "anchor",
                    cell: (l) => <span class="font-mono">{l.sku}</span>,
                  },
                  { key: "label", header: "Label", role: "secondary", cell: (l) => l.label },
                ]}
              />
            </div>
          </Show>
        </Card>
      </div>
    </div>
  )
}
