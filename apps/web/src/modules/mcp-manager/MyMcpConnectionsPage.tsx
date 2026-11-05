// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings -> Connections, second block: the caller's OWN (personal) MCP
// connections. Shown to every member holding
// mcp_manager:personal_connection:write, it never shows the org's connections
// nor anyone else's: only rows whose owner is the viewer. Adding goes through
// the same stepped flow as the org's servers (McpAddFlow), forced to personal.
// The org's servers are on Settings > Connectors. A sign-in finishes in another
// tab, so the list re-reads itself when the person comes back.
import { type Component, createResource, createSignal, For, Show, type Signal } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { relativeTime } from "~/lib/relative-time"
import { userFromToken } from "~/modules/auth/auth-store"
import { openExternal } from "~/modules/desktop/external-links"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  deleteConnection,
  disableConnection,
  enableConnection,
  listConnections,
  signInToMcp,
  testConnection,
} from "~/modules/mcp-manager/api"
import { McpAddFlow } from "~/modules/mcp-manager/McpAddFlow"
import { useMcpRowDetail } from "~/modules/mcp-manager/McpConnectionsList"
import { canSignIn, McpStatusChip, mcpRowState } from "~/modules/mcp-manager/McpStatusChip"
import { onReturnToPage } from "~/modules/mcp-manager/refetch-on-return"
import { ConfigurationTab } from "~/modules/mcp-manager/tabs/ConfigurationTab"
import type { McpConnectionListItem } from "~/modules/mcp-manager/types"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"

type View = { kind: "list" } | { kind: "add" } | { kind: "edit"; id: string }

/** The viewer's own personal connections, whatever else the API lets them read. */
export function ownPersonal(
  rows: McpConnectionListItem[],
  userId: string | undefined,
): McpConnectionListItem[] {
  if (!userId) return []
  return rows.filter((r) => r.ownershipScope === "personal" && r.ownerUserId === userId)
}

/**
 * Resource storage that reconciles a refetched list by id, so a row keeps its
 * DOM across the refetch every action triggers. A plain signal swaps in new
 * row objects and `For` rebuilds every row: a click landing on a row while
 * the refetch resolves hits a detached button and is lost.
 */
function rowsById<T>(value: T | undefined): Signal<T | undefined> {
  const [store, setStore] = createStore({ value })
  return [
    () => store.value,
    (next: unknown) => {
      const resolved =
        typeof next === "function"
          ? (next as (prev: T | undefined) => T)(unwrap(store.value))
          : next
      setStore("value", reconcile(resolved as T, { key: "id" }))
      return store.value
    },
  ] as Signal<T | undefined>
}

export const MyMcpConnectionsPage: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [view, setView] = createSignal<View>({ kind: "list" })
  const [busy, setBusy] = createSignal<string | null>(null)
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null)
  const [rows, { refetch }] = createResource(
    async () => ownPersonal(await listConnections(api), userFromToken()?.userId),
    { storage: rowsById },
  )
  onReturnToPage(() => void refetch())
  const detail = useMcpRowDetail()

  async function act(id: string, run: () => Promise<unknown>): Promise<void> {
    setBusy(id)
    try {
      await run()
    } catch (e) {
      addToast({ message: e instanceof Error ? e.message : String(e), type: "error" })
    } finally {
      setBusy(null)
      await refetch()
    }
  }

  async function runTest(c: McpConnectionListItem): Promise<void> {
    await act(c.id, async () => {
      const r = await testConnection(api, c.id)
      addToast({
        message: r.ok
          ? i18n.t("kernel.mcpUi.testOk", { name: c.displayName, count: r.toolCount ?? 0 })
          : i18n.t("kernel.mcpUi.testFailed", {
              name: c.displayName,
              error: r.error?.message ?? "",
            }),
        type: r.ok ? "success" : "error",
      })
    })
  }

  async function signIn(c: McpConnectionListItem): Promise<void> {
    await act(c.id, async () => {
      await signInToMcp(api, c.id, (url) => void openExternal(url))
    })
  }

  const lastTest = (c: McpConnectionListItem): string => {
    const when = relativeTime(c.lastCheckedAt ?? null, i18n.locale())
    return when ? i18n.t("kernel.mcpUi.lastTest", { when }) : i18n.t("kernel.mcpUi.neverTested")
  }

  return (
    <div class="space-y-4" data-testid="my-mcp-connections-page">
      <header class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold text-text">{i18n.t("kernel.mcpUi.myTitle")}</h2>
          <p class="text-sm text-text-secondary">{i18n.t("kernel.mcpUi.myIntro")}</p>
        </div>
        <Show
          when={view().kind === "list"}
          fallback={
            <Button
              variant="ghost"
              onClick={() => {
                setView({ kind: "list" })
                void refetch()
              }}
            >
              {i18n.t("kernel.mcpUi.back")}
            </Button>
          }
        >
          <Button
            variant="primary"
            data-testid="my-mcp-add-btn"
            onClick={() => setView({ kind: "add" })}
          >
            {i18n.t("kernel.mcpUi.addConnection")}
          </Button>
        </Show>
      </header>

      <Show when={view().kind === "add"}>
        <McpAddFlow
          ownership="personal"
          onCancel={() => {
            setView({ kind: "list" })
            void refetch()
          }}
          onDone={() => {
            setView({ kind: "list" })
            void refetch()
          }}
        />
      </Show>

      <Show when={view().kind === "edit"} keyed>
        {(() => {
          const v = view()
          return v.kind === "edit" ? <ConfigurationTab connectionId={v.id} /> : null
        })()}
      </Show>

      <Show when={view().kind === "list"}>
        <Show
          when={!rows.loading || rows()}
          fallback={<div class="h-14 animate-pulse rounded-lg bg-surface-muted" aria-busy="true" />}
        >
          <Show
            when={(rows() ?? []).length > 0}
            fallback={
              <div
                data-testid="my-mcp-empty"
                class="rounded-lg border border-border bg-surface p-6 text-center text-sm text-text-secondary"
              >
                {i18n.t("kernel.mcpUi.myEmpty")}
              </div>
            }
          >
            <div class="space-y-3">
              <For each={rows() ?? []}>
                {(c) => (
                  <div
                    data-testid={`my-mcp-row-${c.slug}`}
                    class="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3"
                  >
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="text-sm font-medium text-text">{c.displayName}</span>
                        <span
                          data-testid={
                            c.disabled ? "mcp-status-disabled" : `mcp-status-${c.status}`
                          }
                        >
                          <McpStatusChip conn={c} />
                        </span>
                      </div>
                      <div class="text-xs text-text-secondary">
                        <Show
                          when={mcpRowState(c) === "connected" || mcpRowState(c) === "idle"}
                          fallback={detail(c)}
                        >
                          {i18n.t("kernel.mcpUi.toolCount", { count: c.toolCount })} · {lastTest(c)}
                        </Show>
                      </div>
                      <Show when={mcpRowState(c) === "needs_reauth" && c.lastError}>
                        <div class="text-xs text-text-tertiary">{c.lastError}</div>
                      </Show>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <Show when={canSignIn(mcpRowState(c))}>
                        <Button
                          variant="outline"
                          size="sm"
                          data-testid="my-mcp-signin"
                          disabled={busy() === c.id}
                          onClick={() => void signIn(c)}
                        >
                          {mcpRowState(c) === "needs_reauth"
                            ? i18n.t("kernel.mcpUi.signInAgain")
                            : i18n.t("kernel.mcpUi.signIn")}
                        </Button>
                      </Show>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="my-mcp-test"
                        disabled={busy() === c.id || c.disabled}
                        onClick={() => void runTest(c)}
                      >
                        {i18n.t("kernel.mcpUi.test")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid="my-mcp-edit"
                        onClick={() => setView({ kind: "edit", id: c.id })}
                      >
                        {i18n.t("kernel.mcpUi.edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid="my-mcp-toggle"
                        disabled={busy() === c.id}
                        onClick={() =>
                          void act(c.id, () =>
                            c.disabled ? enableConnection(api, c.id) : disableConnection(api, c.id),
                          )
                        }
                      >
                        {c.disabled
                          ? i18n.t("kernel.mcpUi.enable")
                          : i18n.t("kernel.mcpUi.disable")}
                      </Button>
                      <Show
                        when={confirmDelete() === c.id}
                        fallback={
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid="my-mcp-delete"
                            onClick={() => setConfirmDelete(c.id)}
                          >
                            {i18n.t("kernel.mcpUi.delete")}
                          </Button>
                        }
                      >
                        <Button
                          variant="danger"
                          size="sm"
                          data-testid="my-mcp-delete-confirm"
                          disabled={busy() === c.id}
                          onClick={() => {
                            setConfirmDelete(null)
                            void act(c.id, () => deleteConnection(api, c.id))
                          }}
                        >
                          {i18n.t("kernel.mcpUi.confirmDelete")}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                          {i18n.t("kernel.common.cancel")}
                        </Button>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

export default MyMcpConnectionsPage
