// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The desktop hook point (S2, S5). Every producer that holds a `RouterDecision`
 * calls `onDesktopDecision`; by default it hands the item to the realtime
 * desktop emitter (`emitDesktopNotify`: target selection, presence,
 * idempotency). Tests swap the emitter with `registerDesktopEmitter`.
 *
 * `notifyId` is `attention:<rowId>[:<revision>]` or `message:<messageId>`;
 * `route` is `thread/<threadId>` for a thread, else
 * `attention/<app>/<entityType>/<entityId>`.
 */
import { rootLogger } from "~/lib/logger"
import { type DesktopNotifyPayload, emitDesktopNotify } from "./desktop-emitter"
import type { RouterDecision } from "./router"

export type { DesktopNotifyPayload }

const log = rootLogger.child({ module: "notifications-desktop-hook" })

export type DesktopEmitter = (
  decision: RouterDecision,
  payload: DesktopNotifyPayload,
) => Promise<void> | void

const defaultEmitter: DesktopEmitter = async (decision, payload) => {
  await emitDesktopNotify(decision, payload)
}

let emitter: DesktopEmitter = defaultEmitter

/** Swap the desktop emitter (tests). `null` restores `emitDesktopNotify`. */
export function registerDesktopEmitter(fn: DesktopEmitter | null): void {
  emitter = fn ?? defaultEmitter
}

/**
 * Hand one routed item to the desktop emitter. Does nothing unless the
 * decision's desktop channel delivers. Never throws: a desktop notification is
 * not worth failing the producer that raised it.
 */
export async function onDesktopDecision(
  decision: RouterDecision,
  payload: DesktopNotifyPayload,
): Promise<void> {
  if (!decision.channels.desktop.deliver) return
  try {
    await emitter(decision, payload)
  } catch (err) {
    log.warn({ err, userId: decision.userId, notifyId: payload.notifyId }, "desktop emit failed")
  }
}
