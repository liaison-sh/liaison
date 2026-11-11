// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DASHBOARD'S TIME RANGE, in its toolbar: one button that reads the range
// as days ("1–11 Nov 2026 · vs 1–11 Nov 2025") and opens a menu of periods
// (presets, then a custom range in a small dialog) and of what to compare them
// with. Picking calls `onChange`; the page remembers it and puts it in the URL.
import { CalendarRange, Check } from "lucide-solid"
import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { PopupMenu } from "~/ui/PopupMenu"
import {
  COMPARE_MODES,
  type CompareMode,
  isValidTimeRange,
  type RangeChoice,
  TIME_PRESETS,
  type TimePreset,
} from "./time-range"

export const PRESET_KEYS: Record<TimePreset, string> = {
  last7d: "kernel.dashboards.presetLast7d",
  last30d: "kernel.dashboards.presetLast30d",
  last90d: "kernel.dashboards.presetLast90d",
  mtd: "kernel.dashboards.presetMtd",
  lastMonth: "kernel.dashboards.presetLastMonth",
  qtd: "kernel.dashboards.presetQtd",
  lastQuarter: "kernel.dashboards.presetLastQuarter",
  ytd: "kernel.dashboards.presetYtd",
  lastYear: "kernel.dashboards.presetLastYear",
  custom: "kernel.dashboards.presetCustom",
}

export const COMPARE_KEYS: Record<CompareMode, string> = {
  lastYear: "kernel.dashboards.compareLastYear",
  previousPeriod: "kernel.dashboards.comparePrevious",
  none: "kernel.dashboards.compareNone",
}

export interface TimeRangePickerProps {
  choice: RangeChoice
  /** The range as it reads ("1–11 Nov 2026 · vs 1–11 Nov 2025"). */
  label: string
  /** The days a custom range starts from when opened (the window shown now). */
  window: { from: string; to: string }
  /** The person has a remembered choice: offer to go back to the dashboard's default. */
  saved: boolean
  onChange: (choice: RangeChoice) => void
  onReset: () => void
}

export const TimeRangePicker: Component<TimeRangePickerProps> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const [customOpen, setCustomOpen] = createSignal(false)
  const [from, setFrom] = createSignal("")
  const [to, setTo] = createSignal("")
  const customValid = () => isValidTimeRange({ preset: "custom", from: from(), to: to() })

  const pickPreset = (preset: TimePreset) => {
    if (preset === "custom") {
      setFrom(props.window.from)
      setTo(props.window.to)
      setCustomOpen(true)
      return
    }
    props.onChange({ timeRange: { preset }, compare: props.choice.compare })
  }

  return (
    <>
      <PopupMenu open={open()} onOpenChange={setOpen}>
        <PopupMenu.Trigger
          data-testid="dashboard-range-trigger"
          aria-label={i18n.t("kernel.dashboards.rangeAria", { range: props.label })}
          title={props.label}
          class="flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border px-2.5 text-[12.5px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
        >
          <CalendarRange size={13} class="shrink-0" aria-hidden="true" />
          <span data-testid="dashboard-range-label" class="truncate tabular-nums">
            {props.label}
          </span>
        </PopupMenu.Trigger>
        <PopupMenu.Content data-testid="dashboard-range-menu" class="min-w-[14rem]">
          <PopupMenu.Group>
            <PopupMenu.Label>{i18n.t("kernel.dashboards.rangePeriod")}</PopupMenu.Label>
            <For each={TIME_PRESETS}>
              {(preset) => (
                <PopupMenu.Item
                  data-testid={`dashboard-range-preset-${preset}`}
                  onSelect={() => pickPreset(preset)}
                >
                  <Check
                    size={13}
                    aria-hidden="true"
                    class={props.choice.timeRange.preset === preset ? "" : "invisible"}
                  />
                  {i18n.t(PRESET_KEYS[preset])}
                </PopupMenu.Item>
              )}
            </For>
          </PopupMenu.Group>
          <PopupMenu.Separator />
          <PopupMenu.Group>
            <PopupMenu.Label>{i18n.t("kernel.dashboards.rangeCompare")}</PopupMenu.Label>
            <For each={COMPARE_MODES}>
              {(mode) => (
                <PopupMenu.Item
                  data-testid={`dashboard-range-compare-${mode}`}
                  onSelect={() =>
                    props.onChange({ timeRange: props.choice.timeRange, compare: mode })
                  }
                >
                  <Check
                    size={13}
                    aria-hidden="true"
                    class={props.choice.compare === mode ? "" : "invisible"}
                  />
                  {i18n.t(COMPARE_KEYS[mode])}
                </PopupMenu.Item>
              )}
            </For>
          </PopupMenu.Group>
          <Show when={props.saved}>
            <PopupMenu.Separator />
            <PopupMenu.Item data-testid="dashboard-range-reset" onSelect={() => props.onReset()}>
              {i18n.t("kernel.dashboards.rangeReset")}
            </PopupMenu.Item>
          </Show>
        </PopupMenu.Content>
      </PopupMenu>
      <Dialog open={customOpen()} onOpenChange={setCustomOpen}>
        <Dialog.Content class="max-w-sm">
          <Dialog.Title>{i18n.t("kernel.dashboards.customTitle")}</Dialog.Title>
          <form
            data-testid="dashboard-range-custom"
            class="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (!customValid()) return
              setCustomOpen(false)
              props.onChange({
                timeRange: { preset: "custom", from: from(), to: to() },
                compare: props.choice.compare,
              })
            }}
          >
            <div class="grid grid-cols-2 gap-3">
              <label class="flex flex-col gap-1 text-[12px] text-text-secondary">
                {i18n.t("kernel.dashboards.customFrom")}
                <input
                  type="date"
                  data-testid="dashboard-range-from"
                  required
                  value={from()}
                  max={to() || undefined}
                  onInput={(e) => setFrom(e.currentTarget.value)}
                  class="rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-text"
                />
              </label>
              <label class="flex flex-col gap-1 text-[12px] text-text-secondary">
                {i18n.t("kernel.dashboards.customTo")}
                <input
                  type="date"
                  data-testid="dashboard-range-to"
                  required
                  value={to()}
                  min={from() || undefined}
                  onInput={(e) => setTo(e.currentTarget.value)}
                  class="rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-text"
                />
              </label>
            </div>
            <Show when={from() && to() && !customValid()}>
              <p data-testid="dashboard-range-invalid" class="text-[12px] text-text-tertiary">
                {i18n.t("kernel.dashboards.customInvalid")}
              </p>
            </Show>
            <div class="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="dashboard-range-cancel"
                onClick={() => setCustomOpen(false)}
              >
                {i18n.t("kernel.dashboards.customCancel")}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                data-testid="dashboard-range-apply"
                disabled={!customValid()}
              >
                {i18n.t("kernel.dashboards.customApply")}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog>
    </>
  )
}

export default TimeRangePicker
