// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contact's address book, in the contact page. Every address says whether
// a person verified it, when, who, and against what ("Verified 2 Nov 2026 by
// Ada from a purchase order"), or "Not verified". Adding and editing happen in
// the row; editing a location field makes the server clear the verification,
// and the row shows what the server answered. Verifying is an inline form
// (what it was checked against, a note, a file stored on the contact): this
// page is the one browser surface allowed to verify, since app UIs go through
// the host services, which refuse it (framework/person-only-actions.ts).

import { createSignal, For, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import {
  ADDRESS_ROLES,
  ADDRESS_SOURCES,
  ADDRESS_TEXT_FIELDS,
  type AddressDraft,
  type AddressesApi,
  type AddressSource,
  type AddressTextField,
  addAddress,
  addressLine,
  archiveAddress,
  type ContactAddress,
  type ContactFile,
  listAddresses,
  listContactFiles,
  markAddressStale,
  updateAddress,
  verifyAddress,
} from "./contact-addresses-api"

interface State {
  rows: ContactAddress[]
  canEdit: boolean
  loaded: boolean
}

const NEW = "new"

function emptyDraft(): AddressDraft {
  const draft: AddressDraft = {
    role: "delivery",
    label: null,
    name: null,
    company: null,
    street1: null,
    street2: null,
    postalCode: null,
    city: null,
    region: null,
    countryIso2: null,
    phone: null,
    email: null,
  }
  return draft
}

function draftOf(a: ContactAddress): AddressDraft {
  const draft = emptyDraft()
  draft.role = a.role
  for (const f of ADDRESS_TEXT_FIELDS) draft[f] = a[f]
  return draft
}

export function ContactAddresses(props: { contactId: string }) {
  const i18n = useI18n()
  const api: AddressesApi = useApi()
  const [state, setState] = createStore<State>({ rows: [], canEdit: false, loaded: false })
  // Which row is open: its id, NEW for the add form, or null.
  const [editing, setEditing] = createSignal<string | null>(null)
  const [verifying, setVerifying] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  onMount(() => {
    listAddresses(api, props.contactId)
      .then(({ rows, canEdit }) => setState({ rows, canEdit, loaded: true }))
      .catch(() => setState("loaded", true))
  })

  function replace(next: ContactAddress): void {
    setState(
      produce((s) => {
        const at = s.rows.findIndex((r) => r.id === next.id)
        if (next.archivedAt) {
          if (at >= 0) s.rows.splice(at, 1)
        } else if (at >= 0) s.rows[at] = next
        else s.rows.push(next)
      }),
    )
  }

  async function run(action: () => Promise<ContactAddress>, failure: string): Promise<boolean> {
    setError(null)
    try {
      replace(await action())
      return true
    } catch {
      setError(failure)
      return false
    }
  }

  async function save(id: string, draft: AddressDraft): Promise<void> {
    const saved =
      id === NEW
        ? await run(
            () => addAddress(api, props.contactId, draft),
            i18n.t("contacts.addresses.saveFailed"),
          )
        : await run(() => {
            // Send only what changed, so an untouched field never clears a verification.
            const before = state.rows.find((r) => r.id === id)
            const patch: Partial<AddressDraft> = {}
            if (!before || before.role !== draft.role) patch.role = draft.role
            for (const f of ADDRESS_TEXT_FIELDS) {
              if (!before || (before[f] ?? null) !== draft[f]) patch[f] = draft[f]
            }
            return updateAddress(api, props.contactId, id, patch)
          }, i18n.t("contacts.addresses.saveFailed"))
    if (saved) setEditing(null)
  }

  return (
    <section class="mt-12" data-testid="contact-addresses">
      <div class="flex items-baseline justify-between gap-3 border-b border-border-subtle pb-2">
        <h2 class="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-text-tertiary">
          {i18n.t("contacts.addresses.eyebrow")}
        </h2>
        <Show when={state.canEdit && editing() !== NEW}>
          <button
            type="button"
            data-testid="contact-address-add"
            class="text-[11.5px] text-accent hover:text-accent-hover"
            onClick={() => {
              setVerifying(null)
              setEditing(NEW)
            }}
          >
            {i18n.t("contacts.addresses.add")}
          </button>
        </Show>
      </div>
      <Show when={state.loaded && !state.canEdit && state.rows.length > 0}>
        <p data-testid="contact-addresses-read-only" class="mt-2 text-[11.5px] text-text-tertiary">
          {i18n.t("contacts.addresses.readOnly")}
        </p>
      </Show>
      <Show when={error()}>
        {(message) => (
          <p data-testid="contact-addresses-error" class="mt-2 text-[12px] text-error">
            {message()}
          </p>
        )}
      </Show>
      <Show when={editing() === NEW}>
        <AddressForm
          testId="contact-address-new"
          initial={emptyDraft()}
          onCancel={() => setEditing(null)}
          onSave={(draft) => save(NEW, draft)}
        />
      </Show>
      <Show
        when={state.rows.length > 0 || !state.loaded || editing() === NEW}
        fallback={
          <p class="mt-3 text-[12.5px] text-text-tertiary" data-testid="contact-addresses-empty">
            {i18n.t("contacts.addresses.empty")}
          </p>
        }
      >
        <ul class="mt-2 divide-y divide-border-subtle">
          <For each={state.rows}>
            {(row) => (
              <li class="py-3" data-testid={`contact-address-${row.id}`}>
                <Show
                  when={editing() === row.id}
                  fallback={
                    <AddressRow
                      row={row}
                      canEdit={state.canEdit}
                      onEdit={() => {
                        setVerifying(null)
                        setEditing(row.id)
                      }}
                      onVerify={() => {
                        setEditing(null)
                        setVerifying(row.id)
                      }}
                      onStale={() =>
                        void run(
                          () => markAddressStale(api, props.contactId, row.id, !row.staleAt),
                          i18n.t("contacts.addresses.saveFailed"),
                        )
                      }
                      onArchive={() =>
                        void run(
                          () => archiveAddress(api, props.contactId, row.id),
                          i18n.t("contacts.addresses.saveFailed"),
                        )
                      }
                    />
                  }
                >
                  <AddressForm
                    testId={`contact-address-${row.id}`}
                    initial={draftOf(row)}
                    onCancel={() => setEditing(null)}
                    onSave={(draft) => save(row.id, draft)}
                  />
                </Show>
                <Show when={verifying() === row.id && state.canEdit}>
                  <VerifyForm
                    testId={`contact-address-${row.id}-verify`}
                    api={api}
                    contactId={props.contactId}
                    onCancel={() => setVerifying(null)}
                    onSubmit={async (input) => {
                      const ok = await run(
                        () => verifyAddress(api, props.contactId, row.id, input),
                        i18n.t("contacts.addresses.verifyFailed"),
                      )
                      if (ok) setVerifying(null)
                    }}
                  />
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}

function AddressRow(props: {
  row: ContactAddress
  canEdit: boolean
  onEdit: () => void
  onVerify: () => void
  onStale: () => void
  onArchive: () => void
}) {
  const i18n = useI18n()
  const id = () => `contact-address-${props.row.id}`
  const verifiedDate = () =>
    props.row.verifiedAt
      ? new Date(props.row.verifiedAt).toLocaleDateString(i18n.locale(), { dateStyle: "medium" })
      : ""
  const action = "text-[11.5px] text-text-tertiary hover:text-text"
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex flex-wrap items-center gap-2">
        <span
          data-testid={`${id()}-role`}
          class="rounded bg-surface-hover px-1.5 py-0.5 text-[11px] text-text-secondary"
        >
          {i18n.t(`contacts.addresses.role.${props.row.role}`)}
        </span>
        <Show when={props.row.label}>
          <span class="text-[12px] font-medium text-text">{props.row.label}</span>
        </Show>
        <span
          data-testid={`${id()}-badge`}
          data-verified={props.row.verified ? "true" : "false"}
          class={cn(
            "rounded px-1.5 py-0.5 text-[11px]",
            props.row.verified ? "bg-surface-hover text-text-secondary" : "text-text-tertiary",
          )}
        >
          {props.row.verified
            ? i18n.t("contacts.addresses.verified", {
                date: verifiedDate(),
                who: props.row.verifiedByName ?? i18n.t("contacts.addresses.someone"),
                source: i18n.t(`contacts.addresses.source.${props.row.source ?? "other"}`),
              })
            : i18n.t("contacts.addresses.notVerified")}
        </span>
        <Show when={props.row.staleAt}>
          <span data-testid={`${id()}-stale-chip`} class="text-[11px] text-text-tertiary">
            {i18n.t("contacts.addresses.stale")}
          </span>
        </Show>
      </div>
      <p
        data-testid={`${id()}-line`}
        class={cn("text-[13px] text-text", props.row.staleAt && "text-text-tertiary")}
      >
        {addressLine(props.row) || "-"}
      </p>
      <Show when={props.row.phone || props.row.email}>
        <p class="text-[12px] text-text-secondary">
          {[props.row.phone, props.row.email].filter(Boolean).join(" · ")}
        </p>
      </Show>
      <Show when={props.canEdit}>
        <div class="flex flex-wrap items-center gap-3">
          <button type="button" data-testid={`${id()}-edit`} class={action} onClick={props.onEdit}>
            {i18n.t("contacts.addresses.edit")}
          </button>
          <Show when={!props.row.verified}>
            <button
              type="button"
              data-testid={`${id()}-verify`}
              class={action}
              onClick={props.onVerify}
            >
              {i18n.t("contacts.addresses.verify")}
            </button>
          </Show>
          <button
            type="button"
            data-testid={`${id()}-stale`}
            class={action}
            onClick={props.onStale}
          >
            {props.row.staleAt
              ? i18n.t("contacts.addresses.markCurrent")
              : i18n.t("contacts.addresses.markStale")}
          </button>
          <button
            type="button"
            data-testid={`${id()}-archive`}
            class={action}
            onClick={props.onArchive}
          >
            {i18n.t("contacts.addresses.archive")}
          </button>
        </div>
      </Show>
    </div>
  )
}

const INPUT =
  "min-w-0 w-full rounded-sm border border-border bg-bg px-2 py-1 text-[13px] text-text outline-none focus:border-accent-muted"

function AddressForm(props: {
  testId: string
  initial: AddressDraft
  onCancel: () => void
  onSave: (draft: AddressDraft) => Promise<void>
}) {
  const i18n = useI18n()
  const [draft, setDraft] = createStore<AddressDraft>({ ...props.initial })
  const [busy, setBusy] = createSignal(false)
  function setField(field: AddressTextField, value: string): void {
    setDraft(field, value.trim() === "" ? null : value)
  }
  return (
    <form
      data-testid={`${props.testId}-form`}
      class="mt-2 grid grid-cols-1 gap-2 rounded-md border border-border-subtle p-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        const trimmed: AddressDraft = { ...draft }
        for (const f of ADDRESS_TEXT_FIELDS) {
          const v = trimmed[f]
          trimmed[f] = v === null ? null : v.trim() || null
        }
        void props.onSave(trimmed).finally(() => setBusy(false))
      }}
    >
      <label class="flex flex-col gap-1 text-[11.5px] text-text-tertiary">
        {i18n.t("contacts.addresses.field.role")}
        <select
          data-testid={`${props.testId}-field-role`}
          class={INPUT}
          value={draft.role}
          onChange={(event) => {
            const role = ADDRESS_ROLES.find((r) => r === event.currentTarget.value)
            if (role) setDraft("role", role)
          }}
        >
          <For each={ADDRESS_ROLES}>
            {(role) => <option value={role}>{i18n.t(`contacts.addresses.role.${role}`)}</option>}
          </For>
        </select>
      </label>
      <For each={ADDRESS_TEXT_FIELDS}>
        {(field) => (
          <label class="flex flex-col gap-1 text-[11.5px] text-text-tertiary">
            {i18n.t(`contacts.addresses.field.${field}`)}
            <input
              data-testid={`${props.testId}-field-${field}`}
              class={INPUT}
              value={draft[field] ?? ""}
              maxLength={field === "countryIso2" ? 2 : 200}
              onInput={(event) => setField(field, event.currentTarget.value)}
            />
          </label>
        )}
      </For>
      <div class="flex items-center justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" size="sm" onClick={props.onCancel}>
          {i18n.t("contacts.addresses.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          data-testid={`${props.testId}-save`}
          disabled={busy()}
        >
          {i18n.t("contacts.addresses.save")}
        </Button>
      </div>
    </form>
  )
}

function VerifyForm(props: {
  testId: string
  api: AddressesApi
  contactId: string
  onCancel: () => void
  onSubmit: (input: { source: AddressSource; note?: string; fileId?: string }) => Promise<void>
}) {
  const i18n = useI18n()
  const [source, setSource] = createSignal<AddressSource>("purchase_order")
  const [note, setNote] = createSignal("")
  const [fileId, setFileId] = createSignal("")
  const [files, setFiles] = createSignal<ContactFile[]>([])
  const [busy, setBusy] = createSignal(false)
  onMount(() => {
    void listContactFiles(props.api, props.contactId).then(setFiles)
  })
  return (
    <form
      data-testid={`${props.testId}-form`}
      class="mt-2 flex flex-col gap-2 rounded-md border border-border-subtle p-3"
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        const trimmedNote = note().trim()
        void props
          .onSubmit({
            source: source(),
            ...(trimmedNote ? { note: trimmedNote } : {}),
            ...(fileId() ? { fileId: fileId() } : {}),
          })
          .finally(() => setBusy(false))
      }}
    >
      <p class="text-[12px] text-text-secondary">{i18n.t("contacts.addresses.verifyHint")}</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label class="flex flex-col gap-1 text-[11.5px] text-text-tertiary">
          {i18n.t("contacts.addresses.field.source")}
          <select
            data-testid={`${props.testId}-source`}
            class={INPUT}
            value={source()}
            onChange={(event) => {
              const next = ADDRESS_SOURCES.find((s) => s === event.currentTarget.value)
              if (next) setSource(next)
            }}
          >
            <For each={ADDRESS_SOURCES}>
              {(s) => <option value={s}>{i18n.t(`contacts.addresses.sourceOption.${s}`)}</option>}
            </For>
          </select>
        </label>
        <label class="flex flex-col gap-1 text-[11.5px] text-text-tertiary">
          {i18n.t("contacts.addresses.field.file")}
          <select
            data-testid={`${props.testId}-file`}
            class={INPUT}
            value={fileId()}
            onChange={(event) => setFileId(event.currentTarget.value)}
          >
            <option value="">{i18n.t("contacts.addresses.noFile")}</option>
            <For each={files()}>{(f) => <option value={f.id}>{f.filename}</option>}</For>
          </select>
        </label>
      </div>
      <label class="flex flex-col gap-1 text-[11.5px] text-text-tertiary">
        {i18n.t("contacts.addresses.field.note")}
        <textarea
          data-testid={`${props.testId}-note`}
          class={cn(INPUT, "min-h-[56px]")}
          maxLength={1000}
          value={note()}
          onInput={(event) => setNote(event.currentTarget.value)}
        />
      </label>
      <div class="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={props.onCancel}>
          {i18n.t("contacts.addresses.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          data-testid={`${props.testId}-submit`}
          disabled={busy()}
        >
          {i18n.t("contacts.addresses.verifySubmit")}
        </Button>
      </div>
    </form>
  )
}
