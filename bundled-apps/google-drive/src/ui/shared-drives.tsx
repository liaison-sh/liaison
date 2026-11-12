// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Shared drives" (custom block `DriveSharedDrives`, admins): per organization
// Drive connection, the shared drives its Google account is a member of, each
// with a checkbox, saved as one list (`shared_drives_save`).

import { app } from "@liaison/host"
import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { t } from "./strings"

interface Drive {
  id: string
  name: string
  chosen?: boolean
}
interface OrgAccount {
  id: string
  identifier: string
  sharedDrives: Drive[]
  needsSharedDrives: boolean
}
interface State {
  canManage: boolean
  accounts: OrgAccount[]
  available?: { account: OrgAccount; available: Drive[] }
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

const AccountDrives: Component<{ account: OrgAccount }> = (props) => {
  const [available, setAvailable] = createSignal<Drive[] | null>(null)
  const [chosen, setChosen] = createSignal<Set<string>>(
    new Set(props.account.sharedDrives.map((d) => d.id)),
  )
  const [status, setStatus] = createSignal<string | null>(null)

  onMount(async () => {
    try {
      const state = await call<State>("shared_drives", { account: props.account.identifier })
      setAvailable(state.available?.available ?? [])
    } catch (err) {
      setStatus(t("loadFailed", { message: errorMessage(err) }))
    }
  })

  async function save(): Promise<void> {
    try {
      await call("shared_drives_save", { account: props.account.identifier, drives: [...chosen()] })
      setStatus(t("saved"))
    } catch (err) {
      setStatus(t("saveFailed", { message: errorMessage(err) }))
    }
  }

  return (
    <div
      class="flex flex-col gap-2 rounded-md border border-border p-3"
      data-testid={`drive-shared-${props.account.id}`}
    >
      <span class="font-medium">{props.account.identifier}</span>
      <Show when={chosen().size === 0}>
        <span class="text-text-muted">{t("needsChoice")}</span>
      </Show>
      <For each={available() ?? []}>
        {(drive) => (
          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              checked={chosen().has(drive.id)}
              data-testid={`drive-shared-option-${drive.id}`}
              onChange={(e) => {
                const next = new Set(chosen())
                if (e.currentTarget.checked) next.add(drive.id)
                else next.delete(drive.id)
                setChosen(next)
                setStatus(null)
              }}
            />
            {drive.name}
          </label>
        )}
      </For>
      <span class="text-text-muted">{t("notMember", { account: props.account.identifier })}</span>
      <div class="flex items-center gap-2">
        <button
          type="button"
          class="rounded-sm border border-border bg-surface px-3 py-1"
          data-testid="drive-shared-save"
          onClick={() => void save()}
        >
          {t("save")}
        </button>
        <Show when={status()}>{(s) => <span class="text-text-muted">{s()}</span>}</Show>
      </div>
    </div>
  )
}

export const DriveSharedDrives: Component = () => {
  const [state, setState] = createSignal<State | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  onMount(async () => {
    try {
      setState(await call<State>("shared_drives", {}))
    } catch (err) {
      setError(errorMessage(err))
    }
  })
  return (
    <div class="flex flex-col gap-3 text-[13px]" data-testid="drive-shared-drives">
      <p class="text-text-muted">{t("sharedIntro")}</p>
      <Show when={error()}>
        {(e) => <p class="text-danger">{t("loadFailed", { message: e() })}</p>}
      </Show>
      <Show when={state() && state()?.accounts.length === 0}>
        <p class="text-text-muted">{t("noOrgConnection")}</p>
      </Show>
      <For each={state()?.accounts ?? []}>{(account) => <AccountDrives account={account} />}</For>
    </div>
  )
}
