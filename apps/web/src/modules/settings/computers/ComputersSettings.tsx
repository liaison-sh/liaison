// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SETTINGS > COMPUTERS: every computer of the viewer's, live (the nodes
// store), each with "This computer", online or last seen, its sessions
// running, folders and agents, a problem that blocks it (a place the OS does
// not let Liaison read), its on/off switch, and a way into its page. In the
// desktop app, while this computer is not set up yet, its setup comes first.
//
// It replaces "This computer" and "Nodes" (both paths land here or on this
// computer's page: ComputerRedirects.tsx). Phone first: one column, 44 px
// targets.

import type { NodeFolderList } from "@liaison/shared"
import { useNavigate } from "@solidjs/router"
import { ChevronRight, Laptop, TriangleAlert } from "lucide-solid"
import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  type NodeAttachmentSummary,
  type NodeProfileSummary,
  type NodeSummary,
  nodeAttachments,
  nodeProfiles,
  updateNode,
} from "~/modules/nodes/node-api"
import { nodeFolders } from "~/modules/nodes/node-folders-api"
import {
  loadNodes,
  nodes,
  nodesStatus,
  onNodeChange,
  refetchNodes,
} from "~/modules/nodes/nodes-store"
import { countsByNode, ensureListLoaded } from "~/modules/sessions/session-list"
import { useApi } from "~/modules/shell/ApiContext"
import { formatRelativeTime, rowLocaleFrom } from "~/modules/shell/attention-row-format"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"
import { Switch as Toggle } from "~/ui/Switch"
import { SetupCard } from "./ComputerChecks"
import { agentRowsFor, computerRoute, osKey, placesLabel } from "./computer-model"
import { type ThisComputer, useThisComputer } from "./this-computer"

/** The pieces of a computer's status line, shared by the list and its page. */
export function useStatusLine() {
  const i18n = useI18n()
  const ago = (iso: string) => formatRelativeTime(iso, { i18n: rowLocaleFrom(i18n) })
  return {
    presence: (node: NodeSummary) =>
      node.online
        ? i18n.t("kernel.computers.status.online")
        : node.lastSeenAt
          ? i18n.t("kernel.computers.status.lastSeen", { when: ago(node.lastSeenAt) })
          : i18n.t("kernel.computers.status.neverSeen"),
    running: (nodeId: string) => {
      const { running } = countsByNode(nodeId)
      return running === 1
        ? i18n.t("kernel.computers.status.runningOne")
        : i18n.t("kernel.computers.status.running", { count: running })
    },
    needsYou: (nodeId: string) => countsByNode(nodeId).needsYou,
  }
}

export function openSessions(label: string): void {
  openTab({
    type: "kernel:sessions",
    entityId: "sessions",
    label,
    routePath: "/sessions",
  })
}

/** This computer's on/off: through the shell's flows; any other computer's: a PATCH. */
export async function setComputerEnabled(
  api: ReturnType<typeof useApi>,
  tc: ThisComputer,
  node: NodeSummary,
  next: boolean,
  failed: () => void,
): Promise<void> {
  if (tc.available && tc.nodeId() === node.id) {
    await tc.toggle(next)
    return
  }
  try {
    await updateNode(api, node.id, { enabled: next })
    await refetchNodes()
  } catch {
    failed()
  }
}

const ComputersSettings: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const navigate = useNavigate()
  const tc = useThisComputer()
  const status = useStatusLine()
  const [attachments, setAttachments] = createSignal<NodeAttachmentSummary[]>([])
  const [profiles, setProfiles] = createSignal<NodeProfileSummary[]>([])
  /** Each online computer's folder answer, for the problem it may name. */
  const [folders, setFolders] = createSignal<Record<string, NodeFolderList>>({})

  const failed = () => addToast({ message: i18n.t("kernel.computers.actionFailed"), type: "error" })

  async function loadAgents(): Promise<void> {
    const [a, p] = await Promise.all([
      nodeAttachments(api).catch(() => null),
      nodeProfiles(api).catch(() => null),
    ])
    if (a) setAttachments(a)
    if (p) setProfiles(p)
  }

  const asked = new Set<string>()
  async function readFolders(node: NodeSummary): Promise<void> {
    if (!node.online || !node.enabled || asked.has(node.id)) return
    asked.add(node.id)
    try {
      const list = await nodeFolders(api, node.id)
      setFolders((all) => ({ ...all, [node.id]: list }))
    } catch {
      // No problem line: the computer's page says what failed.
      asked.delete(node.id)
    }
  }

  onMount(() => {
    void loadNodes(api).then(() => {
      for (const node of nodes()) void readFolders(node)
    })
    void ensureListLoaded()
    void loadAgents()
    const off = onNodeChange((frame) => {
      if (frame.change === "profile" || frame.change === "attachment") void loadAgents()
      if (frame.change === "presence" && frame.online) {
        const node = nodes().find((n) => n.id === frame.nodeId)
        if (node) void readFolders({ ...node, online: true })
      }
    })
    onCleanup(off)
  })

  const isThis = (node: NodeSummary) => tc.available && tc.nodeId() === node.id
  /** This computer's switch follows the shell's flow; any other's, the server. */
  const enabledOf = (node: NodeSummary) => (isThis(node) ? tc.isOn() : node.enabled)
  /** The setup card: this computer is not one of the listed ones, or is being set up. */
  const showSetup = () => {
    if (!tc.available) return false
    const phase = tc.state().phase
    if (phase === "loading" || phase === "on") return false
    if (phase === "off") return !nodes().some((n) => n.id === tc.nodeId())
    return true
  }

  const agentCount = (node: NodeSummary) => agentRowsFor(node.id, attachments(), profiles()).length
  const folderCount = (node: NodeSummary) => node.sharedFolderNames?.length
  const denied = (node: NodeSummary) => folders()[node.id]?.search.denied ?? []

  return (
    <div data-testid="computers-settings" class="pb-20">
      <header class="mb-8">
        <h1 class="font-display text-[26px] font-medium leading-none tracking-[-0.01em] text-text">
          {i18n.t("kernel.nav.section.computers")}
        </h1>
        <p class="mt-3 max-w-[60ch] text-[13px] leading-relaxed text-text-secondary">
          {i18n.t("kernel.computers.intro")}
        </p>
      </header>

      <Show when={showSetup()}>
        <SetupCard tc={tc} />
      </Show>

      <Show when={nodesStatus() === "loading" || nodesStatus() === "idle"}>
        <div data-testid="computers-loading" class="flex flex-col gap-4">
          <Skeleton class="h-14 w-full" />
          <Skeleton class="h-14 w-full" />
        </div>
      </Show>

      <Show when={nodesStatus() === "error"}>
        <div data-testid="computers-error" class="flex flex-wrap items-center gap-4">
          <p class="text-[13px] text-warning">{i18n.t("kernel.computers.loadError")}</p>
          <Button variant="outline" class="w-auto shrink-0" onClick={() => void refetchNodes()}>
            {i18n.t("kernel.computers.retry")}
          </Button>
        </div>
      </Show>

      <Show when={nodesStatus() === "ready"}>
        <section aria-label={i18n.t("kernel.nav.section.computers")}>
          <Show when={nodes().length > 0}>
            <ul class="flex flex-col divide-y divide-border-subtle border-y border-border-subtle">
              <For each={nodes()}>
                {(node) => (
                  <li
                    data-testid="computer-row"
                    data-node-id={node.id}
                    class="flex min-h-[56px] items-center gap-3 py-3"
                  >
                    <Laptop
                      size={20}
                      aria-hidden="true"
                      class="hidden shrink-0 sm:block"
                      classList={{
                        "text-accent": node.online && node.enabled,
                        "text-text-tertiary": !(node.online && node.enabled),
                      }}
                    />
                    <div class="min-w-0 flex-1">
                      <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <button
                          type="button"
                          data-testid={`computer-open-name-${node.id}`}
                          class="min-w-0 truncate text-left text-[14px] font-medium text-text hover:underline"
                          onClick={() => navigate(computerRoute(node.id))}
                        >
                          {node.name}
                        </button>
                        <Show when={isThis(node)}>
                          <span
                            data-testid={`computer-this-${node.id}`}
                            class="rounded-full border border-border-subtle px-1.5 py-px text-[11.5px] font-medium text-text-secondary"
                          >
                            {i18n.t("kernel.computers.thisComputer")}
                          </span>
                        </Show>
                      </p>
                      <p class="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12px] text-text-secondary">
                        <span
                          data-testid={`computer-status-${node.id}`}
                          data-online={String(node.online)}
                          classList={{ "text-accent": node.online }}
                        >
                          {status.presence(node)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <button
                          type="button"
                          data-testid={`computer-sessions-${node.id}`}
                          class="tabular-nums underline-offset-2 hover:text-text hover:underline"
                          onClick={() => openSessions(i18n.t("kernel.nodeSessions.app.title"))}
                        >
                          {status.running(node.id)}
                          <Show when={status.needsYou(node.id) > 0}>
                            {`, ${i18n.t("kernel.computers.status.waiting", { count: status.needsYou(node.id) })}`}
                          </Show>
                        </button>
                        <Show when={folderCount(node) !== undefined}>
                          <span aria-hidden="true">·</span>
                          <span data-testid={`computer-folders-${node.id}`} class="tabular-nums">
                            {folderCount(node) === 1
                              ? i18n.t("kernel.computers.status.foldersOne")
                              : i18n.t("kernel.computers.status.folders", {
                                  count: folderCount(node) ?? 0,
                                })}
                          </span>
                        </Show>
                        <span aria-hidden="true">·</span>
                        <span data-testid={`computer-agents-${node.id}`} class="tabular-nums">
                          {agentCount(node) === 1
                            ? i18n.t("kernel.computers.status.agentsOne")
                            : i18n.t("kernel.computers.status.agents", {
                                count: agentCount(node),
                              })}
                        </span>
                      </p>
                      <Show when={denied(node).length > 0}>
                        <p
                          data-testid={`computer-problem-${node.id}`}
                          class="mt-1 flex items-start gap-1.5 text-[12.5px] text-warning"
                        >
                          <TriangleAlert size={14} aria-hidden="true" class="mt-px shrink-0" />
                          <span>
                            {i18n.t("kernel.computers.problem.denied", {
                              os: i18n.t(`kernel.computers.os.${osKey(node.os)}`),
                              places: placesLabel(denied(node)),
                            })}
                          </span>
                        </p>
                      </Show>
                    </div>
                    <div class="flex min-h-11 shrink-0 items-center">
                      <Toggle
                        data-testid={`computer-enabled-${node.id}`}
                        checked={enabledOf(node)}
                        disabled={isThis(node) && tc.state().phase === "registering"}
                        label={i18n.t("kernel.computers.switchLabel", { name: node.name })}
                        onChange={(next) => void setComputerEnabled(api, tc, node, next, failed)}
                      />
                    </div>
                    <button
                      type="button"
                      data-testid={`computer-open-${node.id}`}
                      aria-label={i18n.t("kernel.computers.open", { name: node.name })}
                      class="flex size-11 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text"
                      onClick={() => navigate(computerRoute(node.id))}
                    >
                      <ChevronRight size={18} aria-hidden="true" />
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <p
            data-testid={nodes().length === 0 ? "computers-empty" : "computers-add-hint"}
            class="mt-4 max-w-[60ch] text-[13px] leading-relaxed text-text-secondary"
          >
            {i18n.t("kernel.computers.addHint")}
          </p>
        </section>
      </Show>
    </div>
  )
}

export default ComputersSettings
