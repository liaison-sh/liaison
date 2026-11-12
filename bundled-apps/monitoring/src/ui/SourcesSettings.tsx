// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MonitoringSources: the "Sources" block of the declarative settings page
// (manifest `settings`). Lists every seen and profiled source in display order:
// reorder, label, urgent toggle, identity hue (automatic or picked), each row
// previewing its square. Saves the whole order as the `monitoringSources`
// config value through the kernel's app-config write path
// (`PUT /api/apps/monitoring/config/monitoringSources`, `kernel:apps:admin`),
// then tells every monitoring surface to refetch. The "Detailed monitoring"
// link is a plain field of the same page. Errors stay on screen.
import { hueGlyphColor } from "@liaison/app-ui/hue"
import { app, fetch as hostFetch } from "@liaison/host"
import {
  type Component,
  createEffect,
  createResource,
  createSignal,
  For,
  Index,
  Show,
} from "solid-js"
import type { IncidentsSummaryWithConfig } from "../lib/summarize"
import { tr } from "./i18n"
import { Button, cx, inputClass } from "./kit"
import { announceConfigChanged, SourceSquare } from "./source-glyph"
import {
  type DraftRow,
  draftFromSummary,
  monogram,
  moveRow,
  profilesFromDraft,
  SOURCES_KEY,
  type SourceView,
  sourceHue,
} from "./sources"

async function putConfig(key: string, value: unknown): Promise<void> {
  await hostFetch(`/api/apps/monitoring/config/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  })
}

function previewView(row: DraftRow): SourceView {
  const label = row.label.trim() || row.source
  return {
    source: row.source,
    label,
    monogram: monogram(label),
    urgent: row.urgent,
    hue: sourceHue(row.source, row.hue === null ? null : { source: row.source, hue: row.hue }),
    profiled: true,
    live: 0,
    worstSeverity: null,
    lastSeenAt: null,
    tone: "quiet",
  }
}

const ArrowButton: Component<{
  dir: "up" | "down"
  disabled: boolean
  onClick: () => void
  testid: string
}> = (props) => (
  <button
    type="button"
    data-testid={props.testid}
    disabled={props.disabled}
    onClick={props.onClick}
    aria-label={props.dir === "up" ? tr("Move up") : tr("Move down")}
    title={props.dir === "up" ? tr("Move up") : tr("Move down")}
    class="grid h-5 w-5 place-items-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
  >
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={props.dir === "up" ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
    </svg>
  </button>
)

async function loadSummary(): Promise<IncidentsSummaryWithConfig | null> {
  try {
    const res = await app.invokeTool<{ data: IncidentsSummaryWithConfig }>("incidents_summary", {})
    return res?.data ?? null
  } catch {
    return null
  }
}

export const MonitoringSources: Component = () => {
  const [summary, { refetch }] = createResource(loadSummary)
  const [rows, setRows] = createSignal<DraftRow[]>([])
  const [dirty, setDirty] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [saved, setSaved] = createSignal(false)

  // A fresh read replaces the rows unless the admin is editing them.
  createEffect(() => {
    const s = summary()
    if (s && !dirty()) setRows(draftFromSummary(s))
  })

  const edit = (next: (list: DraftRow[]) => DraftRow[]) => {
    setRows(next)
    setDirty(true)
    setSaved(false)
  }
  const patch = (i: number, change: Partial<DraftRow>) =>
    edit((list) => list.map((r, j) => (j === i ? { ...r, ...change } : r)))

  const discard = () => {
    setDirty(false)
    setError(null)
    const s = summary()
    if (s) setRows(draftFromSummary(s))
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await putConfig(SOURCES_KEY, profilesFromDraft(rows()))
      announceConfigChanged()
      setDirty(false)
      setSaved(true)
      void refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="monitoring-sources-settings" class="flex flex-col gap-3">
      <Show when={summary.error || (summary() === null && !summary.loading)}>
        <p class="text-[12px] text-text-tertiary">
          {tr("The sources could not be read. Try again later.")}
        </p>
      </Show>
      <Show when={(summary()?.warnings.length ?? 0) > 0}>
        <div
          data-testid="monitoring-sources-settings-warnings"
          class="rounded-lg border border-warning-border bg-warning-glow px-3 py-2 text-[11.5px] text-warning"
        >
          <p class="font-medium">{tr("Some saved entries were ignored:")}</p>
          <ul class="mt-1 list-disc pl-4 font-mono">
            <For each={summary()?.warnings ?? []}>{(w) => <li>{w}</li>}</For>
          </ul>
        </div>
      </Show>

      <Show
        when={rows().length > 0}
        fallback={
          <Show when={summary()}>
            <p class="py-2 text-[12px] text-text-tertiary">
              {tr(
                "No alert source has reported yet. Sources appear the first time they deliver an alert to the webhook.",
              )}
            </p>
          </Show>
        }
      >
        <ul class="flex flex-col gap-1.5">
          <Index each={rows()}>
            {(row, i) => (
              <li
                data-testid={`monitoring-sources-settings-row-${row().source}`}
                class="flex items-center gap-2.5 rounded-lg border border-border-subtle bg-surface px-2.5 py-2"
              >
                <div class="flex flex-col">
                  <ArrowButton
                    dir="up"
                    testid={`monitoring-sources-settings-up-${row().source}`}
                    disabled={busy() || i === 0}
                    onClick={() => edit((list) => moveRow(list, i, -1))}
                  />
                  <ArrowButton
                    dir="down"
                    testid={`monitoring-sources-settings-down-${row().source}`}
                    disabled={busy() || i === rows().length - 1}
                    onClick={() => edit((list) => moveRow(list, i, 1))}
                  />
                </div>
                <SourceSquare source={previewView(row())} size="md" />
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                  <input
                    class={cx(inputClass, "py-1")}
                    value={row().label}
                    placeholder={row().source}
                    aria-label={tr("Label")}
                    data-testid={`monitoring-sources-settings-label-${row().source}`}
                    onInput={(e) => patch(i, { label: e.currentTarget.value })}
                  />
                  <span class="truncate font-mono text-[10.5px] text-text-tertiary">
                    {row().source}
                  </span>
                </div>
                <div class="flex w-28 shrink-0 flex-col gap-1">
                  <Show
                    when={!row().urgent}
                    fallback={
                      <span class="text-[10.5px] text-text-tertiary">
                        {tr("Urgent sources use red")}
                      </span>
                    }
                  >
                    <input
                      type="range"
                      min="0"
                      max="359"
                      step="1"
                      value={row().hue ?? sourceHue(row().source)}
                      aria-label={tr("Colour")}
                      data-testid={`monitoring-sources-settings-hue-${row().source}`}
                      class="h-1.5 w-full cursor-pointer appearance-none rounded-full"
                      style={{
                        background:
                          "linear-gradient(90deg, hsl(0 48% 52%), hsl(60 48% 52%), hsl(120 48% 52%), hsl(180 48% 52%), hsl(240 48% 52%), hsl(300 48% 52%), hsl(359 48% 52%))",
                        "accent-color": hueGlyphColor(row().hue ?? sourceHue(row().source)),
                      }}
                      onInput={(e) => patch(i, { hue: Number(e.currentTarget.value) })}
                    />
                    <button
                      type="button"
                      disabled={row().hue === null}
                      onClick={() => patch(i, { hue: null })}
                      data-testid={`monitoring-sources-settings-hue-auto-${row().source}`}
                      class="self-start text-[10.5px] text-text-tertiary hover:text-text disabled:cursor-default disabled:hover:text-text-tertiary"
                    >
                      {row().hue === null ? tr("Automatic colour") : tr("Use automatic colour")}
                    </button>
                  </Show>
                </div>
                <label class="flex shrink-0 items-center gap-1.5 text-[11.5px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={row().urgent}
                    data-testid={`monitoring-sources-settings-urgent-${row().source}`}
                    onChange={(e) => patch(i, { urgent: e.currentTarget.checked })}
                  />
                  {tr("Urgent")}
                </label>
              </li>
            )}
          </Index>
        </ul>
      </Show>

      <Show when={error()}>
        <div
          data-testid="monitoring-sources-settings-error"
          class="rounded-lg border border-error-border bg-error-glow px-3 py-2 text-[12px] text-error"
        >
          {error()}
        </div>
      </Show>

      <Show when={dirty() || saved()}>
        <div class="flex items-center justify-end gap-2">
          <Show when={saved() && !dirty()}>
            <span
              class="text-[12px] text-text-secondary"
              data-testid="monitoring-sources-settings-saved"
            >
              {tr("Saved")}
            </span>
          </Show>
          <Show when={dirty()}>
            <Button
              variant="ghost"
              onClick={discard}
              disabled={busy()}
              testid="monitoring-sources-settings-cancel"
            >
              {tr("Discard")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={busy()}
              testid="monitoring-sources-settings-save"
            >
              {busy() ? tr("Saving…") : tr("Save")}
            </Button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
