// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "Choose files for Liaison": the Google Drive files a person lets Liaison see
 * when their Drive is connected with `drive.file` only (picked mode). One
 * component, drawn in three places: under the agent's `kernel__drive_picker`
 * call, inside a Drive connect card once it connected, and on the Drive
 * connection in Settings.
 *
 * "Choose files" opens Google's Picker on a page of its own (the server's
 * one-time picker page): a popup on the web, the system browser in a desktop
 * or phone shell. The card then follows the sync live: "Syncing 12 files…",
 * then the count in Knowledge. Calm: no alarms, a sync error is one quiet line.
 *
 * Under an agent's call (`origin`, `threadId`) the card is about this
 * conversation: it lists first what was picked through it ("Picked here", read
 * from the pick lines it posted, picker-announce.ts), then one collapsed line
 * for the account's other picks, which opens to manage them. Picks stay
 * account-wide: Settings and Knowledge list them all.
 *
 * `quiet`: draw nothing unless a Drive account is in picked mode (the connect
 * card and Settings, where full-mode accounts need no picker talk).
 */
import { Folder, X } from "lucide-solid"
import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { openExternal } from "~/modules/desktop/external-links"
import { useI18n } from "~/modules/i18n/i18n-context"
import { shellRunsOAuth } from "~/modules/settings/oauth-connect"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

export interface PickedItemView {
  id: string
  name: string
  mimeType: string
}

export interface DriveAccountView {
  id: string
  identifier: string
  ownerType: "user" | "org"
  mode: "full" | "picked"
  picked: PickedItemView[]
  /** Picked files Knowledge does not import (no text form), with their type. */
  notImported?: Array<{ id: string; name: string; type: string }>
  sync: { status: string; documents: number; lastError: string | null } | null
}

export interface DrivePickerStateView {
  pickerConfigured: boolean
  accounts: DriveAccountView[]
  /** Asked for a card (origin and conversation): the ids picked through it. */
  cardPicks?: string[]
}

const FOLDER_MIME = "application/vnd.google-apps.folder"
const POLL_MS = 2500
/** How long the card follows a pick before it stops polling on its own. */
const FOLLOW_MS = 3 * 60 * 1000

/**
 * The origin a `kernel__drive_picker` call minted: the card hands it to the
 * picker ticket, so the agent in this conversation hears what was picked.
 */
export function drivePickerOrigin(toolCall: { result?: unknown }): string | undefined {
  const result = toolCall.result
  if (!result || typeof result !== "object") return undefined
  const origin = (result as { origin?: unknown }).origin
  return typeof origin === "string" ? origin : undefined
}

/** The conversation a `kernel__drive_picker` call's card was shown in. */
export function drivePickerThread(toolCall: { result?: unknown }): string | undefined {
  const result = toolCall.result
  if (!result || typeof result !== "object") return undefined
  const threadId = (result as { threadId?: unknown }).threadId
  return typeof threadId === "string" ? threadId : undefined
}

/** Whether a finished `kernel__drive_picker` call asks for the card. */
export function drivePickerCardShown(toolCall: {
  toolName: string
  status: string
  result?: unknown
}): boolean {
  const name = toolCall.toolName.replace("kernel:", "kernel__")
  if (name !== "kernel__drive_picker" || toolCall.status === "error") return false
  const result = toolCall.result
  return !!result && typeof result === "object" && (result as { card?: unknown }).card === "shown"
}

export const DrivePickerCard: Component<{
  quiet?: boolean
  accountId?: string
  /** Set under an agent's call: its picks are announced in that conversation. */
  origin?: string
  /** The conversation of that call: the card lists what was picked through it. */
  threadId?: string
}> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [state, setState] = createSignal<DrivePickerStateView | null>(null)
  const [message, setMessage] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [othersOpen, setOthersOpen] = createSignal(false)
  let followUntil = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const accounts = () =>
    (state()?.accounts ?? []).filter((a) => !props.accountId || a.id === props.accountId)
  const picked = () => accounts().filter((a) => a.mode === "picked")
  /** In a conversation: the card shows its own picks first, the rest folded. */
  const inConversation = () => !!props.origin
  const cardPicks = () => new Set(state()?.cardPicks ?? [])
  const here = (a: DriveAccountView) => a.picked.filter((p) => cardPicks().has(p.id))
  const others = (a: DriveAccountView) => a.picked.filter((p) => !cardPicks().has(p.id))

  function stateUrl(): string {
    if (!props.origin || !props.threadId) return "/google-drive/picker"
    const q = new URLSearchParams({ origin: props.origin, threadId: props.threadId })
    return `/google-drive/picker?${q.toString()}`
  }

  async function load(): Promise<void> {
    if (!api) return
    try {
      setState(await api.get<DrivePickerStateView>(stateUrl()))
    } catch {
      // A failed read keeps the last state; the next poll or focus tries again.
    }
  }

  function syncing(a: DriveAccountView): boolean {
    if (a.picked.length === 0) return false
    return !a.sync || a.sync.status === "running" || a.sync.status === "idle"
  }

  // Polling always ends: FOLLOW_MS after a pick, a removal, or a mount or focus
  // that found a sync running. A sync that never starts (no worker) stops being
  // followed; the next focus looks again.
  function schedule(): void {
    if (timer) clearTimeout(timer)
    if (Date.now() >= followUntil) return
    timer = setTimeout(async () => {
      await load()
      schedule()
    }, POLL_MS)
  }

  function follow(): void {
    followUntil = Date.now() + FOLLOW_MS
    schedule()
  }

  function followIfSyncing(): void {
    if (picked().some(syncing)) follow()
  }

  const onFocus = () => {
    void load().then(followIfSyncing)
  }

  onMount(() => {
    void load().then(followIfSyncing)
    window.addEventListener("focus", onFocus)
  })
  onCleanup(() => {
    if (timer) clearTimeout(timer)
    window.removeEventListener("focus", onFocus)
  })

  async function choose(account: DriveAccountView): Promise<void> {
    if (!api) return
    setMessage(null)
    // A popup is opened in the click itself, before any await, or the browser blocks it.
    const shell = shellRunsOAuth()
    const popup = shell
      ? null
      : window.open("about:blank", "liaison-drive-picker", "popup,width=1050,height=720")
    if (popup) popup.opener = null
    if (!shell && !popup) {
      setMessage(i18n.t("google-drive.picker.card.popupBlocked"))
      return
    }
    setBusy(true)
    try {
      const { url } = await api.post<{ url: string }>("/google-drive/picker/ticket", {
        accountId: account.id,
        ...(props.origin ? { origin: props.origin } : {}),
      })
      if (popup) popup.location.href = url
      else if (!(await openExternal(url))) setMessage(i18n.t("google-drive.picker.card.openFailed"))
      follow()
    } catch (err) {
      popup?.close()
      setMessage(
        err instanceof ApiError && err.message
          ? err.message
          : i18n.t("google-drive.picker.card.openFailed"),
      )
    } finally {
      setBusy(false)
    }
  }

  async function remove(account: DriveAccountView, itemId: string): Promise<void> {
    if (!api) return
    try {
      await api.post("/google-drive/picker/items", { accountId: account.id, remove: [itemId] })
      await load()
      follow()
    } catch {
      setMessage(i18n.t("google-drive.picker.card.openFailed"))
    }
  }

  const SyncLine: Component<{ account: DriveAccountView; count?: number }> = (p) => (
    <span data-testid="drive-picker-sync" role="status">
      {syncing(p.account)
        ? i18n.t("google-drive.picker.card.syncing", {
            count: p.count ?? p.account.picked.length,
          })
        : i18n.t("google-drive.picker.card.synced", {
            count: p.account.sync?.documents ?? 0,
          })}
    </span>
  )

  const SyncError: Component<{ account: DriveAccountView }> = (p) => (
    <Show when={p.account.sync?.status === "error"}>
      <p class="mt-1 text-[12px] text-text-tertiary" data-testid="drive-picker-sync-error">
        {i18n.t("google-drive.picker.card.syncError")}
      </p>
    </Show>
  )

  const ItemList: Component<{ account: DriveAccountView; items: PickedItemView[] }> = (p) => (
    <Show when={p.items.length > 0}>
      <ul class="mt-1.5 flex max-h-48 flex-col gap-0.5 overflow-y-auto">
        <For each={p.items}>
          {(item) => (
            <li
              class="flex items-center gap-1.5 text-text-primary"
              data-testid={`drive-picker-item-${item.id}`}
            >
              <Show when={item.mimeType === FOLDER_MIME}>
                <Folder
                  size={13}
                  class="shrink-0 text-text-tertiary"
                  role="img"
                  aria-label={i18n.t("google-drive.picker.card.folder")}
                />
              </Show>
              <span class="min-w-0 flex-1 truncate">{item.name}</span>
              <Show when={p.account.notImported?.find((n) => n.id === item.id)}>
                {(n) => (
                  <span
                    class="shrink-0 text-[11.5px] text-text-tertiary"
                    data-testid={`drive-picker-not-imported-${item.id}`}
                  >
                    {i18n.t("google-drive.picker.card.notImported", { type: n().type })}
                  </span>
                )}
              </Show>
              <button
                type="button"
                class="shrink-0 rounded p-0.5 text-text-tertiary hover:text-text-primary"
                aria-label={i18n.t("google-drive.picker.card.remove", { name: item.name })}
                data-testid={`drive-picker-remove-${item.id}`}
                onClick={() => void remove(p.account, item.id)}
              >
                <X size={12} />
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )

  const visible = () => {
    const s = state()
    if (!s) return false
    if (props.quiet) return picked().length > 0
    return true
  }

  return (
    <Show when={visible()}>
      <div
        data-testid="drive-picker-card"
        class="my-2 max-w-md rounded-lg border border-border bg-elevated px-3 py-2 text-[13px]"
      >
        <div class="font-medium text-text-primary">{i18n.t("google-drive.picker.card.title")}</div>
        <Show when={accounts().length === 0}>
          <p class="mt-1 text-text-secondary" data-testid="drive-picker-no-account">
            {i18n.t("google-drive.picker.card.noAccount")}
          </p>
        </Show>
        <Show when={accounts().length > 0 && picked().length === 0}>
          <p class="mt-1 text-text-secondary" data-testid="drive-picker-full">
            {i18n.t("google-drive.picker.card.fullDrive")}
          </p>
        </Show>
        <For each={picked()}>
          {(account) => (
            <div class="mt-1.5" data-testid={`drive-picker-account-${account.id}`}>
              <p class="text-text-secondary">{i18n.t("google-drive.picker.card.intro")}</p>
              <Show when={accounts().length > 1}>
                <p class="mt-1 text-[12px] text-text-tertiary">{account.identifier}</p>
              </Show>
              <Show
                when={inConversation()}
                fallback={
                  <>
                    <div class="mt-1.5 flex items-center gap-2 text-[12.5px] text-text-secondary">
                      <span data-testid="drive-picker-count">
                        {account.picked.length > 0
                          ? i18n.t("google-drive.picker.card.count", {
                              count: account.picked.length,
                            })
                          : i18n.t("google-drive.picker.card.none")}
                      </span>
                      <Show when={account.picked.length > 0}>
                        <span aria-hidden="true">·</span>
                        <SyncLine account={account} />
                      </Show>
                    </div>
                    <SyncError account={account} />
                    <ItemList account={account} items={account.picked} />
                  </>
                }
              >
                <Show when={here(account).length > 0}>
                  <div class="mt-1.5 flex items-center gap-2 text-[12.5px] text-text-secondary">
                    <span class="font-medium text-text-primary" data-testid="drive-picker-here">
                      {i18n.t("google-drive.picker.card.pickedHere")}
                    </span>
                    <Show when={syncing(account)}>
                      <span aria-hidden="true">·</span>
                      <SyncLine account={account} count={here(account).length} />
                    </Show>
                  </div>
                  <SyncError account={account} />
                  <ItemList account={account} items={here(account)} />
                </Show>
              </Show>
              <Show
                when={state()?.pickerConfigured}
                fallback={
                  <p
                    class="mt-1.5 text-[12px] text-text-tertiary"
                    data-testid="drive-picker-not-configured"
                  >
                    {i18n.t("google-drive.picker.card.notConfigured")}
                  </p>
                }
              >
                <div class="mt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy()}
                    data-testid="drive-picker-choose"
                    onClick={() => void choose(account)}
                  >
                    {i18n.t("google-drive.picker.card.choose")}
                  </Button>
                </div>
              </Show>
              <Show when={inConversation() && others(account).length > 0}>
                <p
                  class="mt-2 flex items-center gap-1.5 text-[12px] text-text-tertiary"
                  data-testid="drive-picker-others"
                >
                  <span>
                    {others(account).length === 1
                      ? i18n.t("google-drive.picker.card.othersOne")
                      : i18n.t("google-drive.picker.card.othersMany", {
                          count: others(account).length,
                        })}
                  </span>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    class="text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
                    aria-expanded={othersOpen()}
                    data-testid="drive-picker-others-toggle"
                    onClick={() => setOthersOpen((o) => !o)}
                  >
                    {othersOpen()
                      ? i18n.t("google-drive.picker.card.hideOthers")
                      : i18n.t("google-drive.picker.card.manage")}
                  </button>
                </p>
                <Show when={othersOpen()}>
                  <div data-testid="drive-picker-others-list">
                    <ItemList account={account} items={others(account)} />
                  </div>
                </Show>
              </Show>
            </div>
          )}
        </For>
        <Show when={message()}>
          {(m) => (
            <p class="mt-1.5 text-[12px] text-text-secondary" data-testid="drive-picker-message">
              {m()}
            </p>
          )}
        </Show>
      </div>
    </Show>
  )
}

export default DrivePickerCard
