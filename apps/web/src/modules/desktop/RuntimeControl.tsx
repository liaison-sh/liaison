// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T06: WHERE THIS CONVERSATION'S TURNS RUN, in one control.
//
// It replaces four floating things the overlay drew over the page: a folder
// picker, a recent folders list, a "Run this on my machine" button anchored to
// nothing and a full width "Open folder with Liaison" banner. All four were
// the same question, asked four times, so this asks it once, in the menu
// idiom every other control in this app already uses.
//
// THE TRIGGER NEVER CARRIES A PATH. A full path in a header trigger is what
// ws06b-fx9-21.png looked like: a line of machine text where a product puts a
// name. The basename shows; the full path is the menu row's second line and
// the row's own title attribute, for the one moment a person needs to tell two
// folders of the same name apart.
//
// THE RUNTIME IS NAMED ONCE PER SCREEN. While a local session is live the
// composer row names the runtime (P6d-T09's badge), so this trigger drops to
// the folder alone rather than saying the same two words a second time.
//
// It renders NOTHING in a browser for a person with no node. Not a disabled
// control, nothing at all: a browser has no shell to run anything on, and an
// affordance that can never be used is worse than an absent one.
//
// MY NODE (P4 N-D T6, S21, S24, A24). A person with a node that is enabled and
// online gets a third place, on the web, the phone and the desktop app alike:
// that node, one row per node, each named by the node's own name, and the
// trigger names the node the turns run on. It is stored on the SERVER for this
// (thread, agent) (modules/nodes/thread-node-runtime.ts), not in this window,
// so every device shows and uses the same runtime; This machine stays the
// desktop's own. In a browser with no node online the control is absent.

import { Check, Cloud, Folder, MonitorSmartphone, Server, Zap } from "lucide-solid"
import { type Component, createEffect, createSignal, For, on, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { NodeSummary } from "~/modules/nodes/node-api"
import { modelsFor, nodeForRun } from "~/modules/nodes/nodes-store"
import {
  availableNodes,
  loadMyNodes,
  loadThreadNodeRuntime,
  nodeRuntimeFor,
  setThreadNodeRuntime,
  type ThreadRunsOn,
} from "~/modules/nodes/thread-node-runtime"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { PopupMenu } from "~/ui/PopupMenu"
import {
  chooseFolder,
  desktopState,
  isDesktop,
  loadRecentFolders,
  localSessionFor,
  restoreThreadFolder,
  setRuntimeLocation,
  startLocalSession,
} from "./desktop-store"
import { RUNTIME_LABEL_LIAISON, RUNTIME_LABEL_LOCAL } from "./RuntimeBadge"

/** What the control is called, for a keyboard and a screen reader (a catalog key). */
export const RUNTIME_CONTROL_LABEL = "kernel.desktopUi.runtime.controlLabel"

/**
 * ONE PLAIN SENTENCE PER MODE (P3-T3, S18): what each place can do, under its
 * name, so a person picks with the difference in front of them. The agent's
 * prompt says the same in each mode (COMPUTER_MODE_SECTION on the server,
 * LOCAL_MODE_SECTION on this computer, NODE_MODE_SECTION on a node).
 */
export const RUNTIME_DESCRIPTION_LOCAL = "kernel.desktopUi.runtime.thisMachineDescription"
export const RUNTIME_DESCRIPTION_LIAISON = "kernel.desktopUi.runtime.liaisonDescription"
export const RUNTIME_LABEL_NODE = "kernel.desktopUi.runtime.myNode"
export const RUNTIME_DESCRIPTION_NODE = "kernel.desktopUi.runtime.myNodeDescription"

/** A mode's name with its one sentence underneath. */
const ModeRow: Component<{ label: string; description: string }> = (props) => (
  <span class="flex min-w-0 flex-1 flex-col">
    <span class="text-text">{props.label}</span>
    <span class="text-[11px] leading-snug text-text-tertiary">{props.description}</span>
  </span>
)

/** The last segment of a path, whichever separator the platform uses. */
export function folderBasename(path: string | null): string | null {
  if (!path) return null
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : null
}

interface RuntimeControlProps {
  agentId: string
  agentName: string
  threadId: string
  /**
   * Icon only, for a header too narrow to give this control words without
   * taking them from something that needs them more (P6d-T08: the agent
   * panel's conversation title). The words move to the tooltip and the menu,
   * which is where they were readable anyway.
   */
  compact?: boolean
}

const RuntimeControl: Component<RuntimeControlProps> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [open, setOpen] = createSignal(false)

  const state = () => desktopState()
  const live = () => localSessionFor(props.threadId, props.agentId)
  /** The viewer's own node runtime for this agent here (S24). */
  const setting = () => {
    const row = nodeRuntimeFor(props.threadId, props.agentId)
    return row?.mine ? row : null
  }
  const onNode = () => setting() !== null
  const isLocal = () => isDesktop() && !onNode() && state().runtimeLocation === "local"
  const basename = () => folderBasename(state().folderPath)
  /**
   * The node the turns run on: the one the setting names, else (no node
   * named, any of the owner's) the only enabled one, else the first online.
   */
  const runningNode = (): NodeSummary | undefined => {
    const row = setting()
    return row ? nodeForRun(row.nodeId) : undefined
  }
  /**
   * The node rows: every node online now, plus the one in use when it is not
   * (so the check mark still says where the turns go).
   */
  const nodeRows = (): NodeSummary[] => {
    const rows = availableNodes()
    const current = runningNode()
    return current && !rows.some((n) => n.id === current.id) ? [...rows, current] : rows
  }
  /** My node is on offer while a node is online, or already in use. */
  const nodeOffered = () => availableNodes().length > 0 || onNode()
  const nodeLabel = (node: NodeSummary | undefined) =>
    !node
      ? i18n.t(RUNTIME_LABEL_NODE)
      : node.online
        ? node.name
        : i18n.t("kernel.desktopUi.runtime.nodeOffline", { node: node.name })

  createEffect(
    on(
      () => props.threadId,
      (threadId) => {
        if (!api) return
        void loadMyNodes(api)
        if (threadId) void loadThreadNodeRuntime(api, threadId)
      },
    ),
  )

  /**
   * Where the turns run, stored where it is kept: the node runtime on the
   * server (another person's runtime, a node gone, bypass: refused, said), and
   * This machine in the desktop's own state.
   */
  async function storeNode(runsOn: ThreadRunsOn, nodeId?: string): Promise<boolean> {
    if (!api || !props.threadId) return false
    // A model picked on another node stays only if this node offers it too.
    const model = setting()?.model ?? null
    const keepModel = !nodeId || !model || modelsFor(nodeId).some((m) => m.id === model)
    try {
      await setThreadNodeRuntime(api, props.threadId, {
        agentId: props.agentId,
        runsOn,
        ...(nodeId ? { nodeId } : {}),
        ...(keepModel ? {} : { model: null }),
      })
      return true
    } catch {
      addToast({ message: i18n.t("kernel.desktopUi.runtime.notChanged"), type: "warning" })
      return false
    }
  }

  async function chooseNode(nodeId: string) {
    if (!(await storeNode("node", nodeId))) return
    // The turns go through the server to the node: this window's own local
    // session must not answer them first.
    if (isDesktop()) setRuntimeLocation("liaison")
  }

  async function chooseLocation(location: "local" | "liaison") {
    if (onNode() && !(await storeNode("cloud"))) return
    if (isDesktop()) setRuntimeLocation(location)
  }

  /**
   * What the trigger says. Live: the folder, because the composer row is
   * already saying the runtime. Idle and local with a folder: both, because
   * nothing else on the screen says either. Otherwise: the runtime alone.
   */
  const triggerLabel = () => {
    if (onNode()) return nodeLabel(runningNode())
    const folder = basename()
    if (live() && folder) return folder
    if (isLocal() && folder)
      return i18n.t("kernel.desktopUi.runtime.thisMachineInFolder", { folder })
    return i18n.t(isLocal() ? RUNTIME_LABEL_LOCAL : RUNTIME_LABEL_LIAISON)
  }

  async function pickFolder() {
    await chooseFolder(props.agentId, props.threadId || undefined)
  }

  /**
   * THE CONVERSATION'S FOLDER IS PUT BACK when it is opened on this machine.
   * A relaunch used to forget it: the header said "This machine" with no
   * folder, and the next send asked for one again.
   */
  createEffect(
    on(
      () => [props.threadId, props.agentId, isDesktop() && isLocal()] as const,
      ([threadId, agentId, local]) => {
        if (!local || !threadId || !agentId || live()) return
        void restoreThreadFolder(threadId, agentId)
      },
    ),
  )

  /**
   * ASKED EVERY TIME THE MENU OPENS (P6d-FX3, W3).
   *
   * The recent folders are the SHELL's, in a file that outlives the window,
   * and nothing read them back: the list was written by a pick and offered
   * only for the rest of that window's life, so a relaunch showed an agent
   * none of the folders it had run in. Asking on open also keeps it right
   * after a pick made in another window.
   */
  function onOpenChange(next: boolean) {
    setOpen(next)
    if (next && isDesktop()) void loadRecentFolders(props.agentId)
  }

  async function startHere() {
    // No handle: the folder already on the state, which got there through the
    // picker (P6d-FX2, SK-1).
    await startLocalSession(props.threadId, props.agentId)
  }

  async function startIn(folderId: string) {
    await startLocalSession(props.threadId, props.agentId, folderId)
  }

  return (
    <Show when={isDesktop() || nodeOffered()}>
      <PopupMenu open={open()} onOpenChange={onOpenChange}>
        <PopupMenu.Trigger
          aria-label={i18n.t(RUNTIME_CONTROL_LABEL)}
          class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
        >
          <Show
            when={onNode()}
            fallback={
              <Show when={isLocal()} fallback={<Cloud size={13} class="shrink-0" />}>
                <MonitorSmartphone size={13} class="shrink-0" />
              </Show>
            }
          >
            <Server size={13} class="shrink-0" />
          </Show>
          <Show when={!props.compact}>
            <span class="max-w-[160px] truncate">{triggerLabel()}</span>
          </Show>
        </PopupMenu.Trigger>

        <PopupMenu.Content class="w-72" aria-label={i18n.t(RUNTIME_CONTROL_LABEL)}>
          <PopupMenu.Group>
            <PopupMenu.Label>{i18n.t("kernel.desktopUi.runtime.menuTitle")}</PopupMenu.Label>
          </PopupMenu.Group>
          <Show when={isDesktop()}>
            <PopupMenu.Item onSelect={() => void chooseLocation("local")}>
              <MonitorSmartphone size={14} class="shrink-0" />
              <ModeRow
                label={i18n.t(RUNTIME_LABEL_LOCAL)}
                description={i18n.t(RUNTIME_DESCRIPTION_LOCAL)}
              />
              <Show when={isLocal()}>
                <Check size={14} class="shrink-0 text-accent" />
              </Show>
            </PopupMenu.Item>
          </Show>
          <PopupMenu.Item onSelect={() => void chooseLocation("liaison")}>
            <Cloud size={14} class="shrink-0" />
            <ModeRow
              label={i18n.t(RUNTIME_LABEL_LIAISON)}
              description={i18n.t(RUNTIME_DESCRIPTION_LIAISON)}
            />
            <Show when={!isLocal() && !onNode()}>
              <Check size={14} class="shrink-0 text-accent" />
            </Show>
          </PopupMenu.Item>
          <For each={nodeRows()}>
            {(node) => (
              <PopupMenu.Item
                onSelect={() => void chooseNode(node.id)}
                textValue={node.name}
                data-testid="runtime-node-row"
                data-node-id={node.id}
              >
                <Server size={14} class="shrink-0" />
                <ModeRow label={nodeLabel(node)} description={i18n.t(RUNTIME_DESCRIPTION_NODE)} />
                <Show when={runningNode()?.id === node.id}>
                  <Check size={14} class="shrink-0 text-accent" />
                </Show>
              </PopupMenu.Item>
            )}
          </For>

          <Show when={isLocal()}>
            <PopupMenu.Separator />
            <PopupMenu.Group>
              <PopupMenu.Label>{i18n.t("kernel.desktopUi.runtime.folder")}</PopupMenu.Label>
            </PopupMenu.Group>
            <PopupMenu.Item onSelect={() => void pickFolder()}>
              <Folder size={14} class="shrink-0" />
              <span class="flex-1">{i18n.t("kernel.desktopUi.runtime.chooseFolder")}</span>
            </PopupMenu.Item>
            <For each={state().recentFolders}>
              {(folder) => (
                <PopupMenu.Item onSelect={() => void startIn(folder.id)} textValue={folder.name}>
                  <span class="flex min-w-0 flex-col" title={folder.path}>
                    <span class="truncate text-text">{folder.name}</span>
                    <span class="truncate text-[11px] text-text-tertiary">{folder.path}</span>
                  </span>
                </PopupMenu.Item>
              )}
            </For>

            {/*
              No conversation, no start: a local session claims a (thread,
              agent) pair (A32), and the agent panel reaches this control
              before its first chat exists. Offering to start one there would
              claim nothing and answer nowhere.
            */}
            <Show when={!live() && state().folderPath && props.threadId}>
              <PopupMenu.Separator />
              <PopupMenu.Item onSelect={() => void startHere()}>
                <Zap size={14} class="shrink-0" />
                <span class="flex-1">{i18n.t("kernel.desktopUi.runtime.startHere")}</span>
              </PopupMenu.Item>
            </Show>
          </Show>
        </PopupMenu.Content>
      </PopupMenu>
    </Show>
  )
}

export default RuntimeControl
