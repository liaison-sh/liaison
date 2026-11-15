// SPDX-License-Identifier: FSL-1.1-ALv2
// The dated sheet tab: one project and month, read only. Exports at the top; the lines, their
// total and the coverage line; an aside with who sees it and what it is not. No input, no grid,
// no reminder and no list of who has not entered. A partial sheet asks once before it exports.
import { type Component, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { runTool } from "~/lib/run-tool"
import { getDownloadUrl } from "~/modules/files/file-service"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

export interface TimesheetData {
  projectId: string
  projectName: string
  month: string
  period: { from: string; to: string; label: string }
  lines: Array<{
    entryId: string
    date: string
    person: string
    taskKey: string | null
    task: string
    minutes: number
    hours: string
  }>
  totalMinutes: number
  total: string
  coverage: { withEntries: number; total: number }
  partial: boolean
  coverageLine: string
  note: string
}

/** A draft invoice of the project, as `invoicing:documents_search` lists it. */
export interface AttachDraft {
  id: string
  counterparty_name: string | null
  currency: string
  grand_total_minor: string | number
}

interface ExportResult {
  fileId?: string
  filename?: string
  needsConfirm?: boolean
  coverageLine?: string
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number]
  const d = new Date(Date.UTC(y, m - 1 + by, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

/** The code of a refusal, thrown (`ApiError`) or answered in the result (`{ error: { code } }`). */
function refusalCode(failure: unknown): string | undefined {
  if (failure instanceof ApiError) return failure.code
  const code = (failure as { error?: { code?: unknown } } | undefined)?.error?.code
  return typeof code === "string" ? code : undefined
}

/**
 * Why there is no sheet, in words that say what to do: a project with dated hours off is turned
 * on in its budget panel; a project not using time and budgets has no sheet; anyone else is not
 * its lead or finance.
 */
export function noSheetKey(code: string | undefined): string {
  if (code === "dated_hours_off") return "projects.timesheet.datedOff"
  if (code === "planning_off") return "projects.timesheet.planningOff"
  return "projects.timesheet.noAccess"
}

export const TimesheetView: Component<{ entityId: string }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [month, setMonth] = createSignal<string | undefined>(undefined)
  const [data] = createResource(
    () => ({ projectId: props.entityId, month: month() }),
    (p) =>
      runTool<TimesheetData>(
        api,
        "projects:timesheet_get",
        { projectId: p.projectId, ...(p.month ? { month: p.month } : {}) },
        { suppressGlobalError: true },
      ),
  )
  const [asking, setAsking] = createSignal<"pdf" | "csv" | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [saved, setSaved] = createSignal<string | null>(null)

  // Attach to invoice: pick one of this project's drafts, then the sheet is exported as a PDF and
  // filed on it, both as the person (the attach reads the file under the person's own scopes).
  const [drafts, setDrafts] = createSignal<AttachDraft[] | null>(null)
  const [attachAsk, setAttachAsk] = createSignal<string | null>(null)
  const [attachNote, setAttachNote] = createSignal<string | null>(null)
  const openAttach = async () => {
    const d = data()
    if (!d || busy()) return
    setAttachNote(null)
    try {
      const rows = await runTool<AttachDraft[] | { status?: string }>(
        api,
        "invoicing:documents_search",
        { project_id: d.projectId, type: "invoice", status: "draft" },
        { suppressGlobalError: true },
      )
      setDrafts(Array.isArray(rows) ? rows : [])
    } catch {
      setDrafts([])
    }
  }
  const attachTo = async (documentId: string, acceptPartial = false) => {
    const d = data()
    if (!d || busy()) return
    setBusy(true)
    setAttachNote(null)
    try {
      const out = await runTool<ExportResult>(api, "projects:timesheet_export", {
        projectId: d.projectId,
        month: d.month,
        format: "pdf",
        ...(acceptPartial ? { acceptPartial: true } : {}),
      })
      if (out.needsConfirm) {
        setAttachAsk(documentId)
        return
      }
      setAttachAsk(null)
      if (!out.fileId) return
      const res = await runTool<{ status?: string; error?: { message?: string } }>(
        api,
        "invoicing:document_attachment_add",
        { documentId, fileId: out.fileId, kind: "timesheet", partial: d.partial },
        { suppressGlobalError: true },
      )
      if (res?.status === "error") {
        setAttachNote(
          i18n.t("projects.timesheet.attachFailed", { reason: res.error?.message ?? "" }),
        )
        return
      }
      setDrafts(null)
      setAttachNote(i18n.t("projects.timesheet.attached"))
    } catch (e) {
      setAttachNote(
        i18n.t("projects.timesheet.attachFailed", {
          reason: e instanceof Error ? e.message : "",
        }),
      )
    } finally {
      setBusy(false)
    }
  }

  const exportAs = async (format: "pdf" | "csv", acceptPartial = false) => {
    const d = data()
    if (!d || busy()) return
    setBusy(true)
    setSaved(null)
    try {
      const out = await runTool<ExportResult>(api, "projects:timesheet_export", {
        projectId: d.projectId,
        month: d.month,
        format,
        ...(acceptPartial ? { acceptPartial: true } : {}),
      })
      if (out.needsConfirm) {
        setAsking(format)
        return
      }
      setAsking(null)
      if (out.fileId) {
        setSaved(out.filename ?? "")
        window.open(await getDownloadUrl(api, out.fileId), "_blank", "noopener")
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="h-full overflow-y-auto px-6 py-5 pb-dock-runway" data-testid="timesheet-view">
      <Switch>
        <Match when={data.loading}>
          <p class="text-[13px] text-text-secondary" data-testid="timesheet-view.loading">
            {i18n.t("projects.timesheet.loading")}
          </p>
        </Match>
        <Match when={data.error || !data()?.lines}>
          <p class="text-[13px] text-text-secondary" data-testid="timesheet-view.no-access">
            {i18n.t(noSheetKey(refusalCode(data.error ?? data())))}
          </p>
        </Match>
        <Match when={data()}>
          {(d) => (
            <>
              <div
                class="mb-4 flex flex-wrap items-center gap-2"
                data-testid="timesheet-view.actions"
              >
                <h2 class="mr-auto text-[15px] font-medium text-text">
                  {d().projectName}, {d().period.label}
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="timesheet-view.prev"
                  onClick={() => setMonth(shiftMonth(d().month, -1))}
                >
                  {i18n.t("projects.timesheet.previous")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="timesheet-view.next"
                  onClick={() => setMonth(shiftMonth(d().month, 1))}
                >
                  {i18n.t("projects.timesheet.next")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="timesheet-view.export-pdf"
                  disabled={busy()}
                  onClick={() => void exportAs("pdf")}
                >
                  {i18n.t("projects.timesheet.exportPdf")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="timesheet-view.export-csv"
                  disabled={busy()}
                  onClick={() => void exportAs("csv")}
                >
                  {i18n.t("projects.timesheet.exportCsv")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="timesheet-view.attach"
                  disabled={busy()}
                  onClick={() => void openAttach()}
                >
                  {i18n.t("projects.timesheet.attach")}
                </Button>
              </div>
              <Show when={drafts()}>
                {(list) => (
                  <div
                    class="mb-4 text-[13px] text-text-secondary"
                    data-testid="timesheet-view.attach-list"
                  >
                    <Show
                      when={list().length > 0}
                      fallback={
                        <p data-testid="timesheet-view.attach-none">
                          {i18n.t("projects.timesheet.attachNone")}
                        </p>
                      }
                    >
                      <p class="mb-2">{i18n.t("projects.timesheet.attachPick")}</p>
                      <div class="flex flex-wrap gap-2">
                        <For each={list()}>
                          {(draft) => (
                            <Button
                              variant="outline"
                              size="sm"
                              data-testid="timesheet-view.attach-draft"
                              data-draft-id={draft.id}
                              disabled={busy()}
                              onClick={() => void attachTo(draft.id)}
                            >
                              {i18n.t("projects.timesheet.attachDraft", {
                                customer: draft.counterparty_name ?? "",
                                amount: i18n.fmtCurrency(
                                  Number(draft.grand_total_minor) / 100,
                                  draft.currency,
                                ),
                              })}
                            </Button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={attachAsk()}>
                {(documentId) => (
                  <div
                    class="mb-4 flex items-center gap-3 text-[13px] text-text-secondary"
                    data-testid="timesheet-view.attach-confirm"
                  >
                    <span>{i18n.t("projects.timesheet.partialAsk")}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="timesheet-view.attach-anyway"
                      onClick={() => void attachTo(documentId(), true)}
                    >
                      {i18n.t("projects.timesheet.exportAnyway")}
                    </Button>
                  </div>
                )}
              </Show>
              <Show when={attachNote()}>
                {(n) => (
                  <p
                    class="mb-4 text-[13px] text-text-secondary"
                    data-testid="timesheet-view.attach-note"
                  >
                    {n()}
                  </p>
                )}
              </Show>
              <Show when={asking()}>
                {(format) => (
                  <div
                    class="mb-4 flex items-center gap-3 text-[13px] text-text-secondary"
                    data-testid="timesheet-view.confirm"
                  >
                    <span>{i18n.t("projects.timesheet.partialAsk")}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="timesheet-view.confirm-export"
                      onClick={() => void exportAs(format(), true)}
                    >
                      {i18n.t("projects.timesheet.exportAnyway")}
                    </Button>
                  </div>
                )}
              </Show>
              <Show when={saved() !== null}>
                <p class="mb-4 text-[13px] text-text-secondary" data-testid="timesheet-view.saved">
                  {i18n.t("projects.timesheet.saved")}
                </p>
              </Show>
              <p class="mb-3 text-[13px] text-text-secondary" data-testid="timesheet-view.coverage">
                {d().coverageLine}
              </p>
              <Show
                when={d().lines.length > 0}
                fallback={
                  <p class="text-[13px] text-text-secondary" data-testid="timesheet-view.empty">
                    {i18n.t("projects.timesheet.empty")}
                  </p>
                }
              >
                <table class="w-full text-[13px]" data-testid="timesheet-view.lines">
                  <thead>
                    <tr class="text-left text-text-secondary">
                      <th class="py-1 font-normal">{i18n.t("projects.timesheet.date")}</th>
                      <th class="py-1 font-normal">{i18n.t("projects.timesheet.person")}</th>
                      <th class="py-1 font-normal">{i18n.t("projects.timesheet.task")}</th>
                      <th class="py-1 text-right font-normal">
                        {i18n.t("projects.timesheet.hours")}
                      </th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-border">
                    <For each={d().lines}>
                      {(l) => (
                        <tr data-testid="timesheet-view.line">
                          <td class="py-1.5 text-text-secondary">{l.date}</td>
                          <td class="py-1.5 text-text">{l.person}</td>
                          <td class="py-1.5 text-text">
                            {l.taskKey ? `${l.taskKey} ${l.task}` : l.task}
                          </td>
                          <td class="py-1.5 text-right text-text">{l.hours}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                  <tfoot>
                    <tr data-testid="timesheet-view.total">
                      <td class="pt-2 text-text-secondary" colSpan={3}>
                        {i18n.t("projects.timesheet.total")}
                      </td>
                      <td class="pt-2 text-right font-medium text-text">{d().total}</td>
                    </tr>
                  </tfoot>
                </table>
              </Show>
              <aside
                class="mt-6 space-y-1 text-[12px] text-text-tertiary"
                data-testid="timesheet-view.aside"
              >
                <p>{i18n.t("projects.timesheet.whoSees")}</p>
                <p data-testid="timesheet-view.not">{i18n.t("projects.timesheet.not")}</p>
              </aside>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}
