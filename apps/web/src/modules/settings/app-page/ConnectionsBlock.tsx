// SPDX-License-Identifier: FSL-1.1-ALv2
// A connections block: each declared connection the block names, with one row
// per account (whose it is, its health, whether access renews by itself) and
// what can be done right there: Reconnect, Disconnect (asked first), Share
// with organization for a personal OAuth account, and Connect / Add account,
// which opens the credential form or OAuth sign-in INLINE (ConnectAppDialog's
// content, the one form every connect uses). `openConnection` (the page's
// `?open=`) opens that connection's form on arrival.
//
// A block may name a `status` read tool: its answer is a status line above the
// connections (connected, not connected, revoked, or unavailable with the
// read's own message and any `warnings` it lists), with the fix in place:
// Reconnect opens the first connection's form or OAuth sign-in right there,
// and a save or disconnect checks again. "Not connected" may come back as a
// 200 carrying `{ error }` (lib/tool-answer.ts), never read as success.
//
// Not connected is said ONCE, with ONE Connect: the connection's own card
// below already says "No account connected yet" and offers Connect, so the
// status line stays out of the way while that connection holds no account,
// and never adds a second Connect (or a "Check again" with nothing to check).
//
// A multi-instance connection's accounts are each named by an identifier the
// app defines, so the generic form neither adds nor replaces one there: the
// app's own block does, and this block lists and disconnects them.
import {
  type Accessor,
  type Component,
  createEffect,
  createResource,
  createSignal,
  For,
  on,
  Show,
} from "solid-js"
import { connectionLabel } from "~/lib/app-label"
import { appDisplayNames } from "~/lib/capability-copy"
import { isNotConnectedCode } from "~/lib/tool-answer"
import { canAccessScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { type AppConnectionConfig, appsStore, connectionState } from "../apps-store"
import { DisconnectConfirmDialog } from "../DisconnectConfirmDialog"
import { InlineConnectForm } from "../InlineConnectForm"
import { connectWithOAuth } from "../oauth-connect"
import { accountLabel, type ConnectionAccount, loadConnectionAccounts } from "./connection-accounts"
import { useAppPage } from "./page-context"
import { labelOf } from "./page-model"
import { callAppTool, type ToolOutcome } from "./settings-api"
import type { SettingsConnectionsBlock } from "./types"

const P = "kernel.settingsPage"

function shortDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10)
}

/** The connection's own admin scope, as the server checks it (connections/admin-scope.ts). */
export function canAdministerConnection(app: string, conn: { adminScope?: string }): boolean {
  return canAccessScope(conn.adminScope ?? `${app}:accounts:admin`)
}

export const ConnectionsBlock: Component<{
  app: string
  block: SettingsConnectionsBlock
  blockId: string
  /** A connection whose form opens on arrival (`?open=`). */
  openConnection?: string
  /**
   * The section is open to every member, to connect their own account: whoever
   * does not administer a connection sees only their own accounts on it.
   */
  personalSection?: boolean
}> = (props) => {
  const api = useApi()
  const page = useAppPage()
  const [configs] = createResource(
    () => page?.reloadToken() ?? 0,
    async () => {
      await appsStore.loadConnections(api, props.app)
      const all = appsStore.connectionsFor(props.app)
      const names = props.block.names
      return names ? all.filter((c) => names.includes(c.name)) : all
    },
  )
  // An account was connected or disconnected here: the status line checks again.
  const [changed, setChanged] = createSignal(0)
  const bumpChanged = () => setChanged((n) => n + 1)
  // The status line's Connect / Reconnect, handed to the connection it fixes.
  const [fixRequest, setFixRequest] = createSignal<{ name: string } | null>(null)
  const fixable = () => {
    const list = (configs.latest ?? []).filter((c) => !c.multiInstance)
    return list.find((c) => !c.optional) ?? list[0]
  }
  // The connection the status line would fix holds no account: its card is
  // the empty state (with its Connect), so a "not connected" line says nothing
  // new. Until the connections are listed it is not known yet, so the line
  // waits too rather than showing "Checking" and then vanishing.
  const cardIsEmptyState = () => {
    if (configs.latest === undefined) return true
    const c = fixable()
    return c !== undefined && (c.accounts?.active ?? 0) + (c.accounts?.error ?? 0) === 0
  }
  return (
    <div class="flex flex-col gap-3" data-testid={`settings-block-${props.blockId}`}>
      {/* The line reports what the org's connection does: for those who run it. */}
      <Show
        when={
          !props.personalSection ||
          (configs() ?? []).some((c) => canAdministerConnection(props.app, c))
            ? props.block.status
            : undefined
        }
      >
        {(status) => (
          <StatusLine
            app={props.app}
            tool={status().tool}
            params={status().params ?? {}}
            reloadKey={() => `${page?.reloadToken() ?? 0}:${changed()}`}
            canFix={fixable() !== undefined}
            quietWhenNotConnected={cardIsEmptyState()}
            onFix={() => {
              const c = fixable()
              if (c) setFixRequest({ name: c.name })
            }}
          />
        )}
      </Show>
      <For each={configs() ?? []}>
        {(conn) => (
          <ConnectionCard
            app={props.app}
            conn={conn}
            personalSection={props.personalSection}
            initiallyOpen={props.openConnection === conn.name}
            fixRequest={fixRequest}
            onChanged={bumpChanged}
            disconnectBody={props.block.disconnectBody}
            disconnectBodyKey={props.block.disconnectBodyKey}
          />
        )}
      </For>
    </div>
  )
}

export type ConnectionStatus =
  | { state: "connected"; warnings: string[] }
  | { state: "not_connected" }
  | { state: "revoked"; message: string }
  | { state: "unavailable"; message: string | null }

/**
 * What a status read says about the connection: data = connected (with the
 * `warnings` it lists), a not-connected code (thrown or a 200 `{ error }`) =
 * not connected, a revoked grant = revoked, anything else = unavailable with
 * the read's own message.
 */
export function connectionStatusOf(outcome: ToolOutcome): ConnectionStatus {
  if (outcome.kind === "ok") {
    const data = outcome.data
    const raw =
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as { warnings?: unknown }).warnings
        : undefined
    const warnings = Array.isArray(raw) ? raw.filter((w): w is string => typeof w === "string") : []
    return { state: "connected", warnings }
  }
  if (outcome.kind === "pending") return { state: "unavailable", message: null }
  if (isNotConnectedCode(outcome.code)) return { state: "not_connected" }
  if (/revoked/i.test(outcome.code)) return { state: "revoked", message: outcome.message }
  return { state: "unavailable", message: outcome.message }
}

const StatusLine: Component<{
  app: string
  tool: string
  params: Record<string, string | number | boolean>
  reloadKey: Accessor<string>
  canFix: boolean
  /** Not connected (or still checking) shows nothing: the card below says it. */
  quietWhenNotConnected: boolean
  onFix: () => void
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [status, { refetch }] = createResource(props.reloadKey, () =>
    callAppTool(api, props.app, props.tool, props.params).then(connectionStatusOf),
  )
  // `latest` keeps the last answer on screen while a re-check runs.
  const current = () => status.latest
  const state = () => current()?.state ?? "checking"
  const label = () => {
    switch (state()) {
      case "connected":
        return i18n.t(`${P}.connected`)
      case "not_connected":
        return i18n.t(`${P}.notConnected`)
      case "revoked":
        return i18n.t(`${P}.statusRevoked`)
      case "unavailable":
        return i18n.t(`${P}.statusUnavailable`)
      default:
        return i18n.t(`${P}.statusChecking`)
    }
  }
  const tone = () => {
    switch (state()) {
      case "connected":
        return "text-success"
      case "revoked":
      case "unavailable":
        return "text-danger"
      default:
        return "text-text-secondary"
    }
  }
  const message = () => {
    const c = current()
    return c && (c.state === "unavailable" || c.state === "revoked") ? c.message : null
  }
  const warnings = () => {
    const c = current()
    return c?.state === "connected" ? c.warnings : []
  }
  const hint = () => {
    switch (state()) {
      case "not_connected":
        return i18n.t(`${P}.statusNotConnectedHint`)
      case "revoked":
        return i18n.t(`${P}.statusRevokedHint`)
      case "unavailable":
        return i18n.t(`${P}.statusUnavailableHint`)
      default:
        return null
    }
  }
  // Not connected is fixed by the card's own Connect, never a second one here.
  const needsFix = () => state() === "revoked" || state() === "unavailable"
  // "Check again" re-reads something that exists: a connection's health.
  const canCheckAgain = () => state() !== "not_connected"
  const quiet = () =>
    props.quietWhenNotConnected && (state() === "not_connected" || state() === "checking")
  return (
    <Show when={!quiet()}>
      <div
        class="flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-3.5 py-2.5"
        data-testid="connections-status"
        data-state={state()}
      >
        <div class="flex flex-wrap items-center gap-3">
          <span class={`min-w-0 flex-1 text-[13px] font-medium ${tone()}`}>{label()}</span>
          <Show when={canCheckAgain()}>
            <Button
              size="sm"
              variant="ghost"
              loading={status.loading}
              data-testid="connections-status-refresh"
              onClick={() => void refetch()}
            >
              {i18n.t(`${P}.checkAgain`)}
            </Button>
          </Show>
        </div>
        <Show when={message()}>
          {(m) => (
            <p
              class="break-words font-mono text-xs text-text-secondary"
              data-testid="connections-status-message"
            >
              {m()}
            </p>
          )}
        </Show>
        <Show when={warnings().length > 0}>
          <div class="text-xs" data-testid="connections-status-warnings">
            <div class="font-medium text-text-secondary">{i18n.t(`${P}.statusWarnings`)}</div>
            <ul class="mt-1 flex flex-col gap-1">
              <For each={warnings()}>{(w) => <li class="text-warning">{w}</li>}</For>
            </ul>
          </div>
        </Show>
        <Show when={hint()}>{(h) => <p class="text-xs text-text-secondary">{h()}</p>}</Show>
        <Show when={needsFix() && props.canFix}>
          <Button
            class="w-fit"
            size="sm"
            variant="outline"
            data-testid="connections-status-fix"
            onClick={() => props.onFix()}
          >
            {i18n.t(`${P}.reconnect`)}
          </Button>
        </Show>
      </div>
    </Show>
  )
}

const ConnectionCard: Component<{
  app: string
  conn: AppConnectionConfig
  personalSection?: boolean
  initiallyOpen: boolean
  /** The block's status line asks this connection to be fixed. */
  fixRequest: Accessor<{ name: string } | null>
  /** An account was connected or disconnected. */
  onChanged: () => void
  /** What disconnecting deletes (the block's own words), else the kernel's. */
  disconnectBody?: string
  disconnectBodyKey?: string
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const page = useAppPage()
  // A failed read shows the account counts the connection list carries (null).
  const [accounts, { refetch }] = createResource(
    () => page?.reloadToken() ?? 0,
    (): Promise<ConnectionAccount[] | null> =>
      loadConnectionAccounts(api, props.app, props.conn.name).catch(() => null),
  )
  const [formOpen, setFormOpen] = createSignal(props.initiallyOpen)
  // The store a reconnect could not start for by itself: the form opens on it.
  const [formVars, setFormVars] = createSignal<Record<string, string> | undefined>(undefined)
  const [confirm, setConfirm] = createSignal<ConnectionAccount | null>(null)
  const [busy, setBusy] = createSignal<string | null>(null)
  const isOAuth = () => props.conn.type === "oauth2"
  const multi = () => props.conn.multiInstance === true
  const canAdminOrg = () => canAdministerConnection(props.app, props.conn)
  const ownOnly = () => props.personalSection === true && !canAdminOrg()
  const title = () => connectionLabel(props.app, props.conn, i18n.t, appDisplayNames()[props.app])
  const rows = () => (accounts() ?? []).filter((a) => !ownOnly() || a.ownerType !== "org")
  const known = () => accounts() !== null && accounts() !== undefined
  // A connection holds one account unless it is OAuth (one per person); a
  // multi-instance one is added through the app's own block.
  const canAddMore = () => !multi() && (isOAuth() || rows().length === 0)

  function owner(a: ConnectionAccount): string {
    if (a.ownerType === "org") return i18n.t(`${P}.ownerOrg`)
    return a.isMine ? i18n.t(`${P}.ownerMine`) : i18n.t(`${P}.ownerPersonal`)
  }

  function detail(a: ConnectionAccount): string {
    const parts = [owner(a)]
    if (a.connectedByName) parts.push(i18n.t(`${P}.connectedBy`, { name: a.connectedByName }))
    if (a.status === "error") {
      parts.push(a.statusMessage ?? i18n.t(`${P}.needsReconnect`))
    } else if (a.hasRefreshToken) {
      parts.push(i18n.t(`${P}.renews`))
    } else if (a.tokenExpiresAt) {
      parts.push(i18n.t(`${P}.expires`, { date: shortDate(a.tokenExpiresAt) }))
    }
    return parts.join(" · ")
  }

  async function oauth(
    mode: "personal" | "org",
    key: string,
    extra: Record<string, string> = {},
  ): Promise<void> {
    setBusy(key)
    try {
      const outcome = await connectWithOAuth(
        api,
        `/connections/${props.app}/${props.conn.name}/authorize`,
        { mode, ...extra },
      )
      if (outcome === "connected") {
        void refetch()
        props.onChanged()
      }
      if (outcome === "no-redirect") {
        addToast({ message: i18n.t(`${P}.noRedirect`), type: "error" })
      }
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : String(err), type: "error" })
    } finally {
      setBusy(null)
    }
  }

  // A per-store OAuth connection (`{shop}` in its URLs): the authorize call
  // needs the store, which a new account types into the form.
  const asksForStore = () => (props.conn.templateVars?.length ?? 0) > 0

  createEffect(
    on(
      props.fixRequest,
      (req) => {
        if (req?.name !== props.conn.name) return
        if (isOAuth() && !asksForStore()) void oauth(canAdminOrg() ? "org" : "personal", "fix")
        else setFormOpen(true)
      },
      { defer: true },
    ),
  )

  // Reconnect is offered on every account its viewer may manage, as Disconnect
  // is: their own personal account, or an org account when they administer it.
  // It re-runs the grant (new scopes, a revoked token) for that very account.
  const canManage = (a: ConnectionAccount) =>
    a.ownerType === "org" ? canAdminOrg() : a.isMine === true
  // A credentials account of a multi-instance connection is named by an
  // identifier the app defines: the generic form cannot replace it.
  const canReconnect = (a: ConnectionAccount) => canManage(a) && (isOAuth() || !multi())

  // The template variables of a per-store account, read off its identifier when
  // the connection says which variable that identifier is. Null: not derivable.
  function storeVarsOf(a: ConnectionAccount): Record<string, string> | null {
    const vars = props.conn.templateVars ?? []
    const key = props.conn.identifierVar
    if (!key || vars.length !== 1 || vars[0] !== key || !a.identifier) return null
    return { [key]: a.identifier }
  }

  function reconnect(a: ConnectionAccount): void {
    if (!isOAuth()) {
      setFormVars(undefined)
      setFormOpen(true)
      return
    }
    const mode = a.ownerType === "org" ? "org" : "personal"
    if (!asksForStore()) {
      void oauth(mode, a.id, { accountHint: a.identifier })
      return
    }
    const vars = storeVarsOf(a)
    if (vars) {
      void oauth(mode, a.id, vars)
      return
    }
    // The store cannot be read safely off the account: the form asks for it,
    // starting from the identifier when the connection names its variable.
    const key = props.conn.identifierVar
    setFormVars(key && a.identifier ? { [key]: a.identifier } : undefined)
    setFormOpen(true)
  }

  async function disconnect(a: ConnectionAccount): Promise<void> {
    setBusy(a.id)
    try {
      await api.delete(`/connections/${a.id}`)
      setConfirm(null)
      void refetch()
      void appsStore.loadConnections(api, props.app)
      props.onChanged()
    } catch (err) {
      addToast({ message: err instanceof Error ? err.message : String(err), type: "error" })
    } finally {
      setBusy(null)
    }
  }

  const confirmName = () => {
    const a = confirm()
    return a ? accountLabel(a, title()) : ""
  }

  const countLine = () => {
    if (ownOnly()) return i18n.t(`${P}.noAccount`)
    const c = props.conn.accounts ?? { active: 0, error: 0 }
    const parts: string[] = []
    if (c.active > 0) parts.push(i18n.t(`${P}.countConnected`, { count: c.active }))
    if (c.error > 0) parts.push(i18n.t(`${P}.countBroken`, { count: c.error }))
    return parts.length > 0 ? parts.join(" · ") : i18n.t(`${P}.noAccount`)
  }

  // No chip while nothing is connected: the card's own line ("No account
  // connected yet") already says so.
  const chip = () => {
    const s = connectionState(props.conn)
    if (s === "connected") return { label: i18n.t(`${P}.connected`), cls: "text-success" }
    if (s === "attention") return { label: i18n.t(`${P}.needsReconnect`), cls: "text-warning" }
    return null
  }

  return (
    <div
      class="rounded-lg border border-border bg-surface"
      data-testid={`connections-conn-${props.conn.name}`}
    >
      <div class="flex min-h-11 flex-wrap items-center gap-3 border-b border-border px-3.5 py-2.5">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="text-[13.5px] font-medium">{title()}</span>
            <Show when={chip()}>
              {(c) => <span class={`text-[11px] font-medium ${c().cls}`}>{c().label}</span>}
            </Show>
          </div>
          <Show when={props.conn.optional}>
            <div class="text-xs text-text-tertiary">{i18n.t(`${P}.optional`)}</div>
          </Show>
        </div>
        <Show when={canAddMore() && !formOpen()}>
          <Button
            size="sm"
            variant="outline"
            data-testid={`connections-connect-${props.conn.name}`}
            onClick={() => {
              setFormVars(undefined)
              setFormOpen(true)
            }}
          >
            {rows().length > 0 ? i18n.t(`${P}.addAccount`) : i18n.t(`${P}.connect`)}
          </Button>
        </Show>
      </div>
      <Show
        when={known()}
        fallback={
          <Show when={!accounts.loading}>
            <div class="px-3.5 py-2.5 text-xs text-text-secondary">{countLine()}</div>
          </Show>
        }
      >
        <Show
          when={rows().length > 0}
          fallback={
            <div class="px-3.5 py-2.5 text-xs text-text-tertiary">{i18n.t(`${P}.noAccount`)}</div>
          }
        >
          <ul class="divide-y divide-border">
            <For each={rows()}>
              {(a) => (
                <li
                  class="flex min-h-11 flex-wrap items-center gap-3 px-3.5 py-2.5"
                  data-testid={`connections-account-${a.id}`}
                >
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span
                        class="truncate text-[13.5px] font-medium"
                        data-testid={`connections-account-label-${a.id}`}
                      >
                        {accountLabel(a, title())}
                      </span>
                      <span
                        class={`text-[11px] font-medium ${a.status === "error" ? "text-warning" : "text-success"}`}
                      >
                        {a.status === "error"
                          ? i18n.t(`${P}.needsReconnect`)
                          : i18n.t(`${P}.connected`)}
                      </span>
                    </div>
                    <div class="text-xs text-text-secondary">{detail(a)}</div>
                    <Show when={a.ownerType === "user" && isOAuth()}>
                      <div class="mt-1 text-xs text-text-tertiary">
                        {i18n.t(`${P}.personalNote`)}
                      </div>
                    </Show>
                  </div>
                  <div class="flex items-center gap-1">
                    <Show when={a.ownerType === "user" && isOAuth() && canAdminOrg()}>
                      <Button
                        size="sm"
                        variant="outline"
                        loading={busy() === `share-${a.id}`}
                        data-testid={`connections-share-${a.id}`}
                        onClick={() =>
                          asksForStore() ? setFormOpen(true) : void oauth("org", `share-${a.id}`)
                        }
                      >
                        {i18n.t(`${P}.share`)}
                      </Button>
                    </Show>
                    <Show when={canReconnect(a)}>
                      <Button
                        size="sm"
                        variant="outline"
                        loading={busy() === a.id}
                        data-testid={`connections-reconnect-${a.id}`}
                        onClick={() => reconnect(a)}
                      >
                        {isOAuth() ? i18n.t(`${P}.reconnect`) : i18n.t(`${P}.replace`)}
                      </Button>
                    </Show>
                    <Show when={a.ownerType === "user" || canAdminOrg()}>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`connections-disconnect-${a.id}`}
                        onClick={() => setConfirm(a)}
                      >
                        {i18n.t(`${P}.disconnect`)}
                      </Button>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
      <Show when={formOpen()}>
        <div class="border-t border-border p-3">
          <InlineConnectForm
            appName={props.app}
            connectionName={props.conn.name}
            initialTemplateVars={formVars()}
            onConnected={() => {
              setFormOpen(false)
              setFormVars(undefined)
              void refetch()
              void appsStore.loadConnections(api, props.app)
              props.onChanged()
            }}
            onClose={() => {
              setFormOpen(false)
              setFormVars(undefined)
            }}
          />
        </div>
      </Show>
      <DisconnectConfirmDialog
        open={confirm() !== null}
        name={confirmName()}
        body={
          props.disconnectBody
            ? labelOf(i18n.t, props.disconnectBodyKey, props.disconnectBody)
            : i18n.t(`${P}.disconnectBody`)
        }
        busy={busy() !== null}
        revokes={isOAuth()}
        testId="connections-disconnect-dialog"
        onConfirm={() => {
          const a = confirm()
          if (a) void disconnect(a)
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}
