// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE OWNER'S NODES, LIVE (S18, C10, L27, P2-D5). One source for every
// surface that shows a node: online, name, shared folder names, offered
// models and level pins (GET /api/nodes/me).
//
// - Loaded once per page (`loadNodes`), and again on a socket reconnect or
//   page resume (the resync bus) and on window focus.
// - The API publishes an ephemeral `kernel:node` frame on every change, to the
//   owner only: `{ownerUserId, nodeId, change, online?}`. `applyNodeFrame`
//   applies a `presence` frame's `online` at once, then refetches (debounced
//   250 ms, so a burst of frames is one read); every other change refetches.
// - `onNodeChange` lets a page reload its own sections (the Nodes page reloads
//   profiles and attachments on `profile` and `attachment` frames).
// - Signing out forgets everything.

import type { EffortLevel } from "@liaison/shared"
import { createStore, reconcile } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import type { ApiClient } from "~/lib/api-client"
import { log } from "~/lib/logger"
import { onSessionStart, onSessionTeardown } from "~/lib/session-lifecycle"
import { myNodes, type NodeModel, type NodeSummary } from "./node-api"

export type NodeChange = "presence" | "node" | "capabilities" | "profile" | "attachment" | "removed"

/** The `kernel:node` frame's data (apps/api/src/modules/nodes/node-broadcast.ts). */
export interface NodeChangeFrame {
  ownerUserId?: string
  nodeId: string
  change: NodeChange
  online?: boolean
}

export type NodesStatus = "idle" | "loading" | "ready" | "error"

type Api = Pick<ApiClient, "get">

const REFETCH_DEBOUNCE_MS = 250

const [state, setState] = createStore<{ nodes: NodeSummary[]; status: NodesStatus }>({
  nodes: [],
  status: "idle",
})

let apiOf: () => Api | null = () => null
let lastApi: Api | null = null
let firstLoad: Promise<void> | null = null
let refetchTimer: ReturnType<typeof setTimeout> | null = null
let generation = 0
const listeners = new Set<(frame: NodeChangeFrame) => void>()

/** Where the store's reads go (the kernel API client; null while signed out). */
export function setNodesStoreApi(getter: () => Api | null): void {
  apiOf = getter
}

const currentApi = (): Api | null => apiOf() ?? lastApi

async function read(api: Api): Promise<void> {
  const mine = generation
  if (state.status !== "ready") setState("status", "loading")
  try {
    const nodes = await myNodes(api)
    if (mine !== generation) return
    setState("nodes", reconcile(nodes, { key: "id" }))
    setState("status", "ready")
  } catch (err) {
    if (mine !== generation) return
    log.warn({ err }, "reading the owner's nodes failed")
    // A failed refetch keeps what is shown; only a first load reads as an error.
    if (state.status !== "ready") setState("status", "error")
  }
}

/** The owner's nodes, once per page (pass the API on first use if none is set). */
export function loadNodes(api?: Api): Promise<void> {
  if (api) lastApi = api
  if (firstLoad) return firstLoad
  const target = currentApi()
  if (!target) return Promise.resolve()
  const load = read(target).then(() => {
    // A first load that failed is tried again by the next caller.
    if (state.status === "error" && firstLoad === load) firstLoad = null
  })
  firstLoad = load
  return load
}

/** Read the nodes again now (resync, focus, Retry). */
export function refetchNodes(): Promise<void> {
  const api = currentApi()
  if (!api) return Promise.resolve()
  if (!firstLoad) {
    firstLoad = read(api)
    return firstLoad
  }
  return read(api)
}

function scheduleRefetch(): void {
  if (refetchTimer) clearTimeout(refetchTimer)
  refetchTimer = setTimeout(() => {
    refetchTimer = null
    void refetchNodes()
  }, REFETCH_DEBOUNCE_MS)
}

const CHANGES: ReadonlySet<string> = new Set([
  "presence",
  "node",
  "capabilities",
  "profile",
  "attachment",
  "removed",
])

function isFrame(data: unknown): data is NodeChangeFrame {
  const f = data as Partial<NodeChangeFrame> | null
  return (
    !!f && typeof f.nodeId === "string" && typeof f.change === "string" && CHANGES.has(f.change)
  )
}

/** A `kernel:node` frame from the socket. */
export function applyNodeFrame(data: unknown): void {
  if (!isFrame(data)) return
  if (data.change === "presence" && typeof data.online === "boolean") {
    const index = state.nodes.findIndex((n) => n.id === data.nodeId)
    if (index >= 0) setState("nodes", index, "online", data.online)
  }
  if (data.change === "removed") {
    setState("nodes", (nodes) => nodes.filter((n) => n.id !== data.nodeId))
  }
  for (const listener of [...listeners]) {
    try {
      listener(data)
    } catch (err) {
      log.warn({ err }, "a node change listener failed")
    }
  }
  scheduleRefetch()
}

/** Run `listener` on every node frame. Returns the unregister. */
export function onNodeChange(listener: (frame: NodeChangeFrame) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function nodes(): NodeSummary[] {
  return state.nodes
}

export function nodesStatus(): NodesStatus {
  return state.status
}

export function nodeById(id: string | null | undefined): NodeSummary | undefined {
  if (!id) return undefined
  return state.nodes.find((n) => n.id === id)
}

export function nodeOnline(id: string | null | undefined): boolean {
  return nodeById(id)?.online === true
}

/** True when the owner has an enabled node (live, L27). */
export function hasEnabledNode(): boolean {
  return state.nodes.some((n) => n.enabled)
}

/**
 * The nodes a conversation can run on right now: enabled and online. "My node"
 * is offered only while one is (a node that is off answers nothing). A demo's
 * recorded computer (`simulated`) is never offered: it only plays its replay.
 */
export function availableNodes(): NodeSummary[] {
  return state.nodes.filter((n) => n.enabled && n.online && !n.simulated)
}

/**
 * The node a conversation's node runtime runs on: the one it names, else (a
 * runtime stored before it named one: any of the owner's nodes) the only
 * enabled node, else the first online. Undefined when none stands for it.
 */
export function nodeForRun(nodeId: string | null | undefined): NodeSummary | undefined {
  if (nodeId) return nodeById(nodeId)
  const enabled = state.nodes.filter((n) => n.enabled && !n.simulated)
  return enabled.length === 1 ? enabled[0] : availableNodes()[0]
}

/** The folder names every enabled node shares, deduplicated, in order of first appearance. */
export function sharedFolderNames(): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const n of state.nodes) {
    if (!n.enabled) continue
    for (const name of n.sharedFolderNames ?? []) {
      if (seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

/**
 * The models one node offers, or with no node given the union over the
 * enabled nodes (deduplicated by id).
 */
export function modelsFor(nodeId?: string | null): NodeModel[] {
  if (nodeId) return [...(nodeById(nodeId)?.models ?? [])]
  const out: NodeModel[] = []
  const seen = new Set<string>()
  for (const n of state.nodes) {
    if (!n.enabled) continue
    for (const m of n.models ?? []) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push(m)
    }
  }
  return out
}

/**
 * S25: the reasoning levels a node's model supports, in the node's order;
 * empty when the model publishes none (or the node predates the field).
 */
export function effortsFor(nodeId: string | null | undefined, modelId: string): EffortLevel[] {
  const model = modelsFor(nodeId).find((m) => m.id === modelId)
  return [...(model?.efforts ?? [])]
}

/**
 * The page's socket connected for the first time. A node change published
 * between the first read and the socket's hello never replays (frames are
 * ephemeral), and the resync bus skips that first connect: the demo's recorded
 * laptop, prepared as its scenario starts with the page, stayed off Sessions
 * ("No computer yet"). Read again once; reconnects go through the resync bus.
 */
export function nodesSocketConnected(): void {
  if (firstLoad) scheduleRefetch()
}

let uninstall: (() => void) | null = null

/** Wire the resync bus (socket reconnect, page resume) and window focus. Idempotent. */
export function installNodesStoreSync(): void {
  if (uninstall) return
  const onResync = () => {
    if (firstLoad) void refetchNodes()
  }
  const unsubscribe = subscribeResync(onResync)
  const win = typeof window !== "undefined" ? window : null
  win?.addEventListener("focus", onResync)
  uninstall = () => {
    unsubscribe()
    win?.removeEventListener("focus", onResync)
  }
}

/** Forget every node (sign-out), so the next account never sees them. */
export function resetNodesStore(): void {
  generation++
  if (refetchTimer) clearTimeout(refetchTimer)
  refetchTimer = null
  firstLoad = null
  lastApi = null
  setState({ nodes: [], status: "idle" })
}

onSessionTeardown(resetNodesStore)
// A sign-in without a page reload (or a restored token) reads the nodes again:
// sign-out left the store empty with no API remembered (m4).
onSessionStart(() => void loadNodes())
