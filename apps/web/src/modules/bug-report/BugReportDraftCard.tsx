// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A bug report an agent prepared for the Liaison team (`kernel:report_bug` on a
// server that sends bug reports only to the Liaison team). Drawn under the
// tool call, and listed in Report a bug for a report asked from another app.
// It shows exactly what the Liaison team receives; only the reporter's click on
// Send queues it, and only the reporter can read it (the server answers 404 to
// anyone else). Not an approval: nobody else decides.

import { type Component, createResource, createSignal, For, type JSX, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

/** What `GET /bug-reports/drafts/:id` answers. */
export interface BugReportDraft {
  draftId: string
  data: unknown
  digest: string
  createdAt: string
  sentMessageId: string | null
}

/** The parts of a prepared report the card writes out as text; anything else falls back to the raw payload. */
interface ReadableReport {
  description: string
  page: string
  userAgent: string
  reporterEmail: string
  logs: string[]
  logsTruncated: boolean
  serverErrors: Array<{ signature: string; count1h: number | null }>
  attachments: Array<{ filename: string; mimeType: string; sizeBytes: number | null }>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const textOf = (v: unknown): string => (typeof v === "string" ? v : "")
const numberOf = (v: unknown): number | null => (typeof v === "number" ? v : null)

/** Null when the payload does not have the shape of a prepared report. */
export function readableReport(data: unknown): ReadableReport | null {
  if (!isRecord(data) || !isRecord(data.report)) return null
  const report = data.report
  const description = textOf(report.description)
  if (description === "") return null
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  return {
    description,
    page: textOf(report.page),
    userAgent: textOf(report.userAgent),
    reporterEmail: isRecord(data.reporter) ? textOf(data.reporter.email) : "",
    logs: list(report.logs).map(textOf),
    logsTruncated: report.logsTruncated === true,
    serverErrors: list(report.serverErrors)
      .filter(isRecord)
      .map((e) => ({ signature: textOf(e.signature), count1h: numberOf(e.count1h) })),
    attachments: list(report.attachments)
      .filter(isRecord)
      .map((a) => ({
        filename: textOf(a.filename),
        mimeType: textOf(a.mimeType),
        sizeBytes: numberOf(a.sizeBytes),
      })),
  }
}

const FIELD = "mt-2 text-[11px] font-medium uppercase tracking-wide text-text-tertiary"
const TEXT = "mt-0.5 whitespace-pre-wrap break-words text-[12px] text-text"

const ERROR_KEYS: Record<string, string> = {
  FORWARD_RATE_LIMITED: "kernel.bugReport.draftRateLimited",
  DRAFT_ALREADY_SENT: "kernel.bugReport.draftGone",
  DRAFT_NOT_FOUND: "kernel.bugReport.draftGone",
  FORWARDING_UNAVAILABLE: "kernel.bugReport.teamOnlyUnavailable",
}

function ReportField(props: { testid: string; label: string; value: string }): JSX.Element {
  return (
    <Show when={props.value !== ""}>
      <p class={FIELD}>{props.label}</p>
      <p data-testid={props.testid} class={TEXT}>
        {props.value}
      </p>
    </Show>
  )
}

export const BugReportDraftCard: Component<{ draftId: string }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [draft, { mutate }] = createResource(
    () => props.draftId,
    async (id) => {
      try {
        return await api.get<BugReportDraft>(`/bug-reports/drafts/${encodeURIComponent(id)}`)
      } catch {
        return null
      }
    },
  )
  const [sending, setSending] = createSignal(false)
  const [sentRef, setSentRef] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [discarded, setDiscarded] = createSignal(false)

  async function discard(d: BugReportDraft): Promise<void> {
    if (sending()) return
    setSending(true)
    setError(null)
    try {
      await api.delete(`/bug-reports/drafts/${encodeURIComponent(d.draftId)}`)
      setDiscarded(true)
    } catch (err) {
      // 404: the report already expired or was dropped, so it is gone either way.
      if (err instanceof ApiError && err.status === 404) setDiscarded(true)
      else setError(i18n.t("kernel.bugReport.draftDiscardFailed"))
    } finally {
      setSending(false)
    }
  }

  async function send(d: BugReportDraft): Promise<void> {
    if (sending()) return
    setSending(true)
    setError(null)
    try {
      const res = await api.post<{ forwarded: string; messageId: string }>(
        `/bug-reports/drafts/${encodeURIComponent(d.draftId)}/send`,
        { digest: d.digest },
      )
      setSentRef(res.messageId)
    } catch (err) {
      if (err instanceof ApiError && err.code === "FORWARD_PAYLOAD_CHANGED") {
        const next = err.details as BugReportDraft | undefined
        if (next?.digest) mutate(next)
        setError(i18n.t("kernel.bugReport.forwardChanged"))
      } else {
        const key = err instanceof ApiError && err.code ? ERROR_KEYS[err.code] : undefined
        setError(i18n.t(key ?? "kernel.bugReport.draftFailed"))
      }
    } finally {
      setSending(false)
    }
  }

  const reference = () => sentRef() ?? draft()?.sentMessageId ?? null

  return (
    <Show when={!draft.loading && !discarded()}>
      <div
        class="my-2 rounded-lg border border-border bg-elevated p-3 text-[13px]"
        data-testid="bug-report-draft-card"
      >
        <Show
          when={draft()}
          fallback={
            <p class="text-xs text-text-tertiary" data-testid="bug-report-draft-gone">
              {i18n.t("kernel.bugReport.draftGone")}
            </p>
          }
        >
          {(d) => (
            <Show
              when={!reference()}
              fallback={
                <p class="text-xs text-text-secondary" data-testid="bug-report-draft-sent">
                  {i18n.t("kernel.bugReport.draftSent", { reference: reference() ?? "" })}
                </p>
              }
            >
              <p class="font-medium text-text">{i18n.t("kernel.bugReport.draftTitle")}</p>
              <p class="mt-1 text-xs text-text-secondary">{i18n.t("kernel.bugReport.draftHelp")}</p>
              {/* Everything the Liaison team receives, in full: no capped or scrolling box, so nothing
                  the person is about to send can sit below a fold. The page scrolls. */}
              <Show
                when={readableReport(d().data)}
                fallback={
                  <pre
                    data-testid="bug-report-draft-payload"
                    class="mt-2 whitespace-pre-wrap break-all rounded border border-border bg-surface-sunken p-2 text-[11px] text-text"
                  >
                    {JSON.stringify(d().data, null, 2)}
                  </pre>
                }
              >
                {(r) => (
                  <div
                    data-testid="bug-report-draft-payload"
                    class="mt-2 rounded border border-border bg-surface-sunken p-2"
                  >
                    <p class={FIELD}>{i18n.t("kernel.bugReport.draftFieldReport")}</p>
                    <p data-testid="bug-report-draft-description" class={TEXT}>
                      {r().description}
                    </p>
                    <ReportField
                      testid="bug-report-draft-page"
                      label={i18n.t("kernel.bugReport.draftFieldPage")}
                      value={r().page}
                    />
                    <ReportField
                      testid="bug-report-draft-user-agent"
                      label={i18n.t("kernel.bugReport.draftFieldSentFrom")}
                      value={r().userAgent}
                    />
                    <ReportField
                      testid="bug-report-draft-reporter"
                      label={i18n.t("kernel.bugReport.draftFieldReporter")}
                      value={r().reporterEmail}
                    />
                    <Show when={r().attachments.length > 0}>
                      <p class={FIELD}>{i18n.t("kernel.bugReport.draftFieldAttachments")}</p>
                      <ul data-testid="bug-report-draft-attachments" class={TEXT}>
                        <For each={r().attachments}>
                          {(a) => (
                            <li>
                              {a.filename} ({a.mimeType}
                              {a.sizeBytes === null ? "" : `, ${a.sizeBytes} B`})
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                    <Show when={r().serverErrors.length > 0}>
                      <p class={FIELD}>{i18n.t("kernel.bugReport.draftFieldServerErrors")}</p>
                      <ul data-testid="bug-report-draft-server-errors" class={TEXT}>
                        <For each={r().serverErrors}>
                          {(e) => (
                            <li>
                              {e.signature}
                              {e.count1h === null ? "" : ` (x${e.count1h})`}
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                    <Show when={r().logs.length > 0}>
                      <p class={FIELD}>
                        {i18n.t("kernel.bugReport.draftFieldLogs")}
                        {r().logsTruncated
                          ? ` (${i18n.t("kernel.bugReport.draftLogsTruncated")})`
                          : ""}
                      </p>
                      <ul
                        data-testid="bug-report-draft-logs"
                        class={`${TEXT} font-mono text-[11px]`}
                      >
                        <For each={r().logs}>{(line) => <li>{line}</li>}</For>
                      </ul>
                    </Show>
                  </div>
                )}
              </Show>
              <p class="mt-1 text-xs text-text-tertiary">
                {i18n.t("kernel.bugReport.forwardEnvelopeNote")}
              </p>
              <Show when={error()}>
                {(e) => (
                  <p class="mt-1 text-xs text-text-secondary" data-testid="bug-report-draft-error">
                    {e()}
                  </p>
                )}
              </Show>
              <div class="mt-2 flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="bug-report-draft-discard"
                  disabled={sending()}
                  onClick={() => discard(d())}
                >
                  {i18n.t("kernel.bugReport.draftDiscard")}
                </Button>
                <Button
                  size="sm"
                  data-testid="bug-report-draft-send"
                  loading={sending()}
                  onClick={() => send(d())}
                >
                  {i18n.t("kernel.bugReport.draftSend")}
                </Button>
              </div>
            </Show>
          )}
        </Show>
      </div>
    </Show>
  )
}
