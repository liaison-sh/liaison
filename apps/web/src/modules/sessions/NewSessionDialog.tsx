// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NEW SESSION DIALOG (S4, D24, D32, D42, two-node rule). A prompt, an
// optional shared folder (no repo, A30), a model the node that will run it
// offers, an agent (default: the owner's personal agent, D32), a level
// (default: that agent's profile level, Strict when it has none) and, when the
// model publishes reasoning levels, a reasoning level (default: the model's
// own, sent only when chosen, S23). Then Run on its own (S30, off: guided,
// sent only when on) and When finished (S57: a pull request by default, commit
// only, or leave uncommitted; the node applies it only to a repository; sent
// only when not the default). D42: an API older than wave 2 refuses those two
// fields (400); the dialog then says to update the server.
//
// A level above the profile, and any choice of Open, opens the in-app level
// confirmation first (`session_start`, on the node the two-node rule picks)
// and the start carries its id. 201 opens the session. A 403
// `confirmation_required` names the node the server picked (m6): the dialog
// confirms exactly that node and starts again with every id it holds; the
// same refusal for nodes already confirmed is said in words, never a loop.
// Any other refusal is said in words, with the candidates or the offered
// models when the server names them.

import {
  type EffortLevel,
  FINISH_WITH,
  type FinishWith,
  levelNeedsConfirmation,
  NODE_DEFAULT_LEVEL,
  NODE_LEVELS,
  type NodeLevel,
} from "@liaison/shared"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onMount,
  Show,
} from "solid-js"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { LevelConfirmDialog } from "~/modules/nodes/LevelConfirmDialog"
import { type NodeProfileSummary, type NodeSummary, nodeProfiles } from "~/modules/nodes/node-api"
import {
  effortsFor,
  hasEnabledNode,
  loadNodes,
  modelsFor,
  nodes,
  sharedFolderNames,
} from "~/modules/nodes/nodes-store"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import {
  listAgentDirectory,
  loadAgentDirectory,
  personalAgentFor,
} from "~/modules/threads/agent-directory"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Switch } from "~/ui/Switch"
import { type CreateSessionRefusal, createSession, type NodeSessionRow } from "./session-api"
import { applyRow } from "./session-store"

export interface NewSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the new session's row, after the dialog closed and its view opened. */
  onCreated?: (session: NodeSessionRow) => void
}

/** Refusal codes with their own sentence (kernel.nodeSessions.refusal.*). */
const REFUSAL_KEYS = new Set([
  "folder_unresolved",
  "model_unavailable",
  "no_node",
  "level_unconfirmed",
  "folder_missing",
  "worktree_failed",
  "timeout",
  "settings_refused",
  "auth_required",
  "confirmation_required",
  "node_outdated",
  "server_outdated",
])

/**
 * The node that will run it (the server's two-node rule, resolve.ts pickNode):
 * the enabled nodes that published capabilities (they offer a model), with a
 * folder only those sharing it; then online first, then the most recently
 * seen. A guess for the model list and the first confirmation only: the
 * server names its own pick when it refuses (m6).
 */
export function predictNode(
  all: readonly NodeSummary[],
  folderName: string | null,
): NodeSummary | null {
  const pool = all.filter(
    (n) =>
      n.enabled &&
      (n.models ?? []).length > 0 &&
      (!folderName || (n.sharedFolderNames ?? []).includes(folderName)),
  )
  if (pool.length === 0) return null
  const seen = (n: NodeSummary) => (n.lastSeenAt ? Date.parse(n.lastSeenAt) : 0)
  return (
    [...pool].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1
      return seen(b) - seen(a)
    })[0] ?? null
  )
}

interface Asking {
  level: NodeLevel
  nodes: Array<{ nodeId: string; nodeName: string }>
  /** Confirmations already made for this start, kept and sent again. */
  held: string[]
}

export const NewSessionDialog: Component<NewSessionDialogProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()

  const [prompt, setPrompt] = createSignal("")

  let promptField: HTMLTextAreaElement | undefined

  const promptFieldDictation = useDictation({ target: () => promptField })
  const [folder, setFolder] = createSignal("")
  const [model, setModel] = createSignal("")
  const [agentId, setAgentId] = createSignal("")
  const [level, setLevel] = createSignal<NodeLevel>(NODE_DEFAULT_LEVEL)
  const [levelTouched, setLevelTouched] = createSignal(false)
  // S23: "" is the model's default and sends nothing.
  const [effort, setEffort] = createSignal<EffortLevel | "">("")
  // S30: guided unless the owner switches it on; S57: a pull request by default.
  const [autonomous, setAutonomous] = createSignal(false)
  const [finishWith, setFinishWith] = createSignal<FinishWith>("pr")
  const [profiles, setProfiles] = createSignal<NodeProfileSummary[]>([])
  const [asking, setAsking] = createSignal<Asking | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [refusal, setRefusal] = createSignal<CreateSessionRefusal | null>(null)

  const me = () => userFromToken()?.userId ?? null
  const agents = createMemo(() =>
    listAgentDirectory().filter((a) => a.kind === undefined || a.kind !== "system"),
  )
  const node = createMemo(() => predictNode(nodes(), folder() || null))
  const models = createMemo(() => {
    const n = node()
    return n ? modelsFor(n.id) : []
  })
  // S25: the levels the chosen model publishes on the predicted node.
  const efforts = createMemo(() => {
    const n = node()
    return n ? effortsFor(n.id, model()) : []
  })
  // A level the newly chosen model does not offer goes back to Default.
  createEffect(() => {
    const chosen = effort()
    if (chosen && !efforts().includes(chosen)) setEffort("")
  })
  const profileLevel = createMemo<NodeLevel>(
    () => profiles().find((p) => p.agentId === agentId())?.level ?? NODE_DEFAULT_LEVEL,
  )
  const agentName = () => agents().find((a) => a.id === agentId())?.name ?? ""

  onMount(() => {
    void loadNodes(api)
    void loadAgentDirectory(api)
    nodeProfiles(api)
      .then(setProfiles)
      .catch(() => setProfiles([]))
  })

  // The personal agent by default, once the directory has it (D32).
  createEffect(() => {
    if (agentId()) return
    const mine = personalAgentFor(me())
    if (mine) setAgentId(mine.id)
  })

  // The level follows the agent's profile until the owner picks one.
  createEffect(
    on(profileLevel, (l) => {
      if (!levelTouched()) setLevel(l)
    }),
  )

  // Keep the model one the predicted node offers.
  createEffect(() => {
    const offered = models()
    if (offered.length === 0) return
    if (!offered.some((m) => m.id === model())) setModel(offered[0]?.id ?? "")
  })

  const canStart = () =>
    hasEnabledNode() && prompt().trim().length > 0 && model().length > 0 && !busy()

  function close(): void {
    setAsking(null)
    setRefusal(null)
    props.onOpenChange(false)
  }

  // The nodes confirmed for the start in flight (to tell a new pick from a loop).
  let confirmedNodes: string[] = []

  function askFor(
    chosen: NodeLevel,
    named: Array<{ nodeId: string; nodeName: string }>,
    held: string[] = [],
  ): boolean {
    if (named.length === 0) return false
    setAsking({ level: chosen, nodes: named, held })
    return true
  }

  const predicted = () => {
    const n = node()
    return n ? [{ nodeId: n.id, nodeName: n.name }] : []
  }

  /** The nodes a 403 names: with names from the server, else from the store. */
  function namedBy(outcome: CreateSessionRefusal): Array<{ nodeId: string; nodeName: string }> {
    if (outcome.nodes?.length) return outcome.nodes
    if (outcome.nodeIds?.length) {
      const ids = outcome.nodeIds
      return nodes()
        .filter((n) => ids.includes(n.id))
        .map((n) => ({ nodeId: n.id, nodeName: n.name }))
    }
    return []
  }

  async function start(confirmationIds: string[] = []): Promise<void> {
    setRefusal(null)
    setBusy(true)
    const chosen = level()
    const outcome = await createSession(api, {
      prompt: prompt().trim(),
      model: model(),
      ...(folder() ? { folderName: folder() } : {}),
      ...(agentId() ? { agentId: agentId() } : {}),
      level: chosen,
      ...(effort() ? { effort: effort() as EffortLevel } : {}),
      ...(autonomous() ? { autonomy: "autonomous" as const } : {}),
      // D42: the default (a pull request) goes unsaid, so an API older than
      // wave 2, whose start body is strict, still starts the session.
      ...(finishWith() !== "pr" ? { finishWith: finishWith() } : {}),
      ...(confirmationIds.length > 0 ? { confirmationIds } : {}),
    }).catch((): CreateSessionRefusal => ({ ok: false, code: "failed" }))
    setBusy(false)
    if (outcome.ok) {
      const session = outcome.session
      applyRow(session)
      close()
      openTab({
        type: "kernel:session",
        entityId: session.id,
        label: session.title,
        routePath: `/sessions/${encodeURIComponent(session.id)}`,
      })
      props.onCreated?.(session)
      return
    }
    if (outcome.code === "confirmation_required") {
      const named = namedBy(outcome)
      const target = named.length > 0 ? named : confirmationIds.length === 0 ? predicted() : []
      // Ask only for a node not confirmed yet: the same refusal again is said, not looped.
      const fresh = target.filter((n) => !confirmedNodes.includes(n.nodeId))
      if (askFor(chosen, fresh, confirmationIds)) return
    }
    setRefusal(outcome)
  }

  function submit(): void {
    if (!canStart()) return
    const chosen = level()
    confirmedNodes = []
    if (levelNeedsConfirmation(profileLevel(), chosen)) {
      setRefusal(null)
      if (!askFor(chosen, predicted())) setRefusal({ ok: false, code: "no_node" })
      return
    }
    void start()
  }

  const refusalText = (r: CreateSessionRefusal) =>
    REFUSAL_KEYS.has(r.code)
      ? i18n.t(`kernel.nodeSessions.refusal.${r.code}`, { agent: agentName() })
      : i18n.t("kernel.computers.actionFailed")

  const field = "min-h-9 w-full rounded-sm border border-border bg-bg px-2 text-[13px] text-text"
  const label = "flex flex-col gap-1 text-[12.5px] text-text-secondary"

  return (
    <>
      <Dialog open={props.open && asking() === null} onOpenChange={(o) => !o && close()}>
        <Dialog.Content>
          <form
            data-testid="new-session-dialog"
            class="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <Dialog.Title>
              {i18n.t("kernel.nodeSessions.newDialog.title", {
                node: node()?.name ?? i18n.t("kernel.nodeSessions.app.noNode"),
              })}
            </Dialog.Title>
            <Show
              when={hasEnabledNode()}
              fallback={
                <p data-testid="new-session-no-node" class="text-[13px] text-text-secondary">
                  {i18n.t("kernel.nodeSessions.newDialog.noNode")}
                </p>
              }
            >
              <label class={label}>
                {i18n.t("kernel.nodeSessions.newDialog.prompt")}
                <textarea
                  ref={promptField}
                  data-testid="new-session-prompt"
                  required
                  rows={4}
                  value={prompt()}
                  onInput={(e) => setPrompt(e.currentTarget.value)}
                  class="w-full rounded-sm border border-border bg-bg px-2 py-1.5 text-[13px] text-text"
                />
              </label>
              {/* The wand stays with the field; the mic sits left of Start. */}
              <div class="-mt-2 flex justify-end gap-0.5">
                <ComposerAssist target={() => promptField} />
              </div>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label class={label}>
                  {i18n.t("kernel.nodeSessions.newDialog.folder")}
                  <select
                    data-testid="new-session-folder"
                    value={folder()}
                    onChange={(e) => setFolder(e.currentTarget.value)}
                    class={field}
                  >
                    <option value="">{i18n.t("kernel.nodeSessions.newDialog.noFolder")}</option>
                    <For each={sharedFolderNames()}>
                      {(name) => <option value={name}>{name}</option>}
                    </For>
                  </select>
                </label>
                <label class={label}>
                  {i18n.t("kernel.nodeSessions.newDialog.model")}
                  <select
                    data-testid="new-session-model"
                    value={model()}
                    onChange={(e) => setModel(e.currentTarget.value)}
                    class={field}
                  >
                    <For each={models()}>{(m) => <option value={m.id}>{m.label}</option>}</For>
                  </select>
                </label>
                <label class={label}>
                  {i18n.t("kernel.nodeSessions.newDialog.agent")}
                  <select
                    data-testid="new-session-agent"
                    value={agentId()}
                    onChange={(e) => {
                      setAgentId(e.currentTarget.value)
                      setLevelTouched(false)
                    }}
                    class={field}
                  >
                    <For each={agents()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
                  </select>
                </label>
                <label class={label}>
                  {i18n.t("kernel.nodeSessions.newDialog.level")}
                  <select
                    data-testid="new-session-level"
                    value={level()}
                    onChange={(e) => {
                      setLevel(e.currentTarget.value as NodeLevel)
                      setLevelTouched(true)
                    }}
                    class={field}
                  >
                    <For each={[...NODE_LEVELS]}>
                      {(l) => <option value={l}>{i18n.t(`kernel.nodeSessions.level.${l}`)}</option>}
                    </For>
                  </select>
                </label>
                <Show when={efforts().length > 0}>
                  <label class={label}>
                    {i18n.t("kernel.nodeSessions.reasoning.label")}
                    <select
                      data-testid="new-session-effort"
                      value={effort()}
                      onChange={(e) => setEffort(e.currentTarget.value as EffortLevel | "")}
                      class={field}
                    >
                      <option value="">{i18n.t("kernel.nodeSessions.reasoning.default")}</option>
                      <For each={efforts()}>
                        {(l) => (
                          <option value={l}>{i18n.t(`kernel.nodeSessions.effort.${l}`)}</option>
                        )}
                      </For>
                    </select>
                  </label>
                </Show>
                <label class={label}>
                  {i18n.t("kernel.nodeSessions.newDialog.finishWith")}
                  <select
                    data-testid="new-session-finish"
                    value={finishWith()}
                    onChange={(e) => setFinishWith(e.currentTarget.value as FinishWith)}
                    class={field}
                  >
                    <For each={[...FINISH_WITH]}>
                      {(f) => (
                        <option value={f}>
                          {i18n.t(`kernel.nodeSessions.newDialog.finish.${f}`)}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
                <div class="flex min-h-11 items-center justify-between gap-2 text-[12.5px] text-text-secondary sm:self-end">
                  {i18n.t("kernel.nodeSessions.autonomy.runOnItsOwn")}
                  <Switch
                    checked={autonomous()}
                    label={i18n.t("kernel.nodeSessions.autonomy.runOnItsOwn")}
                    onChange={setAutonomous}
                    data-testid="new-session-autonomy"
                  />
                </div>
              </div>
              <p class="text-[12px] text-text-tertiary">
                {i18n.t(`kernel.nodeSessions.levelAllows.${level()}`)}
              </p>
              <p class="text-[12px] text-text-tertiary">
                {i18n.t("kernel.nodeSessions.newDialog.hint")}
              </p>
            </Show>
            <Show when={refusal()}>
              {(r) => (
                <div
                  role="alert"
                  data-testid="new-session-refusal"
                  class="text-[12.5px] text-error"
                >
                  <p>{refusalText(r())}</p>
                  <Show when={(r().candidates ?? r().offered ?? []).length > 0}>
                    <p data-testid="new-session-refusal-list" class="mt-1 text-text-secondary">
                      {(r().candidates ?? r().offered ?? []).join(", ")}
                    </p>
                  </Show>
                </div>
              )}
            </Show>
            {/* A take turns this footer into the recorder line. */}
            <div class="mt-2 flex items-center justify-end gap-2">
              <RecorderRow dictation={promptFieldDictation}>
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="new-session-cancel"
                  onClick={close}
                >
                  {i18n.t("kernel.nodeSessions.newDialog.cancel")}
                </Button>
                {/* The prompt only exists with a node to run on. */}
                <Show when={hasEnabledNode()}>
                  <DictationMic dictation={promptFieldDictation} />
                </Show>
                <Button
                  type="submit"
                  data-testid="new-session-start"
                  disabled={!canStart()}
                  loading={busy()}
                >
                  {i18n.t("kernel.nodeSessions.newDialog.start")}
                </Button>
              </RecorderRow>
            </div>
          </form>
        </Dialog.Content>
      </Dialog>
      <Show when={asking()}>
        {(a) => (
          <LevelConfirmDialog
            open={props.open}
            level={a().level}
            purpose="session_start"
            agentId={agentId()}
            agentName={agentName()}
            nodes={a().nodes}
            onCancel={() => setAsking(null)}
            onConfirmed={(ids) => {
              const held = a().held
              confirmedNodes = [...confirmedNodes, ...a().nodes.map((n) => n.nodeId)]
              setAsking(null)
              void start([...held, ...ids])
            }}
          />
        )}
      </Show>
    </>
  )
}
