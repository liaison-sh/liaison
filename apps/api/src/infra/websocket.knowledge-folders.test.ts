// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Knowledge folder's frames follow its row's SELECT policy on every delivery
// path (broadcast, bufferAndBroadcast, hello replay): a shared folder's reach
// every reader of Knowledge, a personal one's its owner only, not even an admin
// holding `*`. A folder that stops being shared still tells the readers who saw
// it, so they drop it. A frame naming nobody (a previous release's) reaches no one.
import { beforeEach, describe, expect, it, mock } from "bun:test"
import { WebSocketManager } from "~/infra/websocket"

const mockRedis = {
  zadd: mock(() => Promise.resolve()),
  eval: mock((..._args: unknown[]) => Promise.resolve(0)),
  zrangebyscore: mock(() => Promise.resolve([] as string[])),
  expire: mock(() => Promise.resolve()),
  incr: mock(() => Promise.resolve(1)),
  exists: mock(() => Promise.resolve(1)),
  set: mock(() => Promise.resolve("OK")),
  get: mock(() => Promise.resolve(null)),
  del: mock(() => Promise.resolve(0)),
  sadd: mock(() => Promise.resolve(1)),
  srem: mock(() => Promise.resolve(0)),
  smembers: mock(() => Promise.resolve([] as string[])),
  mget: mock(() => Promise.resolve([] as string[])),
  scanStream: mock(() => {
    const stream = {
      on: mock((event: string, cb: (...args: unknown[]) => void) => {
        if (event === "end") setTimeout(() => cb(), 0)
        return stream
      }),
    }
    return stream
  }),
}

/** What a Full Member holds of Knowledge. */
const FULL_MEMBER = [
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
  "knowledge:collections:manage",
  "knowledge:sources:read",
]

type Audience = { orgWide?: boolean; wasOrgWide?: boolean; userIds?: string[] }

const folderFrame = (action: string, audience: Audience) => ({
  app: "knowledge",
  entity: "collection",
  action,
  entityId: "f1",
  orgId: "org-1",
  data: { id: "f1", ...audience },
})

const membershipFrame = (action: string, audience: Audience) => ({
  app: "knowledge",
  entity: "collection_membership",
  action,
  entityId: "m1",
  orgId: "org-1",
  data: { collectionId: "f1", targetType: "document", targetId: "d1", ...audience },
})

const SHARED: Audience = { orgWide: true, wasOrgWide: true, userIds: [] }
const ANAS: Audience = { orgWide: false, wasOrgWide: false, userIds: ["ana"] }

const socket = () => ({ send: mock(() => {}), readyState: 1 }) as any

describe("knowledge folder frames", () => {
  let manager: WebSocketManager
  let ana: ReturnType<typeof socket>
  let ben: ReturnType<typeof socket>
  let admin: ReturnType<typeof socket>
  let outsider: ReturnType<typeof socket>

  beforeEach(() => {
    manager = new WebSocketManager(mockRedis as any)
    ana = socket()
    ben = socket()
    admin = socket()
    outsider = socket()
    manager.addConnection("ana", ana, FULL_MEMBER, "org-1")
    manager.addConnection("ben", ben, FULL_MEMBER, "org-1")
    manager.addConnection("admin", admin, ["*"], "org-1")
    manager.addConnection("outsider", outsider, ["tickets:tickets:read"], "org-1")
  })

  const deliveries = [
    ["bufferAndBroadcast", (f: object) => manager.bufferAndBroadcast(f as never)],
    ["broadcast", (f: object) => manager.broadcast(f as never)],
  ] as const

  for (const [path, deliver] of deliveries) {
    it(`${path}: a shared folder and a membership of it reach a Full Member, nobody without Knowledge`, async () => {
      await deliver(folderFrame("create", SHARED))
      await deliver(membershipFrame("create", SHARED))
      for (const s of [ana, ben, admin]) expect(s.send).toHaveBeenCalledTimes(2)
      expect(outsider.send).not.toHaveBeenCalled()
    })

    it(`${path}: a personal folder and its memberships reach its owner alone`, async () => {
      for (const action of ["create", "update", "archive"]) await deliver(folderFrame(action, ANAS))
      for (const action of ["create", "delete"]) await deliver(membershipFrame(action, ANAS))
      expect(ana.send).toHaveBeenCalledTimes(5)
      for (const s of [ben, admin, outsider]) expect(s.send).not.toHaveBeenCalled()
    })

    it(`${path}: the others hear a folder become shared, and hear it leave`, async () => {
      await deliver(folderFrame("update", { orgWide: true, wasOrgWide: false, userIds: [] }))
      expect(ben.send).toHaveBeenCalledTimes(1)
      await deliver(folderFrame("update", { orgWide: false, wasOrgWide: true, userIds: ["ana"] }))
      expect(ben.send).toHaveBeenCalledTimes(2)
      await deliver(folderFrame("update", ANAS))
      expect(ben.send).toHaveBeenCalledTimes(2)
    })

    it(`${path}: a frame naming nobody reaches no one`, async () => {
      const before = folderFrame("create", {})
      Object.assign(before.data, { name: "A previous release named it" })
      await deliver(before)
      await deliver(membershipFrame("create", {}))
      for (const s of [ana, ben, admin, outsider]) expect(s.send).not.toHaveBeenCalled()
    })
  }

  it("hello replay follows the same rule", async () => {
    const frames = [
      folderFrame("create", ANAS),
      membershipFrame("create", ANAS),
      folderFrame("create", SHARED),
      folderFrame("create", {}),
    ].map((payload, i) => JSON.stringify({ type: "event", eventId: i + 1, payload }))
    const replayed = async (userId: string, s: typeof ben) => {
      mockRedis.zrangebyscore.mockResolvedValueOnce(frames)
      await manager.handleHello(s, userId, 1, FULL_MEMBER, "org-1")
      return s.send.mock.calls.map(([m]: [string]) => JSON.parse(m).eventId)
    }
    expect(await replayed("ben", ben)).toEqual([3])
    expect(await replayed("ana", ana)).toEqual([1, 2, 3])
  })
})
