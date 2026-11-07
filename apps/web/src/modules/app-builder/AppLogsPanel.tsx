// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A custom app's Logs, on its settings page, for holders of kernel:apps:logs:
// what the app logged (GET /api/apps/:name/logs), newest first, filtered by the
// lowest level and by one run. Levels are a quiet word, never a colour alarm.
import { type Component, createResource, createSignal, For, Match, Switch } from "solid-js"
import { hasScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import {
  APP_LOG_LEVELS,
  type AppLogLevel,
  type BuilderApi,
  isCustomAppName,
  isRunId,
  readAppLogs,
} from "./builder-client"

const K = "kernel.appLogs"

/** Whether the settings page of `app` shows the panel. */
export function showsAppLogs(app: string): boolean {
  return isCustomAppName(app) && hasScope("kernel:apps:logs")
}

export const AppLogsPanel: Component<{ app: string }> = (props) => {
  const i18n = useI18n()
  const api = useApi() as unknown as BuilderApi
  const [level, setLevel] = createSignal<AppLogLevel | "">("")
  const [runId, setRunId] = createSignal("")
  const [tick, setTick] = createSignal(0)
  const run = () => (isRunId(runId().trim()) ? runId().trim() : undefined)

  const [logs] = createResource(
    () => ({ app: props.app, level: level(), runId: run(), tick: tick() }),
    async (q) => {
      try {
        const rows = await readAppLogs(api, q.app, {
          ...(q.level ? { level: q.level } : {}),
          ...(q.runId ? { runId: q.runId } : {}),
          limit: 200,
        })
        return { ok: true as const, rows: [...rows].sort((a, b) => (a.at < b.at ? 1 : -1)) }
      } catch {
        return { ok: false as const }
      }
    },
  )

  return (
    <section
      data-testid="app-logs-panel"
      class="mt-7 rounded-lg border border-border bg-surface px-4 py-3.5"
    >
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <h2 class="min-w-0 flex-1 text-[14px] font-semibold">{i18n.t(`${K}.title`)}</h2>
        <label class="sr-only" for="app-logs-level">
          {i18n.t(`${K}.level`)}
        </label>
        <select
          id="app-logs-level"
          data-testid="app-logs-level"
          class="h-8 rounded-md border border-border bg-bg px-2 text-[12.5px]"
          value={level()}
          onChange={(e) => setLevel(e.currentTarget.value as AppLogLevel | "")}
        >
          <option value="">{i18n.t(`${K}.allLevels`)}</option>
          <For each={APP_LOG_LEVELS}>
            {(l) => <option value={l}>{i18n.t(`${K}.atLeast.${l}`)}</option>}
          </For>
        </select>
        <label class="sr-only" for="app-logs-run">
          {i18n.t(`${K}.runId`)}
        </label>
        <input
          id="app-logs-run"
          data-testid="app-logs-run"
          class="h-8 w-56 rounded-md border border-border bg-bg px-2 font-mono text-[12px]"
          placeholder={i18n.t(`${K}.runId`)}
          value={runId()}
          onInput={(e) => setRunId(e.currentTarget.value)}
        />
        <Button
          variant="outline"
          size="sm"
          data-testid="app-logs-refresh"
          onClick={() => setTick((t) => t + 1)}
        >
          {i18n.t(`${K}.refresh`)}
        </Button>
      </div>
      <Switch>
        <Match when={logs.loading && !logs()}>
          <p data-testid="app-logs-loading" class="text-[12.5px] text-text-tertiary">
            {i18n.t("kernel.loading")}
          </p>
        </Match>
        <Match when={logs() && !logs()?.ok}>
          <p data-testid="app-logs-failed" class="text-[12.5px] text-text-secondary">
            {i18n.t(`${K}.failed`)}
          </p>
        </Match>
        <Match when={logs()?.ok && (logs() as { rows: unknown[] }).rows.length === 0}>
          <p data-testid="app-logs-empty" class="text-[12.5px] text-text-tertiary">
            {i18n.t(`${K}.empty`)}
          </p>
        </Match>
        <Match when={logs()?.ok}>
          <ul data-testid="app-logs-list" class="max-h-96 space-y-1 overflow-y-auto">
            <For each={(logs() as { rows: Awaited<ReturnType<typeof readAppLogs>> }).rows}>
              {(row) => (
                <li
                  data-testid="app-log-line"
                  data-level={row.level}
                  class="flex gap-2 font-mono text-[11.5px] text-text-secondary"
                >
                  <span class="shrink-0 text-text-tertiary">
                    {new Date(row.at).toLocaleString()}
                  </span>
                  <span
                    class="w-10 shrink-0 text-text-tertiary"
                    classList={{ "font-semibold text-text": row.level === "error" }}
                  >
                    {row.level}
                  </span>
                  <span class="min-w-0 flex-1 break-words">{row.message}</span>
                  <button
                    type="button"
                    data-testid="app-log-run"
                    class="shrink-0 text-text-tertiary hover:text-text"
                    title={row.runId}
                    onClick={() => setRunId(row.runId)}
                  >
                    {row.runId.slice(0, 8)}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Match>
      </Switch>
    </section>
  )
}
