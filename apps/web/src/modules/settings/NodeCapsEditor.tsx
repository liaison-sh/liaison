// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN ATTACHED AGENT'S DAILY CAPS (L30, S25): how many sessions, and how many
// tokens, other people's requests may start on your node each day. Your own
// dispatches, app sessions and routines are not capped. Saved with
// PATCH /api/nodes/attachments/:id (the server bounds: 1..1000 sessions,
// 1,000..1,000,000,000 tokens).
//
// P3 adds the live-process cap (D35) inside this file only.

import { type Component, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type NodeAttachmentSummary, updateAttachment } from "~/modules/nodes/node-api"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

export const CAPS_BOUNDS = {
  jobs: { min: 1, max: 1000 },
  tokens: { min: 1000, max: 1_000_000_000 },
} as const

export interface NodeCapsEditorProps {
  attachment: NodeAttachmentSummary
  onSaved: (saved: NodeAttachmentSummary) => void
}

function parseCap(raw: string, bounds: { min: number; max: number }): number | null {
  const n = Number(raw.replace(/[\s,._]/g, ""))
  if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) return null
  return n
}

export const NodeCapsEditor: Component<NodeCapsEditorProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [jobs, setJobs] = createSignal(String(props.attachment.maxJobsPerDay))
  const [tokens, setTokens] = createSignal(String(props.attachment.maxTokensPerDay))
  const [status, setStatus] = createSignal<"idle" | "saving" | "saved" | "error">("idle")

  const parsedJobs = () => parseCap(jobs(), CAPS_BOUNDS.jobs)
  const parsedTokens = () => parseCap(tokens(), CAPS_BOUNDS.tokens)
  const changed = () =>
    parsedJobs() !== props.attachment.maxJobsPerDay ||
    parsedTokens() !== props.attachment.maxTokensPerDay
  const valid = () => parsedJobs() !== null && parsedTokens() !== null

  async function save(): Promise<void> {
    const j = parsedJobs()
    const t = parsedTokens()
    if (j === null || t === null) return
    setStatus("saving")
    try {
      const saved = await updateAttachment(api, props.attachment.id, {
        maxJobsPerDay: j,
        maxTokensPerDay: t,
      })
      props.onSaved(
        saved?.id ? saved : { ...props.attachment, maxJobsPerDay: j, maxTokensPerDay: t },
      )
      setStatus("saved")
    } catch {
      setStatus("error")
    }
  }

  const input =
    "min-h-8 w-28 rounded-sm border border-border bg-bg px-2 text-right text-[13px] tabular-nums text-text"

  return (
    <div
      data-testid={`node-caps-${props.attachment.id}`}
      class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-text-secondary"
    >
      <label class="flex items-center gap-2">
        <span>{i18n.t("kernel.nodeSessions.nodesPage.capsJobs")}</span>
        <input
          type="number"
          inputmode="numeric"
          min={CAPS_BOUNDS.jobs.min}
          max={CAPS_BOUNDS.jobs.max}
          data-testid={`node-caps-jobs-${props.attachment.id}`}
          value={jobs()}
          aria-invalid={parsedJobs() === null}
          onInput={(e) => {
            setJobs(e.currentTarget.value)
            setStatus("idle")
          }}
          class={input}
        />
      </label>
      <label class="flex items-center gap-2">
        <span>{i18n.t("kernel.nodeSessions.nodesPage.capsTokens")}</span>
        <input
          type="number"
          inputmode="numeric"
          min={CAPS_BOUNDS.tokens.min}
          max={CAPS_BOUNDS.tokens.max}
          step={1000}
          data-testid={`node-caps-tokens-${props.attachment.id}`}
          value={tokens()}
          aria-invalid={parsedTokens() === null}
          onInput={(e) => {
            setTokens(e.currentTarget.value)
            setStatus("idle")
          }}
          class={input}
        />
      </label>
      <Button
        variant="outline"
        class="w-auto shrink-0"
        data-testid={`node-caps-save-${props.attachment.id}`}
        disabled={!valid() || !changed() || status() === "saving"}
        loading={status() === "saving"}
        onClick={() => void save()}
      >
        {i18n.t("kernel.nodeSessions.nodesPage.capsSave")}
      </Button>
      <Show when={status() === "saved"}>
        <span data-testid={`node-caps-saved-${props.attachment.id}`} class="text-text-secondary">
          {i18n.t("kernel.computers.agents.saved")}
        </span>
      </Show>
      <Show when={status() === "error"}>
        <span role="alert" class="text-warning">
          {i18n.t("kernel.computers.actionFailed")}
        </span>
      </Show>
    </div>
  )
}
