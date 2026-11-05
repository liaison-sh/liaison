// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { catalogHasKey, useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

interface SkippedApp {
  app: string
  reason: string
}

const AdminDataExport: Component = () => {
  const i18n = useI18n()
  const api = useApi()

  // Source from export-capable apps (registered export handlers), NOT the
  // enabled-app surface set — an admin who skipped the apps setup step must
  // still be able to export their data (spec WS3 / E2).
  const [state] = createResource(async () => {
    const res = await api.getEnvelope<{ apps: string[] }>("/export/apps")
    return res.data
  })

  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [format, setFormat] = createSignal<"json" | "csv">("json")
  const [from, setFrom] = createSignal("")
  const [to, setTo] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [skipped, setSkipped] = createSignal<SkippedApp[]>([])
  const [done, setDone] = createSignal(false)
  const [exportError, setExportError] = createSignal<string | null>(null)

  const enabledApps = () => state()?.apps ?? []

  function toggleApp(app: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(app)) next.delete(app)
      else next.add(app)
      return next
    })
  }

  async function runExport(): Promise<void> {
    const appNames = [...selected()]
    if (appNames.length === 0) return
    setBusy(true)
    setDone(false)
    setSkipped([])
    setExportError(null)
    try {
      const dateRange =
        from() || to() ? { from: from() || undefined, to: to() || undefined } : undefined
      const res = await api.rawPost("/export", {
        appNames,
        format: format(),
        ...(dateRange ? { dateRange } : {}),
      })
      const skipHeader = res.headers.get("X-Export-Skipped")
      if (skipHeader) {
        try {
          setSkipped(JSON.parse(skipHeader) as SkippedApp[])
        } catch {
          setSkipped([])
        }
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "liaison-export.zip"
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setDone(true)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : i18n.t("kernel.settingsUi.exportFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="admin-data-export">
      <Show
        when={enabledApps().length > 0}
        fallback={
          <p class="text-sm text-text-secondary">
            {state.loading ? i18n.t("kernel.common.loading2") : i18n.t("kernel.dataExport.noApps")}
          </p>
        }
      >
        <section class="mb-5">
          <h2 class="mb-2 text-sm font-medium text-text">
            {i18n.t("kernel.dataExport.selectApps")}
          </h2>
          <div class="flex flex-wrap gap-2">
            <For each={enabledApps()}>
              {(app) => (
                <button
                  type="button"
                  class="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-surface-hover"
                  classList={{
                    "border-accent text-text": selected().has(app),
                    "border-border-subtle text-text-secondary": !selected().has(app),
                  }}
                  data-testid={`data-export-app-${app}`}
                  aria-pressed={selected().has(app)}
                  onClick={() => toggleApp(app)}
                >
                  <span
                    class="inline-block h-3 w-3 rounded-sm border"
                    classList={{
                      "border-accent bg-accent": selected().has(app),
                      "border-border-subtle": !selected().has(app),
                    }}
                  />
                  {catalogHasKey(`kernel.capabilities.apps.${app}`)
                    ? i18n.t(`kernel.capabilities.apps.${app}`)
                    : app}
                </button>
              )}
            </For>
          </div>
        </section>

        <section class="mb-5">
          <h2 class="mb-2 text-sm font-medium text-text">{i18n.t("kernel.dataExport.format")}</h2>
          <div class="flex gap-2">
            <button
              type="button"
              data-testid="data-export-format-json"
              class="rounded-md border px-3 py-1.5 text-sm"
              classList={{
                "border-accent text-text": format() === "json",
                "border-border-subtle text-text-secondary": format() !== "json",
              }}
              onClick={() => setFormat("json")}
            >
              {i18n.t("kernel.dataExport.formatJson")}
            </button>
            <button
              type="button"
              data-testid="data-export-format-csv"
              class="rounded-md border px-3 py-1.5 text-sm"
              classList={{
                "border-accent text-text": format() === "csv",
                "border-border-subtle text-text-secondary": format() !== "csv",
              }}
              onClick={() => setFormat("csv")}
            >
              {i18n.t("kernel.dataExport.formatCsv")}
            </button>
          </div>
        </section>

        <section class="mb-5 flex gap-4">
          <label class="flex flex-col gap-1 text-sm text-text-secondary">
            {i18n.t("kernel.dataExport.dateFrom")}
            <input
              type="date"
              data-testid="data-export-from"
              class="rounded-md border border-border-subtle bg-surface px-2 py-1 text-sm"
              value={from()}
              onInput={(e) => setFrom(e.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1 text-sm text-text-secondary">
            {i18n.t("kernel.dataExport.dateTo")}
            <input
              type="date"
              data-testid="data-export-to"
              class="rounded-md border border-border-subtle bg-surface px-2 py-1 text-sm"
              value={to()}
              onInput={(e) => setTo(e.currentTarget.value)}
            />
          </label>
        </section>

        <button
          type="button"
          data-testid="data-export-submit"
          class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={selected().size === 0 || busy()}
          onClick={() => void runExport()}
        >
          {busy() ? i18n.t("kernel.dataExport.exporting") : i18n.t("kernel.dataExport.export")}
        </button>

        <Show when={exportError()}>
          {(msg) => (
            <p class="mt-3 text-sm text-rose-600" data-testid="data-export-error">
              {msg()}
            </p>
          )}
        </Show>

        <Show when={done() && skipped().length === 0}>
          <p class="mt-3 text-sm text-text-secondary" data-testid="data-export-done">
            {i18n.t("kernel.dataExport.done")}
          </p>
        </Show>

        <Show when={skipped().length > 0}>
          <div
            class="mt-4 rounded-md border border-border-subtle p-3"
            data-testid="data-export-skipped"
          >
            <h3 class="mb-2 text-sm font-medium text-text">
              {i18n.t("kernel.dataExport.skippedTitle")}
            </h3>
            <ul class="space-y-1 text-sm text-text-secondary">
              <For each={skipped()}>
                {(s) => (
                  <li>
                    <span class="font-medium text-text">{s.app}</span>: {s.reason}
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      </Show>
    </div>
  )
}

export default AdminDataExport
