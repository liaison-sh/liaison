// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE ROUTES, typed (P4, spec-node.md, A17, A25, F7, F11). The server
// side is N-S T1-T3; the shapes here are the spec's and this file is the one
// place the client names them.
//
//   POST   /api/nodes                  enable: bind (owner, WS deviceId) -> node credential
//   PATCH  /api/nodes/:id              { name?, enabled? }
//   GET    /api/nodes/me               { nodes: NodeSummary[] } (status + queue counts)
//   DELETE /api/nodes/:id              forget the node, revoke its credential
//   GET    /api/nodes/me/profiles      one per (owner, agent): level, Liaison tools, each node's confirmed level
//   PUT    /api/nodes/me/profiles/:agentId  { level, liaisonTools, confirmationIds? }; 403 confirmation_required
//   POST   /api/me/node-level-confirmations { nodeId, agentId | sessionId, level, purpose } -> { confirmationId, expiresAt }
//   GET    /api/nodes/me/attachments   (owner, agent) attachments with caps
//   POST   /api/nodes/me/attachments   { agentId, maxJobsPerDay?, maxTokensPerDay? }
//   PATCH  /api/nodes/attachments/:id  { allowedRequesters?, maxJobsPerDay?, maxTokensPerDay? }
//   DELETE /api/nodes/attachments/:id

import type { EffortLevel, NodeGuardrailLevel, NodeLevel } from "@liaison/shared"
import type { ApiClient } from "~/lib/api-client"
import type { DesktopBridge } from "~/lib/desktop-shell-contract"

export type NodeOs = DesktopBridge["platform"]

export interface NodeSummary {
  id: string
  name: string
  enabled: boolean
  /** From the live presence registry (F12). */
  online: boolean
  /** A demo org's recorded computer: no machine behind it, its session is a replay. */
  simulated?: boolean
  lastSeenAt: string | null
  os: string | null
  appVersion: string | null
  /** The WS deviceId the node is bound to (F11). */
  deviceId: string
  queue: { queued: number; running: number }
  /** D35 (G8): the live-session caps (walk D23 edits them). */
  maxLiveSessions?: number
  maxLiveBackground?: number
  /** The names of the folders the node shares (C1); never a path. */
  sharedFolderNames?: string[]
  /** A shared folder inside another one (a repo in it), by name: the holder's name. */
  sharedFolderWithin?: Record<string, string>
  /** The models the node's Claude sign-in offers (S3). */
  models?: NodeModel[]
  /** The level each agent runs at on this node today (D42); none reads as Strict. */
  levelPins?: Array<{ agentId: string; level: NodeLevel }>
}

/** A model a node offers. */
export interface NodeModel {
  id: string
  label: string
  /** S25: the reasoning levels the model supports (absent: none published). */
  efforts?: EffortLevel[]
}

export interface EnableNodeRequest {
  deviceId: string
  os: NodeOs
  name?: string
  appVersion?: string
}

export interface EnableNodeResponse {
  node: NodeSummary
  /** The node credential (A25). Answered once; the shell keeps it. */
  credential: string
}

export interface UpdateNodeRequest {
  name?: string
  enabled?: boolean
  /** D35 (G8): live session processes on the node, and how many may be background. */
  maxLiveSessions?: number
  maxLiveBackground?: number
}

/** One of the owner's enabled nodes, and the level it has confirmed for an agent (D42). */
export interface NodeProfileNode {
  nodeId: string
  nodeName: string
  /** What the node runs this agent at today: Strict until it publishes a pin. */
  confirmedLevel: NodeLevel
  /** When the node was last seen: tells same-named computers apart (D6). */
  lastSeenAt?: string | null
}

/** A profile is a level and the Liaison tools switch (S20, D18, D24). */
export interface NodeProfileSummary {
  id: string
  agentId: string
  agentName: string | null
  level: NodeLevel
  liaisonTools: boolean
  /** D18: the level suggested for the agent's Claude model, and why. */
  suggestedGuardrail?: NodeGuardrailLevel | null
  riskNote?: string | null
  updatedAt: string
  nodes: NodeProfileNode[]
}

export interface SaveProfileRequest {
  level: NodeLevel
  liaisonTools: boolean
  /** D24, D42: one `profile_raise` confirmation per node that needs one. */
  confirmationIds?: string[]
}

/**
 * D24, D41: what a confirmation is for. A profile raise or a new session names
 * the agent; a raise of a running session names the session.
 */
export type ConfirmLevelRequest = { nodeId: string; level: NodeLevel } & (
  | { purpose: "profile_raise" | "session_start"; agentId: string }
  | { purpose: "session_raise"; sessionId: string }
)

export interface LevelConfirmation {
  confirmationId: string
  expiresAt: string
}

export interface NodeRequester {
  type: "user" | "agent"
  id: string
  name?: string | null
}

export interface NodeAttachmentSummary {
  id: string
  agentId: string
  /** The node the attachment names, or null for any of the owner's nodes. */
  nodeId?: string | null
  agentName: string | null
  /** D18: the agent's model and the guardrail level suggested for it. */
  agentModel?: string | null
  suggestedGuardrail?: NodeGuardrailLevel
  allowedRequesters: NodeRequester[]
  maxJobsPerDay: number
  maxTokensPerDay: number
}

export interface AttachAgentRequest {
  agentId: string
  maxJobsPerDay?: number
  maxTokensPerDay?: number
}

type Api = Pick<ApiClient, "get" | "post" | "patch" | "put" | "delete">

export const NODE_ROUTES = {
  nodes: "/nodes",
  me: "/nodes/me",
  node: (id: string) => `/nodes/${encodeURIComponent(id)}`,
  profiles: "/nodes/me/profiles",
  levelConfirmations: "/me/node-level-confirmations",
  profile: (agentId: string) => `/nodes/me/profiles/${encodeURIComponent(agentId)}`,
  attachments: "/nodes/me/attachments",
  attachment: (id: string) => `/nodes/attachments/${encodeURIComponent(id)}`,
} as const

export function enableNode(api: Pick<Api, "post">, body: EnableNodeRequest) {
  return api.post<EnableNodeResponse>(NODE_ROUTES.nodes, body)
}

export function updateNode(api: Pick<Api, "patch">, id: string, body: UpdateNodeRequest) {
  return api.patch<{ node: NodeSummary }>(NODE_ROUTES.node(id), body)
}

export async function myNodes(api: Pick<Api, "get">): Promise<NodeSummary[]> {
  const res = await api.get<{ nodes?: NodeSummary[] }>(NODE_ROUTES.me)
  return Array.isArray(res?.nodes) ? res.nodes : []
}

export function deleteNode(api: Pick<Api, "delete">, id: string) {
  return api.delete<void>(NODE_ROUTES.node(id))
}

async function list<T>(api: Pick<Api, "get">, path: string): Promise<T[]> {
  const res = await api.get<T[]>(path)
  return Array.isArray(res) ? res : []
}

export function nodeProfiles(api: Pick<Api, "get">) {
  return list<NodeProfileSummary>(api, NODE_ROUTES.profiles)
}

export function nodeAttachments(api: Pick<Api, "get">) {
  return list<NodeAttachmentSummary>(api, NODE_ROUTES.attachments)
}

export function attachAgent(api: Pick<Api, "post">, body: AttachAgentRequest) {
  return api.post<NodeAttachmentSummary>(NODE_ROUTES.attachments, body)
}

export function detachAgent(api: Pick<Api, "delete">, id: string) {
  return api.delete<void>(NODE_ROUTES.attachment(id))
}

/**
 * One agent's profile: its level and the Liaison tools switch. A 403
 * `confirmation_required` is the editor's to handle (it asks again), so the
 * global error toast stays out of it.
 */
export function saveNodeProfile(api: Pick<Api, "put">, agentId: string, body: SaveProfileRequest) {
  return api.put<
    Omit<NodeProfileSummary, "id" | "agentName" | "updatedAt" | "nodes"> & {
      /** D7: a Confirm on some computers saved; these still need theirs. */
      unconfirmedNodeIds?: string[]
    }
  >(NODE_ROUTES.profile(agentId), body, { suppressGlobalError: true })
}

/** D24: the owner's in-app confirmation of a level for one node and one agent. */
export function confirmLevel(api: Pick<Api, "post">, body: ConfirmLevelRequest) {
  return api.post<LevelConfirmation>(NODE_ROUTES.levelConfirmations, body, {
    suppressGlobalError: true,
  })
}

/** Who may ask an attached agent (A17), and its daily caps. */
export function updateAttachment(
  api: Pick<Api, "patch">,
  id: string,
  body: {
    allowedRequesters?: Array<{ type: "user" | "agent"; id: string }>
    maxJobsPerDay?: number
    maxTokensPerDay?: number
  },
) {
  return api.patch<NodeAttachmentSummary>(NODE_ROUTES.attachment(id), body)
}
