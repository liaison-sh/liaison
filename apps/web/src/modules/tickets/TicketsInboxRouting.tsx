// SPDX-License-Identifier: FSL-1.1-ALv2
// The Tickets settings page's inbox routing block (custom block
// `TicketsInboxRouting`, declared in the tickets manifest `settings`): every
// inbox with its routing and reply identity, connection health and reconnect,
// API inboxes with their ingest URL and key. Connecting a Gmail or IMAP
// mailbox is the page's connections block, right above this one.

import type { Component } from "solid-js"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { runTool } from "~/lib/run-tool"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { DisconnectConfirmDialog } from "~/modules/settings/DisconnectConfirmDialog"
import { connectWithOAuth } from "~/modules/settings/oauth-connect"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import {
  handleInboxEvent,
  loadInboxes,
  saveInboxSettings,
  ticketInboxStore,
} from "~/modules/tickets/ticket-inbox-store"
import type { InboxConnectionHealth, TicketInbox } from "~/modules/tickets/ticket-types"
import { Dialog } from "~/ui/Dialog"

function inboxKind(inbox: TicketInbox): "mailbox" | "api" {
  return inbox.kind === "api" ? "api" : "mailbox"
}

function replyViaInboxId(inbox: TicketInbox): string | null {
  return inbox.replyViaInboxId ?? inbox.reply_via_inbox_id ?? null
}

function replyFromEmail(inbox: TicketInbox): string | null {
  return inbox.replyFromEmail ?? inbox.reply_from_email ?? null
}

function replyToEmail(inbox: TicketInbox): string | null {
  return inbox.replyToEmail ?? inbox.reply_to_email ?? null
}

function signatureHtml(inbox: TicketInbox): string | null {
  return inbox.signatureHtml ?? inbox.signature_html ?? null
}

function signatureText(inbox: TicketInbox): string | null {
  return inbox.signatureText ?? inbox.signature_text ?? null
}

function ackEnabled(inbox: TicketInbox): boolean {
  const v = inbox.ackEnabled ?? inbox.ack_enabled
  return v !== false
}

function ackBodyText(inbox: TicketInbox): string | null {
  return inbox.ackBodyText ?? inbox.ack_body_text ?? null
}

function slaPromisePhrase(inbox: TicketInbox): string {
  return inbox.slaPromisePhrase ?? inbox.sla_promise_phrase ?? "within 2 business days"
}

function suppressAttention(inbox: TicketInbox): boolean {
  return (inbox.suppressAttention ?? inbox.suppress_attention) === true
}

function slaExempt(inbox: TicketInbox): boolean {
  return (inbox.slaExempt ?? inbox.sla_exempt) === true
}

/** Bounds and defaults of the close-silent delays; the server checks the same. */
const CLOSE_SILENT_DEFAULT_NUDGE_DAYS = 7
const CLOSE_SILENT_DEFAULT_CLOSE_DAYS = 5
const CLOSE_SILENT_MAX_DAYS = 90

function closeSilentEnabled(inbox: TicketInbox): boolean {
  return inbox.close_silent_enabled === true
}

function closeSilentDays(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback
}

/** A day count typed in the form, clamped to 1..90, else the default. */
export function parseCloseSilentDays(raw: string, fallback: number): number {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(CLOSE_SILENT_MAX_DAYS, Math.max(1, n))
}

function connectionHealth(inbox: TicketInbox): InboxConnectionHealth | null {
  return inbox.connectionHealth ?? inbox.connection_health ?? null
}

function needsReconnect(inbox: TicketInbox): boolean {
  return !inbox.archivedAt && connectionHealth(inbox)?.status === "needs_reconnect"
}

/** User-facing badge + hint per health reason. No dash punctuation. */
function reconnectCopy(
  health: InboxConnectionHealth,
  t: (key: string, params?: Record<string, string>) => string,
): { badge: string; hint: string } {
  if (health.reason === "missing_scopes") {
    return {
      badge: t("tickets.reconnectCopy.reauthBadge"),
      hint: t("tickets.reconnectCopy.reauthHint", {
        scopes: (health.missingScopes ?? []).join(", "),
      }),
    }
  }
  if (health.reason === "expired_no_refresh") {
    return {
      badge: t("tickets.reconnectCopy.badge"),
      hint: t("tickets.reconnectCopy.expiredHint"),
    }
  }
  return {
    badge: t("tickets.reconnectCopy.badge"),
    hint: health.statusMessage ?? t("tickets.reconnectCopy.revokedHint"),
  }
}

/** What a refused or failed inbox save tells the person, in their language. */
export function inboxSaveErrorMessage(
  err: unknown,
  t: (key: string, params?: Record<string, string | number | boolean>) => string,
): string {
  if (err instanceof ApiError && err.status === 403) return t("tickets.inboxSaveForbidden")
  const reason = err instanceof Error && err.message ? err.message : String(err)
  return t("tickets.inboxSaveFailed", { reason })
}

/**
 * Copyable per-inbox ingest endpoint. The web app and API share an origin
 * (VITE_API_BASE defaults to the same-origin `/api` proxy path — see
 * apps/web/src/lib/env.ts), so `window.location.origin` is the right base
 * absent a dedicated API-origin env var. Webhooks are mounted at `/webhooks`
 * with NO `/api` prefix (apps/api/src/app.ts).
 */
function ingestUrl(inboxId: string): string {
  const orgId = userFromToken()?.orgId ?? ""
  const origin = typeof window !== "undefined" ? window.location.origin : ""
  return `${origin}/webhooks/${orgId}/inboxes/${inboxId}/tickets/create`
}

export const TicketsInboxRouting: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [editing, setEditing] = createSignal<string | null>(null)
  const [showApiForm, setShowApiForm] = createSignal(false)
  const [apiFormError, setApiFormError] = createSignal<string | null>(null)
  const [copiedId, setCopiedId] = createSignal<string | null>(null)
  const [revealedKey, setRevealedKey] = createSignal<{ inboxId: string; key: string } | null>(null)
  let apiName!: HTMLInputElement
  let apiReplyVia!: HTMLSelectElement
  let apiReplyFrom!: HTMLInputElement
  let apiTeam!: HTMLInputElement
  let apiSensitivity!: HTMLSelectElement

  onMount(() => {
    if (!ticketInboxStore.loaded) void loadInboxes(api)
    const onInboxesInvalidated = () => void loadInboxes(api)
    window.addEventListener("tickets:inboxes-invalidated", onInboxesInvalidated)
    onCleanup(() => window.removeEventListener("tickets:inboxes-invalidated", onInboxesInvalidated))
  })

  // A disconnected inbox is archived (its tickets stay), so it leaves the list:
  // it takes no new tickets and offers no live action (configure, API key).
  const inboxes = createMemo(() => ticketInboxStore.inboxes.filter((i) => !i.archivedAt))
  const mailboxInboxes = createMemo(() => inboxes().filter((i) => inboxKind(i) === "mailbox"))

  function updateInbox(id: string, params: Record<string, unknown>): Promise<"saved" | "pending"> {
    return saveInboxSettings(api, id, params)
  }

  async function disconnect(id: string): Promise<void> {
    await runTool(api, "tickets:inboxes.disconnect", { id })
    // Apply the disconnect to the local store immediately on success. Without
    // this, the user's own click depends entirely on the WS broadcast + a
    // follow-up `loadInboxes` round-trip — both of which can take longer
    // than 5s under heavy parallel load, leaving the Disconnect button
    // visible after the user has already clicked it. The WS handler that
    // follows is idempotent (same `disconnect` action, same `archivedAt`).
    handleInboxEvent("disconnect", { id })
    // Still refresh in the background to pick up any additional server-side
    // side effects we don't model locally (e.g., connection metadata).
    void loadInboxes(api)
  }

  // Disconnecting an inbox ends its mailbox connection: it asks first, saying what stays.
  const [pendingDisconnect, setPendingDisconnect] = createSignal<TicketInbox | null>(null)
  function requestDisconnect(id: string): Promise<void> {
    setPendingDisconnect(inboxes().find((i) => i.id === id) ?? null)
    return Promise.resolve()
  }
  function confirmDisconnect(): void {
    const inbox = pendingDisconnect()
    setPendingDisconnect(null)
    if (inbox) void disconnect(inbox.id)
  }

  async function reconnect(inbox: TicketInbox): Promise<void> {
    const connection = connectionHealth(inbox)?.connection ?? "gmail"
    if (connection === "imap") {
      // IMAP has no OAuth flow: reconnecting means replacing the credentials
      // in the IMAP connection of the connections block above.
      addToast({ message: i18n.t("tickets.settingsPage.inboxes.imapReconnect"), type: "info" })
      return
    }
    // Same authorize flow as Connect Gmail: the OAuth callback rebinds this
    // inbox to the fresh account row (matching by email address), so
    // re-authorizing IS the reconnect. Field is `redirectUrl`, not `url`.
    await connectWithOAuth(api, `/connections/tickets/${connection}/authorize`)
  }

  async function createApiInbox(): Promise<void> {
    setApiFormError(null)
    const name = apiName.value.trim()
    if (!name) {
      setApiFormError(i18n.t("tickets.nameIsRequired"))
      return
    }
    await runTool(api, "tickets:inboxes.create", {
      kind: "api",
      name,
      replyViaInboxId: apiReplyVia.value || null,
      replyFromEmail: apiReplyFrom.value.trim() || null,
      defaultTeam: apiTeam.value.trim() || null,
      defaultSensitivity: apiSensitivity.value || null,
    })
    apiName.value = ""
    apiReplyFrom.value = ""
    apiTeam.value = ""
    setShowApiForm(false)
    void loadInboxes(api)
  }

  async function copyIngestUrl(inboxId: string): Promise<void> {
    const url = ingestUrl(inboxId)
    if (navigator.clipboard) await navigator.clipboard.writeText(url)
    setCopiedId(inboxId)
    window.setTimeout(() => setCopiedId((cur) => (cur === inboxId ? null : cur)), 2000)
  }

  async function generateApiKey(inboxId: string): Promise<void> {
    const out = await runTool<{ key: string }>(api, "tickets:apiKeys.create", {
      label: `${inboxes().find((i) => i.id === inboxId)?.name ?? "inbox"} ingest`,
      inboxId,
    })
    setRevealedKey({ inboxId, key: out.key })
  }

  async function copyRevealedKey(): Promise<void> {
    const key = revealedKey()?.key
    if (!key || !navigator.clipboard) return
    await navigator.clipboard.writeText(key)
  }

  return (
    <div class="flex flex-col gap-3" data-testid="tickets-inbox-routing">
      <DisconnectConfirmDialog
        open={pendingDisconnect() !== null}
        name={pendingDisconnect()?.name ?? ""}
        body={
          pendingDisconnect() && inboxKind(pendingDisconnect() as TicketInbox) === "api"
            ? i18n.t("tickets.disconnectApiInboxConfirmBody")
            : i18n.t("tickets.disconnectConfirmBody")
        }
        revokes={!!pendingDisconnect() && inboxKind(pendingDisconnect() as TicketInbox) !== "api"}
        testId="tickets-inboxes-disconnect-dialog"
        onConfirm={confirmDisconnect}
        onCancel={() => setPendingDisconnect(null)}
      />
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded border border-border px-3 py-1.5 text-sm"
          data-testid="tickets-inboxes-connect-api"
          onClick={() => setShowApiForm((open) => !open)}
        >
          {i18n.t("tickets.createApiInbox")}
        </button>
      </div>

      <Show when={showApiForm()}>
        <div
          class="grid gap-2 rounded border border-border p-3 sm:grid-cols-2"
          data-testid="tickets-inboxes-api-form"
        >
          <input
            ref={apiName}
            class="rounded border border-border bg-surface-sunken px-2 py-1.5 text-sm"
            data-testid="tickets-api-inbox-name"
            placeholder={i18n.t("tickets.bugReports")}
          />
          <select
            ref={apiReplyVia}
            class="rounded border border-border bg-surface-sunken px-2 py-1.5 text-sm"
            data-testid="tickets-api-inbox-reply-via"
          >
            <option value="">{i18n.t("tickets.noReplyViaInternalOnly")}</option>
            <For each={mailboxInboxes()}>
              {(inbox) => <option value={inbox.id}>{inbox.name}</option>}
            </For>
          </select>
          <input
            ref={apiReplyFrom}
            class="rounded border border-border bg-surface-sunken px-2 py-1.5 text-sm"
            data-testid="tickets-api-inbox-reply-from"
            placeholder={i18n.t("tickets.replyFromEmailOptional")}
          />
          <input
            ref={apiTeam}
            class="rounded border border-border bg-surface-sunken px-2 py-1.5 text-sm"
            data-testid="tickets-api-inbox-team"
            placeholder={i18n.t("tickets.defaultTeam")}
          />
          <select
            ref={apiSensitivity}
            class="rounded border border-border bg-surface-sunken px-2 py-1.5 text-sm"
            data-testid="tickets-api-inbox-sensitivity"
          >
            <option value="">{i18n.t("tickets.internal")}</option>
            <option value="restricted">{i18n.t("tickets.restricted")}</option>
            <option value="confidential">{i18n.t("tickets.confidential")}</option>
          </select>
          <button
            type="button"
            class="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
            data-testid="tickets-api-inbox-create"
            onClick={() => void createApiInbox()}
          >
            {i18n.t("kernel.common.create")}
          </button>
          <Show when={apiFormError()}>
            <p class="text-sm text-red-500" data-testid="tickets-api-inbox-error">
              {apiFormError()}
            </p>
          </Show>
        </div>
      </Show>

      <Show
        when={inboxes().length > 0}
        fallback={
          <p class="text-text-secondary" data-testid="tickets-inboxes-empty">
            {i18n.t("tickets.connectAnEmailAccountFromThe")}
          </p>
        }
      >
        <div class="flex flex-col gap-3" data-testid="tickets-inboxes-list">
          <For each={inboxes()}>
            {(inbox) => (
              <InboxRow
                inbox={inbox}
                editing={editing() === inbox.id}
                onEdit={() => setEditing(inbox.id)}
                onCancel={() => setEditing(null)}
                onDisconnect={requestDisconnect}
                onReconnect={reconnect}
                onUpdate={updateInbox}
                mailboxInboxes={mailboxInboxes()}
                copied={copiedId() === inbox.id}
                onCopyIngestUrl={copyIngestUrl}
                onGenerateApiKey={generateApiKey}
              />
            )}
          </For>
        </div>
      </Show>

      <Dialog open={!!revealedKey()} onOpenChange={(open) => !open && setRevealedKey(null)}>
        <Show when={revealedKey()}>
          {(r) => (
            <Dialog.Content>
              <div data-testid="tickets-inboxes-key-reveal">
                <Dialog.Title>{i18n.t("tickets.copyApiKey")}</Dialog.Title>
                <Dialog.Description>{i18n.t("tickets.thisIsTheOnlyTimeThis")}</Dialog.Description>
                <code class="mt-3 block break-all rounded bg-surface-sunken p-2 text-sm">
                  {r().key}
                </code>
                <div class="mt-4 flex gap-2">
                  <button
                    type="button"
                    class="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
                    data-testid="tickets-inboxes-key-copy"
                    onClick={() => void copyRevealedKey()}
                  >
                    {i18n.t("tickets.copyKey")}
                  </button>
                  <button
                    type="button"
                    class="rounded border border-border px-3 py-1.5 text-sm"
                    onClick={() => setRevealedKey(null)}
                  >
                    {i18n.t("tickets.iCopiedIt")}
                  </button>
                </div>
              </div>
            </Dialog.Content>
          )}
        </Show>
      </Dialog>
    </div>
  )
}

interface InboxRowProps {
  inbox: TicketInbox
  editing: boolean
  onEdit: () => void
  onCancel: () => void
  onDisconnect: (id: string) => Promise<void>
  onReconnect: (inbox: TicketInbox) => Promise<void>
  onUpdate: (id: string, params: Record<string, unknown>) => Promise<"saved" | "pending">
  mailboxInboxes: TicketInbox[]
  copied: boolean
  onCopyIngestUrl: (inboxId: string) => Promise<void>
  onGenerateApiKey: (inboxId: string) => Promise<void>
}

const InboxRow: Component<InboxRowProps> = (props) => {
  const i18n = useI18n()
  let nameInput!: HTMLInputElement
  let teamInput!: HTMLInputElement
  let sensitivityInput!: HTMLSelectElement
  let fromDisplayNameInput!: HTMLInputElement
  let defaultInput!: HTMLInputElement
  let replyViaInput!: HTMLSelectElement
  let replyFromInput!: HTMLInputElement
  let replyToInput!: HTMLInputElement
  let signatureHtmlInput!: HTMLTextAreaElement
  let signatureTextInput!: HTMLTextAreaElement
  let ackEnabledInput!: HTMLInputElement
  let ackBodyInput!: HTMLTextAreaElement
  let slaPromiseInput!: HTMLInputElement
  let suppressAttentionInput!: HTMLInputElement
  let slaExemptInput!: HTMLInputElement
  let closeSilentNudgeDaysInput!: HTMLInputElement
  let closeSilentCloseDaysInput!: HTMLInputElement
  let closeSilentTextInput!: HTMLTextAreaElement
  const [closeSilentOn, setCloseSilentOn] = createSignal(closeSilentEnabled(props.inbox))
  const nudgeDays = () =>
    closeSilentDays(props.inbox.close_silent_nudge_days, CLOSE_SILENT_DEFAULT_NUDGE_DAYS)
  const closeDays = () =>
    closeSilentDays(props.inbox.close_silent_close_days, CLOSE_SILENT_DEFAULT_CLOSE_DAYS)

  const [saveError, setSaveError] = createSignal<string | null>(null)
  const [savePending, setSavePending] = createSignal(false)
  const [saving, setSaving] = createSignal(false)

  async function save(): Promise<void> {
    const isApi = inboxKind(props.inbox) === "api"
    setSaveError(null)
    setSavePending(false)
    setSaving(true)
    try {
      const outcome = await props.onUpdate(props.inbox.id, {
        name: nameInput.value.trim() || props.inbox.name,
        defaultTeam: teamInput.value.trim() || null,
        defaultSensitivity: sensitivityInput.value || null,
        fromDisplayName: fromDisplayNameInput.value.trim() || null,
        isDefaultForCreate: defaultInput.checked,
        replyToEmail: replyToInput.value.trim() || null,
        signatureHtml: signatureHtmlInput.value.trim() || null,
        signatureText: signatureTextInput.value.trim() || null,
        ackEnabled: ackEnabledInput.checked,
        ackBodyText: ackBodyInput.value.trim() || null,
        slaPromisePhrase: slaPromiseInput.value.trim() || "within 2 business days",
        suppressAttention: suppressAttentionInput.checked,
        slaExempt: slaExemptInput.checked,
        closeSilentEnabled: closeSilentOn(),
        ...(closeSilentOn()
          ? {
              closeSilentNudgeDays: parseCloseSilentDays(
                closeSilentNudgeDaysInput.value,
                CLOSE_SILENT_DEFAULT_NUDGE_DAYS,
              ),
              closeSilentCloseDays: parseCloseSilentDays(
                closeSilentCloseDaysInput.value,
                CLOSE_SILENT_DEFAULT_CLOSE_DAYS,
              ),
              closeSilentNudgeText: closeSilentTextInput.value.trim() || null,
            }
          : {}),
        ...(isApi
          ? {
              replyViaInboxId: replyViaInput.value || null,
              replyFromEmail: replyFromInput.value.trim() || null,
            }
          : {}),
      })
      if (outcome === "pending") setSavePending(true)
      else props.onCancel()
    } catch (err) {
      // A refused or failed save stays on screen with the form still open, so
      // nothing typed is lost and the person knows it did not take.
      setSaveError(inboxSaveErrorMessage(err, i18n.t))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      class="rounded border border-border-subtle p-3 text-sm"
      data-testid={`tickets-inboxes-row-${props.inbox.id}`}
    >
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="flex items-center gap-2">
            <span class="font-medium">{props.inbox.name}</span>
            <span
              class={
                inboxKind(props.inbox) === "api"
                  ? "rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent"
                  : "rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-text-secondary"
              }
              data-testid={`tickets-inboxes-kind-${props.inbox.id}`}
            >
              {inboxKind(props.inbox) === "api" ? "API" : i18n.t("tickets.mailbox")}
            </span>
            <Show when={needsReconnect(props.inbox)}>
              <span
                class="rounded-full bg-warning-glow border border-warning-border px-2 py-0.5 text-[10px] font-medium text-warning"
                data-testid={`tickets-inboxes-health-badge-${props.inbox.id}`}
              >
                {reconnectCopy(connectionHealth(props.inbox)!, i18n.t).badge}
              </span>
            </Show>
          </div>
          <div class="text-text-secondary">{props.inbox.emailAddress}</div>
          <Show when={needsReconnect(props.inbox)}>
            <p
              class="mt-1 text-xs text-warning"
              data-testid={`tickets-inboxes-health-hint-${props.inbox.id}`}
            >
              {reconnectCopy(connectionHealth(props.inbox)!, i18n.t).hint}
            </p>
          </Show>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-text-tertiary">
            {props.inbox.archivedAt ? "archived" : "active"}
          </span>
          <Show when={needsReconnect(props.inbox)}>
            <button
              type="button"
              class="rounded bg-accent px-2 py-1 text-xs font-medium text-accent-foreground"
              data-testid={`tickets-inboxes-reconnect-${props.inbox.id}`}
              onClick={() => void props.onReconnect(props.inbox)}
            >
              {connectionHealth(props.inbox)?.reason === "missing_scopes"
                ? i18n.t("tickets.reAuthorize")
                : i18n.t("tickets.reconnect")}
            </button>
          </Show>
          <button
            type="button"
            class="rounded border border-border px-2 py-1 text-xs"
            data-testid={`tickets-inboxes-configure-${props.inbox.id}`}
            onClick={props.onEdit}
          >
            {i18n.t("tickets.configure")}
          </button>
          <Show when={!props.inbox.archivedAt}>
            <button
              type="button"
              class="text-xs text-red-600"
              data-testid={`tickets-inboxes-disconnect-${props.inbox.id}`}
              onClick={() => void props.onDisconnect(props.inbox.id)}
            >
              {i18n.t("kernel.common.disconnect")}
            </button>
          </Show>
        </div>
      </div>
      <Show when={inboxKind(props.inbox) === "api"}>
        <div
          class="mt-2 flex flex-wrap items-center gap-2 rounded bg-surface-sunken p-2 text-xs"
          data-testid={`tickets-inboxes-api-panel-${props.inbox.id}`}
        >
          <code
            class="flex-1 break-all text-text-secondary"
            data-testid={`tickets-inboxes-ingest-url-${props.inbox.id}`}
          >
            {ingestUrl(props.inbox.id)}
          </code>
          <button
            type="button"
            class="rounded border border-border px-2 py-1"
            data-testid={`tickets-inboxes-copy-ingest-url-${props.inbox.id}`}
            onClick={() => void props.onCopyIngestUrl(props.inbox.id)}
          >
            {props.copied ? i18n.t("tickets.copied") : i18n.t("kernel.common.copy")}
          </button>
          <button
            type="button"
            class="rounded border border-border px-2 py-1"
            data-testid={`tickets-inboxes-generate-key-${props.inbox.id}`}
            onClick={() => void props.onGenerateApiKey(props.inbox.id)}
          >
            {i18n.t("tickets.generateApiKey")}
          </button>
        </div>
      </Show>
      <Show when={props.editing}>
        <div
          class="mt-3 grid gap-2 sm:grid-cols-2"
          data-testid={`tickets-inboxes-config-${props.inbox.id}`}
        >
          <input
            ref={nameInput}
            class="rounded border border-border bg-surface-sunken px-2 py-1.5"
            data-testid={`tickets-inboxes-name-${props.inbox.id}`}
            value={props.inbox.name}
          />
          <input
            ref={teamInput}
            class="rounded border border-border bg-surface-sunken px-2 py-1.5"
            data-testid={`tickets-inboxes-team-${props.inbox.id}`}
            value={props.inbox.defaultTeam ?? ""}
            placeholder={i18n.t("tickets.defaultTeam")}
          />
          <select
            ref={sensitivityInput}
            class="rounded border border-border bg-surface-sunken px-2 py-1.5"
            data-testid={`tickets-inboxes-sensitivity-${props.inbox.id}`}
            value={props.inbox.defaultSensitivity ?? "internal"}
          >
            <option value="internal">{i18n.t("tickets.internal")}</option>
            <option value="restricted">{i18n.t("tickets.restricted")}</option>
            <option value="confidential">{i18n.t("tickets.confidential")}</option>
          </select>
          <input
            ref={fromDisplayNameInput}
            class="rounded border border-border bg-surface-sunken px-2 py-1.5"
            data-testid={`tickets-inboxes-from-name-${props.inbox.id}`}
            value={props.inbox.fromDisplayName ?? ""}
            placeholder={i18n.t("tickets.fromDisplayName")}
          />
          <input
            ref={replyToInput}
            class="rounded border border-border bg-surface-sunken px-2 py-1.5"
            data-testid={`tickets-inboxes-reply-to-${props.inbox.id}`}
            value={replyToEmail(props.inbox) ?? ""}
            placeholder={i18n.t("tickets.replyToBaseAddressEG")}
          />
          <Show when={inboxKind(props.inbox) === "api"}>
            <select
              ref={replyViaInput}
              class="rounded border border-border bg-surface-sunken px-2 py-1.5"
              data-testid={`tickets-inboxes-reply-via-${props.inbox.id}`}
              value={replyViaInboxId(props.inbox) ?? ""}
            >
              <option value="">{i18n.t("tickets.noReplyViaInternalOnly")}</option>
              <For each={props.mailboxInboxes}>
                {(mb) => <option value={mb.id}>{mb.name}</option>}
              </For>
            </select>
            <input
              ref={replyFromInput}
              class="rounded border border-border bg-surface-sunken px-2 py-1.5"
              data-testid={`tickets-inboxes-reply-from-${props.inbox.id}`}
              value={replyFromEmail(props.inbox) ?? ""}
              placeholder={i18n.t("tickets.replyFromEmailOptional")}
            />
          </Show>
          <label class="flex flex-col gap-1 text-sm sm:col-span-2">
            <span>{i18n.t("tickets.signatureHtml")}</span>
            <textarea
              ref={signatureHtmlInput}
              class="min-h-[60px] rounded border border-border bg-surface-sunken px-2 py-1.5"
              data-testid={`tickets-inboxes-signature-html-${props.inbox.id}`}
              value={signatureHtml(props.inbox) ?? ""}
            />
          </label>
          <label class="flex flex-col gap-1 text-sm sm:col-span-2">
            <span>{i18n.t("tickets.signaturePlainText")}</span>
            <textarea
              ref={signatureTextInput}
              class="min-h-[60px] rounded border border-border bg-surface-sunken px-2 py-1.5"
              data-testid={`tickets-inboxes-signature-text-${props.inbox.id}`}
              value={signatureText(props.inbox) ?? ""}
            />
          </label>
          <label class="flex items-center gap-2">
            <input
              ref={ackEnabledInput}
              type="checkbox"
              data-testid={`tickets-inboxes-ack-enabled-${props.inbox.id}`}
              checked={ackEnabled(props.inbox)}
            />
            {i18n.t("tickets.sendAcknowledgementEmailOnNewTicket")}
          </label>
          <input
            ref={slaPromiseInput}
            class="rounded border border-border bg-surface-sunken px-2 py-1.5"
            data-testid={`tickets-inboxes-sla-promise-${props.inbox.id}`}
            value={slaPromisePhrase(props.inbox)}
            placeholder={i18n.t("tickets.within2BusinessDays")}
          />
          <label class="flex flex-col gap-1 text-sm sm:col-span-2">
            <span>{i18n.t("tickets.acknowledgementBodyTextOptional")}</span>
            <textarea
              ref={ackBodyInput}
              class="min-h-[60px] rounded border border-border bg-surface-sunken px-2 py-1.5"
              data-testid={`tickets-inboxes-ack-body-${props.inbox.id}`}
              value={ackBodyText(props.inbox) ?? ""}
              placeholder={i18n.t("tickets.weHaveReceivedYourRequestAnd")}
            />
          </label>
          <label class="flex items-center gap-2">
            <input
              ref={defaultInput}
              type="checkbox"
              data-testid={`tickets-inboxes-default-${props.inbox.id}`}
              checked={props.inbox.isDefaultForCreate}
            />
            {i18n.t("tickets.defaultForNewTickets")}
          </label>
          <label class="flex flex-col gap-1 sm:col-span-2">
            <span class="flex items-center gap-2">
              <input
                ref={suppressAttentionInput}
                type="checkbox"
                data-testid={`tickets-inboxes-suppress-attention-${props.inbox.id}`}
                checked={suppressAttention(props.inbox)}
              />
              {i18n.t("tickets.monitoringInboxKeepOutOfThe")}
            </span>
            <span class="pl-6 text-xs text-text-secondary">
              {i18n.t("tickets.ticketsFromThisInboxRaiseNo")}
            </span>
          </label>
          <label class="flex flex-col gap-1 sm:col-span-2">
            <span class="flex items-center gap-2">
              <input
                ref={slaExemptInput}
                type="checkbox"
                data-testid={`tickets-inboxes-sla-exempt-${props.inbox.id}`}
                checked={slaExempt(props.inbox)}
              />
              {i18n.t("tickets.noSlaExemptThisInboxS")}
            </span>
            <span class="pl-6 text-xs text-text-secondary">
              {i18n.t("tickets.ticketsCreatedInThisInboxGet")}
            </span>
          </label>
          <div
            class="flex flex-col gap-2 sm:col-span-2"
            data-testid={`tickets-inboxes-close-silent-${props.inbox.id}`}
          >
            <label class="flex flex-col gap-1">
              <span class="flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid={`tickets-inboxes-close-silent-enabled-${props.inbox.id}`}
                  checked={closeSilentOn()}
                  onChange={(e) => setCloseSilentOn(e.currentTarget.checked)}
                />
                {i18n.t("tickets.closeSilent.toggle")}
              </span>
              <span class="pl-6 text-xs text-text-secondary">
                {i18n.t("tickets.closeSilent.help")}
              </span>
            </label>
            <Show when={closeSilentOn()}>
              <div class="flex flex-wrap items-center gap-2 pl-6 text-sm">
                <label class="flex items-center gap-2">
                  {i18n.t("tickets.closeSilent.nudgeAfter")}
                  <input
                    ref={closeSilentNudgeDaysInput}
                    type="number"
                    min="1"
                    max={String(CLOSE_SILENT_MAX_DAYS)}
                    class="w-16 rounded border border-border bg-surface-sunken px-2 py-1"
                    data-testid={`tickets-inboxes-close-silent-nudge-days-${props.inbox.id}`}
                    value={nudgeDays()}
                  />
                  {i18n.t("tickets.closeSilent.days")}
                </label>
                <label class="flex items-center gap-2">
                  {i18n.t("tickets.closeSilent.closeAfter")}
                  <input
                    ref={closeSilentCloseDaysInput}
                    type="number"
                    min="1"
                    max={String(CLOSE_SILENT_MAX_DAYS)}
                    class="w-16 rounded border border-border bg-surface-sunken px-2 py-1"
                    data-testid={`tickets-inboxes-close-silent-close-days-${props.inbox.id}`}
                    value={closeDays()}
                  />
                  {i18n.t("tickets.closeSilent.daysAfterNudge")}
                </label>
              </div>
              <label class="flex flex-col gap-1 pl-6 text-sm">
                <span>{i18n.t("tickets.closeSilent.nudgeText")}</span>
                <textarea
                  ref={closeSilentTextInput}
                  class="min-h-[100px] rounded border border-border bg-surface-sunken px-2 py-1.5"
                  data-testid={`tickets-inboxes-close-silent-text-${props.inbox.id}`}
                  value={props.inbox.close_silent_nudge_text ?? ""}
                  placeholder={i18n.t("tickets.closeSilent.defaultNudge", { days: closeDays() })}
                />
                <span class="text-xs text-text-secondary">
                  {i18n.t("tickets.closeSilent.nudgeTextHelp")}
                </span>
              </label>
            </Show>
          </div>
          <Show when={saveError()}>
            <p
              role="alert"
              class="text-xs text-red-400"
              data-testid={`tickets-inboxes-save-error-${props.inbox.id}`}
            >
              {saveError()}
            </p>
          </Show>
          <Show when={savePending()}>
            <p
              class="text-xs text-amber-300"
              data-testid={`tickets-inboxes-save-pending-${props.inbox.id}`}
            >
              {i18n.t("tickets.inboxSaveAwaitingSecondApprover")}
            </p>
          </Show>
          <div class="flex gap-2">
            <button
              type="button"
              class="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
              data-testid={`tickets-inboxes-save-${props.inbox.id}`}
              disabled={saving()}
              onClick={() => void save()}
            >
              {i18n.t("kernel.common.save")}
            </button>
            <button
              type="button"
              class="rounded border border-border px-3 py-1.5 text-sm"
              onClick={props.onCancel}
            >
              {i18n.t("kernel.common.cancel")}
            </button>
          </div>
        </div>
      </Show>
    </section>
  )
}
