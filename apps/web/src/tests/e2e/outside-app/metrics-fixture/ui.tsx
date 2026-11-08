// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The fixture's UI, written the way a real outside metrics app writes its own:
// every read goes through the app's own tools (`app.invokeTool`) inside
// `app.createResource`, the copy follows the reader's language (`hostLocale`),
// a button opens the app's settings page (`navigate`), a plain `<a href>` moves
// the page to one of its routes and marks itself active from the page's path
// (`currentPath`, re-read on `popstate`), and the settings page is a custom
// component of the app's. Framed, each of these is a message to the
// page (app-frame/protocol.ts), which is what the scenario proves.
import { app, currentPath, getContext, hostLocale, navigate } from "@liaison/host"
import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js"

interface Metric {
  id: string
  title: string
  version: string
}

interface Registry {
  formulaVersion?: string
  metrics?: Metric[]
  reportFileId?: string
}

/** Ask the host to open a file by id (host API 1.3); the frame gets no bytes, only the outcome. */
async function openFileOutcome(fileId: string): Promise<string> {
  try {
    return (await app.openFile(fileId, "report.pdf")) ? "opened" : "not-framed"
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

async function readRegistry(): Promise<Registry | { error: string }> {
  try {
    const res = await app.invokeTool<{ data?: Registry } & Registry>("metrics_list", {})
    return res?.data ?? res ?? {}
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Calls a host method no host provides, the way a newer app would on an older host. */
function callUnknownHostMethod(): Promise<string> {
  const id = 900_000 + Math.floor(Math.random() * 1000)
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { kind?: string; id?: number; ok?: boolean; error?: string }
      if (event.source !== window.parent || data?.kind !== "result" || data.id !== id) return
      window.removeEventListener("message", onMessage)
      resolve(data.ok ? "ok" : String(data.error))
    }
    window.addEventListener("message", onMessage)
    window.parent.postMessage({ kind: "call", id, method: "renderChart", args: [] }, "*")
  })
}

export const MetricsAppIcon: Component = () => null

/** The page's path, followed the way a sidebar follows it for its active row. */
function usePagePath(): () => string {
  const [path, setPath] = createSignal(currentPath())
  onMount(() => {
    const onChange = () => setPath(currentPath())
    window.addEventListener("popstate", onChange)
    onCleanup(() => window.removeEventListener("popstate", onChange))
  })
  return path
}

const REVENUE_ROUTE = "/metrics-fixture/revenue.monthly"

export const MetricsExplorer: Component = () => {
  const [registry] = app.createResource(readRegistry)
  const [probe, setProbe] = createSignal<string | null>(null)
  const [fileOutcome, setFileOutcome] = createSignal<string | null>(null)
  const path = usePagePath()
  const reportFileId = () => {
    const value = registry()
    return value && "reportFileId" in value ? (value.reportFileId ?? "") : ""
  }
  const metrics = () => {
    const value = registry()
    return value && "metrics" in value ? (value.metrics ?? []) : []
  }
  return (
    <div data-testid="metrics-fixture-explorer">
      <p data-testid="metrics-fixture-locale">{hostLocale()}</p>
      <Show when={!registry.loading} fallback={<p>Loading</p>}>
        <ul>
          <For each={metrics()}>
            {(metric) => (
              <li data-testid="metrics-fixture-metric" data-metric-id={metric.id}>
                {metric.title} ({metric.version})
              </li>
            )}
          </For>
        </ul>
      </Show>
      <a
        href={REVENUE_ROUTE}
        data-testid="metrics-fixture-link"
        data-active={path() === REVENUE_ROUTE ? "true" : "false"}
      >
        Revenue
      </a>
      <p data-testid="metrics-fixture-path">{path()}</p>
      <button
        type="button"
        data-testid="metrics-fixture-open-settings"
        onClick={() => navigate("/settings/apps/metrics-fixture")}
      >
        Settings
      </button>
      <button
        type="button"
        data-testid="metrics-fixture-probe-unknown"
        onClick={() => void callUnknownHostMethod().then(setProbe)}
      >
        Probe
      </button>
      <Show when={probe()}>
        <p data-testid="metrics-fixture-probe-result">{probe()}</p>
      </Show>
      <p data-testid="metrics-fixture-context-org">{getContext()?.orgId ?? ""}</p>
      <button
        type="button"
        data-testid="metrics-fixture-open-report"
        onClick={() => void openFileOutcome(reportFileId()).then(setFileOutcome)}
      >
        Open report
      </button>
      <button
        type="button"
        data-testid="metrics-fixture-open-foreign"
        onClick={() => void openFileOutcome("someone-elses-file-0001").then(setFileOutcome)}
      >
        Open another file
      </button>
      <Show when={fileOutcome()}>
        <p data-testid="metrics-fixture-file-outcome">{fileOutcome()}</p>
      </Show>
    </div>
  )
}

export const MetricsSettings: Component = () => {
  const [registry] = app.createResource(readRegistry)
  const status = () => {
    const value = registry()
    if (!value) return "Loading"
    if ("error" in value) return `Unavailable: ${value.error}`
    const count = value.metrics?.length ?? 0
    return `Connected, formula ${value.formulaVersion ?? "?"}, ${count} metrics`
  }
  return (
    <div data-testid="metrics-fixture-settings">
      <p data-testid="metrics-fixture-settings-status">{status()}</p>
    </div>
  )
}
