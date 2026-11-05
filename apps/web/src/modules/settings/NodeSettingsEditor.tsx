// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A COMPUTER'S NAME AND LIVE-SESSION CAPS (walk D23; D35, G8): rename it and
// set how many session processes may run on it at once, and how many of those
// may come from other people's requests and routines. Saved with
// PATCH /api/nodes/:id (the server bounds: 1..16 live, 0..live background).

import { type Component, createSignal, type JSX, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type NodeSummary, updateNode } from "~/modules/nodes/node-api"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

export const LIVE_CAP_BOUNDS = { min: 1, max: 16 } as const
/** The server's defaults (D35), when a node row does not carry its caps. */
const DEFAULT_LIVE = 4
const DEFAULT_BACKGROUND = 2

export interface NodeSettingsEditorProps {
  node: NodeSummary
  onSaved: () => void
}

function parseInt0(raw: string): number | null {
  const n = Number(raw.trim())
  return raw.trim() !== "" && Number.isInteger(n) ? n : null
}

export const NodeSettingsEditor: Component<NodeSettingsEditorProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [name, setName] = createSignal(props.node.name)
  const [live, setLive] = createSignal(String(props.node.maxLiveSessions ?? DEFAULT_LIVE))
  const [background, setBackground] = createSignal(
    String(props.node.maxLiveBackground ?? DEFAULT_BACKGROUND),
  )
  const [status, setStatus] = createSignal<"idle" | "saving" | "saved" | "error">("idle")

  const parsedLive = () => {
    const n = parseInt0(live())
    return n !== null && n >= LIVE_CAP_BOUNDS.min && n <= LIVE_CAP_BOUNDS.max ? n : null
  }
  const parsedBackground = () => {
    const n = parseInt0(background())
    const max = parsedLive()
    return n !== null && max !== null && n >= 0 && n <= max ? n : null
  }
  const trimmedName = () => name().trim()
  const valid = () =>
    trimmedName().length > 0 &&
    trimmedName().length <= 80 &&
    parsedLive() !== null &&
    parsedBackground() !== null

  async function save(): Promise<void> {
    const maxLiveSessions = parsedLive()
    const maxLiveBackground = parsedBackground()
    if (!valid() || maxLiveSessions === null || maxLiveBackground === null) return
    setStatus("saving")
    try {
      await updateNode(api, props.node.id, {
        name: trimmedName(),
        maxLiveSessions,
        maxLiveBackground,
      })
      setStatus("saved")
      props.onSaved()
    } catch {
      setStatus("error")
    }
  }

  const input =
    "min-h-11 rounded-sm border border-border bg-bg px-3 text-[14px] text-text tabular-nums sm:min-h-9 sm:text-[13px]"

  const field = (f: { id: string; label: string; hint: string; control: JSX.Element }) => (
    <div class="flex flex-col gap-1.5 sm:grid sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-center sm:gap-x-4">
      <label for={f.id} class="text-[13px] text-text">
        {f.label}
      </label>
      <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
        {f.control}
        <span class="basis-full text-[12px] text-text-tertiary sm:basis-auto">{f.hint}</span>
      </span>
    </div>
  )

  return (
    <div data-testid={`node-settings-${props.node.id}`} class="flex flex-col gap-4">
      {field({
        id: `node-name-input-${props.node.id}`,
        label: i18n.t("kernel.computers.settings.name"),
        hint: i18n.t("kernel.computers.settings.nameHint"),
        control: (
          <input
            type="text"
            id={`node-name-input-${props.node.id}`}
            data-testid={`node-name-input-${props.node.id}`}
            maxLength={80}
            value={name()}
            onInput={(e) => {
              setName(e.currentTarget.value)
              setStatus("idle")
            }}
            class={`${input} w-full sm:w-56`}
          />
        ),
      })}
      {field({
        id: `node-max-live-${props.node.id}`,
        label: i18n.t("kernel.computers.settings.maxLive"),
        hint: i18n.t("kernel.computers.settings.maxLiveHint"),
        control: (
          <input
            type="number"
            inputmode="numeric"
            id={`node-max-live-${props.node.id}`}
            data-testid={`node-max-live-${props.node.id}`}
            min={LIVE_CAP_BOUNDS.min}
            max={LIVE_CAP_BOUNDS.max}
            value={live()}
            onInput={(e) => {
              setLive(e.currentTarget.value)
              setStatus("idle")
            }}
            class={`${input} w-24 text-right`}
          />
        ),
      })}
      {field({
        id: `node-max-background-${props.node.id}`,
        label: i18n.t("kernel.computers.settings.maxBackground"),
        hint: i18n.t("kernel.computers.settings.maxBackgroundHint"),
        control: (
          <input
            type="number"
            inputmode="numeric"
            id={`node-max-background-${props.node.id}`}
            data-testid={`node-max-background-${props.node.id}`}
            min={0}
            max={parsedLive() ?? LIVE_CAP_BOUNDS.max}
            value={background()}
            onInput={(e) => {
              setBackground(e.currentTarget.value)
              setStatus("idle")
            }}
            class={`${input} w-24 text-right`}
          />
        ),
      })}
      <Show when={!valid()}>
        <p
          data-testid={`node-settings-invalid-${props.node.id}`}
          class="text-[12.5px] text-warning"
        >
          {i18n.t("kernel.computers.settings.invalid")}
        </p>
      </Show>
      <div class="flex items-center gap-3 text-[12.5px] text-text-secondary">
        <Button
          variant="outline"
          class="min-h-11 w-auto shrink-0 sm:min-h-0"
          data-testid={`node-save-${props.node.id}`}
          disabled={!valid() || status() === "saving"}
          onClick={() => void save()}
        >
          {i18n.t("kernel.computers.settings.save")}
        </Button>
        <Show when={status() === "saved"}>
          <span>{i18n.t("kernel.computers.settings.saved")}</span>
        </Show>
        <Show when={status() === "error"}>
          <span class="text-warning">{i18n.t("kernel.computers.actionFailed")}</span>
        </Show>
      </div>
    </div>
  )
}
