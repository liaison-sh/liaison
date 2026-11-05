// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings → Organization → Export organization: one button that queues a
// whole-org export (`POST /api/org/export`), the line saying what the archive
// holds and that it expires in 7 days, and the list of exports with their
// state. A download asks the server for a fresh 5-minute link each time, and
// only a completed, unexpired export offers one. While an export is queued or
// running the button is disabled and the list refreshes itself.
import { type Component, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { formatBytes } from "~/modules/files/file-icons"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

type ExportStatus = "queued" | "running" | "completed" | "failed" | "expired"

interface OrgExportItem {
  id: string
  status: ExportStatus
  requestedBy: string | null
  requestedByName: string | null
  requestedVia: "settings" | "cli"
  bytes: number | null
  error: string | null
  createdAt: string
  completedAt: string | null
  expiresAt: string | null
}

const POLL_MS = 5000

/** The state a person sees: a completed export past its expiry is expired already. */
function shownStatus(e: OrgExportItem, now: number): ExportStatus {
  if (e.status === "completed" && e.expiresAt && Date.parse(e.expiresAt) <= now) return "expired"
  return e.status
}

const STATUS_KEY: Record<ExportStatus, string> = {
  queued: "kernel.orgExport.statusQueued",
  running: "kernel.orgExport.statusRunning",
  completed: "kernel.orgExport.statusCompleted",
  failed: "kernel.orgExport.statusFailed",
  expired: "kernel.orgExport.statusExpired",
}

const OrgExportSection: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [starting, setStarting] = createSignal(false)
  const [problem, setProblem] = createSignal<string | null>(null)

  const [exports, { refetch }] = createResource(async () => {
    const res = await api.getEnvelope<OrgExportItem[]>("/org/export")
    return res.data
  })

  const active = () =>
    (exports() ?? []).some((e) => e.status === "queued" || e.status === "running")

  const timer = setInterval(() => {
    if (active()) void refetch()
  }, POLL_MS)
  onCleanup(() => clearInterval(timer))

  const dateText = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(i18n.locale(), { dateStyle: "medium", timeStyle: "short" })
      : ""

  async function start(): Promise<void> {
    setStarting(true)
    setProblem(null)
    try {
      await api.post("/org/export", {})
    } catch {
      // A 409 means one is already running: the refreshed list shows it.
      setProblem(i18n.t("kernel.orgExport.startFailed"))
    } finally {
      await refetch()
      setStarting(false)
    }
  }

  async function download(id: string): Promise<void> {
    setProblem(null)
    try {
      const res = await api.getEnvelope<{ url: string }>(
        `/org/export/${encodeURIComponent(id)}/download`,
      )
      // A download, never a navigation: the archive arrives as a file
      // (attachment) and the Settings page stays, even when the link fails.
      const a = document.createElement("a")
      a.href = res.data.url
      a.download = ""
      a.rel = "noopener"
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch {
      setProblem(i18n.t("kernel.orgExport.downloadFailed"))
      void refetch()
    }
  }

  return (
    <div data-testid="org-export" class="flex flex-col gap-4">
      <p data-testid="org-export-help" class="text-sm text-text-secondary">
        {i18n.t("kernel.orgExport.help")}
      </p>
      <div>
        <Button
          variant="primary"
          size="sm"
          data-testid="org-export-start"
          disabled={starting() || active() || exports.loading}
          onClick={() => void start()}
        >
          {starting() ? i18n.t("kernel.orgExport.starting") : i18n.t("kernel.orgExport.start")}
        </Button>
      </div>
      <Show when={problem()}>
        <p data-testid="org-export-problem" class="text-sm text-text-secondary">
          {problem()}
        </p>
      </Show>
      <Show when={exports.error}>
        <p data-testid="org-export-load-failed" class="text-sm text-text-secondary">
          {i18n.t("kernel.orgExport.loadFailed")}
        </p>
      </Show>
      <Show when={exports() !== undefined}>
        <Show
          when={(exports() ?? []).length > 0}
          fallback={
            <p data-testid="org-export-empty" class="text-sm text-text-secondary">
              {i18n.t("kernel.orgExport.empty")}
            </p>
          }
        >
          <ul data-testid="org-export-list" class="flex flex-col divide-y divide-border-subtle">
            <For each={exports()}>
              {(e) => {
                const status = () => shownStatus(e, Date.now())
                return (
                  <li
                    data-testid={`org-export-row-${e.id}`}
                    class="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm"
                  >
                    <span class="text-text" data-testid={`org-export-date-${e.id}`}>
                      {dateText(e.createdAt)}
                    </span>
                    <span class="text-text-secondary" data-testid={`org-export-requester-${e.id}`}>
                      {e.requestedByName ??
                        (e.requestedVia === "cli" ? i18n.t("kernel.orgExport.operator") : "")}
                    </span>
                    <span class="text-text-secondary" data-testid={`org-export-status-${e.id}`}>
                      {i18n.t(STATUS_KEY[status()])}
                    </span>
                    <Show when={e.bytes !== null && status() !== "failed"}>
                      <span class="text-text-secondary" data-testid={`org-export-size-${e.id}`}>
                        {formatBytes(e.bytes ?? 0)}
                      </span>
                    </Show>
                    <Show when={status() === "completed"}>
                      <span
                        class="text-text-secondary"
                        data-testid={`org-export-expires-${e.id}`}
                        title={i18n.t("kernel.orgExport.colExpires")}
                      >
                        {i18n.t("kernel.orgExport.colExpires")} {dateText(e.expiresAt)}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid={`org-export-download-${e.id}`}
                        onClick={() => void download(e.id)}
                      >
                        {i18n.t("kernel.orgExport.download")}
                      </Button>
                    </Show>
                    <Show when={status() === "failed"}>
                      <span
                        class="w-full text-text-secondary"
                        data-testid={`org-export-failed-${e.id}`}
                      >
                        {e.error?.startsWith("EXPORT_TOO_LARGE")
                          ? i18n.t("kernel.orgExport.failedTooLarge")
                          : i18n.t("kernel.orgExport.failedGeneric")}
                      </span>
                    </Show>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}

export default OrgExportSection
