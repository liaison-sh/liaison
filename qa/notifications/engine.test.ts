// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The matrix judge (lib/engine.ts) on fixture rows: receipt precedence
// suppressed > shown > received, `received` as shown only where A3 allows it,
// the 30 s window, timeouts reading as none, router-level rows, skipped
// surfaces, and when a phase may stop polling.
import { describe, expect, it } from "bun:test"
import {
  evaluatePhase,
  humanIsTrigger,
  humanTriggeredElapsed,
  idsForSurface,
  isSettled,
  logOpensAt,
  matches,
  notificationIdsFrom,
  observeSurface,
  observeWindowFrom,
  rollUp,
  strongestReceipt,
} from "./lib/engine"
import type { DeliveryRow, Phase, PhaseObservation, ReceiptRow } from "./lib/types"

const T0 = Date.parse("2026-10-07T12:00:00.000Z")
const at = (ms: number) => new Date(T0 + ms).toISOString()
const N1 = "11111111-1111-5111-8111-111111111111"
const N2 = "22222222-2222-5222-8222-222222222222"

let seq = 0
function receipt(outcome: ReceiptRow["outcome"], over: Partial<ReceiptRow> = {}): ReceiptRow {
  seq += 1
  return {
    id: `r${seq}`,
    notificationId: N1,
    deviceId: "dev-1",
    surface: "ios",
    outcome,
    reason: null,
    receivedAt: at(500),
    updatedAt: at(500),
    ...over,
  }
}

function delivery(over: Partial<DeliveryRow> = {}): DeliveryRow {
  seq += 1
  return {
    id: `d${seq}`,
    notificationId: N1,
    deviceId: "dev-1",
    surface: "ios",
    channel: "push",
    result: "accepted",
    reason: null,
    attemptedAt: at(0),
    ...over,
  }
}

function obs(over: Partial<PhaseObservation> = {}): PhaseObservation {
  return { notificationIds: [N1], deliveries: [delivery()], receipts: [], triggeredAt: T0, ...over }
}

const ALL = ["ios", "desktop", "web"] as const

describe("receipt precedence (A3: suppressed > shown > received)", () => {
  it("a final outcome beats received, and suppressed beats shown, whatever the order", () => {
    expect(strongestReceipt([receipt("received"), receipt("shown")])?.outcome).toBe("shown")
    expect(strongestReceipt([receipt("shown"), receipt("received")])?.outcome).toBe("shown")
    expect(
      strongestReceipt([receipt("shown"), receipt("suppressed", { reason: "on_screen" })])?.outcome,
    ).toBe("suppressed")
    expect(
      strongestReceipt([receipt("suppressed", { reason: "on_screen" }), receipt("shown")])?.outcome,
    ).toBe("suppressed")
    expect(strongestReceipt([])).toBeNull()
  })

  it("a surface observes the strongest receipt across its devices", () => {
    const o = observeSurface(
      obs({
        receipts: [
          receipt("received", { deviceId: "a" }),
          receipt("suppressed", { deviceId: "b", reason: "on_screen" }),
        ],
      }),
      N1,
      "ios",
    )
    expect(o.kind).toBe("suppressed")
    expect(o.reason).toBe("on_screen")
  })
})

describe("matching an expectation", () => {
  it("received is shown only where the phase allows it", () => {
    const received = { kind: "received" as const, evidence: [] }
    expect(matches({ kind: "shown" }, received, false)).toBe(false)
    expect(matches({ kind: "shown" }, received, true)).toBe(true)
    expect(matches({ kind: "none" }, received, true)).toBe(false)
  })

  it("suppressed checks the reason when the expectation names one", () => {
    const o = { kind: "suppressed" as const, reason: "on_screen", evidence: [] }
    expect(matches({ kind: "suppressed", reason: "on_screen" }, o, false)).toBe(true)
    expect(matches({ kind: "suppressed", reason: "os_permission_denied" }, o, false)).toBe(false)
    expect(matches({ kind: "suppressed" }, o, false)).toBe(true)
    expect(matches({ kind: "shown" }, o, false)).toBe(false)
  })
})

describe("observing a surface", () => {
  it("no receipt (the window ran out) is none", () => {
    expect(observeSurface(obs(), N1, "ios").kind).toBe("none")
  })

  it("a receipt outside the window of the first delivery row does not count", () => {
    const late = receipt("shown", { receivedAt: at(31_000) })
    expect(observeSurface(obs({ receipts: [late] }), N1, "ios").kind).toBe("none")
    expect(observeSurface(obs({ receipts: [late] }), N1, "ios", 45_000).kind).toBe("shown")
  })

  it("the window starts at the server's first delivery row, not the local trigger clock", () => {
    // The local clock is 20 s behind the server's.
    const o = obs({
      triggeredAt: T0 - 20_000,
      receipts: [receipt("shown", { receivedAt: at(25_000) })],
    })
    expect(observeSurface(o, N1, "ios").kind).toBe("shown")
  })

  it("a phase judging earlier notifications (replay) counts its window from its own start", () => {
    // Delivered at T0; replayed and receipted 50 s later, in a phase started at +45 s.
    const replayed = receipt("shown", { surface: "desktop", receivedAt: at(50_000) })
    const o = obs({ receipts: [replayed] })
    expect(observeSurface(o, N1, "desktop").kind).toBe("none")
    expect(observeSurface({ ...o, windowFrom: T0 + 45_000 }, N1, "desktop").kind).toBe("shown")
  })

  it("receipts of another surface, notification or unpinned device are ignored", () => {
    const o = obs({
      receipts: [
        receipt("shown", { surface: "desktop" }),
        receipt("shown", { notificationId: N2 }),
        receipt("shown", { deviceId: "stale-sim" }),
      ],
      deviceIds: { ios: ["dev-1"] },
    })
    expect(observeSurface(o, N1, "ios").kind).toBe("none")
  })
})

const dmPhase = (over: Partial<Phase> = {}): Phase => ({
  label: "dm",
  trigger: { type: "dm" },
  expect: { ios: { kind: "shown" }, desktop: { kind: "none" } },
  ...over,
})

describe("evaluating a phase", () => {
  it("matches shown and none cells and carries the evidence ids", () => {
    const cells = evaluatePhase(
      "C",
      dmPhase(),
      obs({ receipts: [receipt("shown", { id: "rx" })] }),
      ALL,
    )
    expect(cells.map((c) => [c.cell, c.expected, c.observed, c.status])).toEqual([
      ["ios", "shown", "shown", "match"],
      ["desktop", "none", "none", "match"],
    ])
    expect(cells[0]?.evidence).toContain("receipt:rx:shown")
    expect(cells[0]?.evidence).toContain(`notification:${N1}`)
  })

  it("an unexpected receipt on a none surface is a mismatch", () => {
    const cells = evaluatePhase(
      "C",
      dmPhase(),
      obs({ receipts: [receipt("shown"), receipt("shown", { surface: "desktop" })] }),
      ALL,
    )
    expect(cells.find((c) => c.cell === "desktop")?.status).toBe("mismatch")
  })

  it("received on iOS in the background counts as shown, with the note", () => {
    const cells = evaluatePhase(
      "C",
      dmPhase(),
      obs({ receipts: [receipt("received")], receivedCountsAsShown: ["ios"] }),
      ALL,
    )
    expect(cells[0]?.status).toBe("match")
    expect(cells[0]?.note).toContain("A3")
    const strict = evaluatePhase("C", dmPhase(), obs({ receipts: [receipt("received")] }), ALL)
    expect(strict[0]?.status).toBe("mismatch")
  })

  it("expected shown with nothing in the log is a mismatch, not a pass", () => {
    const cells = evaluatePhase("C", dmPhase(), obs({ notificationIds: [], deliveries: [] }), ALL)
    expect(cells[0]?.status).toBe("mismatch")
    expect(cells[0]?.observed).toContain("no notification")
  })

  it("a repeated trigger needs every notification to match", () => {
    const phase = dmPhase({ repeat: 2, expect: { desktop: { kind: "shown" } } })
    const both = obs({
      notificationIds: [N1, N2],
      deliveries: [
        delivery({ surface: "desktop" }),
        delivery({ notificationId: N2, surface: "desktop" }),
      ],
      receipts: [
        receipt("shown", { surface: "desktop" }),
        receipt("shown", { surface: "desktop", notificationId: N2 }),
      ],
    })
    expect(evaluatePhase("C", phase, both, ALL)[0]?.status).toBe("match")
    const oneMissing = { ...both, receipts: both.receipts.slice(0, 1) }
    expect(evaluatePhase("C", phase, oneMissing, ALL)[0]?.status).toBe("mismatch")
    const onlyOne = { ...both, notificationIds: [N1] }
    const cell = evaluatePhase("C", phase, onlyOne, ALL)[0]
    expect(cell?.status).toBe("mismatch")
    expect(cell?.note).toContain("expected 2")
  })

  it("router expectations read the device-less rows", () => {
    const phase = dmPhase({
      expect: { ios: { kind: "none" } },
      router: [{ channel: "push", result: "suppressed", reason: "grid_off" }],
    })
    const held = obs({
      deliveries: [
        delivery({
          id: "held",
          deviceId: null,
          surface: null,
          result: "suppressed",
          reason: "grid_off",
        }),
      ],
    })
    const cells = evaluatePhase("C", phase, held, ALL)
    expect(cells.map((c) => [c.cell, c.status])).toEqual([
      ["ios", "match"],
      ["router:push", "match"],
    ])
    expect(cells[1]?.evidence).toEqual(["delivery:held"])
    const wrongReason = obs({
      deliveries: [
        delivery({ deviceId: null, surface: null, result: "suppressed", reason: "quiet_time" }),
      ],
    })
    const bad = evaluatePhase("C", phase, wrongReason, ALL)[1]
    expect(bad?.status).toBe("mismatch")
    expect(bad?.observed).toBe("push:suppressed/quiet_time")
  })

  it("a surface whose controller is not in the run is skipped, never a pass", () => {
    const cells = evaluatePhase("C", dmPhase(), obs({ receipts: [receipt("shown")] }), ["web"])
    expect(cells.map((c) => c.status)).toEqual(["skipped", "skipped"])
    expect(rollUp(cells)).toBe("skipped")
  })

  it("a registration check is one cell from the device list", () => {
    const phase: Phase = {
      label: "fresh_install",
      trigger: { type: "none" },
      expect: {},
      deviceCheck: { id: "M5", surface: "ios", action: "fresh_install", withinMs: 120_000 },
    }
    const ok = evaluatePhase(
      "M5",
      phase,
      obs({
        deviceCheck: {
          ok: true,
          detail: "ios device abc in the list after 8s",
          evidence: ["device:abc"],
        },
      }),
      ALL,
    )
    expect(ok.map((c) => [c.cell, c.status])).toEqual([["registration:ios", "match"]])
    expect(evaluatePhase("M5", phase, obs(), ALL)[0]?.status).toBe("mismatch")
  })
})

describe("when a phase may stop polling", () => {
  it("waits for a final outcome, or the window", () => {
    const p = dmPhase({ expect: { ios: { kind: "shown" } } })
    expect(isSettled(p, obs(), 1000, ALL)).toBe(false)
    expect(isSettled(p, obs({ receipts: [receipt("received")] }), 1000, ALL)).toBe(false)
    expect(
      isSettled(
        p,
        obs({ receipts: [receipt("received")], receivedCountsAsShown: ["ios"] }),
        1000,
        ALL,
      ),
    ).toBe(true)
    expect(isSettled(p, obs({ receipts: [receipt("shown")] }), 1000, ALL)).toBe(true)
    expect(isSettled(p, obs(), 30_000, ALL)).toBe(true)
  })

  it("a none cell waits out the window unless the router held that channel back", () => {
    const p = dmPhase({ expect: { ios: { kind: "none" } } })
    expect(isSettled(p, obs(), 5000, ALL)).toBe(false)
    const held = obs({
      deliveries: [
        delivery({ deviceId: null, surface: null, result: "suppressed", reason: "grid_off" }),
      ],
    })
    expect(isSettled(p, held, 5000, ALL)).toBe(true)
    // A receipt already broke it: no need to wait.
    expect(isSettled(p, obs({ receipts: [receipt("shown")] }), 5000, ALL)).toBe(true)
  })

  it("waits until all repeated notifications are in the log", () => {
    const p = dmPhase({ repeat: 2, expect: { ios: { kind: "shown" } } })
    expect(isSettled(p, obs({ receipts: [receipt("shown")] }), 1000, ALL)).toBe(false)
  })

  it("ignores surfaces outside the run", () => {
    const p = dmPhase({ expect: { ios: { kind: "shown" } } })
    expect(isSettled(p, obs(), 1000, ["web"])).toBe(true)
  })
})

describe("the notifications of a phase", () => {
  it("prefers the ids the trigger answered, else the log since the trigger", () => {
    const rows = [
      delivery({ notificationId: N2, attemptedAt: at(-5000) }),
      delivery({ notificationId: N1, attemptedAt: at(100) }),
      delivery({ notificationId: N1, attemptedAt: at(200), channel: "desktop" }),
    ]
    expect(notificationIdsFrom(["x", "x"], rows, T0)).toEqual(["x"])
    expect(notificationIdsFrom([], rows, T0)).toEqual([N1])
  })
})

// Cases run back to back: on demo the previous case's notification (suppressed
// on_screen, 5 s earlier) fell inside the clock-slack window of the next one
// (iOS background) and was judged as its own. Ids already in the log before
// the trigger are never this phase's.
describe("notificationIdsFrom excludes what was there before the trigger", () => {
  it("drops ids seen in the log just before firing, keeps the new one", () => {
    const rows = [
      delivery({ notificationId: N1, attemptedAt: at(-3000) }),
      delivery({ notificationId: N2, attemptedAt: at(500) }),
    ]
    expect(notificationIdsFrom([], rows, T0 - 5000, new Set([N1]))).toEqual([N2])
    // Without the snapshot the slack lets the earlier one in.
    expect(notificationIdsFrom([], rows, T0 - 5000)).toEqual([N1, N2])
    // Ids the trigger answered are taken as they are.
    expect(notificationIdsFrom([N1], rows, T0 - 5000, new Set([N1]))).toEqual([N1])
  })
})

// M4-replay on demo: the relaunch itself replays the missed notifications
// (receipts 3 s after the app came back), but the judging phase opened its
// window only after the relaunch had finished, so it saw none of them.
describe("observeWindowFrom", () => {
  it("opens a judging phase's window when its states start changing, not at its trigger", () => {
    const startedAt = T0
    const triggeredAt = T0 + 20_000
    expect(observeWindowFrom(startedAt, triggeredAt, 5000)).toBe(T0 - 5000)
  })
})

// M4-replay phase 1 on demo fires 3 DMs and expects only router rows (desktop
// none, no_target); it settled once TWO notifications had their rows, so the
// replay phase judged 2 of 3. A repeated trigger waits for all of its
// notifications, whatever it expects of them.
describe("a repeated trigger settles only once every notification is in", () => {
  it("waits for repeat x notifications even when it expects none on the surfaces", () => {
    const p = dmPhase({
      repeat: 3,
      expect: { desktop: { kind: "none" } },
      router: [{ channel: "desktop", result: "no_target" }],
    })
    const row = (id: string) =>
      delivery({
        notificationId: id,
        deviceId: null,
        surface: null,
        channel: "desktop",
        result: "no_target",
      })
    const two = obs({ notificationIds: [N1, N2], deliveries: [row(N1), row(N2)] })
    expect(isSettled(p, two, 5000, ALL)).toBe(false)
    const N3 = "33333333-3333-5333-8333-333333333333"
    const three = obs({ notificationIds: [N1, N2, N3], deliveries: [row(N1), row(N2), row(N3)] })
    expect(isSettled(p, three, 5000, ALL)).toBe(true)
  })
})

// TF-test-button on demo, 2026-10-12. The owner taps "Send me a test" on his
// TestFlight iPhone; the test route sends one notification PER DEVICE of the
// user (3 iOS tokens, 1 desktop, 7 browsers: 11 ids). The pinned iPhone
// (afb6fb96) showed its copy in 0.6 s, yet the cell read "none | shown":
// the other 10 copies, addressed to other devices, were judged on iOS too.
// The run before (18:43) read "no notification in the log": the owner tapped
// at 18:44:32, 20 s BEFORE signalling the runner, whose log opened at the signal.
describe("TF-test-button replay (2026-10-12 demo rows)", () => {
  const PINNED = "afb6fb96-13ae-4c33-960e-641d637926a9"
  const sent: Array<[string, string, string, string, string]> = [
    [
      "20:29:49.901",
      "19d50c0c-7485-5b06-99a7-8e7a75842c0f",
      "ios",
      "2c52fb5f-9b94-4652-bef8-daa9365175b0",
      "rejected",
    ],
    [
      "20:29:49.953",
      "4c4ce52c-3898-5051-8ed2-a32e1d47b92c",
      "ios",
      "255458af-e168-4850-aa9c-93dc89d3eb8e",
      "rejected",
    ],
    ["20:29:50.162", "d83663ac-2b4f-53ae-b551-1e27edd4f938", "ios", PINNED, "accepted"],
    [
      "20:29:50.170",
      "b3a10c04-872c-506b-96a5-326b12546c44",
      "desktop",
      "d.85144b9c2239ff0bcd91693d79b4a54a",
      "no_connection",
    ],
    [
      "20:29:50.327",
      "d5524540-be49-5e39-ba2a-c14984bd9e9d",
      "browser_push",
      "f0aded4e-2e1f-4bc5-83e7-76ed911f1345",
      "accepted",
    ],
    [
      "20:29:50.550",
      "021215b7-e6d8-53f5-9941-a3d9c22af8c7",
      "browser_push",
      "7126dd48-ae70-49a3-a2fc-c2348ee7a5fd",
      "accepted",
    ],
    [
      "20:29:50.695",
      "62a9fc58-63ee-5006-86a5-724a2e0bda67",
      "browser_push",
      "b8c1dd3d-365e-4af7-90f6-f20b2a24851b",
      "accepted",
    ],
    [
      "20:29:50.842",
      "9f6faeed-2a0e-57aa-8050-be6cea074289",
      "browser_push",
      "7eb21ccd-f73f-4e8a-943f-111e86d39866",
      "accepted",
    ],
    [
      "20:29:50.992",
      "05fa08db-751c-51a8-9537-04b13bcf80f4",
      "browser_push",
      "9a74c911-d4ff-4b67-af2a-65fb1e773638",
      "accepted",
    ],
    [
      "20:29:51.135",
      "ccfb17c7-42f4-5aa8-b2f5-40766952c93c",
      "browser_push",
      "e8943e0a-9d8f-469f-bb74-a5fbc4034eee",
      "accepted",
    ],
    [
      "20:29:51.286",
      "75d44bb2-47da-582f-8b83-2075ed9cabe1",
      "browser_push",
      "f11e91d9-30f9-4c49-af21-55c730d84d14",
      "accepted",
    ],
  ]
  const day = (t: string) => `2026-10-12T${t}Z`
  const deliveries: DeliveryRow[] = sent.map(
    ([t, notificationId, surface, deviceId, result], i) => ({
      id: `tf-d${i}`,
      notificationId,
      deviceId,
      surface,
      channel: "test",
      result,
      reason: null,
      attemptedAt: day(t),
    }),
  )
  const shown: ReceiptRow = {
    id: "68f8d500-59a9-44a2-a240-8966edc8a741",
    notificationId: "d83663ac-2b4f-53ae-b551-1e27edd4f938",
    deviceId: PINNED,
    surface: "ios",
    appState: "foreground",
    outcome: "shown",
    reason: null,
    receivedAt: day("20:29:50.746"),
    updatedAt: day("20:29:51.020"),
  }
  const phase: Phase = {
    label: "none",
    trigger: { type: "none" },
    expect: { ios: { kind: "shown" } },
    windowMs: 120_000,
  }
  const signalledAt = Date.parse(day("20:29:35.000"))
  const ids = notificationIdsFrom([], deliveries, signalledAt - 5000)
  const replay: PhaseObservation = {
    notificationIds: ids,
    deliveries,
    receipts: [shown],
    triggeredAt: signalledAt,
    deviceIds: { ios: [PINNED] },
  }

  it("judges iOS on the pinned iPhone's copy only, and matches", () => {
    expect(ids).toHaveLength(11)
    expect(idsForSurface(replay, "ios")).toEqual(["d83663ac-2b4f-53ae-b551-1e27edd4f938"])
    const [cell] = evaluatePhase("TF-test-button", phase, replay, ["ios"])
    expect(cell?.observed).toBe("shown")
    expect(cell?.status).toBe("match")
    expect(isSettled(phase, replay, 16_000, ["ios"])).toBe(true)
  })

  it("an ordinary notification is still judged on every surface", () => {
    const dm = obs({ deliveries: [delivery({ surface: "desktop", channel: "desktop" })] })
    expect(idsForSurface(dm, "ios")).toEqual([N1])
  })

  it("waits for the iPhone's copy when only other devices' copies are in yet", () => {
    const early = {
      ...replay,
      deliveries: deliveries.filter((d) => d.surface !== "ios"),
      receipts: [],
    }
    expect(isSettled(phase, early, 2000, ["ios"])).toBe(false)
  })

  it("a tap before the signal is in: the log opens when the cell was announced", () => {
    // 18:43 run: announced 18:43:26, tapped 18:44:32, signalled 18:44:52.
    const announced = Date.parse(day("18:43:26.000"))
    const signalled = Date.parse(day("18:44:52.000"))
    const tap = deliveries.map((d) => ({ ...d, attemptedAt: day("18:44:32.665") }))
    expect(humanIsTrigger(phase, true, 0)).toBe(true)
    expect(humanIsTrigger({ ...phase, trigger: { type: "dm" } }, true, 0)).toBe(false)
    expect(humanIsTrigger(phase, false, 0)).toBe(false)
    const from = logOpensAt(true, announced, signalled)
    expect(notificationIdsFrom([], tap, from - 5000)).toHaveLength(11)
    expect(logOpensAt(false, announced, signalled)).toBe(signalled)
    // A cell that waited 40 min for its human opens at most 5 min before the signal.
    expect(logOpensAt(true, signalled - 40 * 60_000, signalled)).toBe(signalled - 5 * 60_000)
  })

  it("the window waits for the human, then runs from the first delivery", () => {
    const none: PhaseObservation = { ...replay, notificationIds: [], deliveries: [], receipts: [] }
    const wait = 600_000
    // 3 min after the signal, nothing yet: still waiting (the plain clock would be over).
    expect(humanTriggeredElapsed(none, signalledAt + 180_000, signalledAt, wait)).toBe(0)
    expect(
      isSettled(
        phase,
        none,
        humanTriggeredElapsed(none, signalledAt + 180_000, signalledAt, wait),
        ["ios"],
      ),
    ).toBe(false)
    // Past the human wait: over.
    expect(
      humanTriggeredElapsed(none, signalledAt + wait, signalledAt, wait),
    ).toBeGreaterThanOrEqual(wait)
    // Once the test is sent, the window counts from its first delivery row.
    const first = Date.parse(day("20:29:49.901"))
    expect(humanTriggeredElapsed(replay, first + 10_000, signalledAt, wait)).toBe(10_000)
  })
})
