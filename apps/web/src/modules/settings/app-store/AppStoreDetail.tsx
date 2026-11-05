// SPDX-License-Identifier: FSL-1.1-ALv2
// One App store listing (`/settings/store/<app>`, S21, A4, A11, prototype
// S-STORE detail): what the app is (description, screenshots), who publishes
// it and where its source lives (repository, licence: listed apps are
// source-available), what it can do (its permissions in plain words, from the
// scope catalog), its versions, and the actions that fit its state: Add to
// workspace / Install, or Remove from this workspace and Open settings. An
// installed package can be uninstalled from the server; the server refuses
// while another workspace still has it added and says how many (A4). It says
// how the app runs (Running, Failed to load, Upgrade failed, with the reason,
// S8), and the instance operator can roll an installed app back to the
// version kept before it, after an inline confirmation (S9, A10).
import { useLocation, useNavigate } from "@solidjs/router"
import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { appLabel } from "~/lib/app-label"
import { scopeLabel } from "~/lib/capability-copy"
import { openExternal } from "~/modules/desktop/external-links"
import { catalogHasKey, seededCopy, type Translate, useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { PopupMenu } from "~/ui/PopupMenu"
import { RemoveAppDialog } from "../app-management/RemoveAppDialog"
import { appsStore, toUpgradePreview } from "../apps-store"
import { InstallAppDialog, type UpgradePreview } from "../InstallAppDialog"
import type { ScopeCatalogEntry } from "../PermissionGrid"
import {
  itemName,
  kindLabel,
  publisherText,
  runReason,
  StoreAction,
  StoreIcon,
  StoreStateChip,
  stateLabel,
  useStoreActions,
} from "./AppStorePage"
import { StoreInstallDialog } from "./StoreInstallDialog"
import { loadStoreData, settingsPathFor, storeItems } from "./store-data"
import { isInWorkspace, type StoreItem } from "./store-model"

const S = "kernel.appStore"
const DETAIL_PATH = /^\/settings\/store\/([^/?#]+)/

/**
 * The app's permissions in plain words (STO-03): the scope catalog's
 * description when it has one, else the words of the scope itself
 * ("tickets:replies:write" reads "Tickets: edit replies"). A catalog app not
 * installed here has only its declared scope ids, so those read the same way.
 */
export function permissionLines(
  item: StoreItem,
  catalog: readonly ScopeCatalogEntry[],
  t: Translate,
): string[] {
  const own = catalog.filter((e) => e.app === item.name)
  const scopes = own.length > 0 ? own.map((e) => e.scope) : item.scopes
  const describe = (scope: string) =>
    scopeLabel(scope, t, catalog.find((e) => e.scope === scope)?.description)
  return [...new Set(scopes.map(describe))]
}

/** "Upgrade to 2.0.0 failed. Still running 1.4.0.", else the state chip's words. */
export function runHeadline(
  t: (k: string, params?: Record<string, string>) => string,
  item: StoreItem,
): string {
  const run = item.run
  if (run?.state === "upgrade-failed") {
    return t(`${S}.upgradeFailedDetail`, { version: run.version, running: item.version })
  }
  return stateLabel(t, item)
}

const Row: Component<{ label: string; children: unknown; testId?: string }> = (props) => (
  <>
    <dt class="text-text-tertiary">{props.label}</dt>
    <dd class="min-w-0 break-words text-text" data-testid={props.testId}>
      {props.children as never}
    </dd>
  </>
)

export const AppStoreDetail: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const location = useLocation()
  const navigate = useNavigate()
  const appId = createMemo(() => decodeURIComponent(DETAIL_PATH.exec(location.pathname)?.[1] ?? ""))
  const [loaded, setLoaded] = createSignal(false)
  const [urlInstall, setUrlInstall] = createSignal<{ url?: string } | null>(null)
  const [removing, setRemoving] = createSignal(false)
  const [uninstalling, setUninstalling] = createSignal(false)
  const [uninstallError, setUninstallError] = createSignal<string | null>(null)
  const [upgrade, setUpgrade] = createSignal<UpgradePreview | null>(null)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [confirmRollback, setConfirmRollback] = createSignal(false)
  const [rollingBack, setRollingBack] = createSignal(false)
  const [rollbackError, setRollbackError] = createSignal<string | null>(null)
  const actions = useStoreActions((url) => setUrlInstall({ url }))

  onMount(() => {
    void loadStoreData(api).then(() => setLoaded(true))
  })

  const item = createMemo(() => storeItems().find((i) => i.name === appId()))
  const name = () => {
    const it = item()
    return it ? itemName(i18n.t, it) : appLabel(appId(), i18n.t)
  }

  // Scope descriptions need `GET /admin/scope-catalog`; without it the scope names show.
  const [scopeCatalog] = createResource(async () => {
    try {
      const res = await api.get<ScopeCatalogEntry[] | { data?: ScopeCatalogEntry[] }>(
        "/admin/scope-catalog",
        { suppressGlobalError: true },
      )
      return Array.isArray(res) ? res : (res?.data ?? [])
    } catch {
      return [] as ScopeCatalogEntry[]
    }
  })

  const canUninstall = () => {
    const it = item()
    return !!it && it.source === "installed" && !!it.registry && appsStore.canManageInstalls()
  }
  const canCheckUpdates = () => !!item()?.registry?.updateUrl && appsStore.canManageInstalls()

  async function uninstall(): Promise<void> {
    setUninstallError(null)
    try {
      await appsStore.uninstallApp(api, appId())
      addToast({ message: i18n.t(`${S}.uninstalledToast`, { name: name() }), type: "success" })
      setUninstalling(false)
      await loadStoreData(api)
      navigate("/settings/store", { replace: true })
    } catch (e) {
      // The server's guard names how many other workspaces still have it.
      setUninstallError(
        e instanceof ApiError && e.message
          ? e.message
          : i18n.t(`${S}.actionFailed`, { name: name() }),
      )
    }
  }

  // Only the instance operator may roll back (the route refuses everyone else), and
  // only when the server kept a previous version the running one allows going back to.
  const rollbackTo = () => (appsStore.canManageInstalls() ? item()?.rollbackTo : undefined)

  async function rollBack(): Promise<void> {
    const to = rollbackTo()
    if (!to) return
    setRollbackError(null)
    setRollingBack(true)
    try {
      await appsStore.rollbackApp(api, appId())
      addToast({
        message: i18n.t(`${S}.rolledBackToast`, { name: name(), version: to }),
        type: "success",
      })
      setConfirmRollback(false)
      await loadStoreData(api)
    } catch (e) {
      // The server says why: no previous version, a security release, or the
      // previous version failed its health gate and the app still runs this one.
      setRollbackError(
        e instanceof Error && e.message ? e.message : i18n.t(`${S}.actionFailed`, { name: name() }),
      )
    } finally {
      setRollingBack(false)
    }
  }

  async function checkForUpdates(): Promise<void> {
    try {
      const res = await appsStore.upgradePreview(api, appId())
      if (res.upToDate) {
        addToast({
          message: i18n.t(`${S}.upToDate`, { name: name(), version: String(res.version) }),
          type: "info",
        })
        return
      }
      setUpgrade(toUpgradePreview(res))
    } catch (e) {
      addToast({
        message:
          e instanceof Error && e.message
            ? e.message
            : i18n.t("kernel.settingsUi.upgradePreviewFailed"),
        type: "error",
      })
    }
  }

  async function setUiApproval(approved: boolean): Promise<void> {
    if (approved && !window.confirm(i18n.t("kernel.settingsUi.approveUiFullAccess"))) return
    await appsStore.setUiApproval(api, appId(), approved)
  }

  return (
    <div>
      <nav
        class="mb-4 flex items-center gap-1.5 text-[12.5px] text-text-secondary"
        aria-label={i18n.t(`${S}.breadcrumb`)}
      >
        <button
          type="button"
          class="hover:text-text"
          data-testid="app-store-detail-back"
          onClick={() => navigate("/settings/store")}
        >
          {i18n.t(`${S}.title`)}
        </button>
        <span aria-hidden="true">›</span>
        <span class="text-text">{name()}</span>
      </nav>
      <Show
        when={item()}
        fallback={
          <Show when={loaded()}>
            <div
              class="rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-text-secondary"
              data-testid="app-store-detail-missing"
            >
              {i18n.t(`${S}.notFound`)}
            </div>
          </Show>
        }
      >
        {(it) => (
          <div data-testid={`app-store-detail-${it().name}`}>
            <div class="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-border bg-surface px-4 py-3.5">
              <StoreIcon app={it().name} name={name()} large />
              <div class="min-w-[150px] flex-1">
                <div class="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
                  <span>{name()}</span>
                  <span class="rounded border border-border px-1 text-[10px] font-normal uppercase tracking-wide text-text-tertiary">
                    {kindLabel(i18n.t, it().kind)}
                  </span>
                </div>
                <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-text-secondary">
                  <span>
                    <Show
                      when={it().unlisted}
                      fallback={
                        <Show when={it().publisher}>
                          {i18n.t(`${S}.byPublisher`, { publisher: publisherText(i18n.t, it()) })}
                        </Show>
                      }
                    >
                      {i18n.t(`${S}.unlisted`)}
                    </Show>
                  </span>
                  <Show when={it().version}>
                    <span class="font-mono">v{it().latestVersion ?? it().version}</span>
                  </Show>
                  <StoreStateChip item={it()} />
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Show
                  when={isInWorkspace(it())}
                  fallback={
                    <StoreAction
                      item={it()}
                      busy={actions.busy() === it().name}
                      onRun={() => void actions.run(it())}
                      ids={{
                        add: "app-store-detail-add",
                        install: "app-store-detail-install",
                        ask: "app-store-detail-ask",
                      }}
                    />
                  }
                >
                  <Button
                    size="sm"
                    variant="outline"
                    class="w-auto"
                    data-testid="app-store-detail-remove"
                    onClick={() => setRemoving(true)}
                  >
                    {i18n.t(`${S}.remove`)}
                  </Button>
                  <Show when={it().state !== "retired"}>
                    <Button
                      size="sm"
                      class="w-auto"
                      data-testid="app-store-detail-open"
                      onClick={() => navigate(settingsPathFor(it().name, it().kind))}
                    >
                      {i18n.t(`${S}.openSettings`)}
                    </Button>
                  </Show>
                </Show>
                <Show when={canUninstall()}>
                  <PopupMenu open={menuOpen()} onOpenChange={setMenuOpen}>
                    <PopupMenu.Trigger
                      class="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover"
                      aria-label={i18n.t(`${S}.more`, { name: name() })}
                      data-testid="app-store-detail-more"
                    >
                      ⋯
                    </PopupMenu.Trigger>
                    <PopupMenu.Content>
                      <PopupMenu.Item
                        variant="danger"
                        data-testid="app-store-detail-uninstall"
                        onSelect={() => {
                          setUninstallError(null)
                          setUninstalling(true)
                        }}
                      >
                        {i18n.t(`${S}.uninstall`)}
                      </PopupMenu.Item>
                    </PopupMenu.Content>
                  </PopupMenu>
                </Show>
              </div>
            </div>

            <Show when={it().description ?? it().listing?.summary}>
              <p class="mb-2 text-sm text-text" data-testid="app-store-detail-description">
                {seededCopy(
                  it().description ?? it().listing?.summary,
                  `kernel.appDescriptions.${it().name}`,
                  i18n.t,
                )}
              </p>
            </Show>
            <p class="mb-6 text-xs text-text-secondary">
              {i18n.t(it().kind === "connector" ? `${S}.connectorKindHint` : `${S}.appKindHint`)}
            </p>

            <Show when={(it().listing?.screenshots ?? []).length > 0}>
              <section class="mb-6">
                <h2 class="mb-2 text-[13px] font-semibold">{i18n.t(`${S}.screenshots`)}</h2>
                <div class="flex gap-2 overflow-x-auto">
                  <For each={it().listing?.screenshots ?? []}>
                    {(src, n) => (
                      <img
                        src={src}
                        alt={i18n.t(`${S}.screenshotAlt`, { name: name(), n: n() + 1 })}
                        class="h-40 flex-none rounded-md border border-border object-cover"
                        loading="lazy"
                        referrerpolicy="no-referrer"
                      />
                    )}
                  </For>
                </div>
              </section>
            </Show>

            <section class="mb-6">
              <h2 class="mb-2 text-[13px] font-semibold">{i18n.t(`${S}.details`)}</h2>
              <dl class="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4 gap-y-1.5 rounded-lg border border-border bg-surface px-4 py-3 text-[13px]">
                <Show when={it().unlisted}>
                  <Row label={i18n.t(`${S}.listing`)} testId="app-store-detail-unlisted">
                    {i18n.t(`${S}.unlistedDetail`)}
                  </Row>
                </Show>
                {/* Who published it, listed or not: an outside app never passes for a first-party one (A12). */}
                <Show when={it().publisher}>
                  <Row label={i18n.t(`${S}.publisher`)} testId="app-store-detail-publisher">
                    {publisherText(i18n.t, it())}
                  </Row>
                </Show>
                <Show when={!it().unlisted}>
                  <Show when={it().listing?.sourceRepository}>
                    {(repo) => (
                      <Row label={i18n.t(`${S}.sourceRepository`)}>
                        <a
                          href={repo()}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="break-all font-mono text-xs underline"
                          data-testid="app-store-detail-repo"
                          onClick={(e) => {
                            e.preventDefault()
                            void openExternal(repo())
                          }}
                        >
                          {repo()}
                        </a>
                      </Row>
                    )}
                  </Show>
                  <Show when={it().license}>
                    <Row label={i18n.t(`${S}.licence`)} testId="app-store-detail-licence">
                      {it().license}
                    </Row>
                  </Show>
                  <Show when={it().listing?.category}>
                    {(c) => (
                      <Row label={i18n.t(`${S}.detailCategory`)} testId="app-store-detail-category">
                        {i18n.t(`${S}.category.${c()}`)}
                      </Row>
                    )}
                  </Show>
                </Show>
                <Show when={it().run && it().state !== "off" ? it().run : undefined}>
                  {(run) => (
                    <Row label={i18n.t(`${S}.status`)} testId="app-store-detail-run">
                      <span class="block" data-state={run().state}>
                        {runHeadline(i18n.t, it())}
                      </span>
                      <Show when={runReason(i18n.t, it())}>
                        {(reason) => (
                          <span
                            class="block break-words font-mono text-xs text-text-secondary"
                            data-testid="app-store-detail-reason"
                          >
                            {reason()}
                          </span>
                        )}
                      </Show>
                    </Row>
                  )}
                </Show>
                <Row label={i18n.t(`${S}.onServer`)} testId="app-store-detail-where">
                  {it().state === "retired"
                    ? i18n.t(`${S}.notOnServer`)
                    : isInWorkspace(it())
                      ? i18n.t(`${S}.addedHere`)
                      : it().serverInstalled
                        ? i18n.t(`${S}.notAddedHere`)
                        : i18n.t(`${S}.notOnServer`)}
                </Row>
                <Show when={it().registry && it().registry?.status !== "active"}>
                  <Row label={i18n.t(`${S}.status`)} testId="app-store-detail-status">
                    {(() => {
                      const status = it().registry?.status ?? ""
                      const key = `kernel.settingsUi.appStatus.${status}`
                      const label = catalogHasKey(key) ? i18n.t(key) : status
                      const message = it().registry?.statusMessage
                      return message ? `${label}: ${message}` : label
                    })()}
                  </Row>
                </Show>
                <Show when={it().registry?.hasUiBundle}>
                  <Row label={i18n.t(`${S}.interface`)} testId="app-store-detail-ui">
                    <span class="flex flex-wrap items-center gap-2">
                      {it().registry?.uiTrust === "admin-approved"
                        ? i18n.t("kernel.settingsUi.uiFullAccessApproved")
                        : it().registry?.uiTrust
                          ? i18n.t("kernel.settingsUi.uiTrusted")
                          : i18n.t("kernel.settingsUi.uiBlocked")}
                      <Show
                        when={
                          appsStore.canManageInstalls() &&
                          (!it().registry?.uiTrust || it().registry?.uiTrust === "admin-approved")
                        }
                      >
                        <Button
                          size="sm"
                          variant="ghost"
                          class="w-auto"
                          data-testid="app-store-detail-ui-approval"
                          onClick={() =>
                            void setUiApproval(it().registry?.uiTrust !== "admin-approved")
                          }
                        >
                          {it().registry?.uiTrust === "admin-approved"
                            ? i18n.t("kernel.settingsUi.uiWithdrawApproval")
                            : i18n.t("kernel.settingsUi.uiApprove")}
                        </Button>
                      </Show>
                    </span>
                  </Row>
                </Show>
              </dl>
            </section>

            <section class="mb-6">
              <h2 class="text-[13px] font-semibold">{i18n.t(`${S}.whatItCanDo`)}</h2>
              <p class="mb-2 text-xs text-text-secondary">{i18n.t(`${S}.whatItCanDoHint`)}</p>
              <Show when={!scopeCatalog.loading}>
                <ul
                  class="flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-4 py-3 text-[13px]"
                  data-testid="app-store-detail-perms"
                >
                  <For
                    each={permissionLines(it(), scopeCatalog() ?? [], i18n.t)}
                    fallback={<li class="text-text-secondary">{i18n.t(`${S}.noPermissions`)}</li>}
                  >
                    {(line) => (
                      <li class="flex items-start gap-2">
                        <span aria-hidden="true" class="text-success">
                          ✓
                        </span>
                        <span>{line}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>

            <section class="mb-6">
              <div class="mb-2 flex items-center justify-between gap-2">
                <h2 class="text-[13px] font-semibold">{i18n.t(`${S}.versionHistory`)}</h2>
                <Show when={canCheckUpdates()}>
                  <Button
                    size="sm"
                    variant="ghost"
                    class="w-auto"
                    data-testid="app-store-detail-check-updates"
                    onClick={() => void checkForUpdates()}
                  >
                    {i18n.t(`${S}.checkForUpdates`)}
                  </Button>
                </Show>
              </div>
              <ul class="divide-y divide-border rounded-lg border border-border bg-surface text-[13px]">
                <Show when={it().latestVersion}>
                  <li class="flex items-center gap-3 px-4 py-2">
                    <span class="w-20 font-mono">{it().latestVersion}</span>
                    <span class="text-text-secondary">{i18n.t(`${S}.availableVersion`)}</span>
                  </li>
                </Show>
                <li class="flex items-center gap-3 px-4 py-2">
                  <span class="w-20 font-mono">{it().version}</span>
                  <span class="text-text-secondary">
                    {it().serverInstalled
                      ? i18n.t(`${S}.runningHere`)
                      : i18n.t(`${S}.availableVersion`)}
                  </span>
                </li>
                <Show when={rollbackTo()}>
                  {(to) => (
                    <li class="px-4 py-2" data-testid="app-store-detail-rollback-row">
                      <div class="flex flex-wrap items-center gap-3">
                        <span class="w-20 font-mono">{to()}</span>
                        <span class="flex-1 text-text-secondary">
                          {i18n.t(`${S}.previousVersion`)}
                        </span>
                        <Show when={!confirmRollback()}>
                          <Button
                            size="sm"
                            variant="outline"
                            class="w-auto"
                            data-testid="app-store-detail-rollback"
                            onClick={() => {
                              setRollbackError(null)
                              setConfirmRollback(true)
                            }}
                          >
                            {i18n.t(`${S}.rollBackTo`, { version: to() })}
                          </Button>
                        </Show>
                      </div>
                      <Show when={confirmRollback()}>
                        <div
                          class="mt-2 rounded-md border border-border bg-bg px-3 py-2"
                          data-testid="app-store-detail-rollback-confirm"
                        >
                          <p class="text-[13px] text-text">
                            {i18n.t(`${S}.rollBackConfirm`, { name: name(), version: to() })}
                          </p>
                          <Show when={rollbackError()}>
                            <p
                              class="mt-2 text-xs text-text-secondary"
                              role="status"
                              data-testid="app-store-detail-rollback-error"
                            >
                              {rollbackError()}
                            </p>
                          </Show>
                          <div class="mt-2 flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              class="w-auto"
                              data-testid="app-store-detail-rollback-cancel"
                              onClick={() => setConfirmRollback(false)}
                            >
                              {i18n.t("kernel.appManagement.cancel")}
                            </Button>
                            <Button
                              size="sm"
                              class="w-auto"
                              disabled={rollingBack()}
                              data-testid="app-store-detail-rollback-go"
                              onClick={() => void rollBack()}
                            >
                              {rollingBack()
                                ? i18n.t(`${S}.rollingBack`)
                                : i18n.t(`${S}.rollBackTo`, { version: to() })}
                            </Button>
                          </div>
                        </div>
                      </Show>
                    </li>
                  )}
                </Show>
              </ul>
            </section>

            <RemoveAppDialog
              open={removing()}
              app={it().name}
              name={name()}
              kind={it().kind}
              onClose={() => setRemoving(false)}
            />
          </div>
        )}
      </Show>

      <Dialog open={uninstalling()} onOpenChange={(open) => !open && setUninstalling(false)}>
        <Dialog.Content>
          <div data-testid="app-store-uninstall-dialog">
            <Dialog.Title>{i18n.t(`${S}.uninstallTitle`, { name: name() })}</Dialog.Title>
            <p class="mt-3 text-sm text-text-secondary">{i18n.t(`${S}.uninstallBody`)}</p>
            <Show when={uninstallError()}>
              <p
                class="mt-3 text-sm text-error"
                role="alert"
                data-testid="app-store-uninstall-error"
              >
                {uninstallError()}
              </p>
            </Show>
            <div class="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setUninstalling(false)}>
                {i18n.t("kernel.appManagement.cancel")}
              </Button>
              <Button
                variant="danger"
                data-testid="app-store-uninstall-confirm"
                onClick={() => void uninstall()}
              >
                {i18n.t(`${S}.uninstallConfirm`)}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog>

      <Dialog open={upgrade() !== null} onOpenChange={(open) => !open && setUpgrade(null)}>
        <Dialog.Content>
          <Show when={upgrade()}>
            {(preview) => (
              <InstallAppDialog
                mode="upgrade"
                preview={preview()}
                onInstall={async (grants) => {
                  await appsStore.upgradeApp(api, appId(), grants)
                  await loadStoreData(api)
                  return undefined
                }}
                onClose={() => setUpgrade(null)}
              />
            )}
          </Show>
        </Dialog.Content>
      </Dialog>

      <StoreInstallDialog
        open={urlInstall() !== null}
        initialUrl={urlInstall()?.url}
        onClose={() => setUrlInstall(null)}
      />
    </div>
  )
}
