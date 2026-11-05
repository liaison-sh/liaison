// SPDX-License-Identifier: FSL-1.1-ALv2
// Workspace › App store (`/settings/store`, S21, D17, prototype S-STORE v2):
// a LIST, not a card grid. Installed / Available, category chips, search;
// each row has the app's icon, name, kind, publisher, one line and its state
// or action: Running · Failed to load · Upgrade failed (with the reason on the
// row's line) · Update available · Off, or Add to workspace (installed
// on the server, not here) · Install (the operator's workspace) · Ask your
// server operator. A row opens the app's listing (`/settings/store/<app>`).
// "Install from URL" checks a package and asks before granting anything.
// No price anywhere: listings carry none (D11).
import { useLocation, useNavigate } from "@solidjs/router"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onMount,
  Show,
} from "solid-js"
import { appLabel } from "~/lib/app-label"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { orgAppsStore } from "../app-management/org-apps-store"
import { RemoveAppDialog } from "../app-management/RemoveAppDialog"
import { appSettingsPage } from "../app-page/app-settings-pages"
import { appsStore } from "../apps-store"
import { StoreInstallDialog } from "./StoreInstallDialog"
import { loadStoreData, settingsPathFor, storeItems } from "./store-data"
import {
  filterStoreItems,
  isInWorkspace,
  type StoreItem,
  type StoreKind,
  type StoreSegment,
  storeCategories,
} from "./store-model"

const S = "kernel.appStore"

export function storeDetailHref(app: string): string {
  return `/settings/store/${encodeURIComponent(app)}`
}

/** The app's icon: its registered rail icon, else its initial. */
export const StoreIcon: Component<{ app: string; name: string; large?: boolean }> = (props) => {
  const Icon = () => appSettingsPage(props.app)?.icon
  return (
    <span
      class="inline-flex flex-none items-center justify-center rounded-md border border-border bg-bg text-text-secondary"
      classList={{ "h-10 w-10": props.large, "h-8 w-8": !props.large }}
      aria-hidden="true"
    >
      <Show
        when={Icon()}
        fallback={<span class="text-xs font-semibold">{props.name.slice(0, 1).toUpperCase()}</span>}
      >
        {(I) => {
          const C = I()
          return <C size={props.large ? 20 : 16} />
        }}
      </Show>
    </span>
  )
}

/** The state chip's words: Retired, Off, else how the app runs (S8), else Update available. */
export function stateLabel(t: (k: string) => string, item: StoreItem): string {
  if (item.state === "retired") return t(`${S}.stateRetired`)
  if (item.state === "off") return t(`${S}.stateOff`)
  if (item.run?.state === "failed") return t(`${S}.stateFailed`)
  if (item.run?.state === "upgrade-failed") return t(`${S}.stateUpgradeFailed`)
  if (item.state === "update") return t(`${S}.stateUpdate`)
  if (item.state === "added") return t(`${S}.stateRunning`)
  return ""
}

/** Why the app is not running as it should, in words: the server's reason, or what kind of failure. */
export function runReason(
  t: (k: string, params?: Record<string, string>) => string,
  item: StoreItem,
): string | undefined {
  const run = item.run
  if (!run || run.state === "running") return undefined
  if (run.state === "failed") {
    return (
      run.message ??
      t(run.code === "manifest_invalid" ? `${S}.failedManifestInvalid` : `${S}.failedRegistration`)
    )
  }
  return run.message
}

/**
 * One calm chip per app: Running, Failed to load, Upgrade failed, Update
 * available, Off or Retired. A failure reads in neutral colours, never an alarm.
 */
export const StoreStateChip: Component<{ item: StoreItem }> = (props) => {
  const i18n = useI18n()
  const kind = () =>
    props.item.run && props.item.run.state !== "running" && props.item.state !== "off"
      ? props.item.run.state
      : props.item.state
  return (
    <Show when={stateLabel(i18n.t, props.item)}>
      <span
        class="rounded-full border px-2 py-px text-[11px] font-medium"
        classList={{
          "border-success/40 text-success": kind() === "added",
          "border-border text-text-secondary":
            kind() === "off" ||
            kind() === "retired" ||
            kind() === "failed" ||
            kind() === "upgrade-failed",
          "border-warning/40 text-warning": kind() === "update",
        }}
        data-state={kind()}
        title={runReason(i18n.t, props.item)}
        data-testid={`app-store-state-${props.item.name}`}
      >
        {stateLabel(i18n.t, props.item)}
      </span>
    </Show>
  )
}

export function kindLabel(t: (k: string) => string, kind: StoreKind): string {
  return t(kind === "connector" ? `${S}.kindConnector` : `${S}.kindApp`)
}

export function itemName(t: (k: string) => string, item: StoreItem): string {
  return appLabel(item.name, t, item.displayName)
}

/** The publisher as the store shows it: an outside app's reads as self-declared (A12). */
export function publisherText(
  t: (k: string, params?: Record<string, string>) => string,
  item: Pick<StoreItem, "publisher" | "publisherSelfDeclared">,
): string {
  const publisher = item.publisher ?? ""
  return item.publisherSelfDeclared ? t(`${S}.publisherSelfDeclared`, { publisher }) : publisher
}

/**
 * Add a server-installed app to the workspace, or install a catalog app (the
 * operator's org). A registry app opens Install from URL with its package.
 */
export function useStoreActions(openUrlInstall: (url: string) => void) {
  const i18n = useI18n()
  const api = useApi()
  const [busy, setBusy] = createSignal<string | null>(null)

  async function run(item: StoreItem): Promise<void> {
    const name = itemName(i18n.t, item)
    if (item.state === "install" && item.catalogSource === "registry" && item.packageUrl) {
      openUrlInstall(item.packageUrl)
      return
    }
    setBusy(item.name)
    try {
      if (item.state === "add") {
        await orgAppsStore.add(api, item.name)
        addToast({ message: i18n.t(`${S}.addedToast`, { name }), type: "success" })
      } else if (item.state === "install") {
        await appsStore.installCatalogApp(api, item.name)
        await orgAppsStore.load(api)
        addToast({ message: i18n.t(`${S}.installedToast`, { name }), type: "success" })
      }
    } catch (e) {
      addToast({
        message:
          e instanceof Error && e.message ? e.message : i18n.t(`${S}.actionFailed`, { name }),
        type: "error",
      })
    } finally {
      setBusy(null)
    }
  }
  return { busy, run }
}

/** The action a not-yet-added row offers. */
export const StoreAction: Component<{
  item: StoreItem
  busy: boolean
  onRun: () => void
  /** Test ids of the Add, Install and Ask-your-operator controls. */
  ids: { add: string; install: string; ask: string }
}> = (props) => {
  const i18n = useI18n()
  const name = () => itemName(i18n.t, props.item)
  return (
    <>
      <Show when={props.item.state === "add"}>
        <Button
          size="sm"
          variant="primary"
          class="w-auto"
          disabled={props.busy}
          aria-label={i18n.t(`${S}.addLabel`, { name: name() })}
          data-testid={props.ids.add}
          onClick={() => props.onRun()}
        >
          {props.busy ? i18n.t(`${S}.adding`) : i18n.t(`${S}.add`)}
        </Button>
      </Show>
      <Show when={props.item.state === "install"}>
        <Button
          size="sm"
          variant="primary"
          class="w-auto"
          disabled={props.busy}
          aria-label={i18n.t(`${S}.installLabel`, { name: name() })}
          data-testid={props.ids.install}
          onClick={() => props.onRun()}
        >
          {props.busy ? i18n.t(`${S}.installing`) : i18n.t(`${S}.install`)}
        </Button>
      </Show>
      <Show when={props.item.state === "ask-operator"}>
        <span class="text-xs text-text-secondary" data-testid={props.ids.ask}>
          {i18n.t(`${S}.askOperator`)}
        </span>
      </Show>
    </>
  )
}

export const AppStorePage: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const location = useLocation()
  const navigate = useNavigate()
  const [loaded, setLoaded] = createSignal(false)
  const params = () => new URLSearchParams(location.search)
  const kindParam = (): StoreKind | undefined =>
    params().get("kind") === "connector" ? "connector" : undefined
  const [segment, setSegment] = createSignal<StoreSegment>(kindParam() ? "available" : "installed")
  const [category, setCategory] = createSignal<string | undefined>(undefined)
  const [query, setQuery] = createSignal("")
  const [urlInstall, setUrlInstall] = createSignal<{ url?: string } | null>(null)
  // A retired app's Remove asks first (the shared Remove dialog).
  const [removing, setRemoving] = createSignal<StoreItem | null>(null)
  const actions = useStoreActions((url) => setUrlInstall({ url }))

  const load = () => loadStoreData(api).then(() => setLoaded(true))
  onMount(() => {
    void load()
  })
  // The workspace's own list could not be read: say so, never "Installed · 0".
  const loadFailed = () => loaded() && orgAppsStore.failed()
  // A cold load knows no counts until the workspace's apps and the catalog are read
  // (NAV-11): until then it says it is loading, never "Installed · 0". Coming back to
  // the page in the same session, both are already known and show at once.
  const ready = () => loaded() || (orgAppsStore.loaded() && appsStore.catalogLoaded())

  // A former "connect this app" link (Settings › Apps used to take one) lands
  // on the app's page, or its card on Connectors, with the connection open.
  createEffect(
    on([loaded, () => location.search], ([ready, search]) => {
      const q = new URLSearchParams(search)
      const app = q.get("connect")
      if (!app) return
      const kind = appSettingsPage(app)?.manifest.kind ?? orgAppsStore.app(app)?.kind
      if (!kind && !ready) return
      navigate(settingsPathFor(app, kind, q.get("connection") ?? undefined), { replace: true })
    }),
  )

  const items = createMemo(() => storeItems())
  const installed = createMemo(() => filterStoreItems(items(), { segment: "installed" }))
  const available = createMemo(() => filterStoreItems(items(), { segment: "available" }))
  const categories = createMemo(() => storeCategories(items()))
  const shown = createMemo(() =>
    filterStoreItems(items(), {
      segment: segment(),
      category: category(),
      kind: kindParam(),
      query: query(),
      labelOf: (item) => itemName(i18n.t, item),
    }),
  )

  // Labels are accessors: a count change updates the text, never re-creates the button.
  const segButton = (value: StoreSegment, label: () => string) => (
    <button
      type="button"
      class="rounded-md px-3 py-1 text-[12.5px]"
      classList={{
        "bg-surface-active font-medium text-text": segment() === value,
        "text-text-secondary hover:text-text": segment() !== value,
      }}
      aria-pressed={segment() === value}
      data-testid={`app-store-seg-${value}`}
      onClick={() => setSegment(value)}
    >
      {label()}
    </button>
  )

  const chip = (value: string | undefined, label: string, testId: string) => (
    <button
      type="button"
      class="rounded-full border px-2.5 py-0.5 text-[12px]"
      classList={{
        "border-accent bg-accent/10 text-text": category() === value,
        "border-border text-text-secondary hover:text-text": category() !== value,
      }}
      aria-pressed={category() === value}
      data-testid={testId}
      onClick={() => setCategory(value)}
    >
      {label}
    </button>
  )

  return (
    <div data-testid="app-store">
      <div class="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h1 class="text-lg font-semibold leading-tight">{i18n.t(`${S}.title`)}</h1>
          <p class="mt-1 text-[12.5px] text-text-secondary">{i18n.t(`${S}.intro`)}</p>
        </div>
        <Show when={appsStore.canManageInstalls()}>
          <Button
            variant="outline"
            class="w-auto"
            data-testid="app-store-install-url"
            onClick={() => setUrlInstall({})}
          >
            {i18n.t(`${S}.installFromUrl`)}
          </Button>
        </Show>
      </div>

      <Show when={!appsStore.canManageInstalls()}>
        <p class="mb-4 text-xs text-text-secondary" data-testid="app-store-operator-only">
          {i18n.t(`${S}.operatorOnly`)}
        </p>
      </Show>
      <Show when={appsStore.catalogNotice() === "registry_unreachable"}>
        <p
          class="mb-4 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text-secondary"
          data-testid="app-store-registry-notice"
        >
          {i18n.t(`${S}.registryUnreachable`)}
        </p>
      </Show>

      <Show when={loadFailed()}>
        <div
          class="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-text-secondary"
          data-testid="app-store-load-error"
        >
          <span class="min-w-0 flex-1">{i18n.t(`${S}.loadFailed`)}</span>
          <Button
            variant="outline"
            class="w-auto"
            data-testid="app-store-retry"
            onClick={() => void load()}
          >
            {i18n.t(`${S}.retry`)}
          </Button>
        </div>
      </Show>

      <Show when={!ready()}>
        <p class="text-[13px] text-text-secondary" data-testid="app-store-loading">
          {i18n.t("kernel.loading")}
        </p>
      </Show>

      <Show when={ready() && !loadFailed()}>
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <fieldset class="flex gap-1 rounded-lg border border-border p-0.5">
            <legend class="sr-only">{i18n.t(`${S}.show`)}</legend>
            {segButton("installed", () =>
              i18n.t(`${S}.installedCount`, { count: installed().length }),
            )}
            {segButton("available", () =>
              i18n.t(`${S}.availableCount`, { count: available().length }),
            )}
          </fieldset>
          <span class="flex-1" />
          <label class="sr-only" for="app-store-search">
            {i18n.t(`${S}.searchLabel`)}
          </label>
          <input
            id="app-store-search"
            type="search"
            class="h-8 w-48 rounded-md border border-border bg-bg px-2 text-[13px]"
            placeholder={i18n.t(`${S}.search`)}
            value={query()}
            data-testid="app-store-search"
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>

        <fieldset class="mb-4 flex flex-wrap gap-1.5">
          <legend class="sr-only">{i18n.t(`${S}.categoryGroup`)}</legend>
          {chip(undefined, i18n.t(`${S}.all`), "app-store-cat-All")}
          <For each={categories()}>
            {(c) => chip(c, i18n.t(`${S}.category.${c}`), `app-store-cat-${c}`)}
          </For>
        </fieldset>

        <Show when={kindParam()}>
          <p class="mb-3 flex items-center gap-2 text-xs text-text-secondary">
            {i18n.t(`${S}.connectorsOnly`)}
            <button
              type="button"
              class="underline"
              data-testid="app-store-show-all"
              onClick={() => navigate("/settings/store", { replace: true })}
            >
              {i18n.t(`${S}.showAll`)}
            </button>
          </p>
        </Show>

        <Show
          when={shown().length > 0}
          fallback={
            <Show when={loaded()}>
              <div
                class="rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-text-secondary"
                data-testid="app-store-empty"
              >
                {i18n.t(`${S}.nothingMatches`)}
              </div>
            </Show>
          }
        >
          <ul
            class="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface"
            data-testid="app-store-list"
          >
            <For each={shown()}>
              {(item) => (
                <li
                  class="flex items-center gap-3 px-3 py-2.5"
                  data-testid={`app-store-row-${item.name}`}
                >
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-3 text-left"
                    data-testid={`app-store-open-${item.name}`}
                    onClick={() => navigate(storeDetailHref(item.name))}
                  >
                    <StoreIcon app={item.name} name={itemName(i18n.t, item)} />
                    <span class="min-w-0 flex-1">
                      <span class="flex flex-wrap items-center gap-1.5">
                        <span class="text-[13.5px] font-medium">{itemName(i18n.t, item)}</span>
                        <span class="rounded border border-border px-1 text-[10px] uppercase tracking-wide text-text-tertiary">
                          {kindLabel(i18n.t, item.kind)}
                        </span>
                        <span class="text-[11px] text-text-tertiary">
                          <Show when={item.unlisted} fallback={publisherText(i18n.t, item)}>
                            {i18n.t(`${S}.unlisted`)}
                          </Show>
                        </span>
                      </span>
                      <Show
                        when={item.state !== "off" && runReason(i18n.t, item)}
                        fallback={
                          <Show when={item.listing?.summary ?? item.description}>
                            <span class="block truncate text-xs text-text-secondary">
                              {item.listing?.summary ?? item.description}
                            </span>
                          </Show>
                        }
                      >
                        {(reason) => (
                          <span
                            class="block truncate text-xs text-text-secondary"
                            data-testid={`app-store-reason-${item.name}`}
                          >
                            {reason()}
                          </span>
                        )}
                      </Show>
                    </span>
                  </button>
                  <span class="flex-none">
                    <Show
                      when={isInWorkspace(item)}
                      fallback={
                        <StoreAction
                          item={item}
                          busy={actions.busy() === item.name}
                          onRun={() => void actions.run(item)}
                          ids={{
                            add: `app-store-add-${item.name}`,
                            install: `app-store-install-${item.name}`,
                            ask: `app-store-ask-${item.name}`,
                          }}
                        />
                      }
                    >
                      <span class="flex items-center gap-2">
                        <StoreStateChip item={item} />
                        <Show when={item.state === "retired"}>
                          <Button
                            size="sm"
                            variant="outline"
                            class="w-auto"
                            aria-label={i18n.t(`${S}.removeLabel`, {
                              name: itemName(i18n.t, item),
                            })}
                            data-testid={`app-store-remove-${item.name}`}
                            onClick={() => setRemoving(item)}
                          >
                            {i18n.t(`${S}.removeShort`)}
                          </Button>
                        </Show>
                      </span>
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>

      <p class="mt-5 text-xs text-text-tertiary">{i18n.t(`${S}.footer`)}</p>

      <RemoveAppDialog
        open={removing() !== null}
        app={removing()?.name ?? ""}
        name={(() => {
          const item = removing()
          return item ? itemName(i18n.t, item) : ""
        })()}
        kind={removing()?.kind ?? "app"}
        onClose={() => setRemoving(null)}
      />

      <StoreInstallDialog
        open={urlInstall() !== null}
        initialUrl={urlInstall()?.url}
        onClose={() => setUrlInstall(null)}
      />
    </div>
  )
}
