// SPDX-License-Identifier: FSL-1.1-ALv2
// TicketNudgeDialog — gated tool dialog (nudge).

import type { Component } from "solid-js"
import { createSignal } from "solid-js"
import { runTool } from "~/lib/run-tool"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

interface Props {
  ticketId: string
  onClose: () => void
}

export const TicketNudgeDialog: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [body, setBody] = createSignal(i18n.t("tickets.nudgeDefaultMessage"))
  let bodyField: HTMLTextAreaElement | undefined
  const bodyFieldDictation = useDictation({ target: () => bodyField })
  const [submitting, setSubmitting] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  async function submit(): Promise<void> {
    setSubmitting(true)
    setError(null)
    try {
      const result = (await runTool(api, "tickets:nudge", {
        ticketId: props.ticketId,
        textBody: body(),
      })) as { blocked?: unknown } | undefined
      if (result?.blocked) setPending(true)
      else props.onClose()
    } catch (err: any) {
      setError(String(err?.message ?? err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="tickets-nudge-dialog"
    >
      <div class="w-full max-w-md rounded bg-surface p-4 shadow-xl">
        <h2 class="mb-3 text-lg font-semibold">{i18n.t("tickets.nudgeCustomer")}</h2>
        <label class="flex flex-col gap-1 text-sm">
          <span>{i18n.t("tickets.message")}</span>
          <textarea
            ref={bodyField}
            class="min-h-[100px] rounded border border-border bg-surface-sunken px-2 py-1.5"
            data-testid="tickets-nudge-body"
            value={body()}
            onInput={(e) => setBody(e.currentTarget.value)}
          />
        </label>
        {/* The wand stays with the field; the mic sits left of the primary
            action, in the footer a take turns into the recorder line. */}
        <div class="mt-1 flex justify-end gap-0.5">
          <ComposerAssist target={() => bodyField} />
        </div>
        {pending() && (
          <div class="mt-2 text-sm text-amber-700" data-testid="tickets-nudge-pending">
            {i18n.t("tickets.submittedForApproval")}
          </div>
        )}
        {error() && (
          <div class="mt-2 text-sm text-red-500" data-testid="tickets-nudge-error">
            {error()}
          </div>
        )}
        <div class="mt-3 flex items-center justify-end gap-2">
          <RecorderRow dictation={bodyFieldDictation}>
            <button
              type="button"
              class="rounded border border-border px-3 py-1.5 text-sm"
              data-testid="tickets-nudge-cancel"
              onClick={() => props.onClose()}
            >
              {i18n.t("kernel.common.cancel")}
            </button>
            <DictationMic dictation={bodyFieldDictation} />
            <button
              type="button"
              class="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
              data-testid="tickets-nudge-submit"
              disabled={submitting()}
              onClick={() => submit()}
            >
              {submitting() ? i18n.t("kernel.common.sending") : i18n.t("tickets.sendNudge")}
            </button>
          </RecorderRow>
        </div>
      </div>
    </div>
  )
}
