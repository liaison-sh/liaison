// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The push matrix (S7) data model. A case is setup + phases; a phase applies
// surface states, fires one real trigger (or none), then reads the recipient's
// delivery rows and receipts for up to the window and compares each surface
// with its expectation. Everything here is plain data so the engine that
// judges it is pure and unit-tested (engine.test.ts).

export const GROUPS = ["direct", "replies", "approvals", "work", "mail", "agent", "system"] as const
export type Group = (typeof GROUPS)[number]

/** The grid channels the matrix drives. "computer" in the spec is `desktop`. */
export type GridChannel = "push" | "desktop"

/** Where a notification can land, as the delivery log and receipts name it. */
export const SURFACES = ["ios", "desktop", "browser_tab", "browser_push"] as const
export type Surface = (typeof SURFACES)[number]

/** The controllers a run can include (`--surfaces`). */
export const CONTROLLERS = ["ios", "desktop", "web"] as const
export type Controller = (typeof CONTROLLERS)[number]

export function controllerOf(surface: Surface): Controller {
  if (surface === "ios") return "ios"
  if (surface === "desktop") return "desktop"
  return "web"
}

export function channelOf(surface: Surface): GridChannel {
  return surface === "ios" ? "push" : "desktop"
}

export type Expect = { kind: "shown" } | { kind: "suppressed"; reason?: string } | { kind: "none" }

export type ObservedKind = "shown" | "suppressed" | "received" | "none"

export interface Observed {
  kind: ObservedKind
  reason?: string
  /** Receipt and delivery row ids that back the observation. */
  evidence: string[]
}

export type IosState =
  | "foreground_other" // app open on another screen
  | "foreground_thread" // app open on the case's thread
  | "background" // another app in front, ours alive
  | "killed" // terminated

export type DesktopState =
  | "elsewhere" // app running, route not on the thread
  | "on_thread" // app route on the case's thread
  | "tray" // window hidden to the tray
  | "quit" // graceful quit
  | "killed" // SIGKILL, presence lingers up to its TTL
  | "permission_denied" // running, reported OS permission denied

export type BrowserState =
  | "focused_elsewhere" // tab visible, route not on the thread
  | "on_thread" // tab visible on the case's thread
  | "background_tab" // tab open but hidden behind another tab
  | "no_tab" // Chrome running, no Liaison tab (Web Push only)
  | "unregistered" // no tab and no Web Push subscription (no browser device)

export interface SurfaceStates {
  ios?: IosState
  desktop?: DesktopState
  browser?: BrowserState
}

/** A9: every cell a case depends on is set explicitly. */
export type GridCells = Partial<Record<Group, Partial<Record<GridChannel, boolean>>>>

export interface CaseSetup {
  grid: GridCells
  /** Mute the case thread for the recipient. */
  muteThread?: boolean
  /** A per-app rule that unticks these kinds of this source (app_rule). */
  appRuleOff?: { source: string; kinds: string[] }
  /** Explicit work hours that exclude now (quiet time). */
  quietHours?: boolean
}

export type Trigger =
  | { type: "none" }
  | { type: "dm"; text?: string }
  | { type: "mention" } // @mention of the recipient in the group thread
  | { type: "thread_reply" } // plain message in the group thread (replies group)
  | { type: "notify_user"; urgent?: boolean } // agent tool, as the recipient
  | { type: "approval" } // gated tool call by an agent acting for the sender
  | { type: "qa_inject"; kind: string; urgent?: boolean }
  | { type: "test_route" } // POST /api/notifications/test as the recipient

/** A router-level delivery row (device NULL) the phase must find. */
export interface RouterExpect {
  channel: GridChannel
  result: "suppressed" | "no_device" | "no_target"
  reason?: string
}

/** Registration checks (M5): read from the device list, not receipts. */
export interface DeviceCheck {
  id: string
  surface: "ios" | "desktop" | "browser"
  /** What the controller does before the check is polled. */
  action: "fresh_install" | "fail_next_register" | "invalidate_token"
  /** How long registration may take. */
  withinMs: number
}

export interface Phase {
  label: string
  states?: SurfaceStates
  trigger: Trigger
  /** Fire the trigger this many times (M4 replay: 3). */
  repeat?: number
  /** Judge the notifications of an earlier phase (index) instead of this one's. */
  observePhase?: number
  /** Wait this long after the states before the trigger (A13 tray: 3 min). */
  holdMs?: number
  windowMs?: number
  expect: Partial<Record<Surface, Expect>>
  router?: RouterExpect[]
  deviceCheck?: DeviceCheck
  /** Surfaces whose `received` counts as shown here (A3), beyond what the states imply. */
  receivedIsShown?: Surface[]
}

export type CaseGroup = "M1" | "M2" | "M3" | "M4" | "M5" | "A6" | "A13" | "H" | "TF"

export interface HumanSpec {
  /** What the person does, in order; the runner waits for them, then polls. */
  instructions: string[]
  /** The surface the human drives (TestFlight = the owner's phone). */
  device: "testflight-phone" | "mac-system-settings" | "simulator"
}

export interface MatrixCase {
  id: string
  group: CaseGroup
  title: string
  /** The trigger is a stand-in, not the spec's producer: said in the report. */
  producerNote?: string
  setup: CaseSetup
  phases: Phase[]
  human?: HumanSpec
  /** Whose notifications are read: the recipient (default) or the no-device user. */
  recipient?: "primary" | "nodevice"
}

// --- What the runner reads back (the QA log route) ---

export interface DeliveryRow {
  id: string
  notificationId: string
  deviceId: string | null
  surface: string | null
  channel: string
  result: string
  reason: string | null
  providerStatus?: number | null
  attemptedAt: string
}

export interface ReceiptRow {
  id: string
  notificationId: string
  deviceId: string
  surface: string | null
  appState?: string | null
  outcome: "received" | "shown" | "suppressed"
  reason: string | null
  receivedAt: string
  updatedAt: string
}

export interface PhaseObservation {
  /** The notifications this phase raised (from the trigger answer or the log). */
  notificationIds: string[]
  deliveries: DeliveryRow[]
  receipts: ReceiptRow[]
  /** When the trigger fired (ms epoch); receipts later than window are ignored. */
  triggeredAt: number
  /**
   * A phase that judges an earlier phase's notifications (replay on relaunch)
   * counts its window from here, not from their first delivery row.
   */
  windowFrom?: number
  /** Device-list check result, for phases with a deviceCheck. */
  deviceCheck?: { ok: boolean; detail: string; evidence: string[] }
  /** Surfaces whose `received` counts as shown (A3: iOS background / killed). */
  receivedCountsAsShown?: Surface[]
  /** Pin a surface to the runner's own device (stale devices are ignored). */
  deviceIds?: Partial<Record<Surface, string[]>>
}

export type CellStatus = "match" | "mismatch" | "skipped" | "human-pending" | "error"

export interface CellResult {
  caseId: string
  phase: string
  cell: string
  expected: string
  observed: string
  status: CellStatus
  evidence: string[]
  note?: string
}

export interface CaseResult {
  id: string
  group: CaseGroup
  title: string
  producerNote?: string
  status: CellStatus
  cells: CellResult[]
  startedAt: string
  durationMs: number
  error?: string
}

export interface RunReport {
  runId: string
  target: string
  startedAt: string
  finishedAt: string
  surfaces: Controller[]
  run: number
  runs: number
  cases: CaseResult[]
  totals: Record<CellStatus, number>
  /** All evaluated cells match and nothing was skipped or left pending. */
  pass: boolean
  /** Every case of the plan was evaluated (no surface filter, no human gap). */
  complete: boolean
  /** PASS, FAIL, or INCOMPLETE: <why> (nothing failed, but the run cannot pass). */
  verdict: string
}
