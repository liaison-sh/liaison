// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { relativeTime } from "~/lib/relative-time"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

interface McpConnection {
  id: string
  label: string
  createdAt: string
  lastUsedAt: string | null
}

function relativeLastUsed(value: string | null, locale: string, never: string): string {
  return relativeTime(value, locale) || never
}

/** In the reader's chosen language, not the browser's. */
export function formatCreated(value: string, locale: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

const CopyBlock: Component<{ label: string; value: string; testid: string }> = (props) => {
  const i18n = useI18n()
  const [copied, setCopied] = createSignal(false)
  async function copy(): Promise<void> {
    if (!navigator.clipboard) return
    await navigator.clipboard.writeText(props.value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div>
      <div class="mb-1 flex items-center justify-between">
        <p class="text-xs text-text-secondary">{props.label}</p>
        {/* Outlined, not ghost: a ghost control has no background and no
            border at rest, so this read as grey body text beside the label
            and nothing on screen said the snippet could be copied. */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => void copy()}
          data-testid={`${props.testid}-copy`}
        >
          {copied() ? i18n.t("kernel.settingsUi.copied") : i18n.t("kernel.common.copy")}
        </Button>
      </div>
      <pre
        class="overflow-x-auto rounded-lg border border-border bg-surface p-3 text-xs text-text"
        data-testid={props.testid}
      >
        {props.value}
      </pre>
    </div>
  )
}

/**
 * The AI clients connected to Liaison over MCP: how to connect one, and the
 * clients connected now. The first block of Settings > Connections.
 */
const McpSettings: Component = () => {
  const i18n = useI18n()
  const api = useApi()

  const [connectInfo] = createResource(async () =>
    api.get<{ baseUrl: string }>("/mcp/connect-info"),
  )
  const [listFailed, setListFailed] = createSignal(false)
  const [connections, { refetch, mutate }] = createResource(async () => {
    try {
      const rows = await api.get<McpConnection[]>("/mcp/connections")
      setListFailed(false)
      return rows
    } catch {
      setListFailed(true)
      return [] as McpConnection[]
    }
  })

  const [revoking, setRevoking] = createSignal<McpConnection | null>(null)
  const [isRevoking, setIsRevoking] = createSignal(false)
  const [rowError, setRowError] = createSignal<string | null>(null)

  const baseUrl = () => connectInfo()?.baseUrl ?? ""

  const cliSnippet = () => `claude mcp add --transport http liaison ${baseUrl()}/mcp`
  const desktopSnippet = () =>
    JSON.stringify(
      {
        mcpServers: {
          liaison: { type: "http", url: `${baseUrl()}/mcp` },
        },
      },
      null,
      2,
    )

  async function confirmRevoke() {
    const conn = revoking()
    if (!conn) return
    setIsRevoking(true)
    setRowError(null)
    const previous = connections() ?? []
    // Optimistic removal.
    mutate(previous.filter((c) => c.id !== conn.id))
    try {
      await api.delete(`/mcp/connections/${conn.id}`)
      setRevoking(null)
      await refetch()
    } catch {
      // Roll back + inline row error (not a toast).
      mutate(previous)
      setRowError(i18n.t("kernel.settingsUi.revokeFailed", { name: conn.label }))
    } finally {
      setIsRevoking(false)
    }
  }

  return (
    <div>
      <div class="mb-6">
        <h2 class="text-base font-semibold text-text">
          {i18n.t("kernel.settingsUi.connectionsClients")}
        </h2>
        <p class="text-sm text-text-secondary">
          {i18n.t("kernel.settingsUi.connectClaudeCodeOrClaudeDesktop")}
        </p>
      </div>

      <div class="mb-8 space-y-3" data-testid="mcp-connect-section">
        <h3 class="text-sm font-medium text-text">{i18n.t("kernel.connect")}</h3>
        <CopyBlock
          label={i18n.t("kernel.settingsUi.claudeCode")}
          value={cliSnippet()}
          testid="mcp-cli-snippet"
        />
        <CopyBlock
          label={i18n.t("kernel.settingsUi.claudeDesktopConfig")}
          value={desktopSnippet()}
          testid="mcp-desktop-snippet"
        />
      </div>

      <div class="space-y-3">
        <h3 class="text-sm font-medium text-text">{i18n.t("kernel.connections")}</h3>

        <Show when={listFailed()}>
          <div
            class="rounded-lg border border-border bg-surface p-4 text-sm text-text-secondary"
            data-testid="mcp-connections-error"
          >
            {i18n.t("kernel.settingsUi.couldnTLoadConnectionsTheConnect")}
          </div>
        </Show>

        <Show when={rowError()}>
          <div class="text-sm text-text-secondary" data-testid="mcp-row-error">
            {rowError()}
          </div>
        </Show>

        <Show when={!connections.loading && !listFailed() && (connections()?.length ?? 0) === 0}>
          <div
            class="rounded-lg border border-border bg-surface p-4 text-sm text-text-secondary"
            data-testid="mcp-empty"
          >
            {i18n.t("kernel.settingsUi.noConnectionsYet")}
          </div>
        </Show>

        <For each={connections() ?? []}>
          {(conn) => (
            <div
              class="flex items-center justify-between rounded-lg border border-border bg-surface p-4"
              data-testid="mcp-connection-row"
            >
              <div class="min-w-0" data-testid={`mcp-connection-row-${conn.id}`}>
                <p class="truncate text-sm font-medium text-text">{conn.label}</p>
                <p class="text-xs text-text-secondary" data-testid="mcp-connection-row-meta">
                  {i18n.t("kernel.settingsUi.added")} {formatCreated(conn.createdAt, i18n.locale())}{" "}
                  {i18n.t("kernel.settingsUi.lastUsed")}{" "}
                  {relativeLastUsed(conn.lastUsedAt, i18n.locale(), i18n.t("kernel.common.never"))}
                </p>
              </div>
              <Button variant="ghost" onClick={() => setRevoking(conn)}>
                {i18n.t("kernel.common.revoke")}
              </Button>
            </div>
          )}
        </For>
      </div>

      <Dialog open={revoking() !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <Dialog.Content>
          <Dialog.Title>{i18n.t("kernel.revokeConnection")}</Dialog.Title>
          <p class="mt-2 text-sm text-text-secondary">
            {i18n.t("kernel.settingsUi.revoke")}
            {revoking()?.label}
            {i18n.t("kernel.settingsUi.theClientWillLoseAccessAt")}
          </p>
          <div class="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              {i18n.t("kernel.common.cancel")}
            </Button>
            <Button variant="danger" disabled={isRevoking()} onClick={confirmRevoke}>
              {i18n.t("kernel.common.revoke")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}

export default McpSettings
