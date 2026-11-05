// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "Shared drives the team sees": on an ORGANIZATION's Google Drive connection
 * in Settings. The connection shares only the shared drives an admin picks
 * (server: apps/google-drive/drive-scope.ts), never anyone's My Drive. Until
 * one is picked it reads nothing, and the card says so in one calm line.
 *
 * An admin opens "Choose shared drives": the list is the shared drives the
 * connecting Google account is a member of (Google lists no others), each a
 * checkbox; Save replaces the set.
 */
import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"

export interface SharedDriveView {
  id: string
  name: string
}

export interface OrgDriveAccountView {
  id: string
  identifier: string
  sharedDrives: SharedDriveView[]
  needsSharedDrives: boolean
}

export interface SharedDrivesStateView {
  canManage: boolean
  accounts: OrgDriveAccountView[]
}

interface AvailableView {
  account: OrgDriveAccountView
  available: Array<SharedDriveView & { chosen: boolean }>
}

const K = "google-drive.sharedDrives"

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : String(err)
}

export const SharedDrivesCard: Component<{ accountId: string }> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [state, setState] = createSignal<SharedDrivesStateView | null>(null)
  const [available, setAvailable] = createSignal<AvailableView["available"] | null>(null)
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const account = () => state()?.accounts.find((a) => a.id === props.accountId)

  async function load(): Promise<void> {
    if (!api) return
    try {
      setState(await api.get<SharedDrivesStateView>("/google-drive/shared-drives"))
    } catch (err) {
      setError(i18n.t(`${K}.failed`, { message: messageOf(err) }))
    }
  }

  async function openChooser(): Promise<void> {
    if (!api) return
    setOpen(true)
    setAvailable(null)
    setError(null)
    try {
      const q = new URLSearchParams({ accountId: props.accountId })
      const res = await api.get<AvailableView>(`/google-drive/shared-drives/available?${q}`)
      setAvailable(res.available)
      setSelected(new Set(res.available.filter((d) => d.chosen).map((d) => d.id)))
    } catch (err) {
      setError(i18n.t(`${K}.failed`, { message: messageOf(err) }))
    }
  }

  function toggle(id: string): void {
    const next = new Set(selected())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  async function save(): Promise<void> {
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      await api.put("/google-drive/shared-drives", {
        accountId: props.accountId,
        drives: [...selected()],
      })
      addToast({ type: "success", message: i18n.t(`${K}.saved`) })
      setOpen(false)
      await load()
    } catch (err) {
      setError(i18n.t(`${K}.failed`, { message: messageOf(err) }))
    } finally {
      setBusy(false)
    }
  }

  onMount(() => void load())

  return (
    <Show when={account()}>
      {(a) => (
        <div
          class="mt-2 flex flex-col gap-1.5 rounded-md border border-border-subtle p-2.5"
          data-testid={`drive-shared-drives-${a().id}`}
        >
          <div class="text-[13px] font-medium">{i18n.t(`${K}.title`)}</div>
          <div class="text-xs text-text-secondary">{i18n.t(`${K}.intro`)}</div>
          <Show
            when={!a().needsSharedDrives}
            fallback={
              <div class="text-xs text-text-primary" data-testid="drive-shared-drives-none">
                {i18n.t(`${K}.none`)}
              </div>
            }
          >
            <div class="text-xs text-text-primary" data-testid="drive-shared-drives-list">
              {i18n.t(`${K}.shares`, {
                names: a()
                  .sharedDrives.map((d) => d.name)
                  .join(", "),
              })}
            </div>
          </Show>
          <Show
            when={state()?.canManage}
            fallback={
              <Show when={a().needsSharedDrives}>
                <div class="text-xs text-text-tertiary">{i18n.t(`${K}.askAdmin`)}</div>
              </Show>
            }
          >
            <Show
              when={open()}
              fallback={
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="drive-shared-drives-choose"
                    onClick={() => void openChooser()}
                  >
                    {i18n.t(`${K}.choose`)}
                  </Button>
                </div>
              }
            >
              <div class="flex flex-col gap-1" data-testid="drive-shared-drives-chooser">
                <div class="text-xs text-text-tertiary">{i18n.t(`${K}.memberNote`)}</div>
                <Show
                  when={available()}
                  fallback={
                    <Show when={!error()}>
                      <div class="text-xs text-text-tertiary">{i18n.t(`${K}.loading`)}</div>
                    </Show>
                  }
                >
                  {(list) => (
                    <Show
                      when={list().length > 0}
                      fallback={
                        <div class="text-xs text-text-secondary">{i18n.t(`${K}.empty`)}</div>
                      }
                    >
                      <For each={list()}>
                        {(d) => (
                          <label class="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              checked={selected().has(d.id)}
                              data-testid={`drive-shared-drive-${d.id}`}
                              onChange={() => toggle(d.id)}
                            />
                            <span>{d.name}</span>
                          </label>
                        )}
                      </For>
                    </Show>
                  )}
                </Show>
                <div class="flex gap-1.5">
                  <Button
                    size="sm"
                    loading={busy()}
                    disabled={available() === null}
                    data-testid="drive-shared-drives-save"
                    onClick={() => void save()}
                  >
                    {i18n.t(`${K}.save`)}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                    {i18n.t(`${K}.cancel`)}
                  </Button>
                </div>
              </div>
            </Show>
          </Show>
          <Show when={error()}>
            <div class="text-xs text-warning" data-testid="drive-shared-drives-error">
              {error()}
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}

export default SharedDrivesCard
