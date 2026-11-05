// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A `kernel:file` frame names the record whose files changed, never the file.
// Every member holds `kernel:files:read`, but a file is readable only through
// its parent record (a ticket under its team, a thread under membership, a
// shared document under its sharing list), so the socket carries the parent's
// ids and nothing else; the client refetches the shelf through RLS. These
// tests drive every delivery path (broadcast, bufferAndBroadcast, the replay
// buffer and the hello replay of a frame buffered before the cut) against a
// real Redis.
import { afterAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { projectFileEventForSocket, WebSocketManager } from "~/infra/websocket"
import {
  encodeBufferedFrame,
  replayBufferKey,
  replayTrimmedKey,
} from "~/infra/websocket-replay-buffer"
import { redis } from "~/lib/redis"

const ORG = randomUUID()
const TICKET = randomUUID()
const FILE = randomUUID()

afterAll(async () => {
  await redis.del(`ws:seq:${ORG}`, replayBufferKey(ORG), replayTrimmedKey(ORG))
})

/** What the files API queues when a file lands on a finance ticket. */
function fileFrame(action: "create" | "delete" = "create") {
  return {
    app: "kernel",
    entity: "file",
    action,
    entityId: FILE,
    orgId: ORG,
    actorId: "uploader",
    data: {
      id: FILE,
      app: "tickets",
      entityType: "ticket",
      entityId: TICKET,
      filename: "payroll-2026-10.pdf",
      mimeType: "application/pdf",
      sizeBytes: 48211,
      storageKey: `org/${ORG}/files/${FILE}`,
      parentLabel: "Payroll correction",
    },
  }
}

interface SentFrame {
  eventId?: number
  payload: { app: string; entity: string; action: string; data: Record<string, unknown> }
}

function recordingSocket() {
  const sent: SentFrame[] = []
  return {
    sent,
    readyState: 1,
    send(raw: string) {
      sent.push(JSON.parse(raw) as SentFrame)
    },
    close() {},
  }
}

const PARENT_ONLY = { id: FILE, app: "tickets", entityType: "ticket", entityId: TICKET }

describe("kernel:file frames carry the parent record, not the file", () => {
  it("a member outside the ticket's team gets no filename, size, type or storage key on broadcast or bufferAndBroadcast", async () => {
    const manager = new WebSocketManager(redis)
    const support = recordingSocket()
    manager.addConnection("support-agent", support, ["kernel:files:read"], ORG, {
      "tickets:team": ["support"],
    })

    await manager.broadcast(fileFrame())
    await manager.bufferAndBroadcast(fileFrame("delete"))

    expect(support.sent.length).toBe(2)
    for (const frame of support.sent) {
      expect(frame.payload.data).toEqual(PARENT_ONLY)
      expect(JSON.stringify(frame)).not.toContain("payroll")
      expect(JSON.stringify(frame)).not.toContain("storageKey")
    }
  })

  it("a member who can read the ticket gets the parent ids the files shelf refetches by", async () => {
    const manager = new WebSocketManager(redis)
    const finance = recordingSocket()
    const admin = recordingSocket()
    manager.addConnection("finance-agent", finance, ["kernel:files:read"], ORG, {
      "tickets:team": ["finance"],
    })
    manager.addConnection("admin", admin, ["*"], ORG, { "*": ["*"] })

    await manager.bufferAndBroadcast(fileFrame())

    for (const socket of [finance, admin]) {
      expect(socket.sent.length).toBe(1)
      const [frame] = socket.sent
      expect(frame.payload.app).toBe("kernel")
      expect(frame.payload.entity).toBe("file")
      expect(frame.payload.action).toBe("create")
      expect(frame.payload.data).toEqual(PARENT_ONLY)
    }
  })

  it("the replay buffer stores the cut frame, and a frame buffered before the cut replays cut", async () => {
    const manager = new WebSocketManager(redis)
    await redis.del(replayBufferKey(ORG))
    await manager.bufferAndBroadcast(fileFrame())
    const buffered = await redis.zrangebyscore(replayBufferKey(ORG), "-inf", "+inf")
    expect(buffered.length).toBe(1)
    expect(buffered[0]).not.toContain("payroll")

    // A frame written by a server that still buffered the full payload, under
    // the next id of the org's sequence (as that server would have assigned).
    const legacyId = await redis.incr(`ws:seq:${ORG}`)
    await redis.zadd(
      replayBufferKey(ORG),
      legacyId,
      encodeBufferedFrame(
        JSON.stringify({ type: "event", eventId: legacyId, payload: fileFrame() }),
        Date.now(),
      ),
    )
    const reconnecting = recordingSocket()
    manager.addConnection("support-agent", reconnecting, ["kernel:files:read"], ORG, {
      "tickets:team": ["support"],
    })
    await manager.handleHello(
      reconnecting,
      "support-agent",
      legacyId - 1,
      ["kernel:files:read"],
      ORG,
      {
        "tickets:team": ["support"],
      },
    )
    const replayed = reconnecting.sent.filter((f) => f.eventId === legacyId)
    expect(replayed.length).toBe(1)
    expect(replayed[0].payload.data).toEqual(PARENT_ONLY)
  })

  it("leaves every other entity untouched", () => {
    const ticket = {
      app: "tickets",
      entity: "ticket",
      action: "update",
      orgId: ORG,
      data: { id: TICKET, subject: "Payroll correction", "tickets:team": "finance" },
    }
    expect(projectFileEventForSocket(ticket)).toBe(ticket)
  })
})
