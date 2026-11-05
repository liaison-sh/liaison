// SPDX-License-Identifier: FSL-1.1-ALv2
// Clients for a role cell (createRoleCell): a WebSocket on one chosen process,
// a scripted agent turn registered on one chosen process, and the JSON log
// lines a process wrote. The cell scenarios (apps/api/src/tests/e2e/cell) use
// them to drive several `src/index.ts` processes the way clients would.
import type { RoleProcess } from "./role-processes"

/** One parsed server frame. */
export type CellFrame = Record<string, unknown>

export interface CellSocket {
  /** Every frame received so far, in order. */
  frames: CellFrame[]
  /**
   * Resolve with the first frame from the cursor on that matches `pred`, and
   * move the cursor past it, so the same frame is never matched twice.
   */
  waitFor<T extends CellFrame>(pred: (f: CellFrame) => f is T, timeoutMs?: number): Promise<T>
  waitFor(pred: (f: CellFrame) => boolean, timeoutMs?: number): Promise<CellFrame>
  send(frame: unknown): void
  /** Close the socket and resolve once it is closed. */
  close(code?: number): Promise<void>
}

export interface OpenCellSocketOptions {
  lastEventId?: number
  clientKind?: "browser" | "desktop_app"
  /** How long to wait for `presence_sync` (default 10 s). */
  timeoutMs?: number
}

const DEFAULT_WAIT_MS = 10_000

/**
 * Open a socket on `proc` as the token's user: `POST /api/auth/ws-ticket`,
 * then `ws://…/ws?ticket=…`, then `hello`. Resolves once the server's
 * `presence_sync` arrives (sent at the end of its hello handling), so the
 * connection is registered when this returns.
 */
export async function openCellSocket(
  proc: RoleProcess,
  token: string,
  opts?: OpenCellSocketOptions,
): Promise<CellSocket> {
  const ticketRes = await fetch(`${proc.url}/api/auth/ws-ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!ticketRes.ok) {
    const body = await ticketRes.text().catch(() => "")
    throw new Error(
      `ws-ticket on ${proc.role} :${proc.port} answered ${ticketRes.status}: ${body.slice(0, 300)}`,
    )
  }
  const ticketBody = (await ticketRes.json()) as { data?: { ticket?: unknown } }
  const ticket = ticketBody.data?.ticket
  if (typeof ticket !== "string" || ticket.length === 0) {
    throw new Error(`ws-ticket on ${proc.role} :${proc.port} returned no ticket`)
  }

  const ws = new WebSocket(
    `${proc.url.replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(ticket)}`,
  )
  const frames: CellFrame[] = []
  let closed = false
  let wake: Array<() => void> = []
  const notify = () => {
    const waiters = wake
    wake = []
    for (const w of waiters) w()
  }
  ws.addEventListener("message", (event) => {
    try {
      const parsed: unknown = JSON.parse(String(event.data))
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        frames.push(parsed as CellFrame)
      }
    } catch {
      /* not JSON */
    }
    notify()
  })
  const closedPromise = new Promise<void>((resolve) => {
    ws.addEventListener("close", () => {
      closed = true
      notify()
      resolve()
    })
  })

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_MS
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`socket to ${proc.role} :${proc.port} did not open in ${timeoutMs}ms`)),
      timeoutMs,
    )
    ws.addEventListener("open", () => {
      clearTimeout(timer)
      resolve()
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error(`socket to ${proc.role} :${proc.port} failed to open`))
    })
  })

  let cursor = 0
  function waitFor<T extends CellFrame>(pred: (f: CellFrame) => f is T, ms?: number): Promise<T>
  function waitFor(pred: (f: CellFrame) => boolean, ms?: number): Promise<CellFrame>
  async function waitFor(
    pred: (f: CellFrame) => boolean,
    ms = DEFAULT_WAIT_MS,
  ): Promise<CellFrame> {
    const deadline = Date.now() + ms
    while (true) {
      for (let i = cursor; i < frames.length; i++) {
        const f = frames[i] as CellFrame
        if (pred(f)) {
          cursor = i + 1
          return f
        }
      }
      const left = deadline - Date.now()
      if (closed || left <= 0) {
        const seen = frames
          .slice(cursor)
          .map((f) => String(f.type ?? "?"))
          .join(", ")
        throw new Error(
          `socket on ${proc.role} :${proc.port}: no matching frame ${closed ? "before close" : `within ${ms}ms`}. Unmatched: [${seen}]`,
        )
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        wake.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  const send = (frame: unknown) => ws.send(JSON.stringify(frame))
  send({
    type: "hello",
    lastEventId: opts?.lastEventId ?? 0,
    ...(opts?.clientKind ? { clientKind: opts.clientKind } : {}),
  })
  await waitFor((f) => f.type === "presence_sync", timeoutMs)

  return {
    frames,
    waitFor,
    send,
    close: async (code?: number) => {
      if (!closed) ws.close(code)
      await closedPromise
    },
  }
}

/**
 * Register the agent's next turn(s) in `threadId` through `proc` (the
 * scripted model provider, `POST /api/_test/agent-script`). The script lives
 * in Redis, so a turn that runs, or resumes, in any process of the cell plays
 * it; `proc` only has to run with the scripted provider armed.
 */
export async function scriptTurnOn(
  proc: RoleProcess,
  threadId: string,
  steps: unknown[],
): Promise<void> {
  const res = await fetch(`${proc.url}/api/_test/agent-script`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId, steps }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(
      `agent-script on ${proc.role} :${proc.port} answered ${res.status}: ${text.slice(0, 300)}`,
    )
  }
  const body = JSON.parse(text) as { data?: { providerActive?: unknown } }
  if (body.data?.providerActive !== true) {
    throw new Error(
      `agent-script on ${proc.role} :${proc.port}: the scripted provider is off (LIAISON_MODEL_PROVIDER)`,
    )
  }
}

/** Every JSON log line the process wrote so far (pino writes to stderr). */
export function jsonLogLines(p: RoleProcess): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of `${p.stdout()}\n${p.stderr()}`.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("{")) continue
    try {
      const parsed: unknown = JSON.parse(t)
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>)
      }
    } catch {
      /* not a log line */
    }
  }
  return out
}
