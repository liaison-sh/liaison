// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE AGENT'S LEVEL ON YOUR COMPUTERS (S20, D18, D24, D42, K6, K18), as the
// computer's Agents tab edits it: the level its sessions run at and whether
// they get the Liaison tools. The level the agent's model suggests is marked,
// and the risk note says why.
//
// A raise is confirmed HERE, in the app, never on the computer (D24): choosing
// a higher level, or Open (always, K18), opens the shared LevelConfirmDialog
// naming the level, what it allows and the computers it applies to. Nothing
// changes until Confirm, which posts one `profile_raise` confirmation per such
// computer and then saves with their ids; Cancel saves nothing and puts the
// choice back. The computer whose page this is says when its confirmed level
// is below the saved one, with its own Confirm (K6). A 403
// `confirmation_required` (a computer enrolled meanwhile) reads the computers
// again and asks for the ones that need it.
//
// The profile is the agent's, on every computer of the owner's: the server
// keeps one level per agent, each computer confirming it.

import {
  levelNeedsConfirmation,
  levelRank,
  minLevel,
  NODE_DEFAULT_LEVEL,
  type NodeLevel,
  suggestedNodeGuardrail,
} from "@liaison/shared"
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { LevelConfirmDialog } from "~/modules/nodes/LevelConfirmDialog"
import {
  myNodes,
  type NodeProfileNode,
  type NodeProfileSummary,
  nodeProfiles,
  saveNodeProfile,
} from "~/modules/nodes/node-api"
import { distinctNodeLabels } from "~/modules/nodes/node-labels"
import { useApi } from "~/modules/shell/ApiContext"

export interface AgentProfileOptions {
  agentId: string
  agentName: string
  agentModel: () => string | null
  /** The saved profile, as the page last read it (null: none saved yet). */
  profile: () => NodeProfileSummary | null
  /** The computer whose page this is: its own "not confirmed yet". */
  nodeId: string
  onSaved: (profile: NodeProfileSummary) => void
}

interface Asking {
  level: NodeLevel
  nodes: NodeProfileNode[]
}

export type ProfileStatus = "idle" | "saving" | "saved" | "error"

export function useAgentProfile(opts: AgentProfileOptions) {
  const i18n = useI18n()
  const api = useApi()
  const suggested = createMemo(() => suggestedNodeGuardrail(opts.agentModel()))
  const [savedLevel, setSavedLevel] = createSignal<NodeLevel>(
    opts.profile()?.level ?? NODE_DEFAULT_LEVEL,
  )
  const [level, setLevel] = createSignal<NodeLevel>(opts.profile()?.level ?? NODE_DEFAULT_LEVEL)
  const [liaisonTools, setLiaisonTools] = createSignal(opts.profile()?.liaisonTools ?? true)
  const [savedTools, setSavedTools] = createSignal(liaisonTools())
  // The computers and what each has confirmed for this agent; null until read
  // (an agent with no saved profile yet).
  const [nodes, setNodes] = createSignal<NodeProfileNode[] | null>(opts.profile()?.nodes ?? null)
  const [asking, setAsking] = createSignal<Asking | null>(null)
  const [status, setStatus] = createSignal<ProfileStatus>("idle")

  // A profile read again (a `profile` frame) is shown, unless a change is under way.
  createEffect(
    on(
      opts.profile,
      (p) => {
        if (!p || status() === "saving" || asking()) return
        setSavedLevel(p.level)
        setLevel(p.level)
        setLiaisonTools(p.liaisonTools)
        setSavedTools(p.liaisonTools)
        if (Array.isArray(p.nodes)) setNodes(p.nodes)
      },
      { defer: true },
    ),
  )

  /** The computers a save at `chosen` must be confirmed on (D42, the server's own rule). */
  const needing = (chosen: NodeLevel, list: readonly NodeProfileNode[]) =>
    list.filter((n) => levelNeedsConfirmation(minLevel(savedLevel(), n.confirmedLevel), chosen))

  /** D6: each computer's name, with what tells it apart from a same-named one. */
  const labels = createMemo(() => distinctNodeLabels(nodes() ?? [], i18n))
  const named = (list: readonly NodeProfileNode[]) =>
    list.map((n) => ({ ...n, nodeName: labels().get(n.nodeId) ?? n.nodeName }))

  /** This computer, when its confirmed level is below the saved one (K6). */
  const unconfirmedHere = () =>
    (nodes() ?? []).find(
      (n) => n.nodeId === opts.nodeId && levelRank(n.confirmedLevel) < levelRank(savedLevel()),
    ) ?? null

  async function knownNodes(): Promise<NodeProfileNode[]> {
    const known = nodes()
    if (known) return known
    // No saved profile: every enabled computer runs this agent at Strict.
    const list = (await myNodes(api))
      .filter((n) => n.enabled)
      .map((n) => ({
        nodeId: n.id,
        nodeName: n.name,
        confirmedLevel: NODE_DEFAULT_LEVEL,
        lastSeenAt: n.lastSeenAt,
      }))
    setNodes(list)
    return list
  }

  async function freshNodes(): Promise<NodeProfileNode[]> {
    const mine = (await nodeProfiles(api)).find((p) => p.agentId === opts.agentId)
    if (mine && Array.isArray(mine.nodes)) {
      setNodes(mine.nodes)
      return mine.nodes
    }
    setNodes(null)
    return knownNodes()
  }

  async function put(
    chosen: NodeLevel,
    confirmationIds: string[],
    // The computers the dialog asked about: it is closed before the save (m8),
    // so they travel here rather than being read back from `asking()` (D7).
    asked: readonly NodeProfileNode[] = [],
  ): Promise<void> {
    // One save at a time: a second click never posts a second save (m8).
    if (status() === "saving") return
    setStatus("saving")
    try {
      const saved = await saveNodeProfile(api, opts.agentId, {
        level: chosen,
        liaisonTools: liaisonTools(),
        ...(confirmationIds.length > 0 ? { confirmationIds } : {}),
      })
      setSavedLevel(chosen)
      setLevel(chosen)
      setSavedTools(liaisonTools())
      // D7: the computers just confirmed run it from their next session; the
      // ones the server still names stay unconfirmed.
      const still = new Set(saved.unconfirmedNodeIds ?? [])
      const confirmed = new Set(asked.map((n) => n.nodeId).filter((id) => !still.has(id)))
      if (confirmationIds.length > 0 && confirmed.size > 0) {
        setNodes((list) =>
          list
            ? list.map((n) =>
                confirmed.has(n.nodeId) && levelRank(n.confirmedLevel) < levelRank(chosen)
                  ? { ...n, confirmedLevel: chosen }
                  : n,
              )
            : list,
        )
      }
      setAsking(null)
      setStatus("saved")
      opts.onSaved({
        id: opts.profile()?.id ?? opts.agentId,
        agentName: opts.profile()?.agentName ?? opts.agentName,
        updatedAt: new Date().toISOString(),
        ...saved,
        agentId: opts.agentId,
        level: chosen,
        liaisonTools: liaisonTools(),
        nodes: nodes() ?? [],
      })
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && err.code === "confirmation_required") {
        const ask = needing(chosen, await freshNodes().catch(() => []))
        if (ask.length > 0) {
          setStatus("idle")
          setAsking({ level: chosen, nodes: ask })
          return
        }
      }
      setAsking(null)
      setLevel(savedLevel())
      setLiaisonTools(savedTools())
      setStatus("error")
    }
  }

  /** A level chosen in the select: saved at once, or asked first when it is a raise. */
  async function choose(chosen: NodeLevel): Promise<void> {
    setLevel(chosen)
    let list: NodeProfileNode[]
    try {
      list = await knownNodes()
    } catch {
      setLevel(savedLevel())
      setLiaisonTools(savedTools())
      setStatus("error")
      return
    }
    const ask = needing(chosen, list)
    if (ask.length > 0) {
      setAsking({ level: chosen, nodes: ask })
      return
    }
    await put(chosen, [])
  }

  /** The Liaison tools switch: saved with the saved level (asked first where that level needs it). */
  async function setTools(on: boolean): Promise<void> {
    setLiaisonTools(on)
    await choose(savedLevel())
  }

  /** K6: confirm the saved level on this computer, and save it again. */
  function confirmHere(): void {
    const node = unconfirmedHere()
    if (node) setAsking({ level: savedLevel(), nodes: [node] })
  }

  const ConfirmDialog = () => (
    <Show when={asking()}>
      {(a) => (
        <LevelConfirmDialog
          open
          level={a().level}
          purpose="profile_raise"
          agentId={opts.agentId}
          agentName={opts.agentName}
          nodes={named(a().nodes)}
          onCancel={() => {
            setAsking(null)
            setLevel(savedLevel())
            setLiaisonTools(savedTools())
          }}
          onConfirmed={(ids) => {
            // Close at once: the dialog's Confirm must not stay live while the save runs (m8).
            const chosen = a().level
            const asked = a().nodes
            setAsking(null)
            void put(chosen, ids, asked)
          }}
        />
      )}
    </Show>
  )

  return {
    level,
    savedLevel,
    suggested,
    liaisonTools,
    status,
    unconfirmedHere,
    choose,
    setTools,
    confirmHere,
    ConfirmDialog,
  }
}
