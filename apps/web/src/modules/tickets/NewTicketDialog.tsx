// SPDX-License-Identifier: FSL-1.1-ALv2
// NewTicketDialog — manual ticket creation form.

import type { Component } from "solid-js"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { runTool } from "~/lib/run-tool"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import { loadCategories, ticketCategoryStore } from "~/modules/tickets/ticket-category-store"
import { loadInboxes, ticketInboxStore } from "~/modules/tickets/ticket-inbox-store"
import { loadTickets } from "~/modules/tickets/ticket-list-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

interface Props {
  onClose: () => void
}

export const NewTicketDialog: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [subject, setSubject] = createSignal("")
  const [contactEmail, setContactEmail] = createSignal("")
  const [contactName, setContactName] = createSignal("")
  const [contactId, setContactId] = createSignal("")
  const [body, setBody] = createSignal("")
  let bodyField: HTMLTextAreaElement | undefined
  const bodyFieldDictation = useDictation({ target: () => bodyField })
  const [initialKind, setInitialKind] = createSignal<"note" | "inbound">("note")
  const [priority, setPriority] = createSignal("normal")
  const [sourceInboxId, setSourceInboxId] = createSignal("")
  const [categoryId, setCategoryId] = createSignal("")
  const [assignedTo, setAssignedTo] = createSignal("")
  const [team, setTeam] = createSignal("")
  const [sensitivity, setSensitivity] = createSignal("internal")
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [inboxesLoaded, setInboxesLoaded] = createSignal(false)

  const activeInboxes = createMemo(() => ticketInboxStore.inboxes.filter((i) => !i.archivedAt))
  const activeCategories = createMemo(() =>
    ticketCategoryStore.categories.filter((c) => !c.archivedAt),
  )
  const currentUser = createMemo(() => userFromToken())
  const dimensionGrants = createMemo(() => currentUser()?.dimensionGrants ?? {})
  const teamGrants = createMemo(
    () => dimensionGrants()["tickets:team"] ?? dimensionGrants().team ?? [],
  )
  const sensitivityGrants = createMemo(
    () => dimensionGrants()["tickets:sensitivity"] ?? dimensionGrants().sensitivity ?? [],
  )
  const canEditTeam = createMemo(() => teamGrants().length > 0)
  const canEditSensitivity = createMemo(() => sensitivityGrants().length > 0)

  onMount(() => {
    void loadInboxes(api).then(() => {
      setInboxesLoaded(true)
      const active = activeInboxes()
      setSourceInboxId(active.find((i) => i.isDefaultForCreate)?.id ?? active[0]?.id ?? "")
    })
    void loadCategories(api)
    const user = currentUser()
    if (
      user?.scopes?.some(
        (s) => s === "*" || s === "tickets:tickets:write" || s === "tickets:tickets",
      )
    ) {
      setAssignedTo(user.userId)
    }
  })

  function firstAllowedSensitivity(): string {
    const grants = sensitivityGrants()
    if (grants.includes("*") || grants.includes("restricted")) return "restricted"
    if (grants.includes("confidential")) return "confidential"
    return "internal"
  }

  function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  }

  function canSubmit(): boolean {
    return (
      !!subject().trim() && !!sourceInboxId() && (!!contactId().trim() || !!contactEmail().trim())
    )
  }

  async function submit(): Promise<void> {
    const email = contactEmail().trim()
    const existingContactId = contactId().trim()
    if (!subject().trim()) {
      setError("Subject is required")
      return
    }
    if (!sourceInboxId()) {
      setError("Choose a tickets inbox")
      return
    }
    if (!email && !existingContactId) {
      setError("Enter a contact email or contact id")
      return
    }
    if (existingContactId && !isUuid(existingContactId)) {
      setError("Enter a valid contact id")
      return
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setError("Enter a valid contact email")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const out = await runTool<{ ticketId: string; ticketHandle: string }>(api, "tickets:create", {
        subject: subject().trim(),
        priority: priority(),
        channel: "manual",
        contactId: existingContactId || undefined,
        contactEmail: existingContactId ? undefined : email,
        contactName: existingContactId ? undefined : contactName().trim() || undefined,
        sourceInboxId: sourceInboxId(),
        categoryId: categoryId() || undefined,
        assignedTo: assignedTo() || undefined,
        team: canEditTeam() ? team().trim() || undefined : undefined,
        sensitivity: canEditSensitivity() ? sensitivity() : undefined,
        initialMessage: body().trim()
          ? { kind: initialKind(), textBody: body().trim(), subject: subject().trim() }
          : undefined,
      })
      props.onClose()
      void loadTickets(api)
      // Just created by the user — open as a permanent tab, not an ephemeral preview.
      openTab({
        type: "tickets:ticket",
        entityId: out.ticketId,
        label: out.ticketHandle,
        preview: false,
      })
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Content>
        <div data-testid="tickets-new-dialog">
          <Dialog.Title class="mb-3">{i18n.t("tickets.newTicket")}</Dialog.Title>
          <div class="flex flex-col gap-3">
            <label class="flex flex-col gap-1 text-sm">
              <span>{i18n.t("tickets.subject")}</span>
              <input
                type="text"
                class="rounded border border-border bg-surface-sunken px-2 py-1.5"
                data-testid="tickets-new-subject"
                value={subject()}
                onInput={(e) => setSubject(e.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span>{i18n.t("tickets.contactEmail")}</span>
              <input
                type="email"
                class="rounded border border-border bg-surface-sunken px-2 py-1.5"
                data-testid="tickets-new-contact-email"
                value={contactEmail()}
                onInput={(e) => setContactEmail(e.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span>{i18n.t("tickets.existingContactId")}</span>
              <input
                type="text"
                class="rounded border border-border bg-surface-sunken px-2 py-1.5"
                data-testid="tickets-new-contact-id"
                value={contactId()}
                placeholder={i18n.t("tickets.optionalUuid")}
                onInput={(e) => setContactId(e.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span>{i18n.t("tickets.contactName")}</span>
              <input
                type="text"
                class="rounded border border-border bg-surface-sunken px-2 py-1.5"
                data-testid="tickets-new-contact-name"
                value={contactName()}
                onInput={(e) => setContactName(e.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span>{i18n.t("tickets.inbox")}</span>
              <select
                class="rounded border border-border bg-surface-sunken px-2 py-1.5"
                data-testid="tickets-new-inbox"
                value={sourceInboxId()}
                onChange={(e) => setSourceInboxId(e.currentTarget.value)}
              >
                <option value="">{i18n.t("tickets.chooseInbox")}</option>
                <For each={activeInboxes()}>
                  {(inbox) => <option value={inbox.id}>{inbox.name}</option>}
                </For>
              </select>
            </label>
            <Show when={inboxesLoaded() && activeInboxes().length === 0}>
              <p class="text-sm text-text-secondary" data-testid="tickets-new-no-inbox">
                {i18n.t("tickets.noInboxYet")}{" "}
                <button
                  type="button"
                  class="underline"
                  data-testid="tickets-new-no-inbox-settings"
                  onClick={() => {
                    props.onClose()
                    openTab({
                      type: "kernel:settings",
                      entityId: "settings",
                      label: i18n.t("tickets.inboxSettingsTabLabel"),
                      routePath: "/settings/apps/tickets",
                    })
                  }}
                >
                  {i18n.t("tickets.openInboxSettings")}
                </button>
              </p>
            </Show>
            <label class="flex flex-col gap-1 text-sm">
              <span>{i18n.t("tickets.priority")}</span>
              <select
                class="rounded border border-border bg-surface-sunken px-2 py-1.5"
                data-testid="tickets-new-priority"
                value={priority()}
                onChange={(e) => setPriority(e.currentTarget.value)}
              >
                <option value="low">{i18n.t("tickets.low")}</option>
                <option value="normal">{i18n.t("tickets.normal")}</option>
                <option value="high">{i18n.t("tickets.high")}</option>
                <option value="urgent">{i18n.t("tickets.urgent")}</option>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span>{i18n.t("tickets.category")}</span>
              <select
                class="rounded border border-border bg-surface-sunken px-2 py-1.5"
                data-testid="tickets-new-category"
                value={categoryId()}
                onChange={(e) => setCategoryId(e.currentTarget.value)}
              >
                <option value="">{i18n.t("tickets.noCategory")}</option>
                <For each={activeCategories()}>
                  {(category) => <option value={category.id}>{category.name}</option>}
                </For>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span>{i18n.t("tickets.assignee")}</span>
              <select
                class="rounded border border-border bg-surface-sunken px-2 py-1.5"
                data-testid="tickets-new-assignee"
                value={assignedTo()}
                onChange={(e) => setAssignedTo(e.currentTarget.value)}
              >
                <option value="">{i18n.t("tickets.unassigned")}</option>
                <Show when={currentUser()}>
                  {(user) => (
                    <option value={user().userId}>{user().name || i18n.t("tickets.me")}</option>
                  )}
                </Show>
              </select>
            </label>
            <Show when={canEditTeam()}>
              <label class="flex flex-col gap-1 text-sm">
                <span>{i18n.t("tickets.team")}</span>
                <input
                  type="text"
                  class="rounded border border-border bg-surface-sunken px-2 py-1.5"
                  data-testid="tickets-new-team"
                  value={team()}
                  placeholder={
                    teamGrants().includes("*") ? i18n.t("tickets.anyTeam") : teamGrants().join(", ")
                  }
                  onInput={(e) => setTeam(e.currentTarget.value)}
                />
              </label>
            </Show>
            <Show when={canEditSensitivity()}>
              <label class="flex flex-col gap-1 text-sm">
                <span>{i18n.t("tickets.sensitivity")}</span>
                <select
                  class="rounded border border-border bg-surface-sunken px-2 py-1.5"
                  data-testid="tickets-new-sensitivity"
                  value={sensitivity() || firstAllowedSensitivity()}
                  onChange={(e) => setSensitivity(e.currentTarget.value)}
                >
                  <option value="internal">{i18n.t("tickets.internal")}</option>
                  <Show
                    when={
                      sensitivityGrants().includes("*") ||
                      sensitivityGrants().includes("confidential")
                    }
                  >
                    <option value="confidential">{i18n.t("tickets.confidential")}</option>
                  </Show>
                  <Show
                    when={
                      sensitivityGrants().includes("*") ||
                      sensitivityGrants().includes("restricted")
                    }
                  >
                    <option value="restricted">{i18n.t("tickets.restricted")}</option>
                  </Show>
                </select>
              </label>
            </Show>
            <label class="flex flex-col gap-1 text-sm">
              <span>{i18n.t("tickets.initialContent")}</span>
              <select
                class="rounded border border-border bg-surface-sunken px-2 py-1.5"
                data-testid="tickets-new-initial-kind"
                value={initialKind()}
                onChange={(e) => setInitialKind(e.currentTarget.value as "note" | "inbound")}
              >
                <option value="note">{i18n.t("tickets.internalNote")}</option>
                <option value="inbound">{i18n.t("tickets.initialInbound")}</option>
              </select>
              <textarea
                ref={bodyField}
                class="min-h-[80px] rounded border border-border bg-surface-sunken px-2 py-1.5"
                data-testid="tickets-new-body"
                value={body()}
                onInput={(e) => setBody(e.currentTarget.value)}
              />
            </label>
            {/* The wand stays with the field; the mic sits left of Create, in
                the footer a take turns into the recorder line. */}
            <div class="-mt-1 flex justify-end gap-0.5">
              <ComposerAssist target={() => bodyField} />
            </div>
            {error() && (
              <div class="text-sm text-red-500" data-testid="tickets-new-error">
                {error()}
              </div>
            )}
            <div class="mt-2 flex items-center justify-end gap-2">
              <RecorderRow dictation={bodyFieldDictation}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="tickets-new-cancel"
                  onClick={() => props.onClose()}
                >
                  {i18n.t("kernel.common.cancel")}
                </Button>
                <DictationMic dictation={bodyFieldDictation} />
                <Button
                  type="button"
                  size="sm"
                  data-testid="tickets-new-submit"
                  disabled={submitting() || !canSubmit()}
                  onClick={() => submit()}
                >
                  {submitting() ? i18n.t("kernel.common.creating") : i18n.t("kernel.common.create")}
                </Button>
              </RecorderRow>
            </div>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
