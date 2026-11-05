// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js"
import { getSavedViewsHandler } from "~/framework/app-registry"
import { cn } from "~/lib/cn"
import { apiUrl } from "~/lib/env"
import { accessToken, hasScope, userFromToken } from "~/modules/auth/auth-store"
import { englishT, useI18n } from "~/modules/i18n/i18n-context"
import { SavedViewDialog } from "./SavedViewDialog"

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = accessToken()
  const headers: Record<string, string> = { ...(extra ?? {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

export interface SavedViewRow {
  id: string
  app: string
  viewId: string
  manifestKey: string | null
  name: string
  payload: Record<string, unknown>
  ownerUserId: string | null
  owner: { id: string; name: string; status: "active" | "suspended" | "deactivated" } | null
  sharedWithOrg: boolean
  isDefault: boolean
  position: number
  createdAt: string
  updatedAt: string
}

/**
 * A manifest default's name in the reader's language. The defaults are seeded
 * once per org with the manifest's English name ("My open tickets"), so a
 * French org read them in English. While the stored name is still the seeded
 * one it is shown from the catalog; a name an admin changed is theirs and is
 * shown as written.
 */
export function savedViewDisplayName(
  view: Pick<SavedViewRow, "app" | "viewId" | "manifestKey" | "name" | "isDefault">,
  t: (key: string) => string,
): string {
  if (!view.isDefault || !view.manifestKey) return view.name
  const key = `kernel.savedViewDefaults.${view.app}.${view.viewId}.${view.manifestKey}`
  if (englishT(key) !== view.name) return view.name
  return t(key)
}

interface SavedViewsListProps {
  app: string
  viewId: string
}

function applyMeSubstitution(payload: unknown, userId: string | undefined): unknown {
  if (!userId) return payload
  if (payload === "$me") return userId
  if (Array.isArray(payload)) return payload.map((item) => applyMeSubstitution(item, userId))
  if (!payload || typeof payload !== "object") return payload
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    out[k] = applyMeSubstitution(v, userId)
  }
  return out
}

async function fetchSavedViews(
  app: string,
  viewId: string,
  signal?: AbortSignal,
): Promise<SavedViewRow[]> {
  const res = await fetch(
    apiUrl(`/saved-views?app=${encodeURIComponent(app)}&viewId=${encodeURIComponent(viewId)}`),
    { headers: authHeaders(), signal },
  )
  if (!res.ok) return []
  const body = await res.json().catch(() => ({}))
  return body?.data ?? []
}

async function deleteSavedView(id: string): Promise<boolean> {
  const res = await fetch(apiUrl(`/saved-views/${encodeURIComponent(id)}`), {
    method: "DELETE",
    headers: authHeaders(),
  })
  return res.ok
}

async function patchSavedView(id: string, patch: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(apiUrl(`/saved-views/${encodeURIComponent(id)}`), {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(patch),
  })
  return res.ok
}

async function cloneSavedView(id: string): Promise<boolean> {
  const res = await fetch(apiUrl(`/saved-views/${encodeURIComponent(id)}/clone`), {
    method: "POST",
    headers: authHeaders(),
  })
  return res.ok
}

async function createSavedView(input: {
  app: string
  viewId: string
  name: string
  payload: unknown
  sharedWithOrg?: boolean
}): Promise<boolean> {
  const res = await fetch(apiUrl("/saved-views"), {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  })
  return res.ok
}

export const SavedViewsList: Component<SavedViewsListProps> = (props) => {
  const i18n = useI18n()
  const [revision, setRevision] = createSignal(0)
  const [openMenuId, setOpenMenuId] = createSignal<string | null>(null)
  const [dialog, setDialog] = createSignal<{
    mode: "create" | "rename"
    view?: SavedViewRow
  } | null>(null)
  let activeController: AbortController | null = null
  onCleanup(() => activeController?.abort())
  const [views] = createResource(
    () => ({ app: props.app, viewId: props.viewId, rev: revision() }),
    ({ app, viewId }) => {
      activeController?.abort()
      const ac = new AbortController()
      activeController = ac
      return fetchSavedViews(app, viewId, ac.signal)
    },
  )

  const meId = createMemo(() => userFromToken()?.userId)

  const privateViews = createMemo(() => (views() ?? []).filter((v) => !v.sharedWithOrg))
  const sharedViews = createMemo(() => (views() ?? []).filter((v) => v.sharedWithOrg))
  const canShare = createMemo(() => hasScope("kernel:saved_views:share"))

  function refetchAndClose() {
    setRevision((r) => r + 1)
    setOpenMenuId(null)
  }

  function onApply(view: SavedViewRow) {
    const handler = getSavedViewsHandler(props.app, props.viewId)
    if (!handler) return
    handler.apply(applyMeSubstitution(view.payload, meId()))
  }

  function onCreate() {
    setDialog({ mode: "create" })
  }

  async function handleDialogSubmit(input: { name: string; sharedWithOrg: boolean }) {
    const d = dialog()
    if (!d) return
    if (d.mode === "create") {
      const handler = getSavedViewsHandler(props.app, props.viewId)
      if (!handler) return
      if (
        await createSavedView({
          app: props.app,
          viewId: props.viewId,
          name: input.name,
          payload: handler.capture(),
          sharedWithOrg: input.sharedWithOrg,
        })
      ) {
        setDialog(null)
        refetchAndClose()
      }
    } else if (d.view) {
      if (await patchSavedView(d.view.id, { name: input.name })) {
        setDialog(null)
        refetchAndClose()
      }
    }
  }

  function onRename(view: SavedViewRow) {
    setOpenMenuId(null)
    setDialog({ mode: "rename", view })
  }

  async function onDelete(view: SavedViewRow) {
    if (await deleteSavedView(view.id)) {
      refetchAndClose()
      return
    }
    setOpenMenuId(null)
  }

  async function onShareToggle(view: SavedViewRow) {
    if (await patchSavedView(view.id, { sharedWithOrg: !view.sharedWithOrg })) refetchAndClose()
    else setOpenMenuId(null)
  }

  async function onClone(view: SavedViewRow) {
    if (await cloneSavedView(view.id)) refetchAndClose()
    else setOpenMenuId(null)
  }

  function isOwner(view: SavedViewRow): boolean {
    return view.ownerUserId === meId()
  }

  function canMutate(view: SavedViewRow): boolean {
    return isOwner(view) || hasScope("kernel:saved_views:admin")
  }

  function ownerByline(view: SavedViewRow): string | null {
    if (!view.sharedWithOrg || !view.owner) return null
    return view.owner.status === "deactivated"
      ? i18n.t("kernel.shellUi.sharedByDeactivated", { name: view.owner.name })
      : i18n.t("kernel.shellUi.sharedBy", { name: view.owner.name })
  }

  function renderRow(view: SavedViewRow) {
    return (
      <li class="group relative" data-testid={`saved-view-${view.id}`}>
        <button
          type="button"
          class="flex w-full items-start justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-surface-hover"
          onClick={() => onApply(view)}
        >
          <span class="flex-1 truncate">
            <span class="block truncate text-text">{savedViewDisplayName(view, i18n.t)}</span>
            <Show when={ownerByline(view)}>
              {(byline) => (
                <span class="block truncate text-xs text-text-tertiary">{byline()}</span>
              )}
            </Show>
          </span>
        </button>
        <button
          type="button"
          class={cn(
            "absolute right-1 top-1 rounded p-1 text-text-tertiary opacity-0 group-hover:opacity-100",
            openMenuId() === view.id && "opacity-100",
          )}
          data-testid={`saved-view-overflow-${view.id}`}
          aria-label={i18n.t("kernel.savedViewActions")}
          onClick={(e) => {
            e.stopPropagation()
            setOpenMenuId(openMenuId() === view.id ? null : view.id)
          }}
        >
          ⋯
        </button>
        <Show when={openMenuId() === view.id}>
          <div
            class="absolute right-0 top-7 z-10 flex min-w-[160px] flex-col rounded border border-border bg-elevated p-1 shadow-popover"
            role="menu"
          >
            <Show
              when={canMutate(view)}
              fallback={
                <button
                  type="button"
                  class="rounded px-2 py-1 text-left text-xs hover:bg-surface-hover"
                  data-testid={`saved-view-action-clone-${view.id}`}
                  onClick={() => void onClone(view)}
                >
                  {i18n.t("kernel.shellUi.cloneToPrivate")}
                </button>
              }
            >
              <button
                type="button"
                class="rounded px-2 py-1 text-left text-xs hover:bg-surface-hover"
                data-testid={`saved-view-action-rename-${view.id}`}
                onClick={() => void onRename(view)}
              >
                {i18n.t("kernel.common.rename")}
              </button>
              <Show when={view.sharedWithOrg || canShare()}>
                <button
                  type="button"
                  class="rounded px-2 py-1 text-left text-xs hover:bg-surface-hover"
                  data-testid={`saved-view-action-share-${view.id}`}
                  onClick={() => void onShareToggle(view)}
                >
                  {view.sharedWithOrg
                    ? i18n.t("kernel.shellUi.unshare")
                    : i18n.t("kernel.shellUi.share")}
                </button>
              </Show>
              <button
                type="button"
                class="rounded px-2 py-1 text-left text-xs text-error hover:bg-surface-hover"
                data-testid={`saved-view-action-delete-${view.id}`}
                onClick={() => void onDelete(view)}
              >
                {i18n.t("kernel.common.delete")}
              </button>
            </Show>
          </div>
        </Show>
      </li>
    )
  }

  return (
    <>
      <div class="flex flex-col gap-3 px-2 py-3" data-testid="saved-views-list">
        <Show when={privateViews().length > 0}>
          <div>
            <div class="px-2 py-1 text-xs uppercase tracking-wide text-text-tertiary">
              {i18n.t("kernel.shellUi.savedViews")}
            </div>
            <ul class="flex flex-col gap-0.5">
              <For each={privateViews()}>{(v) => renderRow(v)}</For>
            </ul>
          </div>
        </Show>
        <Show when={sharedViews().length > 0}>
          <div data-testid="saved-views-section-shared">
            <div class="px-2 py-1 text-xs uppercase tracking-wide text-text-tertiary">
              {i18n.t("kernel.shellUi.sharedWithOrg")}
            </div>
            <ul class="flex flex-col gap-0.5">
              <For each={sharedViews()}>{(v) => renderRow(v)}</For>
            </ul>
          </div>
        </Show>
        <button
          type="button"
          data-testid="saved-view-create"
          class="mx-2 rounded px-2 py-1 text-left text-xs text-text-secondary hover:bg-surface-hover hover:text-text"
          onClick={onCreate}
        >
          {i18n.t("kernel.shellUi.saveCurrentView2")}
        </button>
      </div>
      <Show when={dialog()}>
        {(d) => (
          <SavedViewDialog
            mode={d().mode}
            open={true}
            initialName={d().view?.name}
            canShare={canShare()}
            onSubmit={handleDialogSubmit}
            onClose={() => setDialog(null)}
          />
        )}
      </Show>
    </>
  )
}
