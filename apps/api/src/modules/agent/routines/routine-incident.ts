// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Routine incidents: an event routine that could not handle an event is an
// operational fault (a customer message nobody triaged), so it is raised on the
// org's monitoring board, the same incident sink the watchdog feeds.
//
// Two incidents per routine, each with a stable dedupKey so a burst folds into
// one incident (the monitoring app counts repeats instead of opening more):
//
//   routine-run-failed:<routineId>   warning. Raised by every failed event or
//                                    retry run; resolved by the next run of the
//                                    routine that succeeds.
//   routine-undelivered:<routineId>  critical. Raised by the reconciler when an
//                                    event used up its retries; resolved once no
//                                    such event is left in the reconciler window.
//
// The sink hands the envelope to the monitoring app's `alert` webhook handler
// in process, through the trusted path its retry worker uses (no signature: the
// caller is the kernel itself). An org without the monitoring app has no
// handler and the call is a no-op. Never throws: an incident is a report about
// the run, never a reason to fail it.
import { processWebhookRetry } from "~/infra/jobs/webhook-worker"
import { rootLogger } from "~/lib/logger"
import { routineDisplayName } from "~/modules/agent/routines/routine-label"
import { webhookHandlers } from "~/modules/apps/app-registries"

const log = rootLogger.child({ module: "routine-incident" })

/** The monitoring source every routine incident is filed under. */
export const ROUTINE_INCIDENT_SOURCE = "liaison-routines"

export type IncidentEnvelope =
  | {
      source: string
      severity: "warning" | "critical"
      title: string
      body?: string
      dedupKey: string
      ts: string
    }
  | { source: string; dedupKey: string; status: "resolved"; ts: string }

export type IncidentSink = (orgId: string, envelope: IncidentEnvelope) => Promise<void>

/** The default sink: the org's monitoring app, when it is installed. */
const monitoringSink: IncidentSink = async (orgId, envelope) => {
  if (!webhookHandlers.get([orgId, "monitoring", "alert"])) return
  await processWebhookRetry({
    orgId,
    appName: "monitoring",
    endpointName: "alert",
    payload: envelope,
    headers: {},
  })
}

let sink: IncidentSink = monitoringSink

export const runFailedDedupKey = (routineId: string) => `routine-run-failed:${routineId}`
export const undeliveredDedupKey = (routineId: string) => `routine-undelivered:${routineId}`

async function send(orgId: string, envelope: IncidentEnvelope): Promise<void> {
  try {
    await sink(orgId, envelope)
  } catch (err) {
    log.error({ err, orgId, dedupKey: envelope.dedupKey }, "Routine incident could not be sent")
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * After a routine run: a failed event or retry run raises (or folds into) the
 * routine's run-failed incident; a succeeded run of a routine whose previous
 * run failed resolves it. Scheduled and manual runs raise nothing here (their
 * owner alert already exists, D21).
 */
export async function reportRoutineRunIncident(input: {
  orgId: string
  routine: { id: string; name: string; title?: string | null }
  status: string
  error: string | null
  trigger: string | null
  previousStatus: string | null
}): Promise<void> {
  const eventDriven = input.trigger === "event" || input.trigger === "retry"
  const ts = new Date().toISOString()
  if (input.status === "failed" && eventDriven) {
    await send(input.orgId, {
      source: ROUTINE_INCIDENT_SOURCE,
      severity: "warning",
      title: clip(`Routine "${routineDisplayName(input.routine)}" could not handle an event`, 200),
      body: clip(
        `${input.error ?? "The run failed."}\nThe event is retried automatically (routine event reconciler).`,
        2000,
      ),
      dedupKey: runFailedDedupKey(input.routine.id),
      ts,
    })
    return
  }
  const succeeded = input.status === "succeeded" || input.status === "output_thread_recreated"
  if (succeeded && input.previousStatus === "failed") {
    await send(input.orgId, {
      source: ROUTINE_INCIDENT_SOURCE,
      dedupKey: runFailedDedupKey(input.routine.id),
      status: "resolved",
      ts,
    })
  }
}

/** The reconciler's verdict for one routine: events that used up their retries, or none. */
export async function reportUndeliveredEvents(input: {
  orgId: string
  routine: { id: string; name: string; title?: string | null }
  exhausted: Array<{ eventId: string; entityId: string | null; lastError: string | null }>
}): Promise<void> {
  const ts = new Date().toISOString()
  if (input.exhausted.length === 0) {
    await send(input.orgId, {
      source: ROUTINE_INCIDENT_SOURCE,
      dedupKey: undeliveredDedupKey(input.routine.id),
      status: "resolved",
      ts,
    })
    return
  }
  const lines = input.exhausted
    .slice(0, 20)
    .map((e) => `- event ${e.eventId} (entity ${e.entityId ?? "none"}): ${e.lastError ?? "failed"}`)
  await send(input.orgId, {
    source: ROUTINE_INCIDENT_SOURCE,
    severity: "critical",
    title: clip(
      `Routine "${routineDisplayName(input.routine)}": ${input.exhausted.length} event(s) never handled after every retry`,
      200,
    ),
    body: clip(lines.join("\n"), 2000),
    dedupKey: undeliveredDedupKey(input.routine.id),
    ts,
  })
}

/** Test access: swap the sink; pass nothing to restore the monitoring sink. */
export const RoutineIncidentTestAccess = {
  setSink(fn?: IncidentSink): void {
    sink = fn ?? monitoringSink
  },
}
