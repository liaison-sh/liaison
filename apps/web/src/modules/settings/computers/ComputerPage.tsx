// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SETTINGS > COMPUTERS > <computer> (/settings/computers/:id[/agents|/settings]):
// its name, "This computer", its status, the switch that lets agents use it,
// and three tabs: Folders (where agents can work), Agents (who can use it, at
// what level) and Settings (name, workload, readiness, Remove). Every client
// reads it; the desktop app adds what only this computer can do (its folder
// picker, its checks, its System Settings).
//
// `?folder=<name>` (a blocked card's "Fix it", the agent's link) opens Add a
// folder with that name searched for.

import { useLocation, useNavigate, useSearchParams } from "@solidjs/router"
import { ChevronLeft } from "lucide-solid"
import { type Component, createMemo, For, Match, onMount, Show, Switch } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { checklistComplete } from "~/modules/nodes/node-setup"
import { loadNodes, nodes, nodesStatus } from "~/modules/nodes/nodes-store"
import { ensureListLoaded } from "~/modules/sessions/session-list"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Skeleton } from "~/ui/Skeleton"
import { Switch as Toggle } from "~/ui/Switch"
import { ComputerAgentsTab } from "./ComputerAgentsTab"
import { SetupCard } from "./ComputerChecks"
import { ComputerFoldersTab } from "./ComputerFoldersTab"
import { ComputerSettingsTab } from "./ComputerSettingsTab"
import { openSessions, setComputerEnabled, useStatusLine } from "./ComputersSettings"
import {
  COMPUTER_TABS,
  COMPUTERS_ROUTE,
  type ComputerTab,
  computerRoute,
  parseComputerPath,
} from "./computer-model"
import { useThisComputer } from "./this-computer"

const ComputerPage: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const tc = useThisComputer()
  const status = useStatusLine()

  const route = createMemo(() => parseComputerPath(location.pathname))
  const nodeId = () => route()?.nodeId ?? ""
  const tab = (): ComputerTab => route()?.tab ?? "folders"
  const node = () => nodes().find((n) => n.id === nodeId()) ?? null
  const isThis = () => tc.available && tc.nodeId() === nodeId()
  /** What the tabs are mounted for: this computer, and the folder a link asks for. */
  const tabKey = () => `${nodeId()}\n${linkedFolder() ?? ""}`
  /** This computer not fully set up, being turned on, or refused: its checklist shows. */
  const needsSetup = () => {
    const { phase, items } = tc.state()
    if (phase === "loading" || phase === "on") return false
    if (phase === "off") return !checklistComplete(items)
    return true
  }
  const linkedFolder = () =>
    typeof searchParams.folder === "string" && searchParams.folder ? searchParams.folder : null

  onMount(() => {
    void loadNodes(api)
    void ensureListLoaded()
  })

  const failed = () => addToast({ message: i18n.t("kernel.computers.actionFailed"), type: "error" })

  const statusLine = () => {
    const n = node()
    if (!n) return ""
    const parts = [status.presence(n), status.running(n.id)]
    const needsYou = status.needsYou(n.id)
    if (needsYou > 0) parts.push(i18n.t("kernel.computers.status.waiting", { count: needsYou }))
    if (isThis() && tc.awake()?.held) parts.push(i18n.t("kernel.computers.status.keptAwake"))
    return parts.join(" · ")
  }

  return (
    <div data-testid="computer-page" data-tab={tab()} class="pb-20">
      <button
        type="button"
        data-testid="computer-back"
        class="-ml-1 mb-4 flex min-h-11 items-center gap-1 px-1 text-[13px] text-text-secondary hover:text-text sm:min-h-0"
        onClick={() => navigate(COMPUTERS_ROUTE)}
      >
        <ChevronLeft size={16} aria-hidden="true" />
        {i18n.t("kernel.nav.section.computers")}
      </button>

      <Show when={nodesStatus() === "loading" || nodesStatus() === "idle"}>
        <Skeleton class="h-16 w-full" />
      </Show>

      <Show when={nodesStatus() !== "loading" && nodesStatus() !== "idle" && !node()}>
        <p data-testid="computer-gone" class="text-[13px] text-text-secondary">
          {i18n.t("kernel.computers.page.gone")}
        </p>
      </Show>

      <Show when={node()}>
        {(n) => (
          <>
            <header class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <h1 class="min-w-0 truncate font-display text-[26px] font-medium leading-tight tracking-[-0.01em] text-text">
                    {n().name}
                  </h1>
                  <Show when={isThis()}>
                    <span
                      data-testid="computer-page-this"
                      class="rounded-full border border-border-subtle px-1.5 py-px text-[11.5px] font-medium text-text-secondary"
                    >
                      {i18n.t("kernel.computers.thisComputer")}
                    </span>
                  </Show>
                </div>
                <p class="mt-2 text-[12.5px] text-text-secondary">
                  <button
                    type="button"
                    data-testid="computer-page-status"
                    data-online={String(n().online)}
                    class="text-left underline-offset-2 hover:underline"
                    onClick={() => openSessions(i18n.t("kernel.nodeSessions.app.title"))}
                  >
                    {statusLine()}
                  </button>
                </p>
              </div>
              <div class="flex min-h-11 shrink-0 items-center justify-between gap-3 text-[13px] text-text sm:justify-end">
                <span>{i18n.t("kernel.computers.page.switch", { name: n().name })}</span>
                <Toggle
                  data-testid="computer-page-enabled"
                  checked={isThis() ? tc.isOn() : n().enabled}
                  disabled={isThis() && tc.state().phase === "registering"}
                  label={i18n.t("kernel.computers.page.switch", { name: n().name })}
                  onChange={(next) => void setComputerEnabled(api, tc, n(), next, failed)}
                />
              </div>
            </header>

            <Show when={isThis() && needsSetup()}>
              <SetupCard tc={tc} />
            </Show>

            <nav
              aria-label={n().name}
              class="-mx-4 mb-6 flex overflow-x-auto border-b border-border-subtle px-4 sm:mx-0 sm:px-0"
            >
              <For each={COMPUTER_TABS}>
                {(t) => (
                  <button
                    type="button"
                    data-testid={`computer-tab-${t}`}
                    aria-current={tab() === t ? "page" : undefined}
                    class="-mb-px min-h-11 shrink-0 border-b-2 px-3 text-[13.5px] font-medium sm:min-h-10"
                    classList={{
                      "border-accent text-text": tab() === t,
                      "border-transparent text-text-secondary hover:text-text": tab() !== t,
                    }}
                    onClick={() => navigate(computerRoute(n().id, t))}
                  >
                    {i18n.t(`kernel.computers.page.tabs.${t}`)}
                  </button>
                )}
              </For>
            </nav>

            {/* Keyed on the computer (and the folder a link asks for): another
                computer, or another "Fix it", mounts its tabs afresh, so no
                state of the previous one is ever shown or acted on. */}
            <Show when={tabKey()} keyed>
              {(_key) => (
                <Switch>
                  <Match when={tab() === "folders"}>
                    <ComputerFoldersTab
                      node={n()}
                      isThis={isThis()}
                      tc={tc}
                      initialQuery={linkedFolder()}
                    />
                  </Match>
                  <Match when={tab() === "agents"}>
                    <ComputerAgentsTab node={n()} />
                  </Match>
                  <Match when={tab() === "settings"}>
                    <ComputerSettingsTab node={n()} isThis={isThis()} tc={tc} />
                  </Match>
                </Switch>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

export default ComputerPage
