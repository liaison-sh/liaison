// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The node job client's two real halves (runner.ts): the server's node job
// routes (job-routes.ts: the owner's session AND the node credential on every
// node call), and the shell's node job commands (src-tauri/src/node_job.rs).

import { NODE_FOLLOW_WHY, type NodeFollowWhy } from "@liaison/shared/node-import"
import { NODE_PROTOCOL_IMPORT, parseNodeCommandPull } from "@liaison/shared/node-session-protocol"
import {
  composeAgentDefinitionText,
  fetchAgentDefinition,
} from "../session/agent-definition-client"
import { invoke, listen } from "../tauri"
import type { PulledCommand } from "./commands"
import type { FolderRequestHttp } from "./folder-requests"
import type { ImportRequestHttp } from "./import-requests"
import {
  type BacklogJob,
  type ClaimedJob,
  NodeHttpError,
  type NodeJobHttp,
  type NodeJobShell,
  type NodeJobView,
  NodeShellRefusal,
  type PermissionStatus,
  type ReportedPosition,
  type RunExit,
  type RunLine,
  type ShellLiveRun,
} from "./runner"

/** The header a node presents its credential in (credentials.ts). */
export const NODE_CREDENTIAL_HEADER = "X-Node-Credential"

/**
 * The node protocol this runner speaks on every claim (D46; older nodes get
 * 409 node_outdated). 3: applies mark_done and set_effort live, and posts the
 * run's completion with its result (S1, S7, S24). 4: also applies
 * set_autonomy live (S33, A28); an older node gets the row change only. 5:
 * also runs follow jobs in the shell's follow host (S40, A45): a follow is
 * never offered to, and is refused from, an older node.
 */
export const NODE_PROTOCOL_HEADER = "X-Liaison-Node-Protocol"
export const NODE_PROTOCOL_VERSION = String(NODE_PROTOCOL_IMPORT)

export interface NodeHttpSource {
  serverAddress: () => string | null
  accessToken: () => string | null
  nodeCredential: () => Promise<string | null>
  /**
   * Renews the window's access token (P1-walk D12): the page's own single
   * flight refresh, so the node never rotates the refresh token beside it.
   * True when a new token is in place.
   */
  refreshAccessToken?: () => Promise<boolean>
}

/**
 * W2-D4: after a 401 on a call made with token `sent`, whether a newer token
 * is now in place. The window may already have rotated it (its own refresh
 * ran while the call was in flight): then a forced refresh compares against
 * the already-new token and answers false, and the call was never retried.
 * So a token that differs from the one sent counts, refreshed here or not.
 */
async function renewedSince(source: NodeHttpSource, sent: string | null): Promise<boolean> {
  const differs = () => {
    const now = source.accessToken()
    return now !== null && now !== sent
  }
  if (differs()) return true
  if (!source.refreshAccessToken) return false
  const renewed = await source.refreshAccessToken().catch(() => false)
  return renewed || differs()
}

export function nodeJobHttp(source: NodeHttpSource): NodeJobHttp {
  const tokenRenewedSince = (sent: string | null) => renewedSince(source, sent)
  /**
   * One call, and when the server answers 401 (an access token that expired
   * while the window sat idle, D12) one more with a fresh token. A refresh
   * that fails leaves the 401 to the caller.
   */
  async function withFreshToken<T>(send: () => Promise<T>): Promise<T> {
    // `send` reads the token before its first await, so this is the token
    // the call presented.
    const sent = source.accessToken()
    try {
      return await send()
    } catch (error) {
      if (
        !(error instanceof NodeHttpError) ||
        error.status !== 401 ||
        error.code === "signed_out" ||
        error.code === "no_node_credential"
      ) {
        throw error
      }
      if (!(await tokenRenewedSince(sent))) throw error
      return send()
    }
  }
  function call<T>(
    method: string,
    path: string,
    body?: unknown,
    node = true,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    return withFreshToken(() => send<T>(method, path, body, node, extraHeaders))
  }
  async function send<T>(
    method: string,
    path: string,
    body: unknown,
    node: boolean,
    extraHeaders: Record<string, string>,
    onServer?: (server: string) => void,
  ): Promise<T> {
    const server = source.serverAddress()?.replace(/\/+$/, "")
    const token = source.accessToken()
    if (!server || !token) throw new NodeHttpError(401, "signed_out")
    onServer?.(server)
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...extraHeaders }
    if (body !== undefined) headers["Content-Type"] = "application/json"
    if (node) {
      const credential = await source.nodeCredential()
      if (!credential) throw new NodeHttpError(401, "no_node_credential")
      headers[NODE_CREDENTIAL_HEADER] = credential
    }
    const response = await fetch(`${server}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const parsed = (await response.json().catch(() => ({}))) as {
      data?: T
      error?: { code?: string; message?: string } & Record<string, unknown>
    }
    if (!response.ok) {
      const { code, message, ...details } = parsed.error ?? {}
      throw new NodeHttpError(
        response.status,
        typeof code === "string" ? code : "http_error",
        typeof message === "string" ? message : undefined,
        details,
      )
    }
    return parsed.data as T
  }
  const job = (id: string, action: string) => `/nodes/jobs/${encodeURIComponent(id)}/${action}`
  return {
    getJob: async (id) => {
      try {
        const row = await call<NodeJobView>(
          "GET",
          `/nodes/jobs/${encodeURIComponent(id)}`,
          undefined,
          false,
        )
        return row && typeof row.agentId === "string" ? row : null
      } catch (error) {
        if (error instanceof NodeHttpError && error.status === 404) return null
        throw error
      }
    },
    // B2-1 (D52): the answer is tagged with the server it came from (never a
    // field the server sends), and every start of the job names that server.
    claim: async (id, mcpConnectionId) => {
      let answeredBy = ""
      const answer = await withFreshToken(() =>
        send<ClaimedJob>(
          "POST",
          job(id, "claim"),
          mcpConnectionId ? { mcpConnectionId } : {},
          true,
          { [NODE_PROTOCOL_HEADER]: NODE_PROTOCOL_VERSION },
          (server) => {
            answeredBy = server
          },
        ),
      )
      return { ...answer, claimedFrom: answeredBy }
    },
    postEvents: (sessionId, body) =>
      call<{ lastSeq: number }>(
        "POST",
        `/node/sessions/${encodeURIComponent(sessionId)}/events`,
        body,
      ),
    started: async (id, leaseGeneration) => {
      await call("POST", job(id, "started"), { leaseGeneration })
    },
    heartbeat: async (id, leaseGeneration) => {
      await call("POST", job(id, "heartbeat"), { leaseGeneration })
    },
    result: async (id, body) => {
      await call("POST", job(id, "result"), body)
    },
    fail: async (id, body) => {
      await call("POST", job(id, "fail"), body)
    },
    backlog: async () => {
      const rows = await call<BacklogJob[]>(
        "GET",
        "/nodes/me/jobs?status=queued&backlog=1",
        undefined,
        false,
      )
      return Array.isArray(rows) ? rows : []
    },
    rerun: async (id) => {
      await call("POST", job(id, "rerun"), undefined, false)
    },
    permissionRequest: (id, body) =>
      call<{ id: string; status: PermissionStatus; refused?: string }>(
        "POST",
        job(id, "permission-requests"),
        body,
      ),
    turnProgress: async (id, body) => {
      await call("POST", job(id, "turn-progress"), body)
    },
    // The owner's own read (the node polls it): the session is enough.
    permissionStatus: (promptId) =>
      call<{ status: PermissionStatus }>(
        "GET",
        `/nodes/permission-requests/${encodeURIComponent(promptId)}`,
        undefined,
        false,
      ).then((row) => ({ status: row?.status ?? "pending" })),
    // P3-T22 (S7): the full text as text/plain; an empty body marked gone when
    // this computer no longer has it.
    putFullOutput: (sessionId, toolUseId, text) =>
      withFreshToken(async () => {
        const server = source.serverAddress()?.replace(/\/+$/, "")
        const token = source.accessToken()
        if (!server || !token) throw new NodeHttpError(401, "signed_out")
        const credential = await source.nodeCredential()
        if (!credential) throw new NodeHttpError(401, "no_node_credential")
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          [NODE_CREDENTIAL_HEADER]: credential,
          "Content-Type": "text/plain; charset=utf-8",
          ...(text === null ? { "X-Full-Output": "gone" } : {}),
        }
        const response = await fetch(
          `${server}/api/node/sessions/${encodeURIComponent(sessionId)}/full-output/${encodeURIComponent(toolUseId)}`,
          { method: "PUT", headers, body: text ?? "" },
        )
        if (!response.ok) throw new NodeHttpError(response.status, "http_error")
      }),
    // P3 (C5): the unacked commands of this node's current runs.
    getCommands: async () => {
      // Walk D1: the server answers `data: {commands: [...]}`; the shared parser
      // is the one both sides are tested against (routes-node.test.ts).
      const data = await call<unknown>("GET", "/node/sessions/commands?unacked=1")
      return parseNodeCommandPull(data) satisfies PulledCommand[]
    },
    // P3 (D36): the runs alive here, on every (re)connect.
    report: async (sessions) => {
      const answer = await call<{ sessions?: ReportedPosition[] }>(
        "POST",
        "/node/sessions/report",
        { sessions },
      )
      return { sessions: Array.isArray(answer?.sessions) ? answer.sessions : [] }
    },
    definition: async (agentId, threadId) => {
      const serverAddress = source.serverAddress()
      const accessToken = source.accessToken()
      if (!serverAddress || !accessToken) throw new NodeHttpError(401, "signed_out")
      return composeAgentDefinitionText(
        await fetchAgentDefinition(agentId, {
          serverAddress,
          accessToken,
          runtime: "node",
          threadId: threadId ?? null,
        }),
      )
    },
  }
}

/** A listener on a shell event, usable synchronously (the unlisten lands later). */
function onEvent(event: string, listener: (payload: unknown) => void): () => void {
  let off: (() => void) | null = null
  let cancelled = false
  void listen<unknown>(event, (e) => listener(e.payload)).then((unlisten) => {
    if (cancelled) unlisten()
    else off = unlisten
  })
  return () => {
    cancelled = true
    off?.()
  }
}

/** A run's line as the shell emits it (node_job.rs): `{sessionId?, jobId, line, index?}`. */
function runLine(payload: unknown): RunLine | null {
  const p = payload as Partial<RunLine> | null
  if (!p || typeof p !== "object" || typeof p.jobId !== "string" || typeof p.line !== "string") {
    return null
  }
  return {
    ...(typeof p.sessionId === "string" ? { sessionId: p.sessionId } : {}),
    jobId: p.jobId,
    line: p.line,
    ...(Number.isInteger(p.index) ? { index: p.index as number } : {}),
  }
}

/** A follow's end as the shell emits it (node_follow.rs): a known why, and an offset only with one that has it. */
function followEnd(value: unknown): RunExit["follow"] | null {
  const f = value as { why?: unknown; endOffset?: unknown } | null
  if (!f || typeof f !== "object" || !(NODE_FOLLOW_WHY as readonly unknown[]).includes(f.why)) {
    return null
  }
  const why = f.why as NodeFollowWhy
  const offset = f.endOffset
  return Number.isSafeInteger(offset) &&
    (offset as number) >= 0 &&
    (why === "replayed" || why === "owner")
    ? { why, endOffset: offset as number }
    : { why }
}

function runExit(payload: unknown): RunExit | null {
  const p = payload as (Partial<RunExit> & { follow?: unknown }) | null
  if (!p || typeof p !== "object" || typeof p.jobId !== "string") return null
  const follow = followEnd(p.follow)
  return {
    ...(typeof p.sessionId === "string" ? { sessionId: p.sessionId } : {}),
    jobId: p.jobId,
    ...(follow ? { follow } : {}),
  }
}

export function nodeJobShell(accessToken: () => string | null): NodeJobShell {
  return {
    startJob: async (request) => {
      try {
        // K25: the window's session rides along for the shell's consume call
        // only; the shell never writes it into the job file.
        await invoke("start_node_job", { request: { ...request, accessToken: accessToken() } })
      } catch (error) {
        throw new NodeShellRefusal(typeof error === "string" ? error : String(error))
      }
    },
    stopJob: async (sessionId, jobId) => {
      await invoke("stop_node_job", { sessionId: sessionId ?? null, jobId: jobId ?? null })
    },
    // A45: a follow runs in the node's one follow host; it calls no server,
    // so no session token rides along.
    startFollow: async (request) => {
      try {
        await invoke("start_node_follow", { request })
      } catch (error) {
        throw new NodeShellRefusal(typeof error === "string" ? error : String(error))
      }
    },
    stopFollow: async (sessionId, jobId) =>
      (await invoke<boolean>("stop_node_follow", { sessionId, jobId })) === true,
    writeSession: async (sessionId, line) =>
      (await invoke<boolean>("node_session_write", { sessionId, line })) === true,
    onLine: (listener) =>
      onEvent("node-job-line", (payload) => {
        const line = runLine(payload)
        if (line) listener(line)
      }),
    onExit: (listener) =>
      onEvent("node-job-exit", (payload) => {
        const exit = runExit(payload)
        if (exit) listener(exit)
      }),
    ensureConnection: async (agentId) => {
      const id = await invoke<string | null>("ensure_node_agent_connection", {
        agentId,
        accessToken: accessToken(),
      })
      return typeof id === "string" && id.length > 0 ? id : null
    },
    confirmConnection: async (agentId, agentName) => {
      const answer = await invoke<{ confirmed?: boolean; connected?: boolean }>(
        "confirm_node_connection",
        { agentId, agentName, accessToken: accessToken() },
      )
      return { confirmed: answer?.confirmed === true, connected: answer?.connected === true }
    },
    connectionFor: async (agentId) => {
      const id = await invoke<string | null>("node_job_connection", { agentId })
      return typeof id === "string" && id.length > 0 ? id : null
    },
    answerPermission: async (requestId, allow, message) => {
      await invoke("answer_node_job_permission", {
        requestId,
        allow,
        message: message ?? null,
      })
    },
    spill: async (sessionId, toolUseId) => {
      const text = await invoke<string | null>("node_session_spill", { sessionId, toolUseId })
      return typeof text === "string" ? text : null
    },
    // P3 (L3, G6): the runs the shell kept, their outbox and posting position.
    liveSessions: async () => {
      const runs = await invoke<ShellLiveRun[]>("node_live_sessions")
      return Array.isArray(runs) ? runs : []
    },
    outbox: async (sessionId, jobId, fromIndex, max) => {
      const lines = await invoke<Array<{ index: number; line: string }>>("node_session_outbox", {
        sessionId,
        jobId,
        fromIndex,
        max,
      })
      return Array.isArray(lines) ? lines : []
    },
    ack: async (sessionId, jobId, index, batchNo) => {
      await invoke("node_session_ack", { sessionId, jobId, index, batchNo })
    },
    acked: async (sessionId, jobId) => {
      const answer = await invoke<{ index?: number; batchNo?: number }>("node_session_acked", {
        sessionId,
        jobId,
      })
      return {
        index: Number.isInteger(answer?.index) ? (answer.index as number) : 0,
        batchNo: Number.isInteger(answer?.batchNo) ? (answer.batchNo as number) : 0,
      }
    },
  }
}

/**
 * The node's half of the folder requests (folder-requests.ts): pull one
 * (404: gone or not this node's, answered null) and put its answer back, with
 * the node credential, and one retry after a token refresh on 401.
 */
export function nodeFolderHttp(source: NodeHttpSource): FolderRequestHttp {
  return nodeRequestHttp(source, "folder-requests")
}

/** The same for the session import requests (import-requests.ts, S40). */
export function nodeImportHttp(source: NodeHttpSource): ImportRequestHttp {
  return nodeRequestHttp(source, "import-requests")
}

function nodeRequestHttp(
  source: NodeHttpSource,
  route: "folder-requests" | "import-requests",
): {
  get(requestId: string): Promise<{ op: unknown; claim: string } | null>
  put(requestId: string, claim: string, result: object): Promise<void>
} {
  async function send(method: "GET" | "PUT", requestId: string, body?: unknown) {
    const server = source.serverAddress()?.replace(/\/+$/, "")
    const token = source.accessToken()
    if (!server || !token) throw new NodeHttpError(401, "signed_out")
    const credential = await source.nodeCredential()
    if (!credential) throw new NodeHttpError(401, "no_node_credential")
    return fetch(`${server}/api/node/${route}/${encodeURIComponent(requestId)}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        [NODE_CREDENTIAL_HEADER]: credential,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  async function once(method: "GET" | "PUT", requestId: string, body?: unknown) {
    const sent = source.accessToken()
    let response = await send(method, requestId, body)
    if (response.status === 401 && (await renewedSince(source, sent))) {
      response = await send(method, requestId, body)
    }
    return response
  }
  return {
    get: async (requestId) => {
      const response = await once("GET", requestId)
      if (response.status === 404) return null
      if (!response.ok) throw new NodeHttpError(response.status, "http_error")
      const parsed = (await response.json().catch(() => ({}))) as {
        data?: { op?: unknown; claim?: unknown }
      }
      const claim = parsed.data?.claim
      return typeof claim === "string" && parsed.data?.op !== undefined
        ? { op: parsed.data.op, claim }
        : null
    },
    put: async (requestId, claim, result) => {
      const response = await once("PUT", requestId, { claim, ...result })
      if (!response.ok) throw new NodeHttpError(response.status, "http_error")
    },
  }
}
