// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Choose files for Liaison" (custom block `DrivePickedFiles`): each of the
// person's Drive accounts in picked mode, what is picked, the sync of the picks
// into Knowledge, and Choose files, which opens Google's picker on the app's own
// page (`drive_picker` answers its handle; the person's session opens it).

import { app, fetch as hostFetch } from "@liaison/host"
import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { t } from "./strings"

interface Picked {
  id: string
  name: string
  mimeType: string
}
interface AccountView {
  id: string
  identifier: string
  ownerType: "user" | "org"
  mode: "full" | "picked"
  picked: Picked[]
  notImported: Array<{ id: string; name: string; type: string }>
  sync: { status: string; documents: number; lastError: string | null } | null
}
interface State {
  pickerConfigured: boolean
  accounts: AccountView[]
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "error" in err) {
    const e = (err as { error?: { message?: string } }).error
    if (e?.message) return e.message
  }
  return err instanceof Error ? err.message : String(err)
}

async function call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
  const out = await app.invokeTool<T | { error: { message: string } }>(tool, args)
  if (out && typeof out === "object" && "error" in out) throw out
  return out as T
}

const POLL_MS = 3000

export const DrivePickedFiles: Component = () => {
  const [state, setState] = createSignal<State | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [message, setMessage] = createSignal<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let followUntil = 0

  async function load(): Promise<void> {
    try {
      setState(await call<State>("picker_state", {}))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  function follow(): void {
    followUntil = Date.now() + 3 * 60 * 1000
    const tick = async () => {
      await load()
      if (Date.now() < followUntil) timer = setTimeout(tick, POLL_MS)
    }
    clearTimeout(timer)
    timer = setTimeout(tick, POLL_MS)
  }

  onMount(load)
  onCleanup(() => clearTimeout(timer))

  async function choose(account: AccountView): Promise<void> {
    setMessage(null)
    // Opened in the click itself, before any await, or the browser blocks it.
    const popup = window.open("about:blank", "liaison-drive-picker", "popup,width=1050,height=720")
    if (!popup) {
      setMessage(t("popupBlocked"))
      return
    }
    popup.opener = null
    try {
      const out = await call<{ page?: { handle: string } }>("drive_picker", { account: account.id })
      if (!out.page?.handle) throw new Error(t("openFailed"))
      const link = await hostFetch<{ url: string }>("/api/apps/google-drive/pages/open", {
        method: "POST",
        body: JSON.stringify({ handle: out.page.handle }),
      })
      popup.location.href = link.url
      follow()
    } catch (err) {
      popup.close()
      setMessage(errorMessage(err))
    }
  }

  async function remove(account: AccountView, itemId: string): Promise<void> {
    try {
      await call("picker_remove", { account: account.id, itemId })
      await load()
      follow()
    } catch (err) {
      setMessage(errorMessage(err))
    }
  }

  const picked = () => (state()?.accounts ?? []).filter((a) => a.mode === "picked")

  return (
    <div class="flex flex-col gap-3 text-[13px]" data-testid="drive-picked-files">
      <Show when={error()}>{(e) => <p class="text-danger">{t("loadFailed", { message: e() })}</p>}</Show>
      <For each={picked()}>
        {(account) => (
          <div class="flex flex-col gap-2 rounded-md border border-border p-3" data-testid={`drive-picked-${account.id}`}>
            <p class="text-text-muted">{t("pickedIntro")}</p>
            <div class="flex items-center justify-between gap-2">
              <span class="font-medium">{account.identifier}</span>
              <Show when={state()?.pickerConfigured} fallback={<span class="text-text-muted">{t("notConfigured")}</span>}>
                <button
                  type="button"
                  class="rounded-sm border border-border bg-surface px-3 py-1"
                  data-testid="drive-picker-choose"
                  onClick={() => void choose(account)}
                >
                  {t("choose")}
                </button>
              </Show>
            </div>
            <span data-testid="drive-picker-count">
              {account.picked.length ? t("pickedCount", { count: account.picked.length }) : t("noPicks")}
            </span>
            <Show when={account.sync}>
              {(sync) => (
                <span class="text-text-muted" data-testid="drive-picker-sync">
                  {sync().status === "running"
                    ? t("syncing")
                    : sync().lastError
                      ? t("syncError", { message: sync().lastError ?? "" })
                      : t("inKnowledge", { count: sync().documents })}
                </span>
              )}
            </Show>
            <ul class="flex flex-col gap-1">
              <For each={account.picked}>
                {(item) => (
                  <li class="flex items-center justify-between gap-2">
                    <span>{item.name}</span>
                    <button
                      type="button"
                      class="text-text-muted"
                      aria-label={t("remove", { name: item.name })}
                      data-testid={`drive-picker-remove-${item.id}`}
                      onClick={() => void remove(account, item.id)}
                    >
                      ×
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <For each={account.notImported}>
              {(n) => <span class="text-text-muted">{t("notImported", { name: n.name, type: n.type })}</span>}
            </For>
          </div>
        )}
      </For>
      <Show when={message()}>{(m) => <p class="text-text-muted">{m()}</p>}</Show>
    </div>
  )
}
