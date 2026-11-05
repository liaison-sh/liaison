// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The organization's MCP servers, on Settings > Connectors (prototype
// S-CONNECTORS): one row per server with its status chip, what it means for
// agents, a sign-in when one is what fixes it, and Open. Empty, loading and
// failed states included. Calm UI: colour only for "needs you".
//
// A sign-in finishes in another tab, so the list re-reads itself when the
// person comes back to this one.
import { type Component, createResource, ErrorBoundary, For, Show, Suspense } from "solid-js"
import { relativeTime } from "~/lib/relative-time"
import { useI18n } from "~/modules/i18n/i18n-context"
import { listConnections } from "~/modules/mcp-manager/api"
import { McpStatusChip, mcpRowState } from "~/modules/mcp-manager/McpStatusChip"
import { onReturnToPage } from "~/modules/mcp-manager/refetch-on-return"
import type { McpConnectionListItem } from "~/modules/mcp-manager/types"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

interface Props {
  onAdd?: () => void
  /** Sign in (first time, or again after the token was refused). */
  onSignIn?: (conn: McpConnectionListItem) => void
  /** Open the server's page. */
  onSelect?: (conn: McpConnectionListItem) => void
}

/** The list's `lastCallAgo` is milliseconds; older servers sent a phrase. */
export function lastCallPhrase(
  ago: McpConnectionListItem["lastCallAgo"],
  locale: string,
): string | null {
  if (ago === null || ago === undefined || ago === "") return null
  if (typeof ago === "string") return ago
  return relativeTime(new Date(Date.now() - ago).toISOString(), locale) || null
}

/** One line under a server's name: what its state means for agents. */
export function useMcpRowDetail(): (c: McpConnectionListItem) => string {
  const i18n = useI18n()
  return (c) => {
    const tools = i18n.t("kernel.mcpUi.toolCount", { count: c.toolCount })
    switch (mcpRowState(c)) {
      case "disabled":
        return i18n.t("kernel.mcpUi.detailDisabled")
      case "secrets_unreadable":
        return c.lastError ?? i18n.t("kernel.mcpUi.detailSecretsUnreadable")
      case "needs_reauth":
        return i18n.t("kernel.mcpUi.detailNeedsReauth", { count: c.toolCount })
      case "oauth_pending":
        return i18n.t("kernel.mcpUi.detailNotSignedIn")
      case "failed":
        return c.lastError ? `${tools} · ${c.lastError}` : tools
      default: {
        const when = lastCallPhrase(c.lastCallAgo, i18n.locale())
        return when ? `${tools} · ${i18n.t("kernel.mcpUi.lastCall", { when })}` : tools
      }
    }
  }
}

export const McpConnectionsList: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const detail = useMcpRowDetail()
  // The org's servers only: personal ones live on their owner's Connected tools.
  const [conns, { refetch }] = createResource(async () =>
    (await listConnections(api)).filter((c) => c.ownershipScope === "org"),
  )
  onReturnToPage(() => void refetch())

  const hasFailed = () => (conns() ?? []).some((c) => mcpRowState(c) === "failed")

  return (
    <ErrorBoundary
      fallback={() => (
        <div
          data-testid="mcp-failed-banner"
          class="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-700 dark:bg-rose-950/30"
        >
          {i18n.t("kernel.mcpUi.couldNotLoad")}{" "}
          <button type="button" onClick={() => refetch()}>
            {i18n.t("kernel.common.retry")}
          </button>
        </div>
      )}
    >
      <Suspense fallback={<LoadingSkeleton />}>
        <Show when={conns()} keyed>
          {(rows) => (
            <div class="space-y-3">
              <Show when={hasFailed()}>
                <div
                  data-testid="mcp-failed-banner"
                  class="rounded-md border border-rose-300 bg-rose-50/60 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/20"
                >
                  {i18n.t("kernel.mcpUi.failedBanner")}
                </div>
              </Show>

              <Show
                when={rows.length > 0}
                fallback={
                  <div
                    data-testid="mcp-empty-state"
                    class="rounded-lg border border-border bg-surface p-6 text-center"
                  >
                    <h3 class="text-sm font-medium text-text">
                      {i18n.t("kernel.mcpUi.emptyTitle")}
                    </h3>
                    <p class="mt-1 text-sm text-text-secondary">
                      {i18n.t("kernel.mcpUi.emptyBody")}
                    </p>
                    <Button
                      variant="primary"
                      data-testid="mcp-add-first-cta"
                      class="mt-3"
                      onClick={() => props.onAdd?.()}
                    >
                      {i18n.t("kernel.mcpUi.addFirst")}
                    </Button>
                  </div>
                }
              >
                <div class="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
                  <For each={rows}>
                    {(conn) => {
                      const state = () => mcpRowState(conn)
                      return (
                        <div
                          data-testid={`mcp-row-${conn.slug}`}
                          class="flex flex-wrap items-center gap-3 px-3.5 py-2.5"
                        >
                          <span class="inline-flex h-8 w-8 flex-none items-center justify-center rounded-md border border-border bg-bg text-xs font-semibold text-text-secondary">
                            {conn.displayName.slice(0, 1).toUpperCase()}
                          </span>
                          <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-center gap-2">
                              <span class="truncate text-[13.5px] font-medium text-text">
                                {conn.displayName}
                              </span>
                              <span
                                data-testid={`mcp-status-${conn.disabled ? "disabled" : conn.status}`}
                              >
                                <McpStatusChip conn={conn} />
                              </span>
                            </div>
                            <div class="text-xs text-text-secondary" data-testid="mcp-row-detail">
                              {detail(conn)}
                            </div>
                          </div>
                          <Show when={state() === "oauth_pending"}>
                            <span data-testid="mcp-oauth-pending" class="contents">
                              <Button
                                variant="outline"
                                size="sm"
                                data-testid="mcp-oauth-resume-btn"
                                aria-label={i18n.t("kernel.mcpUi.resumeOAuthFor", {
                                  name: conn.displayName,
                                })}
                                onClick={() => props.onSignIn?.(conn)}
                              >
                                {i18n.t("kernel.mcpUi.signIn")}
                              </Button>
                            </span>
                          </Show>
                          <Show when={state() === "needs_reauth"}>
                            <Button
                              variant="outline"
                              size="sm"
                              data-testid="mcp-reauth-btn"
                              aria-label={i18n.t("kernel.mcpUi.signInAgainFor", {
                                name: conn.displayName,
                              })}
                              onClick={() => props.onSignIn?.(conn)}
                            >
                              {i18n.t("kernel.mcpUi.signInAgain")}
                            </Button>
                          </Show>
                          <Show when={props.onSelect}>
                            <Button
                              variant="ghost"
                              size="sm"
                              data-testid={`mcp-open-${conn.slug}`}
                              aria-label={i18n.t("kernel.mcpUi.openServer", {
                                name: conn.displayName,
                              })}
                              onClick={() => props.onSelect?.(conn)}
                            >
                              {i18n.t("kernel.mcpUi.open")}
                            </Button>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </Show>
      </Suspense>
    </ErrorBoundary>
  )
}

const LoadingSkeleton: Component = () => (
  <div data-testid="mcp-loading-skeleton" class="space-y-3" aria-busy="true">
    <div class="h-14 animate-pulse rounded-lg bg-surface-muted" />
    <div class="h-14 animate-pulse rounded-lg bg-surface-muted" />
  </div>
)
