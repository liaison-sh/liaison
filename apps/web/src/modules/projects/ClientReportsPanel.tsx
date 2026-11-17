// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * R-09, a project's client reports: the weekly status report a person reads,
 * edits and sends to the client. It lives in the project (no sidebar row, no
 * tab of its own). The report shows as the client will read it; its sources and
 * what was left out, with why, are for staff only. Nothing is sent without a
 * person: Send asks the server, which parks it for approval or sends it, and
 * says which. A project with no report shows nothing here.
 */
import { type Component, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

export interface ReportSummary {
  reportId: string
  periodEnd: string
  status: string
  sentAt: string | null
}

export interface ReportSection {
  kind: string
  heading: string
  text: string
}

export interface ReportDetail {
  reportId: string
  projectId: string
  periodEnd: string
  status: string
  sections: ReportSection[]
  leftOut: Array<{ what: string; why: string }>
  sources: {
    tasks?: Array<{ title: string; status: string }>
    pullRequests?: Array<{ title: string }>
    threadMessages?: unknown[]
  } | null
  approvedAt: string | null
  sentAt: string | null
  message?: string
}

type Api = ReturnType<typeof useApi>

async function runTool<T>(api: Api, toolName: string, params: Record<string, unknown>): Promise<T> {
  const res = await api.post<unknown>("/apps/run-tool", { toolName, params })
  const body = (
    res && typeof res === "object" && "data" in (res as object)
      ? (res as { data: unknown }).data
      : res
  ) as T & { error?: { message?: string } }
  if (body && typeof body === "object" && "error" in body && body.error) {
    throw new ApiError(body.error.message ?? "failed", 422)
  }
  return body
}

/** A report's state in the words of the screen: waiting (a draft), approved, sent, rejected. */
export function reportState(status: string): "waiting" | "approved" | "sent" | "rejected" {
  if (status === "approved" || status === "sent" || status === "rejected") return status
  if (status === "expired") return "rejected"
  return "waiting"
}

const btn =
  "rounded-md border border-border px-3 py-1.5 text-[12.5px] text-text hover:bg-surface-hover disabled:opacity-60"
const primary =
  "rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-foreground disabled:opacity-60"

const ReportView: Component<{ reportId: string; onChanged: () => void }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [report, { refetch }] = createResource(
    () => props.reportId,
    (reportId) => runTool<ReportDetail>(api, "projects:client_report_get", { reportId }),
  )
  const [editing, setEditing] = createSignal<ReportSection[] | null>(null)
  const [message, setMessage] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  const act = async (fn: () => Promise<string | undefined>) => {
    setBusy(true)
    setMessage(null)
    try {
      setMessage((await fn()) ?? null)
      void refetch()
      props.onChanged()
    } catch (err) {
      setMessage(
        err instanceof ApiError && err.message
          ? err.message
          : i18n.t("projects.clientReports.failed"),
      )
    } finally {
      setBusy(false)
    }
  }

  const save = (r: ReportDetail) =>
    act(async () => {
      const out = await runTool<{ message?: string }>(api, "projects:client_report_save_draft", {
        projectId: r.projectId,
        periodEnd: r.periodEnd,
        sections: editing() ?? r.sections,
        leftOut: r.leftOut,
      })
      setEditing(null)
      return out.message
    })

  const send = (r: ReportDetail) =>
    act(async () => {
      const out = await runTool<{ message?: string }>(api, "projects:client_report_send", {
        reportId: r.reportId,
      })
      return out.message
    })

  return (
    <Show
      when={report()}
      fallback={
        <p class="text-[12.5px] text-text-tertiary">
          {report.error
            ? i18n.t("projects.clientReports.failed")
            : i18n.t("projects.clientReports.loading")}
        </p>
      }
    >
      {(r) => (
        <div data-testid="client-report" class="flex flex-col gap-3">
          {/* Action row at the top. */}
          <div class="flex flex-wrap items-center gap-2">
            <span
              data-testid="client-report.state"
              class="mr-auto text-[12.5px] text-text-secondary"
            >
              {i18n.t(`projects.clientReports.state.${reportState(r().status)}`)}
            </span>
            <Show when={reportState(r().status) === "waiting"}>
              <Show
                when={editing()}
                fallback={
                  <button
                    type="button"
                    data-testid="client-report.edit"
                    class={btn}
                    onClick={() => setEditing(r().sections.map((s) => ({ ...s })))}
                  >
                    {i18n.t("projects.clientReports.edit")}
                  </button>
                }
              >
                <button
                  type="button"
                  data-testid="client-report.save"
                  class={btn}
                  disabled={busy()}
                  onClick={() => save(r())}
                >
                  {i18n.t("projects.clientReports.save")}
                </button>
              </Show>
              <button
                type="button"
                data-testid="client-report.send"
                class={primary}
                disabled={busy() || editing() !== null}
                onClick={() => send(r())}
              >
                {i18n.t("projects.clientReports.send")}
              </button>
            </Show>
          </div>
          <Show when={message()}>
            {(m) => (
              <p data-testid="client-report.message" role="status" class="text-[12.5px] text-text">
                {m()}
              </p>
            )}
          </Show>

          <div class="rounded-md border border-border px-3 py-3">
            <p class="mb-2 text-[11.5px] uppercase tracking-wide text-text-tertiary">
              {i18n.t("projects.clientReports.asRead")}
            </p>
            <For each={editing() ?? r().sections}>
              {(s, i) => (
                <div data-testid={`client-report.section-${s.kind}`} class="mb-3">
                  <p class="text-[13px] font-medium text-text">{s.heading}</p>
                  <Show
                    when={editing()}
                    fallback={<p class="whitespace-pre-line text-[13px] text-text">{s.text}</p>}
                  >
                    <SectionTextField
                      index={i()}
                      value={s.text}
                      onInput={(text) => {
                        const next = [...(editing() ?? [])]
                        const cur = next[i()]
                        if (cur) next[i()] = { ...cur, text }
                        setEditing(next)
                      }}
                    />
                  </Show>
                </div>
              )}
            </For>
          </div>

          <div data-testid="client-report.staff-only" class="flex flex-col gap-2">
            <p class="text-[11.5px] uppercase tracking-wide text-text-tertiary">
              {i18n.t("projects.clientReports.staffOnly")}
            </p>
            <Show when={r().leftOut.length > 0}>
              <div data-testid="client-report.left-out">
                <p class="text-[12.5px] font-medium text-text-secondary">
                  {i18n.t("projects.clientReports.leftOut")}
                </p>
                <ul>
                  <For each={r().leftOut}>
                    {(l) => (
                      <li class="text-[12.5px] text-text">
                        {l.what} <span class="text-text-secondary">· {l.why}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>
            <div data-testid="client-report.sources" class="text-[12.5px] text-text-secondary">
              {i18n.t("projects.clientReports.sources", {
                tasks: String(r().sources?.tasks?.length ?? 0),
                prs: String(r().sources?.pullRequests?.length ?? 0),
                messages: String(r().sources?.threadMessages?.length ?? 0),
              })}
            </div>
          </div>
        </div>
      )}
    </Show>
  )
}

export const ClientReportsPanel: Component<{ projectId: string }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const [selected, setSelected] = createSignal<string | null>(null)
  const [list, { refetch }] = createResource(
    () => props.projectId,
    async (projectId) => {
      try {
        const out = await runTool<{ reports?: ReportSummary[] }>(
          api,
          "projects:client_reports_list",
          {
            projectId,
          },
        )
        return Array.isArray(out?.reports) ? out.reports : []
      } catch {
        return []
      }
    },
  )
  const reports = () => list() ?? []
  const waiting = () => reports().filter((r) => reportState(r.status) === "waiting").length

  return (
    <Show when={reports().length > 0}>
      <section data-testid="client-reports" class="flex shrink-0 flex-col gap-2 px-6 pb-3">
        <button
          type="button"
          data-testid="client-reports.toggle"
          class="flex items-center gap-2 text-left text-[12.5px] text-text-secondary hover:text-text"
          aria-expanded={open()}
          onClick={() => setOpen(!open())}
        >
          <span class="font-medium text-text">{i18n.t("projects.clientReports.title")}</span>
          <Show when={waiting() > 0}>
            <span>{i18n.t("projects.clientReports.waitingCount", { n: String(waiting()) })}</span>
          </Show>
        </button>
        <Show when={open()}>
          <div class="flex flex-col gap-3 rounded-md border border-border px-3 py-3">
            <ul class="flex flex-wrap gap-1">
              <For each={reports()}>
                {(r) => (
                  <li>
                    <button
                      type="button"
                      data-testid={`client-reports.item-${r.reportId}`}
                      class={selected() === r.reportId ? primary : btn}
                      onClick={() => setSelected(r.reportId)}
                    >
                      {r.periodEnd} ·{" "}
                      {i18n.t(`projects.clientReports.state.${reportState(r.status)}`)}
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <Switch>
              <Match when={selected()}>
                {(id) => <ReportView reportId={id()} onChanged={() => void refetch()} />}
              </Match>
            </Switch>
          </div>
        </Show>
      </section>
    </Show>
  )
}

/** One section's text while the draft is edited, with the writing helpers beside it. */
const SectionTextField: Component<{
  index: number
  value: string
  onInput: (text: string) => void
}> = (props) => {
  let field: HTMLTextAreaElement | undefined
  const dictation = useDictation({ target: () => field })
  return (
    <>
      <textarea
        ref={field}
        data-testid={`client-report.section-text-${props.index}`}
        rows={4}
        class="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-text"
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
      <div class="mt-1 flex items-center justify-end gap-0.5">
        <ComposerAssist target={() => field} />
        <RecorderRow dictation={dictation}>
          <DictationMic dictation={dictation} />
        </RecorderRow>
      </div>
    </>
  )
}
