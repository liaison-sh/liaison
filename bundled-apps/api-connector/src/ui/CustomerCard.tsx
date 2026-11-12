// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who the person on this ticket or mail is in the company's own CRM/ERP, read
// through the connections that fill `customer.lookup`. Calm by design: plain
// text, labels in the secondary tone, no colour for status or value.
//
// States: loading (skeleton), match, several (a compact picker), no match,
// error (short, with retry). A record found by the company domain (not by the
// person's own address) says so: it is the company, never "the sender". Absent entirely when no connection is configured,
// when the viewer lacks the read scope (the route refuses: whether a customer
// exists is itself guarded data), or when there is no email to look up.
//
// Fetching is by signals, not createResource: the card mounts inside screens
// whose tab-wide Suspense boundary a first resource read would blank.
//
// An approved connector write (the agent added this person, or a note to
// their company) re-reads the card in place, so it shows what the write
// created instead of the "no match" it found before.

import type {
  CustomerMatch,
  CustomerResolution,
  CustomerSummaryValue,
  ProjectedObject,
} from "@liaison/api-connector-core/contract"
import { type HostEntityChangeEvent as EntityChangeEvent, onEntityChange } from "@liaison/host"
import { type Component, createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { CUSTOMER_LOOKUP_TIMEOUT_MS, lookupCustomer } from "./api"
import {
  formatValue,
  humanizeKey,
  type RowRole,
  rowParts,
  SUMMARY_RESERVED_KEYS,
  safeHttpUrl,
} from "./customer-format"
import { narrowFrame, Skeleton, useI18n } from "./kit"

export type CustomerCardVariant = "panel" | "header"

/** The gated tool an API connection's writes run through. */
const CONNECTOR_WRITE_TOOL = "api-connector:connector_write"

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null
}

/**
 * Did this event report a connector write, approved and run, that can change
 * what the card shows for `email`? A write that names another person's email
 * cannot; one that names none (a note on a company) may, so it counts.
 */
export function isConnectorWriteFor(ev: EntityChangeEvent, email: string): boolean {
  if (ev.key !== "kernel:approval_request" || ev.action !== "update") return false
  const data = record(ev.data)
  if (data?.status !== "approved" || data.toolName !== CONNECTOR_WRITE_TOOL) return false
  const params = record(record(data.currentPayload)?.params)
  const written = params?.email
  return typeof written !== "string" || written.trim().toLowerCase() === email.toLowerCase()
}

/** A summary value the card prints as text (a name, a link): strings only. */
function textOf(value: CustomerSummaryValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

type CardState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "absent" }
  | { kind: "error" }
  | { kind: "ready"; result: CustomerResolution }

/** Rows a list shows; the count printed is always the rows shown. */
const LIST_LIMIT = 5

const LIST_ROLES: readonly RowRole[] = ["orders", "invoices", "deals"]

/** Whose card: a ticket's or a conversation's participant (the server reads it), or an address. */
export type CustomerSubject =
  | { ticketId: string }
  | { mailConversationId: string }
  | { email: string }

function subjectKey(subject: CustomerSubject | null | undefined): string {
  if (!subject) return ""
  if ("ticketId" in subject) return subject.ticketId ? `t:${subject.ticketId}` : ""
  if ("mailConversationId" in subject) {
    return subject.mailConversationId ? `m:${subject.mailConversationId}` : ""
  }
  return subject.email.trim() ? `e:${subject.email.trim()}` : ""
}

export const CustomerCard: Component<{
  subject: CustomerSubject | null | undefined
  variant: CustomerCardVariant
}> = (props) => {
  const i18n = useI18n()
  // The participant's address, as the server resolved it (named in the card's messages).
  const [email, setEmail] = createSignal<string | null>(null)
  const [state, setState] = createSignal<CardState>({ kind: "idle" })
  const [picked, setPicked] = createSignal(0)
  const [attempt, setAttempt] = createSignal(0)
  // A re-read after a write keeps the card on screen until the answer comes.
  let quiet = false
  // Narrow widths open the header card collapsed; the sidebar card never collapses.
  const [collapsed, setCollapsed] = createSignal(props.variant === "header" && narrowFrame())

  createEffect(
    on([() => subjectKey(props.subject), attempt], ([key]) => {
      const subject = props.subject
      if (!key || !subject) {
        setState({ kind: "idle" })
        return
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), CUSTOMER_LOOKUP_TIMEOUT_MS)
      let live = true
      onCleanup(() => {
        live = false
        clearTimeout(timer)
        controller.abort()
      })
      const keep = quiet && state().kind === "ready"
      quiet = false
      if (!keep) {
        setState({ kind: "loading" })
        setPicked(0)
      }
      lookupCustomer(subject)
        .then((outcome) => {
          if (!live) return
          if (outcome.kind === "result") setEmail(outcome.email)
          if (outcome.kind === "absent" || !outcome.result.configured || !outcome.email) {
            setState({ kind: "absent" })
          } else {
            setState({ kind: "ready", result: outcome.result })
          }
        })
        .catch(() => {
          if (live) setState({ kind: "error" })
        })
        .finally(() => clearTimeout(timer))
    }),
  )

  onEntityChange("kernel:approval_request", (events) => {
    const address = email() ?? ""
    // A resync (reconnect) may have missed such a write: read again too.
    if (!address || !events.some((ev) => ev.resync || isConnectorWriteFor(ev, address))) return
    quiet = true
    setAttempt((n) => n + 1)
  })

  const ready = () => {
    const s = state()
    return s.kind === "ready" ? s.result : null
  }
  const matches = () => ready()?.matches ?? []
  const current = (): CustomerMatch | undefined => matches()[picked()] ?? matches()[0]
  const visible = () => {
    const kind = state().kind
    return kind === "loading" || kind === "error" || kind === "ready"
  }
  const stateId = () => {
    const s = state()
    if (s.kind !== "ready") return s.kind
    if (s.result.matches.length === 0) return "no-match"
    return s.result.matches.length > 1 ? "several" : "match"
  }

  const systemName = (match: CustomerMatch) =>
    match.connectionName ??
    ready()?.connections?.find((c) => c.identifier === match.connection)?.name ??
    match.connection

  const searchedSystems = () => (ready()?.connections ?? []).map((c) => c.name).join(", ")

  const fmt = { fmtDate: i18n.fmtDate, fmtNumber: i18n.fmtNumber, fmtCurrency: i18n.fmtCurrency }

  const summaryFields = (match: CustomerMatch) =>
    Object.entries(match.summary).filter(
      ([key, value]) => !SUMMARY_RESERVED_KEYS.has(key) && value !== "",
    )

  const nameOf = (match: CustomerMatch) => textOf(match.summary.name) ?? ""

  const listRows = (match: CustomerMatch, role: RowRole): ProjectedObject[] =>
    (match[role] ?? []).slice(0, LIST_LIMIT)

  const collapsible = () => props.variant === "header"
  const bodyOpen = () => !collapsible() || !collapsed()

  return (
    <Show when={visible()}>
      <section
        data-testid="customer-card"
        data-state={stateId()}
        aria-busy={stateId() === "loading" ? "true" : undefined}
        data-collapsed={collapsible() && collapsed() ? "true" : "false"}
        aria-label={i18n.t("api-connector.card.title")}
        class={
          props.variant === "header"
            ? "border-b border-border bg-surface px-5 py-2 text-sm"
            : "border-b border-border bg-surface p-3 text-sm"
        }
      >
        <header class="flex items-center gap-2">
          <Show
            when={collapsible()}
            fallback={
              <span class="text-xs font-semibold text-text-secondary">
                {i18n.t("api-connector.card.title")}
              </span>
            }
          >
            <button
              type="button"
              data-testid="customer-card-toggle"
              aria-expanded={!collapsed()}
              class="text-xs font-semibold text-text-secondary hover:text-text"
              onClick={() => setCollapsed((c) => !c)}
            >
              {i18n.t("api-connector.card.title")} {collapsed() ? "▸" : "▾"}
            </button>
          </Show>
          <Show when={current()}>
            {(match) => (
              <>
                <span
                  data-testid="customer-card-name"
                  class="min-w-0 truncate font-medium text-text"
                  title={nameOf(match())}
                >
                  {nameOf(match()) || i18n.t("api-connector.card.unnamed")}
                </span>
                <span
                  data-testid="customer-card-system"
                  class="ml-auto shrink-0 truncate text-xs text-text-tertiary"
                >
                  {systemName(match())}
                </span>
              </>
            )}
          </Show>
        </header>

        <Show when={state().kind === "loading"}>
          <div data-testid="customer-card-state-loading" class="mt-2 flex flex-col gap-1.5">
            <span class="sr-only">{i18n.t("api-connector.card.loading")}</span>
            <Skeleton class="h-4 w-2/3" />
            <Skeleton class="h-3 w-1/2" />
            <Skeleton class="h-3 w-3/5" />
          </div>
        </Show>

        <Show when={state().kind === "error"}>
          <div
            data-testid="customer-card-state-error"
            class="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary"
          >
            <span>{i18n.t("api-connector.card.error")}</span>
            <button
              type="button"
              data-testid="customer-card-retry"
              class="rounded-sm border border-border px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-hover hover:text-text"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {i18n.t("kernel.common.retry2")}
            </button>
          </div>
        </Show>

        <Show when={stateId() === "no-match"}>
          <p data-testid="customer-card-state-no-match" class="mt-2 text-xs text-text-secondary">
            {searchedSystems()
              ? i18n.t("api-connector.card.noMatchIn", {
                  system: searchedSystems(),
                  email: email() ?? "",
                })
              : i18n.t("api-connector.card.noMatch", { email: email() ?? "" })}
          </p>
        </Show>

        <Show when={current()}>
          {(match) => (
            <div data-testid={`customer-card-state-${stateId()}`}>
              <Show when={matches().length > 1}>
                <label class="mt-2 flex items-center gap-2 text-xs text-text-secondary">
                  <span>
                    {i18n.t("api-connector.card.severalMatches", { count: matches().length })}
                  </span>
                  <select
                    data-testid="customer-card-picker"
                    class="min-w-0 flex-1 rounded-sm border border-border bg-bg px-1.5 py-0.5 text-xs text-text"
                    value={String(picked())}
                    onChange={(e) => setPicked(Number(e.currentTarget.value))}
                  >
                    <For each={matches()}>
                      {(m, i) => (
                        <option value={String(i())}>
                          {(nameOf(m) || i18n.t("api-connector.card.unnamed")) +
                            " · " +
                            systemName(m)}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
              </Show>

              <Show when={match().matchedBy === "domain"}>
                <p
                  data-testid="customer-card-matched-by-domain"
                  class="mt-1 text-xs text-text-tertiary"
                >
                  {i18n.t("api-connector.card.matchedByDomain")}
                </p>
              </Show>

              <Show when={bodyOpen()}>
                <div data-testid="customer-card-body" class="mt-2 flex flex-col gap-3">
                  <Show when={summaryFields(match()).length > 0}>
                    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                      <For each={summaryFields(match())}>
                        {([key, value]) => (
                          <div class="contents" data-testid={`customer-card-field-${key}`}>
                            <dt class="text-text-tertiary">{humanizeKey(key)}</dt>
                            <dd class="min-w-0 break-words text-text">
                              {formatValue(key, value, fmt, {
                                siblings: match().summary,
                                currency: match().currency,
                              })}
                            </dd>
                          </div>
                        )}
                      </For>
                    </dl>
                  </Show>

                  <For each={LIST_ROLES.filter((role) => listRows(match(), role).length > 0)}>
                    {(role) => (
                      <div data-testid={`customer-card-list-${role}`}>
                        <div class="flex items-baseline gap-1.5 text-xs font-medium text-text-secondary">
                          <span>{i18n.t(`api-connector.card.list.${role}`)}</span>
                          <span
                            data-testid={`customer-card-count-${role}`}
                            class="text-text-tertiary"
                          >
                            {listRows(match(), role).length}
                          </span>
                        </div>
                        <ul class="mt-1 flex flex-col gap-0.5">
                          <For each={listRows(match(), role)}>
                            {(row) => {
                              const parts = rowParts(row, fmt, role)
                              return (
                                <li
                                  data-testid="customer-card-row"
                                  class="flex items-baseline gap-2 text-xs"
                                >
                                  <span
                                    data-testid="customer-card-row-title"
                                    class="min-w-0 truncate text-text"
                                    title={parts.title}
                                  >
                                    {parts.title}
                                  </span>
                                  <span
                                    data-testid="customer-card-row-date"
                                    class="shrink-0 whitespace-nowrap tabular-nums text-text-tertiary"
                                  >
                                    {parts.date}
                                  </span>
                                  <span class="ml-auto shrink-0 tabular-nums text-text">
                                    {parts.amount}
                                  </span>
                                  <Show when={parts.status}>
                                    <span
                                      data-testid="customer-card-row-status"
                                      class="shrink-0 rounded-sm bg-surface-sunken px-1.5 text-[11px] text-text-secondary"
                                    >
                                      {parts.status}
                                    </span>
                                  </Show>
                                </li>
                              )
                            }}
                          </For>
                        </ul>
                      </div>
                    )}
                  </For>

                  <Show when={safeHttpUrl(textOf(match().summary.url))}>
                    {(href) => (
                      <a
                        data-testid="customer-card-link"
                        href={href()}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="w-fit text-xs text-accent hover:underline"
                      >
                        {i18n.t("api-connector.card.openIn", { system: systemName(match()) })}
                      </a>
                    )}
                  </Show>
                </div>
              </Show>
            </div>
          )}
        </Show>
      </section>
    </Show>
  )
}
