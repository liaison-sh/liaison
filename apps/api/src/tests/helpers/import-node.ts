// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A fake node for the session import tests (S40, S42): enabled through the
// real routes, its capabilities published with an import protocol, connected
// through a fake socket, and answering `node_import_request` frames the way
// the desktop's relay does (pull with its credential, put the answer back).
import { decodeJwt } from "jose"
import { app } from "~/app"
import type { WebSocketManager } from "~/infra/websocket"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { onNodeConnectionHello } from "~/modules/nodes/hooks"
import type * as minimal from "~/seed/tiers/minimal"

export const IMPORT_HAIKU = "claude-haiku-4-5-20251001"

export interface FakeWs {
  send(data: string): void
  close(): void
  readyState: number
  frames: Array<Record<string, any>>
}

export function fakeWs(): FakeWs {
  const ws: FakeWs = {
    frames: [],
    readyState: 1,
    send(data: string) {
      ws.frames.push(JSON.parse(data))
    },
    close() {},
  }
  return ws
}

export interface FakeNode {
  nodeId: string
  credential: string
  deviceId: string
  who: minimal.Session
  ws?: FakeWs
}

export const callAs = (
  who: minimal.Session,
  path: string,
  method: string,
  body?: unknown,
  opts: { cred?: string; bearer?: string } = {},
) =>
  app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${opts.bearer ?? who.bearer}`,
      ...(opts.cred ? { "X-Node-Credential": opts.cred } : {}),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

export const json = async (res: Response) => (await res.json()) as any

/** Enables a node of `who` and publishes its capabilities (import protocol 5 unless said). */
export async function enableImportNode(
  who: minimal.Session,
  opts: {
    importProtocol?: number | null
    folders?: Array<{ name: string; path: string }>
    models?: Array<{ id: string; label: string }>
  } = {},
): Promise<FakeNode> {
  const deviceId = `d.${crypto.randomUUID()}`
  const res = await callAs(who, "/api/nodes", "POST", { deviceId })
  if (res.status !== 201) throw new Error(`enable node: ${res.status}`)
  const d = (await json(res)).data
  const node: FakeNode = { nodeId: d.node.id, credential: d.credential, deviceId, who }
  const protocol = opts.importProtocol === undefined ? 5 : opts.importProtocol
  const caps = await callAs(
    who,
    `/api/nodes/${node.nodeId}/capabilities`,
    "PUT",
    {
      sharedFolders: (opts.folders ?? [{ name: "code", path: "/Users/o/code" }]).map((f) => ({
        kind: "root",
        ...f,
      })),
      models: opts.models ?? [{ id: IMPORT_HAIKU, label: "Haiku 4.5" }],
      ...(protocol === null ? {} : { importProtocol: protocol }),
    },
    { cred: node.credential },
  )
  if (caps.status !== 200) throw new Error(`capabilities: ${caps.status}`)
  return node
}

export async function connectImportNode(manager: WebSocketManager, node: FakeNode) {
  const ws = fakeWs()
  manager.addConnection(node.who.userId, ws, ["*"], node.who.orgId)
  const entry = await manager.registerNotifyClient(ws, "desktop_app", Date.now(), {
    deviceId: node.deviceId,
  })
  await onNodeConnectionHello({
    orgId: node.who.orgId,
    userId: node.who.userId,
    deviceId: node.deviceId,
    connId: entry!.connId,
    nodeCredential: node.credential,
    bindConnection: (id) => manager.markNodeConnection(ws, id),
  })
  node.ws = ws
  return ws
}

export type NodeAnswer = { ok: true; data: unknown } | { ok: false; code: string }

/** The node answers every import request it is woken for, as the desktop's relay would. */
export function answeringImports(
  node: FakeNode,
  run: (op: any) => NodeAnswer | Promise<NodeAnswer>,
) {
  const seen = new Set<string>()
  const ops: any[] = []
  const puts: number[] = []
  let stop = false
  const one = async (requestId: string) => {
    const pulled = await callAs(
      node.who,
      `/api/node/import-requests/${requestId}`,
      "GET",
      undefined,
      {
        cred: node.credential,
      },
    )
    if (pulled.status !== 200) return
    const { op, claim } = (await json(pulled)).data
    ops.push(op)
    const answer = await run(op)
    const put = await callAs(
      node.who,
      `/api/node/import-requests/${requestId}`,
      "PUT",
      { claim, ...answer },
      { cred: node.credential },
    )
    puts.push(put.status)
  }
  const pending: Promise<void>[] = []
  const loop = (async () => {
    while (!stop) {
      for (const f of node.ws?.frames ?? []) {
        if (f.type !== "node_import_request" || seen.has(f.requestId)) continue
        seen.add(f.requestId)
        pending.push(one(f.requestId))
      }
      await Bun.sleep(15)
    }
  })()
  return {
    ops,
    puts,
    async done() {
      stop = true
      await loop
      await Promise.all(pending)
    },
  }
}

/** The bearer of a restricted (device-flow) session of `who`. */
export async function restrictedBearer(who: minimal.Session): Promise<string> {
  const claims = decodeJwt(who.bearer) as Record<string, any>
  return signAccessToken(
    {
      userId: claims.userId,
      orgId: claims.orgId,
      name: claims.name,
      authVersion: claims.authVersion,
      permissionVersion: claims.permissionVersion,
      roles: claims.roles,
      scopes: claims.scopes,
      restricted: true,
    },
    env.JWT_SECRET,
    600,
  )
}

/** A listing row as the node sends it. */
export function importRow(sdkSessionId: string, extra: Record<string, unknown> = {}) {
  return {
    sdkSessionId,
    folderName: "code",
    cwdSubdir: "app",
    title: "Fix the build",
    firstPrompt: "fix the build please",
    branch: "main",
    lastModified: 1_760_000_000_000,
    createdAt: null,
    sizeBytes: 4096,
    from: "vscode",
    liveNow: false,
    ...extra,
  }
}

/** A passing check answer. */
export function checkOk(model: string | null = IMPORT_HAIKU, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    title: "Fix the build",
    model,
    from: "vscode",
    liveNow: false,
    driver: { elsewhere: false, via: null },
    ...extra,
  }
}

/** A node that lists `rows` and answers every check with `check`. */
export function listAndCheck(
  rows: unknown[],
  check: (op: any) => unknown | Promise<unknown> = () => checkOk(),
) {
  return async (op: any): Promise<NodeAnswer> =>
    op.kind === "list"
      ? { ok: true, data: { rows, truncated: false } }
      : { ok: true, data: await check(op) }
}
