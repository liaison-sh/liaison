// SPDX-License-Identifier: FSL-1.1-ALv2
export interface WsClient {
  ws: WebSocket
  messages: any[]
  waitFor(eventType: string, predicate?: (msg: any) => boolean, timeout?: number): Promise<any>
  close(): void
}

export async function connectWs(
  serverUrl: string,
  token: string,
  lastEventId = 0,
): Promise<WsClient> {
  // Exchange JWT for a single-use WS ticket
  const ticketRes = await fetch(`${serverUrl}/api/auth/ws-ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!ticketRes.ok) {
    throw new Error(`WS ticket exchange failed: ${ticketRes.status}`)
  }
  const body = (await ticketRes.json()) as { data: { ticket: string } }
  const ticket = body.data.ticket

  const wsUrl = `${serverUrl.replace("http://", "ws://")}/ws?ticket=${ticket}`
  const ws = new WebSocket(wsUrl)
  const messages: any[] = []

  ws.addEventListener("message", (event) => {
    try {
      messages.push(JSON.parse(String(event.data)))
    } catch {
      // Ignore non-JSON
    }
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS connect timeout (5s)")), 5000)
    ws.addEventListener("open", () => {
      clearTimeout(timer)
      resolve()
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("WS connect error"))
    })
  })

  // Hello handshake
  ws.send(JSON.stringify({ type: "hello", lastEventId }))

  // Cursor tracks the next index to scan from, preventing duplicate matches
  let cursor = 0

  async function waitForMsg(
    msgs: any[],
    predicate: (msg: any) => boolean,
    timeoutMs = 5000,
  ): Promise<any> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (let i = cursor; i < msgs.length; i++) {
        if (predicate(msgs[i])) {
          cursor = i + 1
          return msgs[i]
        }
      }
      // Messages land in memory, so a tight poll costs nothing and answers fast.
      await Bun.sleep(10)
    }
    const received = msgs
      .slice(cursor)
      .map((m) => m.type ?? "unknown")
      .join(", ")
    throw new Error(`WS waitFor timed out after ${timeoutMs}ms. Received: [${received}]`)
  }

  // Wait for presence_sync
  await waitForMsg(messages, (m) => m.type === "presence_sync", 5000)

  return {
    ws,
    messages,
    waitFor: (eventType, predicate, timeout) =>
      waitForMsg(messages, (m) => m.type === eventType && (!predicate || predicate(m)), timeout),
    close: () => ws.close(),
  }
}
