// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ShopifyDiagnostics: the "Diagnostics and mappings" block of the declarative
// settings page (manifest `settings`, /settings/apps/shopify). The store
// connection itself (connect, reconnect, disconnect, whose account) is the
// page's connections block; this block reads ONE data bundle (`settings_load`)
// and shows what the kernel cannot know:
//   - the store's health: re-authorisation required, permissions missing from
//     the recorded grant, or a grant that predates permission tracking, each
//     with a Reconnect that re-runs the OAuth grant for the SAME store
//   - sync diagnostics (staff mirror, backfill, webhook deliveries)
//   - identity mappings (Liaison user <-> Shopify staff), Plus seed suggestions
//   - the inventory-location allowlist
//
// All writes route through admin-gated tools; the UI never calls
// `ctx.db.insert` directly, so the kernel scope-gate stays the single
// chokepoint enforcing `shopify:admin:*`.
//
// Styling: Tailwind tokens (kernel design system). The kernel's theme.css
// `@source "../../../../bundled-apps/**/src/**/*.{tsx,ts}"` directive scans
// this file at build time so the JIT emits the classes used here.

import { CardTable } from "@liaison/app-ui/card-table"
import { app, onEntityChange } from "@liaison/host"
import { type Component, createSignal, For, Show } from "solid-js"
import { Chip } from "./primitives"

export interface IdentityMappingRow {
  liaisonUserId: string
  liaisonEmail: string
  shopifyStaffId: string | null
  source: "auto" | "override" | "unmapped"
}

export interface DiagnosticsSnapshot {
  staffMirrorLastSyncedAt: string | null
  backfillStatus: "idle" | "running" | "failed" | "completed"
  backfillCursor: string | null
  webhookDeliveriesProcessed24h: number
  webhookDeliveriesFailed24h: number
}

export interface ConnectionSnapshot {
  // `needs_reconnect` = the kernel still has a connection row but the stored
  // OAuth token has been invalidated (revoked scopes / 401 from Shopify /
  // consecutive scope-mirror failures). The store is technically "connected"
  // in the kernel sense but the operator must re-authorise before sync resumes.
  status: "connected" | "disconnected" | "needs_reconnect"
  shopDomain: string | null
  connectedAt: string | null
  /** False when the connection predates granted-scope tracking (grant content
   *  unverifiable until the operator reconnects once). */
  scopesKnown: boolean
  /** Manifest-required OAuth scopes the recorded grant is missing; non-empty
   *  means Shopify silently degrades (60-day order window, analytics denied)
   *  until the operator reconnects and re-authorizes. */
  missingScopes: string[]
}

export interface SettingsBundle {
  connection: ConnectionSnapshot
  mappings: IdentityMappingRow[]
  diagnostics: DiagnosticsSnapshot
  inventoryAllowlist: string[]
  seedAvailable: boolean
  seedSuggestions: Array<{
    liaisonUserId: string
    shopifyStaffEmail: string
    scopes: string[]
  }>
}

function SourceBadge(props: { source: "auto" | "override" | "unmapped" }) {
  const first = props.source.charAt(0).toUpperCase()
  const label = first + props.source.slice(1)
  const cls =
    props.source === "auto"
      ? "bg-accent-subtle text-accent border border-accent-border"
      : props.source === "override"
        ? "bg-warning-glow text-warning border border-warning-border"
        : "bg-surface-hover text-text-tertiary border border-border"
  return (
    <span
      class={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  )
}

/** Custom block named by the manifest's `settings` (component "ShopifyDiagnostics"). */
export const ShopifyDiagnostics: Component = () => {
  const [bundle, { refetch }] = app.createResource<SettingsBundle>(() =>
    app.invokeTool<SettingsBundle>("settings_load", {}),
  )
  // A Reconnect completes OUTSIDE this view (provider redirect, the desktop's
  // system browser, the phone's authentication session), and the new grant is
  // recorded by the app's connect subscriber only after the kernel's own
  // connection event went out. Refetch when that subscriber says the recorded
  // connection changed, or the health banners keep showing the old grant.
  onEntityChange("shopify:connection", () => void refetch())
  const [status, setStatus] = createSignal<string | null>(null)
  // Which unmapped row currently has its inline staff-id editor open, and the
  // draft value typed into it. Keyed by liaisonUserId so only one editor is
  // open at a time (the table is single-column-wide for actions).
  const [editingUserId, setEditingUserId] = createSignal<string | null>(null)
  const [staffIdDraft, setStaffIdDraft] = createSignal("")

  async function onMap(liaisonUserId: string, shopifyStaffId: string) {
    setStatus(null)
    const trimmed = shopifyStaffId.trim()
    if (!trimmed) {
      // Guard in the UI so we never fire the handler with an empty id (the
      // handler rejects empty ids with INVALID_ARG — surface that as guidance
      // rather than a backend error string).
      setStatus("Enter a Shopify staff id before saving.")
      return
    }
    try {
      await app.invokeTool("staff_overrides_upsert", {
        liaisonUserId,
        shopifyStaffId: trimmed,
      })
      setEditingUserId(null)
      setStaffIdDraft("")
      setStatus("Mapping saved.")
      void refetch()
    } catch (err) {
      setStatus(`Failed: ${(err as Error).message}`)
    }
  }

  function startEditing(liaisonUserId: string) {
    setStatus(null)
    setStaffIdDraft("")
    setEditingUserId(liaisonUserId)
  }

  function cancelEditing() {
    setEditingUserId(null)
    setStaffIdDraft("")
  }

  async function onUnmap(rowId: string) {
    setStatus(null)
    try {
      await app.invokeTool("staff_overrides_delete", { id: rowId })
      setStatus("Mapping removed.")
      void refetch()
    } catch (err) {
      setStatus(`Failed: ${(err as Error).message}`)
    }
  }

  async function onConnect() {
    setStatus(null)
    try {
      // Reconnect re-runs the OAuth grant for the SAME store in place: pass the
      // known shop domain (the `{shop}` template var) and org mode so the
      // kernel authorizes the org-owned store connection. A fresh connect (no
      // domain yet) omits `shop`; the server then reports what is missing.
      const shopDomain = bundle()?.connection.shopDomain
      await app.openConnect({
        connectionName: "shop",
        params: {
          mode: "org",
          ...(shopDomain ? { shop: shopDomain } : {}),
        },
      })
    } catch (err) {
      setStatus(`Failed: ${(err as Error).message}`)
    }
  }

  async function onApplySeed(liaisonUserId: string, scopes: string[]) {
    setStatus(null)
    try {
      await app.invokeTool("apply_seed_suggestion", { liaisonUserId, scopes })
      setStatus("Scopes applied.")
      void refetch()
    } catch (err) {
      setStatus(`Failed: ${(err as Error).message}`)
    }
  }

  return (
    <section data-testid="shopify-settings" class="flex w-full flex-col gap-6">
      <Show when={bundle()} fallback={<SettingsSkeleton />}>
        {(b) => (
          <>
            {/* Store health: what needs the operator before sync is whole. */}
            <section data-testid="shopify-connection" class="flex flex-col gap-3">
              <Show when={b().connection.status === "needs_reconnect"}>
                <div
                  data-testid="shopify-connection-reconnect-hint"
                  class="flex items-start justify-between gap-3 rounded-md border border-warning-border bg-warning-glow px-3 py-2"
                >
                  <p class="text-[11px] text-warning">
                    Re-authorisation required for{" "}
                    <span class="font-mono">{b().connection.shopDomain}</span>: the stored Shopify
                    token is no longer valid. Sync is paused until you reconnect.
                  </p>
                  <ReconnectButton
                    testid="shopify-connect-button"
                    label="Reconnect Shopify"
                    onClick={() => void onConnect()}
                  />
                </div>
              </Show>
              {/* Permissions drift — the silent-degradation killer. Shown while
                  technically "Connected": Shopify does not error when a grant
                  lacks scopes, it just hides data (orders older than 60 days,
                  analytics), so this banner is the only honest signal. Under
                  Shopify-managed installation the grant is the app's released
                  configuration, so the scopes go there before a Reconnect. */}
              <Show
                when={
                  b().connection.status === "connected" && b().connection.missingScopes.length > 0
                }
              >
                <div
                  data-testid="shopify-scope-drift-banner"
                  class="rounded-md border border-warning-border bg-warning-glow px-3 py-2"
                >
                  <p class="text-xs font-medium text-warning">Permissions update required</p>
                  <p class="mt-0.5 text-[11px] text-text-secondary">
                    This connection was authorized before the app required{" "}
                    <span class="font-mono text-text">
                      {b().connection.missingScopes.join(", ")}
                    </span>
                    . Until the store grants them, Shopify silently limits what the tools can see
                    (order history older than 60 days, analytics). Shopify grants only the scopes in
                    your Shopify app's configuration, so Reconnect alone cannot add them: first add
                    them to that configuration (download the current shopify.app.toml from Liaison's
                    Shopify setup guide, or add them to{" "}
                    <span class="font-mono">[access_scopes] scopes</span>) and run{" "}
                    <span class="font-mono">shopify app deploy</span>, then click Reconnect and
                    approve.
                  </p>
                  <div class="mt-2">
                    <ReconnectButton
                      testid="shopify-reconnect-button"
                      label="Reconnect"
                      onClick={() => void onConnect()}
                    />
                  </div>
                </div>
              </Show>
              <Show when={b().connection.status === "connected" && !b().connection.scopesKnown}>
                <div
                  data-testid="shopify-scopes-unknown-banner"
                  class="rounded-md border border-warning-border bg-warning-glow px-3 py-2"
                >
                  <p class="text-xs font-medium text-warning">Permissions not verifiable</p>
                  <p class="mt-0.5 text-[11px] text-text-secondary">
                    This connection was made before Liaison recorded granted permissions, so it
                    cannot verify the grant covers everything the tools need (including order
                    history older than 60 days and analytics). Click Reconnect once to re-authorize
                    and record the grant.
                  </p>
                  <div class="mt-2">
                    <ReconnectButton
                      testid="shopify-reconnect-button"
                      label="Reconnect"
                      onClick={() => void onConnect()}
                    />
                  </div>
                </div>
              </Show>
            </section>

            {/* Diagnostics */}
            <section
              data-testid="settings-diagnostics"
              class="rounded-lg border border-border bg-surface p-4"
            >
              <h2 class="text-sm font-medium text-text">Sync diagnostics</h2>
              <dl class="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
                <div>
                  <dt class="text-[11px] uppercase tracking-wide text-text-tertiary">
                    Staff mirror
                  </dt>
                  <dd class="mt-0.5 text-xs text-text">
                    {b().diagnostics.staffMirrorLastSyncedAt ?? (
                      <span class="text-text-tertiary">never</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt class="text-[11px] uppercase tracking-wide text-text-tertiary">Backfill</dt>
                  <dd class="mt-0.5 flex items-center gap-2 text-xs text-text">
                    <BackfillBadge status={b().diagnostics.backfillStatus} />
                    <Show when={b().diagnostics.backfillCursor}>
                      <span class="truncate font-mono text-[11px] text-text-tertiary">
                        {b().diagnostics.backfillCursor}
                      </span>
                    </Show>
                  </dd>
                </div>
                <div>
                  <dt class="text-[11px] uppercase tracking-wide text-text-tertiary">
                    Webhooks (24h)
                  </dt>
                  <dd class="mt-0.5 text-xs text-text">
                    <span class="text-success">
                      {b().diagnostics.webhookDeliveriesProcessed24h} ok
                    </span>
                    <span class="mx-1 text-text-tertiary">·</span>
                    <span
                      class={
                        b().diagnostics.webhookDeliveriesFailed24h > 0
                          ? "text-error"
                          : "text-text-tertiary"
                      }
                    >
                      {b().diagnostics.webhookDeliveriesFailed24h} failed
                    </span>
                  </dd>
                </div>
              </dl>
            </section>

            {/* Mappings */}
            <section
              data-testid="settings-mappings"
              class="overflow-hidden rounded-lg border border-border bg-surface"
            >
              <div class="flex items-baseline justify-between border-b border-border-subtle px-4 py-3">
                <h2 class="text-sm font-medium text-text">Identity mappings</h2>
                <p class="text-[11px] text-text-tertiary">Liaison user ↔ Shopify staff</p>
              </div>
              <Show
                when={b().mappings.length > 0}
                fallback={
                  <p class="px-4 py-6 text-center text-xs text-text-tertiary">
                    No users to map yet.
                  </p>
                }
              >
                <CardTable
                  rows={b().mappings}
                  rowKey={(row) => row.liaisonUserId}
                  columns={[
                    {
                      key: "user",
                      header: "Liaison user",
                      role: "anchor",
                      cell: (row) => <span class="font-mono text-[12px]">{row.liaisonEmail}</span>,
                    },
                    {
                      key: "staff",
                      header: "Shopify staff",
                      role: "secondary",
                      cell: (row) => (
                        <span class="font-mono text-[12px] text-text-secondary">
                          {row.shopifyStaffId ?? <span class="text-text-tertiary">-</span>}
                        </span>
                      ),
                    },
                    {
                      key: "source",
                      header: "Source",
                      role: "meta",
                      cell: (row) => <SourceBadge source={row.source} />,
                    },
                    {
                      key: "mapping",
                      header: "Mapping",
                      role: "fold",
                      align: "right",
                      cell: (row) => (
                        <>
                          <Show when={row.source === "unmapped"}>
                            <Show
                              when={editingUserId() === row.liaisonUserId}
                              fallback={
                                <button
                                  type="button"
                                  data-testid={`map-${row.liaisonUserId}`}
                                  onClick={() => startEditing(row.liaisonUserId)}
                                  class="min-h-11 rounded border border-border bg-surface-hover px-2 py-1 text-[11px] font-medium text-text-secondary transition hover:border-accent-border hover:text-accent sm:min-h-0"
                                >
                                  Map manually
                                </button>
                              }
                            >
                              <form
                                class="flex flex-wrap items-center justify-end gap-1.5"
                                onSubmit={(e) => {
                                  e.preventDefault()
                                  void onMap(row.liaisonUserId, staffIdDraft())
                                }}
                              >
                                <input
                                  type="text"
                                  data-testid={`map-input-${row.liaisonUserId}`}
                                  placeholder="Shopify staff id"
                                  value={staffIdDraft()}
                                  onInput={(e) => setStaffIdDraft(e.currentTarget.value)}
                                  /* biome-ignore lint/a11y/noAutofocus: focus the field the operator just revealed */
                                  autofocus
                                  class="w-36 min-h-11 rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-text outline-none focus:border-accent-border sm:min-h-0"
                                />
                                <button
                                  type="submit"
                                  data-testid={`map-save-${row.liaisonUserId}`}
                                  class="min-h-11 rounded border border-accent-border bg-accent-subtle px-2 py-1 text-[11px] font-medium text-accent transition hover:bg-accent-tint sm:min-h-0"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  data-testid={`map-cancel-${row.liaisonUserId}`}
                                  onClick={() => cancelEditing()}
                                  class="min-h-11 rounded border border-border bg-surface-hover px-2 py-1 text-[11px] font-medium text-text-tertiary transition hover:text-text-secondary sm:min-h-0"
                                >
                                  Cancel
                                </button>
                              </form>
                            </Show>
                          </Show>
                          <Show when={row.source === "override"}>
                            <button
                              type="button"
                              data-testid={`unmap-${row.liaisonUserId}`}
                              onClick={() => onUnmap(row.shopifyStaffId ?? "")}
                              class="min-h-11 rounded border border-border bg-surface-hover px-2 py-1 text-[11px] font-medium text-text-tertiary transition hover:border-error-border hover:text-error sm:min-h-0"
                            >
                              Remove override
                            </button>
                          </Show>
                        </>
                      ),
                    },
                  ]}
                />
              </Show>
            </section>

            {/* Seed suggestions */}
            <Show when={b().seedAvailable}>
              <section
                data-testid="settings-seed"
                class="rounded-lg border border-accent-border bg-accent-subtle p-4"
              >
                <h2 class="text-sm font-medium text-accent">Re-seed from Shopify</h2>
                <p class="mt-0.5 text-xs text-text-secondary">
                  Apply detected Shopify staff scopes to the matching Liaison user.
                </p>
                <ul class="mt-3 flex flex-col divide-y divide-border-subtle">
                  <For each={b().seedSuggestions}>
                    {(s) => (
                      <li class="flex items-center justify-between gap-3 py-2.5">
                        <div class="min-w-0">
                          <p class="truncate font-mono text-[12px] text-text">
                            {s.shopifyStaffEmail}
                          </p>
                          <p class="mt-0.5 truncate text-[11px] text-text-secondary">
                            {s.scopes.join(", ")}
                          </p>
                        </div>
                        <button
                          type="button"
                          data-testid={`apply-seed-${s.liaisonUserId}`}
                          onClick={() => onApplySeed(s.liaisonUserId, s.scopes)}
                          class="shrink-0 rounded-md border border-accent-border bg-accent-tint px-2.5 py-1 text-[11px] font-medium text-accent transition hover:bg-accent-wash"
                        >
                          Apply
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>

            {/* Inventory allowlist */}
            <section
              data-testid="settings-allowlist"
              class="rounded-lg border border-border bg-surface p-4"
            >
              <div class="flex items-baseline justify-between">
                <h2 class="text-sm font-medium text-text">Inventory-location allowlist</h2>
                <p class="text-[11px] text-text-tertiary">
                  {b().inventoryAllowlist.length} locations
                </p>
              </div>
              <Show
                when={b().inventoryAllowlist.length > 0}
                fallback={
                  <p class="mt-2 text-xs text-text-tertiary">
                    All locations are visible. Add to restrict.
                  </p>
                }
              >
                <ul class="mt-3 flex flex-wrap gap-1.5">
                  <For each={b().inventoryAllowlist}>
                    {(loc) => (
                      <li class="rounded border border-border bg-bg/40 px-2 py-0.5 font-mono text-[11px] text-text-secondary">
                        {loc}
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          </>
        )}
      </Show>

      <Show when={status()}>
        <p
          data-testid="settings-status"
          class="rounded border border-border bg-elevated px-3 py-2 text-xs text-text-secondary"
        >
          {status()}
        </p>
      </Show>
    </section>
  )
}

function ReconnectButton(props: { testid: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid={props.testid}
      onClick={props.onClick}
      class="shrink-0 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition hover:bg-surface-hover hover:text-text"
    >
      {props.label}
    </button>
  )
}

function BackfillBadge(props: { status: "idle" | "running" | "failed" | "completed" }) {
  const tone =
    props.status === "completed"
      ? "text-success"
      : props.status === "running"
        ? "text-accent"
        : props.status === "failed"
          ? "text-error"
          : "text-text-tertiary"
  return <span class={`font-medium ${tone}`}>{props.status}</span>
}

function SettingsSkeleton() {
  return (
    <div class="flex flex-col gap-6" aria-hidden="true">
      <div class="h-20 animate-pulse rounded-lg border border-border bg-surface" />
      <div class="h-24 animate-pulse rounded-lg border border-border bg-surface" />
      <div class="h-48 animate-pulse rounded-lg border border-border bg-surface" />
    </div>
  )
}
