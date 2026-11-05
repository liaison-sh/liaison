// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The settings switch the plaintext responder consults before it releases
// anything (spec section 5.3b, "THE SWITCH"), and how it reaches the account
// holder's other devices.
//
// The value the responder reads is this browser's own copy, synchronously, as
// before. It is a REFUSAL preference, never a permission grant, so a browser
// that cannot read it defaults to on, exactly as the settings pane shows it.
//
// WHY IT IS NOT A PLAIN SERVER SETTING. A server-held preference is a value
// the operator can flip, and the point of this switch is that turning the
// assistant off is something only the account holder can undo. Yet a switch
// kept per browser meant "I turned the assistant off" on the desktop left it on
// for the phone's responder (design audit 2026-09-30, finding 10). So the
// server RELAYS changes (PUT /user/preferences/agent-mail-access, a
// `kernel:read_state` frame to the holder's sockets) and each device decides:
//
// - A change applies only when it is newer (`at`) than the one this device
//   holds, so a replayed old record cannot undo a newer choice.
// - An OFF applies as is. The worst a forged "off" can do is switch the
//   assistant off, which is the safe direction.
// - An ON applies only when its `mac` verifies: an HMAC of the change under
//   the mailbox key (the crypto worker's `ledgerMac`, domain-separated by the
//   statement label below). The server never holds that key, so it cannot
//   forge an "on". A device whose mailbox is locked cannot check it and keeps
//   its current value; the responder does not run while locked anyway, and the
//   unlock path re-reads the relayed record (`syncAgentMailAccessFromServer`).
// - Turning it ON is therefore relayed only from a device whose mailbox is
//   unlocked (it must sign). Turning it OFF is always relayed.

import { createSignal } from "solid-js"

const STORAGE_KEY = "liaison.mailbox.agentMailAccess"
const STATEMENT_LABEL = "liaison.agent-mail-access.v1"

export interface AgentMailAccessRecord {
  enabled: boolean
  /** Epoch ms of the change on the device that made it. 0 = never synced. */
  at: number
  mac?: string
}

/** What syncing needs: who the holder is, and the unlocked mailbox's MAC. */
export interface AgentMailAccessSyncDeps {
  userId: string | null
  /** The unlocked mailbox's crypto client, or null while locked. */
  crypto: { ledgerMac(statements: readonly string[]): Promise<string[]> } | null
}

function readLocal(): AgentMailAccessRecord {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return { enabled: true, at: 0 }
    // The first format was a bare "on" / "off": a choice with no time.
    if (raw === "on" || raw === "off") return { enabled: raw === "on", at: 0 }
    const parsed = JSON.parse(raw) as Partial<AgentMailAccessRecord>
    return {
      enabled: parsed.enabled !== false,
      at: typeof parsed.at === "number" ? parsed.at : 0,
    }
  } catch {
    return { enabled: true, at: 0 }
  }
}

function writeLocal(record: AgentMailAccessRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: record.enabled, at: record.at }))
  } catch {
    // Blocked site data. The in-page state still reflects the choice for this
    // session; nothing here is worth an error page.
  }
  setEnabledSignal(record.enabled)
}

// The settings pane follows changes relayed from another device.
const [enabledSignal, setEnabledSignal] = createSignal(readLocal().enabled)

/** Reactive view of the switch, for the settings pane. */
export function agentMailAccessState(): boolean {
  return enabledSignal()
}

/** What the plaintext responder consults, synchronously, before every release. */
export function agentMailAccessEnabled(): boolean {
  return readLocal().enabled
}

/** The signed statement for one change. Distinct label: never a ledger entry. */
export function agentMailAccessStatement(userId: string, enabled: boolean, at: number): string {
  return [STATEMENT_LABEL, userId, enabled ? "on" : "off", String(at)].join("\n")
}

/** Record a change made on THIS device. Returns the record to relay. */
export function setAgentMailAccessEnabled(
  enabled: boolean,
  now: number = Date.now(),
): AgentMailAccessRecord {
  // Strictly after whatever this device holds, even with a skewed clock.
  const at = Math.max(now, readLocal().at + 1)
  const record = { enabled, at }
  writeLocal(record)
  return record
}

/**
 * The record to PUT for a local change, or null when it cannot be relayed:
 * an ON needs the unlocked mailbox's MAC.
 */
export async function signAgentMailAccess(
  record: AgentMailAccessRecord,
  deps: AgentMailAccessSyncDeps,
): Promise<AgentMailAccessRecord | null> {
  if (!record.enabled) return { enabled: false, at: record.at }
  if (!deps.userId || !deps.crypto) return null
  try {
    const [mac] = await deps.crypto.ledgerMac([
      agentMailAccessStatement(deps.userId, true, record.at),
    ])
    return mac ? { enabled: true, at: record.at, mac } : null
  } catch {
    return null
  }
}

/**
 * Apply a change relayed from another device (a socket frame or the stored
 * record). Returns whether this device's value moved. Never throws.
 */
export async function applyRemoteAgentMailAccess(
  remote: unknown,
  deps: AgentMailAccessSyncDeps,
): Promise<boolean> {
  if (!remote || typeof remote !== "object") return false
  const r = remote as Record<string, unknown>
  if (typeof r.enabled !== "boolean" || typeof r.at !== "number") return false
  const local = readLocal()
  if (r.at <= local.at) return false
  if (!r.enabled) {
    writeLocal({ enabled: false, at: r.at })
    return true
  }
  // An ON must prove the holder made it.
  if (typeof r.mac !== "string" || !deps.userId || !deps.crypto) return false
  try {
    const [expected] = await deps.crypto.ledgerMac([
      agentMailAccessStatement(deps.userId, true, r.at),
    ])
    if (!expected || expected !== r.mac) return false
  } catch {
    return false
  }
  // Re-read: another change may have landed while the worker answered.
  if (r.at <= readLocal().at) return false
  writeLocal({ enabled: true, at: r.at })
  return true
}

interface PreferencesApi {
  get: <T = unknown>(path: string) => Promise<T>
  put: <T = unknown>(path: string, body?: unknown) => Promise<T>
}

/** Relay a change made on this device. Best effort: the local value already moved. */
export async function publishAgentMailAccess(
  api: PreferencesApi,
  record: AgentMailAccessRecord,
  deps: AgentMailAccessSyncDeps,
): Promise<void> {
  const signed = await signAgentMailAccess(record, deps)
  if (!signed) return
  try {
    await api.put("/user/preferences/agent-mail-access", signed)
  } catch {
    // Offline or refused: the next change, or this device's own copy, stands.
  }
}

/** Read the relayed record and apply it (on unlock, when an ON can be checked). */
export async function syncAgentMailAccessFromServer(
  api: PreferencesApi,
  deps: AgentMailAccessSyncDeps,
): Promise<void> {
  try {
    const res = await api.get<{ data?: { agentMailAccess?: unknown } }>("/user/preferences")
    await applyRemoteAgentMailAccess(res?.data?.agentMailAccess ?? null, deps)
  } catch {
    // The device keeps its own value.
  }
}
