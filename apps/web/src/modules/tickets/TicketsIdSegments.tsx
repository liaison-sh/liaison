// SPDX-License-Identifier: FSL-1.1-ALv2
// The Tickets settings page's ID prefixes block (custom block
// `TicketsIdSegments`, declared in the tickets manifest `settings`):
// settings.tickets.idSegment.
//
// The org picks ONE field whose value segments its ticket ids, and a short
// code per value: `ticket-B2B-123`. The number never changes; the code follows
// the ticket's current value (display-handle.ts server-side). It reads and
// saves through the `idSegment.get` / `idSegment.set` tools as the viewer: the
// set re-indexes every ticket's display id and may wait for an approval.

import {
  formatTicketHandle,
  readTicketIdSegment,
  TICKET_ID_SEGMENT_FIELDS,
  type TicketIdSegmentBy,
  ticketIdSegmentSchema,
} from "@liaison/shared"
import type { Component } from "solid-js"
import { createEffect, createResource, createSignal, For, on, Show } from "solid-js"
import { runTool } from "~/lib/run-tool"
import { useI18n } from "~/modules/i18n/i18n-context"
import { callAppTool } from "~/modules/settings/app-page/settings-api"
import { useApi } from "~/modules/shell/ApiContext"

interface SegmentValue {
  /** The key the code is stored under: audience value, team name, category or inbox id. */
  key: string
  label: string
}

const PREVIEW_NUMBER = 123

export const TicketsIdSegments: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [stored] = createResource(async () => {
    const out = await callAppTool<{ idSegment?: unknown }>(api, "tickets", "idSegment.get")
    if (out.kind !== "ok") throw new Error(out.kind === "error" ? out.message : "pending")
    return readTicketIdSegment(out.data?.idSegment)
  })
  const [by, setBy] = createSignal<TicketIdSegmentBy>("none")
  const [codes, setCodes] = createSignal<Record<string, string>>({})
  const [values, setValues] = createSignal<SegmentValue[]>([])
  const [saving, setSaving] = createSignal(false)
  const [saved, setSaved] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  createEffect(
    on(stored, (cfg) => {
      if (!cfg) return
      setBy(cfg.by)
      setCodes(cfg.codes)
    }),
  )

  // The values a code can be set for: the fixed audiences, else what the org
  // actually uses (teams on tickets, categories, inboxes).
  async function loadValues(field: TicketIdSegmentBy): Promise<SegmentValue[]> {
    switch (field) {
      case "audience":
        return [
          { key: "b2b", label: "B2B" },
          { key: "b2c", label: "B2C" },
        ]
      case "team": {
        const list = await runTool<Array<{ team: string }>>(api, "tickets:teams.list", {})
        return (Array.isArray(list) ? list : []).map((t) => ({ key: t.team, label: t.team }))
      }
      case "category": {
        const list = await runTool<Array<{ id: string; name: string }>>(
          api,
          "tickets:categories.list",
          {},
        )
        return (Array.isArray(list) ? list : []).map((c) => ({ key: c.id, label: c.name }))
      }
      case "inbox": {
        const list = await runTool<Array<{ id: string; name: string }>>(
          api,
          "tickets:inboxes.list",
          {},
        )
        return (Array.isArray(list) ? list : []).map((b) => ({ key: b.id, label: b.name }))
      }
      default:
        return []
    }
  }

  createEffect(
    on(by, (field) => {
      setValues([])
      void loadValues(field)
        .then((v) => {
          if (by() === field) setValues(v)
        })
        .catch((err: unknown) => setError(String((err as Error)?.message ?? err)))
    }),
  )

  function changeField(next: TicketIdSegmentBy): void {
    // Codes are keyed by the field's values: another field's keys mean nothing.
    setBy(next)
    setCodes({})
    setSaved(false)
    setPending(false)
    setError(null)
  }

  function changeCode(key: string, raw: string): void {
    const code = raw.trim().toUpperCase()
    setCodes((prev) => {
      const next = { ...prev }
      if (code) next[key] = code
      else delete next[key]
      return next
    })
    setSaved(false)
  }

  /** `ticket-B2B-123` from the first shown value that has a code. */
  const preview = (): string => {
    if (by() === "none") return formatTicketHandle(PREVIEW_NUMBER)
    const first = values().find((v) => codes()[v.key])
    return formatTicketHandle(PREVIEW_NUMBER, first ? codes()[first.key] : null)
  }

  async function save(): Promise<void> {
    setError(null)
    setSaved(false)
    setPending(false)
    const parsed = ticketIdSegmentSchema.safeParse({ by: by(), codes: codes() })
    if (!parsed.success) {
      setError(i18n.t("tickets.idSegment.invalid"))
      return
    }
    setSaving(true)
    const out = await callAppTool(api, "tickets", "idSegment.set", parsed.data)
    setSaving(false)
    if (out.kind === "error") setError(out.message)
    else if (out.kind === "pending") setPending(true)
    else setSaved(true)
  }

  return (
    // The form appears once the stored setting is read, so a choice made
    // before it arrives is never overwritten by it.
    <Show when={stored()}>
      <div class="@container max-w-2xl" data-testid="tickets-id-segment-settings">
        <p class="mb-3 text-sm text-text-secondary">{i18n.t("tickets.idSegment.hint")}</p>
        <label class="mb-3 flex flex-col gap-1 text-sm">
          <span>{i18n.t("tickets.idSegment.by")}</span>
          <select
            class="min-w-0 rounded border border-border bg-surface-sunken px-2 py-1.5"
            data-testid="tickets-id-segment-by"
            value={by()}
            onChange={(e) => changeField(e.currentTarget.value as TicketIdSegmentBy)}
          >
            <For each={[...TICKET_ID_SEGMENT_FIELDS]}>
              {(field) => (
                <option value={field} selected={by() === field}>
                  {i18n.t(`tickets.idSegment.field.${field}`)}
                </option>
              )}
            </For>
          </select>
        </label>

        <Show when={by() !== "none"}>
          <Show
            when={values().length > 0}
            fallback={
              <p class="mb-3 text-sm text-text-tertiary">{i18n.t("tickets.idSegment.noValues")}</p>
            }
          >
            <div class="mb-3 grid gap-2 @xs:grid-cols-2">
              <For each={values()}>
                {(v) => (
                  <label class="flex min-w-0 items-center gap-2 text-sm">
                    <span class="min-w-0 flex-1 truncate" title={v.label}>
                      {v.label}
                    </span>
                    <input
                      type="text"
                      maxLength={8}
                      class="w-24 rounded border border-border bg-surface-sunken px-2 py-1 font-mono uppercase"
                      data-testid={`tickets-id-segment-code-${v.key}`}
                      placeholder={i18n.t("tickets.idSegment.codePlaceholder")}
                      value={codes()[v.key] ?? ""}
                      onInput={(e) => {
                        changeCode(v.key, e.currentTarget.value)
                        e.currentTarget.value = codes()[v.key] ?? ""
                      }}
                    />
                  </label>
                )}
              </For>
            </div>
          </Show>
        </Show>

        <p class="mb-3 text-sm">
          <span class="text-text-secondary">{i18n.t("tickets.idSegment.preview")} </span>
          <span class="font-mono" data-testid="tickets-id-segment-preview">
            {preview()}
          </span>
        </p>

        <Show when={error()}>
          <p class="mb-2 text-sm text-red-500" data-testid="tickets-id-segment-error">
            {error()}
          </p>
        </Show>
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
            data-testid="tickets-id-segment-save"
            disabled={saving()}
            onClick={() => save()}
          >
            {saving() ? i18n.t("kernel.common.saving") : i18n.t("kernel.common.save")}
          </button>
          <Show when={saved()}>
            <span class="text-sm text-text-secondary" data-testid="tickets-id-segment-saved">
              {i18n.t("tickets.idSegment.saved")}
            </span>
          </Show>
          <Show when={pending()}>
            <span class="text-sm text-text-secondary" data-testid="tickets-id-segment-pending">
              {i18n.t("kernel.settingsPage.waitingApproval")}
            </span>
          </Show>
        </div>
      </div>
    </Show>
  )
}
