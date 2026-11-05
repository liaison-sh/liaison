// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One MCP server's page (S25, prototype S-MCPADD detail): a header with its
// status and what fixes it, then sections, not tabs: Tools & policy, Activity,
// Usage (managed edition only) and Configuration. Each section is the former
// tab's component. The status comes from the list (the single read that
// joins health); it is re-read when the person comes back from a sign-in tab.
import { type Component, createMemo, createResource, createSignal, type JSX, Show } from "solid-js"
import { hasScope } from "~/modules/auth/auth-store"
import { openExternal } from "~/modules/desktop/external-links"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  deleteConnection,
  getConnection,
  listConnections,
  signInToMcp,
} from "~/modules/mcp-manager/api"
import { MCP_ACCESS_ADMIN_SCOPE, McpAccessSection } from "~/modules/mcp-manager/McpAccessSection"
import { useMcpRowDetail } from "~/modules/mcp-manager/McpConnectionsList"
import { canSignIn, McpStatusChip, mcpRowState } from "~/modules/mcp-manager/McpStatusChip"
import { McpToolsReviewDialog } from "~/modules/mcp-manager/McpToolsReviewDialog"
import { onReturnToPage } from "~/modules/mcp-manager/refetch-on-return"
import { AuditTab } from "~/modules/mcp-manager/tabs/AuditTab"
import { ConfigurationTab } from "~/modules/mcp-manager/tabs/ConfigurationTab"
import { PolicyTab } from "~/modules/mcp-manager/tabs/PolicyTab"
import { ToolsTab } from "~/modules/mcp-manager/tabs/ToolsTab"
import { UsageTab } from "~/modules/mcp-manager/tabs/UsageTab"
import type { McpAuthFlavor } from "~/modules/mcp-manager/types"
import { billingMode } from "~/modules/settings/BillingState"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"

interface Props {
  connectionId: string
  /** The server was removed from this page. */
  onRemoved?: () => void
}

const AUTH_LABEL: Record<McpAuthFlavor, string> = {
  none: "kernel.mcpUi.authDescNone",
  bearer: "kernel.mcpUi.authDescBearer",
  oauth_dcr: "kernel.mcpUi.authDescOAuth",
  oauth_static: "kernel.mcpUi.authDescOAuth",
}

const Section: Component<{ id: string; title: string; hint?: string; children: JSX.Element }> = (
  props,
) => (
  <section class="mt-8" aria-labelledby={`${props.id}-h`} data-testid={props.id}>
    <h2 id={`${props.id}-h`} class="text-[15px] font-semibold leading-snug text-text">
      {props.title}
    </h2>
    <Show when={props.hint}>
      <p class="mt-0.5 text-[12.5px] text-text-secondary">{props.hint}</p>
    </Show>
    <div class="mt-3">{props.children}</div>
  </section>
)

export const ConnectionDetail: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const detail = useMcpRowDetail()
  const [conn, { refetch: refetchConn }] = createResource(
    () => props.connectionId,
    (id) => getConnection(api, id),
  )
  const [row, { refetch }] = createResource(
    () => props.connectionId,
    async (id) => (await listConnections(api)).find((r) => r.id === id) ?? null,
  )
  onReturnToPage(() => void refetch())
  const state = createMemo(() => {
    const r = row.latest
    return r ? mcpRowState(r) : null
  })
  // An org server whose tools nobody reviewed yet reopens the tools review for an
  // admin who may set policy; Done or close marks it reviewed.
  const [reviewDismissed, setReviewDismissed] = createSignal(false)
  const [reviewKey, setReviewKey] = createSignal(0)
  const needsReview = () => {
    const c = conn.latest
    return (
      !!c &&
      c.toolsReviewedAt === null &&
      c.ownershipScope === "org" &&
      c.managedBy !== "env" &&
      hasScope("mcp_manager:policy:write") &&
      !reviewDismissed()
    )
  }
  const [confirmRemove, setConfirmRemove] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  async function signIn(): Promise<void> {
    setBusy(true)
    try {
      await signInToMcp(api, props.connectionId, (url) => void openExternal(url))
      await refetch()
    } catch (e) {
      addToast({ message: e instanceof Error ? e.message : String(e), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    setBusy(true)
    try {
      await deleteConnection(api, props.connectionId)
      props.onRemoved?.()
    } catch (e) {
      addToast({ message: e instanceof Error ? e.message : String(e), type: "error" })
    } finally {
      setBusy(false)
      setConfirmRemove(false)
    }
  }

  return (
    <div data-testid="mcp-detail">
      <Show when={conn()} keyed>
        {(c) => (
          <header
            class="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3"
            data-testid="mcp-detail-header"
          >
            <span class="inline-flex h-10 w-10 flex-none items-center justify-center rounded-md border border-border bg-bg text-sm font-semibold">
              {c.displayName.slice(0, 1).toUpperCase()}
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h1 class="text-lg font-semibold leading-tight text-text">{c.displayName}</h1>
                <Show when={row.latest} keyed>
                  {(r) => <McpStatusChip conn={r} />}
                </Show>
              </div>
              <div class="break-all font-mono text-xs text-text-secondary">{c.httpUrl ?? ""}</div>
              <div class="text-xs text-text-secondary">{i18n.t(AUTH_LABEL[c.authFlavor])}</div>
              <Show when={state() !== "connected" && state() !== "idle" ? row.latest : null} keyed>
                {(r) => (
                  <div
                    class="mt-1 text-xs text-text-secondary"
                    data-testid="mcp-detail-status-detail"
                  >
                    {detail(r)}
                  </div>
                )}
              </Show>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Show when={canSignIn(state() ?? "idle")}>
                <Button
                  data-testid="mcp-detail-signin"
                  loading={busy()}
                  onClick={() => void signIn()}
                >
                  {state() === "needs_reauth"
                    ? i18n.t("kernel.mcpUi.signInAgain")
                    : i18n.t("kernel.mcpUi.signIn")}
                </Button>
              </Show>
              <Show
                when={confirmRemove()}
                fallback={
                  <Button
                    variant="ghost"
                    data-testid="mcp-detail-remove"
                    disabled={c.managedBy === "env"}
                    onClick={() => setConfirmRemove(true)}
                  >
                    {i18n.t("kernel.mcpUi.remove")}
                  </Button>
                }
              >
                <Button
                  variant="danger"
                  data-testid="mcp-detail-remove-confirm"
                  loading={busy()}
                  onClick={() => void remove()}
                >
                  {i18n.t("kernel.mcpUi.confirmDelete")}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                  {i18n.t("kernel.common.cancel")}
                </Button>
              </Show>
            </div>
          </header>
        )}
      </Show>

      <Section
        id="mcp-detail-section-tools"
        title={i18n.t("kernel.mcpUi.sectionTools")}
        hint={i18n.t("kernel.mcpUi.sectionToolsHint")}
      >
        <Show when={reviewKey() + 1} keyed>
          {/* The rows follow the saved default; the policy view below changes it. */}
          <ToolsTab
            connectionId={props.connectionId}
            defaultPolicy={conn.latest?.connectionDefaultPolicy}
          />
          <div class="mt-4 rounded-lg border border-border bg-surface p-4">
            <PolicyTab
              connectionId={props.connectionId}
              onDefaultPolicyChange={() => void refetchConn()}
            />
          </div>
        </Show>
        <Show when={conn.latest}>
          {(c) => (
            <McpToolsReviewDialog
              open={needsReview()}
              connectionId={c().id}
              serverName={c().displayName}
              currentPolicy={c().connectionDefaultPolicy}
              accessSlug={hasScope(MCP_ACCESS_ADMIN_SCOPE) ? c().slug : undefined}
              onClose={() => {
                setReviewDismissed(true)
                // The section re-reads the choices (and the default) the review saved.
                setReviewKey((k) => k + 1)
                void refetchConn()
              }}
            />
          )}
        </Show>
      </Section>
      {/* Who can use an ORG server; a personal one is its owner's alone. */}
      <Show
        when={
          conn.latest?.ownershipScope === "org" && hasScope(MCP_ACCESS_ADMIN_SCOPE)
            ? conn.latest
            : null
        }
        keyed
      >
        {(c) => (
          <Section
            id="mcp-detail-section-access"
            title={i18n.t("kernel.mcpUi.accessTitle")}
            hint={i18n.t("kernel.mcpUi.accessHint")}
          >
            <McpAccessSection connectionId={c.id} slug={c.slug} serverName={c.displayName} />
          </Section>
        )}
      </Show>
      <Section
        id="mcp-detail-section-activity"
        title={i18n.t("kernel.mcpUi.sectionActivity")}
        hint={i18n.t("kernel.mcpUi.sectionActivityHint")}
      >
        <AuditTab connectionId={props.connectionId} />
      </Section>
      {/* Usage is metered on the managed edition only: no empty section on self-host. */}
      <Show when={billingMode() === "managed"}>
        <Section id="mcp-detail-section-usage" title={i18n.t("kernel.mcpUi.sectionUsage")}>
          <UsageTab connectionId={props.connectionId} />
        </Section>
      </Show>
      <Section
        id="mcp-detail-section-configuration"
        title={i18n.t("kernel.mcpUi.sectionConfiguration")}
      >
        <ConfigurationTab connectionId={props.connectionId} />
      </Section>
    </div>
  )
}
