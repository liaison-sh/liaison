// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE ANSWERS A FOLDER REQUEST (owner-only, from any client).
//
// A `node_folder_request` frame names a request id. The node pulls it with its
// credential (only its own node's requests are served), runs it against the
// shell's folder settings (node_folders.rs), and puts the answer back. A change
// to the shared roots publishes the node's capabilities again before the answer
// goes back, so the server's folder names follow at once. Every refusal travels as a code, never a message.

import {
  type NodeFolderOp,
  type NodeFolderResult,
  nodeFolderCode,
  parseNodeFolderOp,
} from "@liaison/shared"

export interface FolderRequestHttp {
  /**
   * The request and this pull's claim, or null when it is gone, not this
   * node's, or already claimed by another of its connections.
   */
  get(requestId: string): Promise<{ op: unknown; claim: string } | null>
  /** The answer, with the claim of the pull that got the request. */
  put(requestId: string, claim: string, result: NodeFolderResult): Promise<void>
}

export interface FolderRequestDeps {
  http: FolderRequestHttp
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  /** Publishes the capabilities (the shared folder names) again. */
  republish: () => Promise<void>
  log?: (message: string, error?: unknown) => void
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createFolderRequests(
  deps: FolderRequestDeps,
): (requestId: string) => Promise<void> {
  async function list(): Promise<unknown> {
    const [shared, search] = await Promise.all([
      deps.invoke("node_shared_roots"),
      deps.invoke("node_search_roots"),
    ])
    return { shared, search }
  }

  async function run(op: NodeFolderOp): Promise<unknown> {
    switch (op.kind) {
      case "list":
        return list()
      case "lookup":
        return deps.invoke("node_folder_lookup", { query: op.query })
      case "share": {
        // The node checks it itself: its own proof from its lookup, or a recent folder.
        await deps.invoke(
          "node_folder_share",
          "token" in op ? { token: op.token } : { path: op.path },
        )
        await deps.republish().catch((error) => deps.log?.("capabilities not published", error))
        return list()
      }
      case "unshare": {
        // One writer at a time on the node (node_folders.rs folders_lock).
        const changed = await deps.invoke("node_folder_unshare", { path: op.path })
        if (changed === true) {
          // Published before answering, so a session asked for right after
          // the answer finds the folder on the server.
          await deps.republish().catch((error) => deps.log?.("capabilities not published", error))
        }
        return list()
      }
      case "clone": {
        // Long: the node's own git, with its own login (node_folders.rs).
        await deps.invoke("node_folder_clone", { url: op.url, name: op.name ?? null })
        await deps.republish().catch((error) => deps.log?.("capabilities not published", error))
        return list()
      }
      case "scan":
        // Every repository in the search roots; tokens only for what it may share.
        return deps.invoke("node_folder_scan")
      case "shareMany": {
        // One write on the node (the folders lock once), then one publish.
        const answer = (await deps.invoke("node_folder_share_many", { tokens: op.tokens })) as {
          refused?: unknown
        } | null
        const refused = Array.isArray(answer?.refused) ? answer.refused : []
        if (refused.length < op.tokens.length) {
          await deps.republish().catch((error) => deps.log?.("capabilities not published", error))
        }
        return { ...((await list()) as object), refused }
      }
      case "remotes":
        // The node's own signed-in gh and glab; nothing from the request.
        return deps.invoke("node_folder_remotes")
      case "addSearchRoot":
        await deps.invoke("node_search_root_add", { path: op.path })
        return list()
      case "removeSearchRoot":
        await deps.invoke("node_search_root_remove", { path: op.path })
        return list()
    }
  }

  return async (requestId: string) => {
    if (!UUID_RE.test(requestId)) return
    let pulled: { op: unknown; claim: string } | null
    try {
      pulled = await deps.http.get(requestId)
    } catch (error) {
      deps.log?.("node folder request not read", error)
      return
    }
    // Gone, or claimed by another connection of this node: not ours to answer.
    if (!pulled) return
    const op = parseNodeFolderOp(pulled.op)
    let result: NodeFolderResult
    if (!op) {
      result = { ok: false, code: "failed" }
    } else {
      try {
        result = { ok: true, data: await run(op) }
      } catch (error) {
        // The shell answers a code string (node_folders.rs); anything else is `failed`.
        result = { ok: false, code: nodeFolderCode(error) }
      }
    }
    try {
      await deps.http.put(requestId, pulled.claim, result)
    } catch (error) {
      deps.log?.("node folder answer not sent", error)
    }
  }
}
