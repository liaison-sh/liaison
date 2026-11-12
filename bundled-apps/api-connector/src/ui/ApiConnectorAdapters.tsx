// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The API connector card's adapter block (a custom block of its declarative
// settings, on Settings > Connectors): the org's connections to its own
// CRM/ERP systems, one adapter each. In place, never a modal: add (slug +
// adapter document), credentials derived from the adapter's auth (the generic
// connect form cannot: each account is named by its adapter's slug), a Test
// panel for read operations, replace, the adapter's history (restore an
// earlier version), and delete with an inline confirmation.
// No declarative block edits an adapter document or runs a test operation.
//
// In a demo workspace the page is read-only: the shipped fixture connection is
// listed and can be tested, nothing can be added, replaced, deleted or given
// credentials (the server refuses those in demo orgs too). Read-only comes
// from the adapters list itself, never from another fetch that a first visit
// may not have made yet, and no control renders before that list arrives.

import type { ConnectionStatus, ConnectionSummary } from "@liaison/api-connector-core/contract"
import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { AdapterForm } from "./AdapterForm"
import { deleteConnection, listConnections, useApi } from "./api"
import { CredentialsForm } from "./CredentialsForm"
import { HistoryPanel } from "./HistoryPanel"
import { Button, useI18n } from "./kit"
import { TestPanel } from "./TestPanel"

type PanelKind = "credentials" | "test" | "replace" | "history" | "delete"

type LoadState = "loading" | "ready" | "error"

const STATUS_KEY: Record<ConnectionStatus, string> = {
  ok: "api-connector.settings.status.ok",
  needs_credentials: "api-connector.settings.status.needs_credentials",
  error: "api-connector.settings.status.error",
}

const ApiConnectorAdapters: Component = () => {
  const api = useApi()
  const i18n = useI18n()
  const [load, setLoad] = createSignal<LoadState>("loading")
  const [connections, setConnections] = createSignal<ConnectionSummary[]>([])
  const [adding, setAdding] = createSignal(false)
  const [open, setOpen] = createSignal<{ id: string; kind: PanelKind } | null>(null)
  const [deleting, setDeleting] = createSignal(false)
  const [deleteFailed, setDeleteFailed] = createSignal(false)
  const [readOnly, setReadOnly] = createSignal(true)

  async function refresh(): Promise<void> {
    try {
      const list = await listConnections(api)
      setConnections(list.connections)
      setReadOnly(list.readOnly)
      setLoad("ready")
    } catch {
      setLoad("error")
    }
  }

  onMount(() => void refresh())

  // Rows are keyed by identifier, so a refresh keeps an open panel mounted.
  const ids = () => connections().map((c) => c.identifier)
  const byId = (id: string) => connections().find((c) => c.identifier === id)

  const toggle = (id: string, kind: PanelKind) => {
    setDeleteFailed(false)
    const current = open()
    setOpen(current?.id === id && current.kind === kind ? null : { id, kind })
  }

  async function onAdded(summary: ConnectionSummary): Promise<void> {
    setAdding(false)
    await refresh()
    setOpen({ id: summary.identifier, kind: "credentials" })
  }

  async function onReplaced(): Promise<void> {
    setOpen(null)
    await refresh()
  }

  async function confirmDelete(id: string): Promise<void> {
    setDeleting(true)
    setDeleteFailed(false)
    try {
      await deleteConnection(api, id)
      setOpen(null)
      await refresh()
    } catch {
      setDeleteFailed(true)
    } finally {
      setDeleting(false)
    }
  }

  const isOpen = (id: string, kind: PanelKind) => {
    const o = open()
    return o?.id === id && o.kind === kind
  }

  return (
    <div class="flex flex-col gap-4" data-testid="api-connector-settings">
      <div class="flex items-start justify-end gap-3">
        <Show when={!readOnly() && load() === "ready" && !adding()}>
          <Button
            variant="outline"
            size="sm"
            data-testid="api-connector-add"
            onClick={() => {
              setOpen(null)
              setAdding(true)
            }}
          >
            {i18n.t("api-connector.settings.add")}
          </Button>
        </Show>
      </div>

      <Show when={load() === "ready" && readOnly()}>
        <p data-testid="api-connector-demo-readonly" class="text-xs text-text-secondary">
          {i18n.t("api-connector.settings.demoReadOnly")}
        </p>
      </Show>

      <Show when={adding()}>
        <AdapterForm onSaved={(s) => void onAdded(s)} onCancel={() => setAdding(false)} />
      </Show>

      <Show when={load() === "loading"}>
        <div data-testid="api-connector-settings-loading" class="text-xs text-text-secondary">
          {i18n.t("api-connector.settings.loading")}
        </div>
      </Show>

      <Show when={load() === "error"}>
        <div
          data-testid="api-connector-settings-error"
          class="flex items-center gap-2 text-xs text-text-secondary"
        >
          <span>{i18n.t("api-connector.settings.loadFailed")}</span>
          <Button
            variant="outline"
            size="sm"
            data-testid="api-connector-settings-retry"
            onClick={() => {
              setLoad("loading")
              void refresh()
            }}
          >
            {i18n.t("kernel.common.retry2")}
          </Button>
        </div>
      </Show>

      <Show when={load() === "ready"}>
        <div data-testid="api-connector-settings-list" class="flex flex-col gap-3">
          <Show when={ids().length === 0 && !adding()}>
            <p data-testid="api-connector-empty" class="text-xs text-text-secondary">
              {i18n.t("api-connector.settings.empty")}
            </p>
          </Show>
          <For each={ids()}>
            {(id) => (
              <Show when={byId(id)}>
                {(c) => (
                  <section
                    data-testid={`api-connector-connection-${id}`}
                    class="flex flex-col gap-3 rounded-sm border border-border p-3"
                  >
                    <div class="flex flex-wrap items-start justify-between gap-2">
                      <div class="min-w-0">
                        <div class="flex items-baseline gap-2">
                          <span class="text-sm font-medium text-text">{c().name}</span>
                          <span class="font-mono text-[11px] text-text-tertiary">{id}</span>
                        </div>
                        <div class="mt-0.5 text-xs text-text-secondary">
                          {c().adapterId} {c().adapterVersion}
                          {" · "}
                          <span data-testid={`api-connector-status-${id}`}>
                            {i18n.t(STATUS_KEY[c().status])}
                          </span>
                        </div>
                        <div class="mt-1 text-xs text-text-tertiary">
                          {c().roles.length > 0
                            ? i18n.t("api-connector.settings.roles", {
                                roles: c().roles.join(", "),
                              })
                            : i18n.t("api-connector.settings.noRoles")}
                        </div>
                      </div>
                      <div class="flex flex-wrap gap-1.5">
                        <Show when={!readOnly()}>
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid={`api-connector-credentials-${id}`}
                            onClick={() => toggle(id, "credentials")}
                          >
                            {i18n.t("api-connector.settings.credentials")}
                          </Button>
                        </Show>
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid={`api-connector-test-${id}`}
                          onClick={() => toggle(id, "test")}
                        >
                          {i18n.t("api-connector.settings.test")}
                        </Button>
                        <Show when={!readOnly()}>
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid={`api-connector-replace-${id}`}
                            onClick={() => toggle(id, "replace")}
                          >
                            {i18n.t("api-connector.settings.replace")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid={`api-connector-history-${id}`}
                            onClick={() => toggle(id, "history")}
                          >
                            {i18n.t("api-connector.settings.history.open")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid={`api-connector-delete-${id}`}
                            onClick={() => toggle(id, "delete")}
                          >
                            {i18n.t("kernel.common.delete")}
                          </Button>
                        </Show>
                      </div>
                    </div>

                    <Show when={!readOnly() && isOpen(id, "credentials")}>
                      <CredentialsForm connection={c()} onSaved={() => void refresh()} />
                    </Show>
                    <Show when={isOpen(id, "test")}>
                      <TestPanel connection={c()} />
                    </Show>
                    <Show when={!readOnly() && isOpen(id, "replace")}>
                      <AdapterForm
                        identifier={id}
                        onSaved={() => void onReplaced()}
                        onCancel={() => setOpen(null)}
                      />
                    </Show>
                    <Show when={!readOnly() && isOpen(id, "history")}>
                      <HistoryPanel identifier={id} onRestored={() => void refresh()} />
                    </Show>
                    <Show when={!readOnly() && isOpen(id, "delete")}>
                      <div
                        data-testid={`api-connector-delete-confirm-${id}`}
                        class="flex flex-wrap items-center gap-2 rounded-sm bg-surface-sunken p-2 text-xs"
                      >
                        <span class="text-text">
                          {i18n.t("api-connector.settings.deleteConfirm", { name: c().name })}
                        </span>
                        <Button
                          variant="danger"
                          size="sm"
                          data-testid={`api-connector-delete-yes-${id}`}
                          loading={deleting()}
                          onClick={() => void confirmDelete(id)}
                        >
                          {i18n.t("kernel.common.delete")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid={`api-connector-delete-no-${id}`}
                          onClick={() => setOpen(null)}
                        >
                          {i18n.t("kernel.common.cancel")}
                        </Button>
                        <Show when={deleteFailed()}>
                          <span data-testid={`api-connector-delete-error-${id}`} class="text-error">
                            {i18n.t("api-connector.settings.deleteFailed")}
                          </span>
                        </Show>
                      </div>
                    </Show>
                  </section>
                )}
              </Show>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export default ApiConnectorAdapters
