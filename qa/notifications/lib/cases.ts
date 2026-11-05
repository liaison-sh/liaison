// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The case catalogue of spec-push.md S7 (M1-M5) with amendments A6, A9, A13
// and the human cells (H-1, the TestFlight pass of D16). Each case sets every
// grid cell it depends on (A9), so none passes on a default.
//
// The computer channel lands on ONE surface, chosen by the server's
// precedence (A6): a live desktop app with permission granted, else a live
// browser tab, else Web Push. Which one a case expects therefore depends on
// which controllers the run drives; `computerTarget` makes that choice the
// same way the server does, from the states the case sets.

import {
  type BrowserState,
  type Controller,
  type DesktopState,
  type Expect,
  GROUPS,
  type GridChannel,
  type Group,
  type MatrixCase,
  type Phase,
  type RouterExpect,
  type Surface,
  type SurfaceStates,
  type Trigger,
} from "./types"

const SHOWN: Expect = { kind: "shown" }
const NONE: Expect = { kind: "none" }
const ON_SCREEN: Expect = { kind: "suppressed", reason: "on_screen" }

/** M1 surfaces "in background". */
const BACKGROUND: SurfaceStates = {
  ios: "background",
  desktop: "elsewhere",
  browser: "background_tab",
}

export const COMPUTER_SURFACES: Surface[] = ["desktop", "browser_tab", "browser_push"]

/** The surface the server picks for the computer channel (A6), or null. */
export function computerTarget(
  enabled: readonly Controller[],
  states: SurfaceStates,
): Surface | null {
  const desktop: DesktopState | undefined = enabled.includes("desktop") ? states.desktop : "quit"
  const browser: BrowserState | undefined = enabled.includes("web")
    ? (states.browser ?? "unregistered")
    : "unregistered"
  if (desktop && desktop !== "quit" && desktop !== "killed" && desktop !== "permission_denied") {
    return "desktop"
  }
  if (browser === "focused_elsewhere" || browser === "on_thread" || browser === "background_tab") {
    return "browser_tab"
  }
  if (browser === "no_tab") return "browser_push"
  return null
}

/**
 * Expectations for every surface the run drives: `ios` follows the push cell,
 * the computer target follows the desktop cell, every other surface none.
 */
export function expectFor(
  enabled: readonly Controller[],
  states: SurfaceStates,
  cells: { push: Expect; computer: Expect },
): Partial<Record<Surface, Expect>> {
  const out: Partial<Record<Surface, Expect>> = {}
  if (enabled.includes("ios")) out.ios = cells.push
  const target = computerTarget(enabled, states)
  for (const s of COMPUTER_SURFACES) {
    if (s === "desktop" && !enabled.includes("desktop")) continue
    if (s !== "desktop" && !enabled.includes("web")) continue
    out[s] = s === target ? cells.computer : NONE
  }
  return out
}

/** The real producer per group (S7 M1). */
function producerFor(group: Group, channel: GridChannel): { trigger: Trigger; note?: string } {
  switch (group) {
    case "direct":
      // Both direct producers are covered: DM on the push pair, @mention on the computer pair.
      return channel === "push" ? { trigger: { type: "dm" } } : { trigger: { type: "mention" } }
    case "replies":
      return { trigger: { type: "thread_reply" } }
    case "approvals":
      return { trigger: { type: "approval" } }
    case "agent":
      return { trigger: { type: "notify_user" } }
    case "mail":
      return {
        trigger: { type: "qa_inject", kind: "new_email" },
        note: "new_email through the mail producer via the QA inject route (A11): no synced demo mailbox",
      }
    case "work":
      return {
        trigger: { type: "qa_inject", kind: "task_overdue" },
        note: "task_overdue (the overdue-task kind the nudge raises) via the QA inject route; the nudge job has no HTTP trigger",
      }
    case "system":
      return {
        trigger: { type: "qa_inject", kind: "system_alert" },
        note: "a real system_alert kind via the QA inject route (A4: not the test route)",
      }
  }
}

function m1(enabled: readonly Controller[]): MatrixCase[] {
  const out: MatrixCase[] = []
  for (const group of GROUPS) {
    for (const channel of ["push", "desktop"] as const) {
      for (const on of [true, false]) {
        // The tested cell as named; the other channel the opposite way, so an
        // "off" case still proves the pipeline is alive on the other channel.
        const other: GridChannel = channel === "push" ? "desktop" : "push"
        const grid = { [group]: { [channel]: on, [other]: !on } }
        const pushOn = channel === "push" ? on : !on
        const computerOn = channel === "desktop" ? on : !on
        const { trigger, note } = producerFor(group, channel)
        const router: RouterExpect[] = [
          ...(pushOn
            ? []
            : [{ channel: "push" as const, result: "suppressed" as const, reason: "grid_off" }]),
          ...(computerOn
            ? []
            : [{ channel: "desktop" as const, result: "suppressed" as const, reason: "grid_off" }]),
        ]
        const name = channel === "push" ? "push" : "computer"
        out.push({
          id: `M1-${group}-${name}-${on ? "on" : "off"}`,
          group: "M1",
          title: `${group} x ${name} cell ${on ? "on" : "off"}, surfaces in background`,
          ...(note ? { producerNote: note } : {}),
          setup: { grid },
          phases: [
            {
              label: trigger.type,
              states: BACKGROUND,
              trigger,
              expect: expectFor(enabled, BACKGROUND, {
                push: pushOn ? SHOWN : NONE,
                computer: computerOn ? SHOWN : NONE,
              }),
              router,
            },
          ],
        })
      }
    }
  }
  return out
}

const DM_PUSH_ONLY = { direct: { push: true, desktop: false } }
const DM_COMPUTER_ONLY = { direct: { push: false, desktop: true } }

function dmCase(
  id: string,
  group: MatrixCase["group"],
  title: string,
  grid: MatrixCase["setup"]["grid"],
  states: SurfaceStates,
  expect: Partial<Record<Surface, Expect>>,
  extra: Partial<Phase> = {},
): MatrixCase {
  return {
    id,
    group,
    title,
    setup: { grid },
    phases: [{ label: "dm", states, trigger: { type: "dm" }, expect, ...extra }],
  }
}

function m2(): MatrixCase[] {
  // iOS: the computer channel is off, so only the phone is judged.
  const ios = (state: SurfaceStates["ios"], e: Expect, t: string) =>
    dmCase(`M2-ios-${state}`, "M2", `iOS ${t}`, DM_PUSH_ONLY, { ios: state }, { ios: e })
  // Desktop: push off; the browser is out of the way unless the case needs it.
  const desk = (state: DesktopState, e: Expect, t: string) =>
    dmCase(
      `M2-desktop-${state}`,
      "M2",
      `Desktop ${t}`,
      DM_COMPUTER_ONLY,
      { desktop: state, browser: "unregistered" },
      { desktop: e },
    )
  const web = (state: BrowserState, t: string, target: Surface) =>
    dmCase(
      `M2-browser-${state}`,
      "M2",
      `Browser ${t} (desktop app quit)`,
      DM_COMPUTER_ONLY,
      { desktop: "quit", browser: state },
      {
        browser_tab: target === "browser_tab" ? SHOWN : NONE,
        browser_push: target === "browser_push" ? SHOWN : NONE,
      },
    )
  return [
    ios("foreground_other", SHOWN, "foreground on another screen"),
    ios("foreground_thread", ON_SCREEN, "foreground on the same thread"),
    ios("background", SHOWN, "background"),
    ios("killed", SHOWN, "killed"),
    desk("elsewhere", SHOWN, "focused elsewhere (route not on the thread)"),
    desk("on_thread", ON_SCREEN, "on the same thread (route)"),
    desk("tray", SHOWN, "window closed to the tray"),
    {
      id: "M2-desktop-quit",
      group: "M2",
      title: "Desktop app quit: browser push per precedence, no replay on relaunch",
      setup: { grid: DM_COMPUTER_ONLY },
      phases: [
        {
          label: "dm while quit",
          states: { desktop: "quit", browser: "no_tab" },
          trigger: { type: "dm" },
          expect: { desktop: NONE, browser_push: SHOWN },
        },
        {
          label: "relaunch: no replay",
          states: { desktop: "elsewhere" },
          trigger: { type: "none" },
          observePhase: 0,
          expect: { desktop: NONE },
        },
      ],
    },
    web("focused_elsewhere", "tab focused elsewhere", "browser_tab"),
    web("background_tab", "background tab", "browser_tab"),
    web("no_tab", "no tab open, Chrome running", "browser_push"),
  ]
}

function m3(enabled: readonly Controller[]): MatrixCase[] {
  const both = (g: Group) => ({ [g]: { push: true, desktop: true } })
  const all = (e: Expect) => expectFor(enabled, BACKGROUND, { push: e, computer: e })
  const held = (reason: string): RouterExpect[] => [
    { channel: "push", result: "suppressed", reason },
    { channel: "desktop", result: "suppressed", reason },
  ]
  return [
    {
      id: "M3-muted-reply",
      group: "M3",
      title: "Muted thread, plain reply: none",
      setup: { grid: both("replies"), muteThread: true },
      phases: [
        {
          label: "thread_reply",
          states: BACKGROUND,
          trigger: { type: "thread_reply" },
          expect: all(NONE),
          router: held("thread_muted"),
        },
      ],
    },
    {
      id: "M3-muted-mention",
      group: "M3",
      title: "Muted thread, @mention: shown (breaks through)",
      setup: { grid: both("direct"), muteThread: true },
      phases: [
        { label: "mention", states: BACKGROUND, trigger: { type: "mention" }, expect: all(SHOWN) },
      ],
    },
    {
      id: "M3-app-rule-off",
      group: "M3",
      title: "App rule off for a kind: none everywhere",
      producerNote: "task_overdue via the QA inject route; a kernel rule that ticks only sla_risk",
      setup: { grid: both("work"), appRuleOff: { source: "kernel", kinds: ["sla_risk"] } },
      phases: [
        {
          label: "qa_inject task_overdue",
          states: BACKGROUND,
          trigger: { type: "qa_inject", kind: "task_overdue" },
          expect: all(NONE),
        },
      ],
    },
    {
      id: "M3-quiet",
      group: "M3",
      title: "Quiet hours with explicit work hours: push and computer none",
      producerNote: "system_alert via the QA inject route",
      setup: { grid: both("system"), quietHours: true },
      phases: [
        {
          label: "qa_inject system_alert",
          states: BACKGROUND,
          trigger: { type: "qa_inject", kind: "system_alert" },
          expect: all(NONE),
          router: held("quiet_time"),
        },
      ],
    },
    {
      id: "M3-quiet-urgent",
      group: "M3",
      title: "Quiet hours, urgent item: shown",
      producerNote: "urgent system_alert via the QA inject route",
      setup: { grid: both("system"), quietHours: true },
      phases: [
        {
          label: "qa_inject system_alert urgent",
          states: BACKGROUND,
          trigger: { type: "qa_inject", kind: "system_alert", urgent: true },
          expect: all(SHOWN),
        },
      ],
    },
    {
      id: "M3-no-device",
      group: "M3",
      title: "Recipient with no device: delivery row no_device",
      recipient: "nodevice",
      setup: { grid: both("direct") },
      phases: [
        {
          label: "dm to the no-device user",
          trigger: { type: "dm" },
          expect: {},
          router: [
            { channel: "push", result: "no_device" },
            { channel: "desktop", result: "no_target" },
          ],
        },
      ],
    },
  ]
}

function m4(): MatrixCase[] {
  return [
    dmCase(
      "M4-desktop-over-browser",
      "M4",
      "Desktop live + browser subscribed: desktop only",
      DM_COMPUTER_ONLY,
      { desktop: "elsewhere", browser: "background_tab" },
      { desktop: SHOWN, browser_tab: NONE, browser_push: NONE },
    ),
    dmCase(
      "M4-desktop-quit",
      "M4",
      "Desktop quit: browser",
      DM_COMPUTER_ONLY,
      { desktop: "quit", browser: "no_tab" },
      { desktop: NONE, browser_push: SHOWN },
    ),
    dmCase(
      "M4-desktop-denied",
      "M4",
      "Desktop OS permission denied (reported): browser",
      DM_COMPUTER_ONLY,
      { desktop: "permission_denied", browser: "no_tab" },
      { desktop: NONE, browser_push: SHOWN },
    ),
    {
      id: "M4-replay",
      group: "M4",
      title: "Desktop relaunch after missing 3 with no browser: the 3 are replayed",
      setup: { grid: DM_COMPUTER_ONLY },
      phases: [
        {
          label: "3 dms while quit, no browser",
          states: { desktop: "quit", browser: "unregistered" },
          trigger: { type: "dm" },
          repeat: 3,
          expect: { desktop: NONE },
          router: [{ channel: "desktop", result: "no_target" }],
        },
        {
          label: "relaunch: replay",
          states: { desktop: "elsewhere" },
          trigger: { type: "none" },
          observePhase: 0,
          repeat: 3,
          windowMs: 45_000,
          expect: { desktop: SHOWN },
        },
      ],
    },
  ]
}

function a6(): MatrixCase[] {
  return [
    dmCase(
      "A6-desktop-killed",
      "A6",
      "Desktop killed (not graceful): browser within 15 s",
      DM_COMPUTER_ONLY,
      { desktop: "killed", browser: "no_tab" },
      { browser_push: SHOWN },
      { windowMs: 15_000 },
    ),
    dmCase(
      "A6-tab-on-thread",
      "A6",
      "Tab on the same thread + Web Push subscribed: in-tab suppressed, no Web Push",
      DM_COMPUTER_ONLY,
      { desktop: "quit", browser: "on_thread" },
      { browser_tab: ON_SCREEN, browser_push: NONE },
    ),
  ]
}

function a13(): MatrixCase[] {
  return [
    dmCase(
      "A13-tray-3min",
      "A13",
      "Desktop in the tray for 3 min, then DM: desktop shown",
      DM_COMPUTER_ONLY,
      { desktop: "tray", browser: "unregistered" },
      { desktop: SHOWN },
      { holdMs: 180_000 },
    ),
  ]
}

function m5(): MatrixCase[] {
  const reg = (
    id: string,
    title: string,
    action: "fresh_install" | "fail_next_register" | "invalidate_token",
    withinMs: number,
  ): MatrixCase => ({
    id,
    group: "M5",
    title,
    setup: { grid: DM_PUSH_ONLY },
    phases: [
      {
        label: action,
        trigger: { type: "none" },
        windowMs: withinMs,
        expect: {},
        deviceCheck: { id, surface: "ios", action, withinMs },
      },
    ],
  })
  return [
    reg(
      "M5-fresh-install",
      "A fresh install registers and is in the device list",
      "fresh_install",
      120_000,
    ),
    reg(
      "M5-register-retry",
      "A forced register POST failure is retried and succeeds within 2 min",
      "fail_next_register",
      120_000,
    ),
    reg(
      "M5-token-invalidated",
      "A token invalidated server-side is re-registered on the next foreground",
      "invalidate_token",
      120_000,
    ),
  ]
}

function human(): MatrixCase[] {
  const tf = (
    id: string,
    title: string,
    instructions: string[],
    trigger: Trigger,
    e: Expect,
    extra: Partial<MatrixCase["setup"]> = {},
    grid: MatrixCase["setup"]["grid"] = DM_PUSH_ONLY,
    windowMs?: number,
    receivedIsShown = false,
  ): MatrixCase => ({
    id,
    group: "TF",
    title: `TestFlight: ${title}`,
    setup: { grid, ...extra },
    human: { device: "testflight-phone", instructions },
    phases: [
      {
        label: trigger.type,
        trigger,
        expect: { ios: e },
        ...(windowMs ? { windowMs } : {}),
        ...(receivedIsShown ? { receivedIsShown: ["ios" as const] } : {}),
      },
    ],
  })
  return [
    {
      id: "H-1",
      group: "H",
      title: "macOS System Settings notifications OFF for the desktop app: browser gets it",
      setup: { grid: DM_COMPUTER_ONLY },
      human: {
        device: "mac-system-settings",
        instructions: [
          "On the Minimac: System Settings > Notifications > Liaison > Allow notifications OFF.",
          "Leave the desktop app running (it reports the permission on change).",
          "Confirm; after the case, turn the setting back ON.",
        ],
      },
      phases: [
        {
          label: "dm",
          states: { desktop: "elsewhere", browser: "no_tab" },
          trigger: { type: "dm" },
          expect: { desktop: NONE, browser_push: SHOWN },
        },
      ],
    },
    tf(
      "TF-test-button",
      "Send me a test",
      [
        "On the phone: Settings > Notifications > Send me a test, right after confirming.",
        "Expect the iOS system banner at the top of the screen, not a Liaison strip inside the app.",
      ],
      { type: "none" },
      SHOWN,
      {},
      DM_PUSH_ONLY,
      120_000,
    ),
    tf(
      "TF-dm-foreground",
      "DM, app in the foreground (another screen)",
      [
        "Open Liaison on the phone, on Home (not the DM thread), then confirm.",
        "Expect the iOS system banner at the top of the screen, not a Liaison strip inside the app.",
      ],
      { type: "dm" },
      SHOWN,
    ),
    tf(
      "TF-dm-background",
      "DM, app in the background",
      ["Open Liaison, then go to the iPhone home screen (app in background), then confirm."],
      { type: "dm" },
      SHOWN,
      {},
      DM_PUSH_ONLY,
      undefined,
      true,
    ),
    tf(
      "TF-dm-killed",
      "DM, app killed",
      ["Swipe Liaison away in the app switcher (killed), then confirm."],
      { type: "dm" },
      SHOWN,
      {},
      DM_PUSH_ONLY,
      undefined,
      true,
    ),
    tf(
      "TF-mention-background",
      "@mention, app in the background",
      ["Leave Liaison in the background, then confirm."],
      { type: "mention" },
      SHOWN,
      {},
      { direct: { push: true, desktop: false } },
      undefined,
      true,
    ),
    tf(
      "TF-muted-reply",
      "Reply in a muted thread: none",
      ["Leave Liaison in the background, then confirm (the runner mutes the thread)."],
      { type: "thread_reply" },
      NONE,
      { muteThread: true },
      { replies: { push: true, desktop: false } },
    ),
  ]
}

/** Every case of the matrix, for the controllers the run drives. */
export function buildCases(enabled: readonly Controller[]): MatrixCase[] {
  return [...m1(enabled), ...m2(), ...m3(enabled), ...m4(), ...m5(), ...a6(), ...a13(), ...human()]
}

/** The controllers a case cannot run without. */
export function controllersNeeded(c: MatrixCase): Controller[] {
  const need = new Set<Controller>()
  for (const p of c.phases) {
    if (p.states?.ios && !c.human) need.add("ios")
    // A quit desktop app is what a run without the desktop controller has.
    if (p.states?.desktop && p.states.desktop !== "quit") need.add("desktop")
    if (p.states?.browser && p.states.browser !== "unregistered") need.add("web")
    if (p.deviceCheck?.surface === "ios") need.add("ios")
    for (const s of Object.keys(p.expect) as Surface[]) {
      need.add(s === "ios" ? "ios" : s === "desktop" ? "desktop" : "web")
    }
  }
  // A TestFlight cell is the owner's phone, not the simulator.
  if (c.human?.device === "testflight-phone") need.delete("ios")
  // M1/M3 adapt their expectations to the run; they need nothing beyond it.
  if (c.group === "M1" || (c.group === "M3" && c.id !== "M3-no-device")) need.clear()
  return [...need]
}
