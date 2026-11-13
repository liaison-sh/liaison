// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two bar forms drawn in HTML rather than on the canvas, because their labels are people and
// their counts read in a legend:
//   - the PIPELINE (map.stackedSingle): one bar, one segment per category, sized by its value and
//     coloured by its data (a status's colour); the legend under it names each category with its
//     count. Counts are never drawn inside segments.
//   - PEOPLE ROWS (a horizontal bar with map.personField): one row per person, their avatar disc
//     and name, the row's total, and a thin track split by the series (a status each).
// A click on a segment (or its legend entry) picks it, like a bar of the canvas chart.
import { type Component, For, Show } from "solid-js"
import { Avatar } from "~/ui/AvatarStack"
import { avatarColors } from "~/ui/avatar-palette"
import type { SeriesData, ValueFormat } from "../dashboards-client"
import { CHART_PALETTE_SIZE } from "./Chart"
import { markColor, useColourScope } from "./data-colour"
import { formatValue } from "./format"

export interface BarRowsProps {
  data: SeriesData
  format?: ValueFormat
  currency?: string
  locale: string
  /** Accessible name of the drawing (the block's title). */
  label?: string
  onPick?: (index: number, datasetIndex: number) => void
  /** "Show rows for {label}". */
  pickLabel: (label: string) => string
}

/** A palette slot as CSS (the theme's token, so both themes hold). */
export function paletteColor(i: number): string {
  return `var(--color-chart-${(i % CHART_PALETTE_SIZE) + 1})`
}

const num = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? v : 0)

/** The form a series block takes in HTML, or null when the canvas chart draws it. */
export function barRowsForm(d: SeriesData): "pipeline" | "people" | null {
  if (d.kind !== "bar" || d.layers) return null
  if (d.display?.stackedSingle) return "pipeline"
  if (d.display?.horizontal && d.paint?.people?.some((p) => p)) return "people"
  return null
}

export const PipelineBar: Component<BarRowsProps> = (props) => {
  const values = () => props.data.series[0]?.values ?? []
  const total = () => values().reduce<number>((t, v) => t + num(v), 0)
  const scope = useColourScope()
  const name = (i: number) => String(props.data.x[i] ?? "")
  // A category's own colour, readable on the surface; else its value's palette slot.
  const colorAt = (i: number) => {
    const own = props.data.paint?.labels?.[i]
    return own ? markColor(own) : scope(name(i))
  }
  const fmt = (v: number | null | undefined) =>
    formatValue(v ?? 0, { format: props.format, currency: props.currency, locale: props.locale })
  const pick = (i: number) => props.onPick?.(i, 0)
  return (
    <div data-testid="dashboard-pipeline" class="flex flex-col gap-3.5 pt-1">
      <div
        role="img"
        aria-label={props.label}
        class="flex h-10 gap-[2px] overflow-hidden rounded-lg bg-surface-sunken"
      >
        <For each={props.data.x}>
          {(_, i) => (
            <Show when={num(values()[i()]) > 0}>
              <button
                type="button"
                data-testid={`dashboard-pipeline-segment-${i()}`}
                title={`${name(i())}: ${fmt(values()[i()])}`}
                aria-label={props.pickLabel(name(i()))}
                disabled={!props.onPick}
                class="h-full min-w-[3px] transition-opacity hover:opacity-85 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-default"
                style={{ flex: `${num(values()[i()])} 1 0%`, background: colorAt(i()) }}
                onClick={() => pick(i())}
              />
            </Show>
          )}
        </For>
        <Show when={total() === 0}>
          <span class="h-full flex-1" />
        </Show>
      </div>
      <ul class="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-3 gap-y-2">
        <For each={props.data.x}>
          {(_, i) => (
            <li>
              <button
                type="button"
                data-testid={`dashboard-pipeline-legend-${i()}`}
                aria-label={props.pickLabel(name(i()))}
                disabled={!props.onPick}
                class="inline-flex max-w-full items-center gap-1.5 rounded px-0.5 text-left text-[13px] text-text-primary hover:bg-surface-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:cursor-default disabled:hover:bg-transparent"
                onClick={() => pick(i())}
              >
                <span
                  aria-hidden="true"
                  class="h-[7px] w-[7px] shrink-0 rounded-full"
                  style={{ background: colorAt(i()) }}
                />
                <span class="truncate">{name(i())}</span>
                <b class="font-semibold tabular-nums">{fmt(values()[i()])}</b>
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}

export const PeopleRows: Component<BarRowsProps> = (props) => {
  const series = () => props.data.series
  const rowTotal = (i: number) => series().reduce<number>((t, s) => t + num(s.values[i]), 0)
  const max = () => Math.max(1, ...props.data.x.map((_, i) => rowTotal(i)))
  const person = (i: number) => props.data.paint?.people?.[i] ?? null
  const name = (i: number) => String(props.data.x[i] ?? "")
  const scope = useColourScope()
  // A split by series: each series its colour (else its name's palette slot); one series: the
  // person's own avatar colour.
  const colorOf = (i: number, j: number) => {
    if (series().length > 1) {
      const own = props.data.paint?.series?.[j]
      return own ? markColor(own) : scope(series()[j]?.name ?? "")
    }
    const own = props.data.paint?.labels?.[i]
    if (own) return markColor(own)
    const p = person(i)
    return p ? avatarColors(p).bg : paletteColor(0)
  }
  const fmt = (v: number) =>
    formatValue(v, { format: props.format, currency: props.currency, locale: props.locale })
  return (
    <div data-testid="dashboard-people-rows" class="flex flex-col gap-3 pt-1">
      <ul aria-label={props.label} class="flex flex-col gap-3">
        <For each={props.data.x}>
          {(_, i) => (
            <li data-testid={`dashboard-people-row-${i()}`} class="flex items-center gap-3">
              <Show
                when={person(i())}
                fallback={
                  <span
                    aria-hidden="true"
                    class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-active text-[11px] font-semibold text-text-secondary"
                  >
                    ?
                  </span>
                }
              >
                {(id) => (
                  <Avatar user={{ id: id(), name: name(i()), avatarUrl: null }} pixelSize={28} />
                )}
              </Show>
              <div class="flex min-w-0 flex-1 flex-col gap-[5px]">
                <div class="flex items-baseline justify-between gap-2 text-[13px]">
                  <span
                    class={`truncate ${person(i()) ? "text-text-primary" : "text-text-secondary"}`}
                  >
                    {name(i())}
                  </span>
                  <span class="font-semibold tabular-nums">{fmt(rowTotal(i()))}</span>
                </div>
                <div class="flex h-2 gap-[2px] overflow-hidden rounded bg-surface-sunken">
                  <For each={series()}>
                    {(s, j) => (
                      <Show when={num(s.values[i()]) > 0}>
                        <button
                          type="button"
                          data-testid={`dashboard-people-segment-${i()}-${j()}`}
                          title={`${series().length > 1 ? `${s.name}: ` : ""}${fmt(num(s.values[i()]))}`}
                          aria-label={props.pickLabel(
                            series().length > 1 ? `${name(i())} · ${s.name}` : name(i()),
                          )}
                          disabled={!props.onPick}
                          class="h-full transition-opacity hover:opacity-85 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent disabled:cursor-default"
                          style={{
                            width: `${(num(s.values[i()]) / max()) * 100}%`,
                            background: colorOf(i(), j()),
                          }}
                          onClick={() => props.onPick?.(i(), j())}
                        />
                      </Show>
                    )}
                  </For>
                </div>
              </div>
            </li>
          )}
        </For>
      </ul>
      <Show when={series().length > 1}>
        <ul class="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-text-secondary">
          <For each={series()}>
            {(s, j) => (
              <li class="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  class="h-[7px] w-[7px] rounded-full"
                  style={{ background: colorOf(0, j()) }}
                />
                {s.name}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
