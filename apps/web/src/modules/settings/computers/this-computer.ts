// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THIS COMPUTER, in the desktop app (P4 N-D T4, S19): whether it is one of the
// viewer's computers, its checklist (Claude sign-in, notifications, open at
// login, keep awake while plugged in) and the flows that turn it on and off.
// The decisions are in modules/nodes/node-setup.ts; this file runs them
// against the shell. Settings > Computers draws the setup card and this
// computer's row from it, and the computer's Settings tab its "Ready to work".
//
// A browser cannot be a computer of the viewer's: `available` is false there
// and nothing is read.

import { createEffect, createSignal, on, onMount } from "solid-js"
import type { DesktopKeepAwake } from "~/lib/desktop-shell-contract"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { serverAddressOverride } from "~/lib/env"
import { claudeAccount, desktopState } from "~/modules/desktop/desktop-store"
import { myNodes } from "~/modules/nodes/node-api"
import { setNodeSession } from "~/modules/nodes/node-session"
import {
  CHECKLIST,
  type ChecklistItem,
  fixChecklistItem,
  initialNodeSetup,
  type NodeSetupEvent,
  nodeSetupReducer,
  readChecklistItem,
  registerNode,
  turnOffNode,
} from "~/modules/nodes/node-setup"
import { refetchNodes } from "~/modules/nodes/nodes-store"
import { desktopDeviceId } from "~/modules/notifications/desktop-device"
import { useApi } from "~/modules/shell/ApiContext"

/** The phases in which the switch reads as on. */
export const ON_PHASES = new Set(["checking", "setup", "registering", "on"])

export function useThisComputer() {
  const api = useApi()
  const shell = getDesktopBridge()
  const server = serverAddressOverride()
  const available = Boolean(shell?.storeNodeCredential && server)
  const [state, setState] = createSignal(initialNodeSetup())
  const [awake, setAwake] = createSignal<DesktopKeepAwake | null>(null)
  const [busy, setBusy] = createSignal<ChecklistItem | null>(null)
  /** The node the shell holds for this server, on or off. */
  const [nodeId, setNodeId] = createSignal<string | null>(null)
  // The Claude sign-in is the shell's own dialog: its item is re-read when
  // the sign-in ends (succeeded or cancelled).
  const [claudePending, setClaudePending] = createSignal(false)
  // A refusal can only be undone in the system's settings: say where.
  const [notificationsRefused, setNotificationsRefused] = createSignal(false)

  const dispatch = (event: NodeSetupEvent) => setState((s) => nodeSetupReducer(s, event))

  async function readItem(item: ChecklistItem): Promise<void> {
    if (!shell) return
    dispatch({ type: "checked", item, state: await readChecklistItem(item, shell) })
  }

  async function checkAll(): Promise<void> {
    await Promise.all(CHECKLIST.map((item) => readItem(item)))
  }

  async function refreshAwake(): Promise<void> {
    if (shell?.keepAwake) setAwake(await shell.keepAwake().catch(() => null))
  }

  onMount(async () => {
    if (!available || !shell?.loadNodeCredential || !server) return
    let node = await shell.loadNodeCredential(server).catch(() => null)
    // A computer removed elsewhere (Settings > Computers on another device)
    // is no computer any more: its credential is dropped here and the switch
    // shows off. Only a server that ANSWERED without it counts; an
    // unreachable one changes nothing (walk N13).
    if (node?.enabled) {
      const listed = await myNodes(api).catch(() => null)
      if (listed && !listed.some((n) => n.id === node?.nodeId)) {
        await shell.storeNodeCredential?.(server, null)
        setNodeSession(null)
        node = null
      }
    }
    setNodeId(node?.nodeId ?? null)
    dispatch({ type: "loaded", enabled: node?.enabled === true })
    // Read at once, on or off: the setup card and "Ready to work" show them.
    await checkAll()
    await refreshAwake()
  })

  async function register(): Promise<void> {
    const deviceId = desktopDeviceId()
    if (!shell || !server || !deviceId) {
      dispatch({ type: "failed", error: "no_device" })
      return
    }
    try {
      const record = await registerNode({ api, shell, server, deviceId })
      setNodeId(record.nodeId)
      dispatch({ type: "registered" })
      await refreshAwake()
      void refetchNodes()
    } catch {
      dispatch({ type: "failed", error: "register" })
    }
  }

  createEffect(
    on(
      () => state().phase,
      (phase) => {
        if (phase === "registering") void register()
      },
    ),
  )

  createEffect(
    on([() => claudeAccount()?.loggedIn, () => desktopState().claudeSignIn], ([, signIn]) => {
      if (!claudePending() || signIn) return
      setClaudePending(false)
      void readItem("claude")
    }),
  )

  /** On: the checklist runs, then the computer registers. Off: queued work waits. */
  async function toggle(next: boolean): Promise<void> {
    if (!shell || !server) return
    if (next) {
      dispatch({ type: "turnOn" })
      await checkAll()
      return
    }
    try {
      await turnOffNode({ api, shell, server })
      dispatch({ type: "turnOff" })
      void refetchNodes()
    } catch {
      // The server did not hear it: nothing changed there, so nothing here.
      setNodeSession(null)
      dispatch({ type: "failed", error: "turnOff" })
    }
    await refreshAwake()
  }

  async function fix(item: ChecklistItem): Promise<void> {
    if (!shell || busy()) return
    setBusy(item)
    const next = await fixChecklistItem(item, shell)
    setBusy(null)
    if (item === "claude" && next === "checking") {
      setClaudePending(true)
      return
    }
    if (item === "notifications") setNotificationsRefused(next !== "done")
    dispatch({ type: "checked", item, state: next })
    if (item === "keepAwake") await refreshAwake()
  }

  /** "Turn off" on a check that has one: open at login, keep awake. */
  async function undo(item: "launchAtLogin" | "keepAwake"): Promise<void> {
    if (!shell || busy()) return
    setBusy(item)
    try {
      if (item === "launchAtLogin") await shell.setLaunchAtLogin?.(false)
      else await shell.setKeepAwake?.(false)
    } catch {
      // Re-read below: the item says what the system holds now.
    }
    setBusy(null)
    await readItem(item)
    if (item === "keepAwake") await refreshAwake()
  }

  return {
    available,
    shell,
    state,
    awake,
    busy,
    nodeId,
    claudePending,
    notificationsRefused,
    toggle,
    fix,
    undo,
    isOn: () => ON_PHASES.has(state().phase),
  }
}

export type ThisComputer = ReturnType<typeof useThisComputer>
