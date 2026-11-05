// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `demo-world`: the durable consumer that runs a demo scenario's world beat
// when its owner reaches it. It reads the owner's tour frames
// (`kernel/tour:start|update`) and hands the tour to the world registry,
// which decides whether the current beat is a world beat and may run.
//
// Registered after `tour-progress`, and it never throws (an error costs a
// world beat, never another consumer's delivery).
import type { TourFrameData } from "@liaison/shared"
import {
  type DurableEventContext,
  registerDurableEventConsumer,
} from "~/infra/events/durable-consumers"
import { rootLogger } from "~/lib/logger"
import { prepareCommerceWorldShipment } from "~/modules/demo/world/commerce-order"
import { completeAlreadyDoneBeat, runWorldBeat } from "~/modules/demo/world/registry"

const log = rootLogger.child({ module: "demo-world" })

export const DEMO_WORLD_CONSUMER = "demo-world"

export async function handleDemoWorldEvent(ctx: DurableEventContext): Promise<void> {
  const event = ctx.event
  try {
    // The live order's invoice was issued: its shipment is prepared next.
    await prepareCommerceWorldShipment(event)
    if (event.app !== "kernel" || event.entity !== "tour") return
    if (event.action !== "start" && event.action !== "update") return
    if (!event.orgId) return
    const data = event.data as Partial<TourFrameData> | null | undefined
    if (data?.status !== "active" || !data.ownerUserId || !data.tourId) return
    // A gate frame is this consumer's own "held back" notice: never a trigger.
    if (data.gate) return
    // A `do` beat already done before it came up (the routine is on) moves
    // on at once; the world beat after it, if any, then runs in this pass.
    await completeAlreadyDoneBeat(event.orgId, data.ownerUserId, data.tourId)
    await runWorldBeat(event.orgId, data.ownerUserId, data.tourId)
  } catch (err) {
    log.error({ err, eventId: ctx.eventId }, "Demo world consumer failed")
  }
}

export function registerDemoWorldConsumer(): void {
  registerDurableEventConsumer(DEMO_WORLD_CONSUMER, handleDemoWorldEvent)
}
