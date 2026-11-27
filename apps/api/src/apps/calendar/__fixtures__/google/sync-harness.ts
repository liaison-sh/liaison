// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Runs the calendar app's real handlers (handlers.ts, through the core-app runner) against the
// real database and the real host bridge (modules/apps/sandbox/bridge/calendar.ts, sync.ts,
// tools.ts), with only Google replaced by the stateful fake (fake-google-calendar.ts) and the
// job queue replaced by an in-process one. Jobs are kept in a FIFO with the job queue's
// deduplication rule (a job id is dropped while a job with that id waits, is delayed or runs)
// and run on `drain()`, so a test drives connect -> import -> initial sync -> watch -> push
// notification -> incremental sync -> push the way production does, one step at a time.

import { sql as drizzleSql } from "drizzle-orm"
import manifest from "~/apps/calendar/app.manifest.json"
import type { CalendarKernelConnectionEvent } from "~/apps/calendar/sync"
import { withRlsContext } from "~/db/rls"
import type { EnqueueOptions } from "~/infra/jobs/jobs"
import { CORE_APP_MODULES } from "~/modules/apps/core/registry"
import { runCoreHandler } from "~/modules/apps/core/run-core"
import { createCalendarMethods } from "~/modules/apps/sandbox/bridge/calendar"
import type { FakeGoogleCalendar } from "./fake-google-calendar"

export interface HarnessJob {
  name: string
  payload: unknown
  jobId?: string
  delay?: number
}

export interface HarnessLog {
  level: "info" | "warn" | "error"
  msg: string
  data: unknown
}

export interface CalendarSyncHarnessOptions {
  orgId: string
  /** The person tools run as (scopes `*`, every calendar dimension). */
  userId: string
  google: FakeGoogleCalendar
  /** App config (`config_get`): defaults give a push secret and an https webhook address. */
  config?: Record<string, string | null>
}

const JOB_HANDLERS: Record<string, string> = Object.fromEntries(
  Object.entries(manifest.jobs).map(([name, def]) => [name, def.handler]),
)
const TOOL_HANDLERS: Record<string, string> = Object.fromEntries(
  Object.entries(manifest.tools).map(([name, def]) => [name, def.handler]),
)

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null
  return value ? JSON.parse(value) : null
}

export function createCalendarSyncHarness(opts: CalendarSyncHarnessOptions) {
  const { orgId, userId, google } = opts
  const config: Record<string, string | null> = {
    calendarPushSecret: "fake-push-secret",
    calendarWebhookUrl: "https://liaison.example.test/api/webhooks/calendar/google-push",
    ...opts.config,
  }
  const queue: HarnessJob[] = []
  const active = new Set<string>()
  /** Every job that ran, in order. */
  const ran: HarnessJob[] = []
  /** Every enqueue dropped by the job id rule. */
  const deduped: HarnessJob[] = []
  const logs: HarnessLog[] = []
  const accountIds: string[] = []
  /** The accounts this harness connected, as a SQL list (a never-matching id before connect). */
  const ownAccounts = () =>
    drizzleSql.join(
      (accountIds.length > 0 ? accountIds : ["00000000-0000-0000-0000-000000000000"]).map(
        (id) => drizzleSql`${id}::uuid`,
      ),
      drizzleSql.raw(", "),
    )
  /** Runs after each Google answer, inside the job that made the call (a concurrent change). */
  let afterFetch: ((url: string, method: string) => Promise<void>) | null = null

  function enqueueLocal(job: HarnessJob): void {
    if (job.jobId && (active.has(job.jobId) || queue.some((q) => q.jobId === job.jobId))) {
      deduped.push(job)
      return
    }
    queue.push(job)
  }

  const enqueue = async (
    _appName: string,
    jobName: string,
    payload: unknown,
    enqueueOpts?: EnqueueOptions,
  ): Promise<string> => {
    enqueueLocal({ name: jobName, payload, jobId: enqueueOpts?.jobId, delay: enqueueOpts?.delay })
    return enqueueOpts?.jobId ?? `${jobName}:${queue.length}`
  }

  /** The DB-less bridge the webhook `verify` export runs on. */
  const verifyMethods = {
    config_get: async (key: string) => config[key] ?? null,
    crypto_timingSafeEqual: async (a: string, b: string) => a === b,
    crypto_hmacSha256Base64: async (secret: string, body: string) => {
      const { createHmac } = await import("node:crypto")
      return createHmac("sha256", secret).update(body, "utf8").digest("base64")
    },
  }

  function bridgeFor(
    txDb: Parameters<typeof createCalendarMethods>[0]["txDb"],
    actor: { userId: string; scopes: string[] },
  ) {
    const methods = createCalendarMethods(
      {
        appName: "calendar",
        callerScopes: actor.scopes,
        orgId,
        userId: actor.userId,
        txDb,
        requireApp: () => {},
      },
      { enqueue },
    )
    const log =
      (level: HarnessLog["level"]) =>
      (msg: string, dataJson?: string): void => {
        logs.push({ level, msg, data: dataJson ? parseJson(dataJson) : null })
      }
    return {
      ...methods,
      getOrgId: () => orgId,
      getUserId: () => actor.userId,
      fetch: async (url: string, optsJson: string) => {
        const res = await google.fetch(url, optsJson)
        if (afterFetch) {
          const method = (JSON.parse(optsJson || "{}") as { method?: string }).method ?? "GET"
          await afterFetch(url, method)
        }
        return res
      },
      connections_getToken: async () => "fake-access-token",
      ...verifyMethods,
      enqueueJob: async (jobName: string, payloadJson: string, optsJson?: string) => {
        const o = (optsJson ? JSON.parse(optsJson) : {}) as EnqueueOptions
        enqueueLocal({
          name: jobName,
          payload: parseJson(payloadJson),
          jobId: o.jobId,
          delay: o.delay,
        })
      },
      emit: async () => {},
      log_info: log("info"),
      log_warn: log("warn"),
      log_error: log("error"),
    }
  }

  /** Runs one handler export with the bridge of an actor: the system for jobs and webhooks,
   * the harness user for tools. */
  async function run(
    exportName: string,
    params: unknown,
    actor: { userId: string; scopes: string[] },
    extraArgs?: unknown[],
  ): Promise<unknown> {
    return withRlsContext(
      {
        actorType: "user",
        userId,
        orgId,
        scopes: actor.scopes,
        dimensionGrants: { "*": ["*"] },
      },
      (tx) =>
        runCoreHandler({
          module: CORE_APP_MODULES.calendar!,
          appName: "calendar",
          exportName,
          params,
          extraArgs,
          bridge: bridgeFor(tx, actor),
          holdsTx: true,
        }),
    )
  }

  const system = { userId: "system:calendar:job", scopes: ["*"] }
  const person = { userId, scopes: ["*"] }

  const harness = {
    google,
    accountIds,
    /** Sets (or clears) the hook run after each Google answer, inside the calling job. */
    afterFetch(hook: ((url: string, method: string) => Promise<void>) | null): void {
      afterFetch = hook
    },
    queue,
    ran,
    deduped,
    logs,
    config,

    /** The kernel's connected_account:create for this Google account; queues the import. */
    async connect(
      email: string = google.accountEmail,
      owner: { type: "user" | "org" } = { type: "user" },
    ): Promise<string> {
      const event: CalendarKernelConnectionEvent = {
        orgId,
        actorId: userId,
        data: {
          id: crypto.randomUUID(),
          appName: "calendar",
          ownerType: owner.type,
          ownerId: owner.type === "user" ? userId : null,
          identifier: email,
          connectionName: "google-calendar",
        },
      }
      await run("onAccountConnected", event, system)
      const rows = await harness.sql<{ id: string }>(
        drizzleSql`SELECT id FROM app_calendar.accounts
                   WHERE org_id = ${orgId}::uuid AND email_address = ${email}`,
      )
      const accountId = rows[0]?.id
      if (!accountId) throw new Error(`harness: no account row for ${email} after connect`)
      accountIds.push(accountId)
      return accountId
    },

    /** Queues a job as the app would. */
    enqueue(name: string, payload: unknown, jobId?: string): void {
      enqueueLocal({ name, payload, jobId })
    },

    /** Runs one job now (not through the queue). */
    async runJob(name: string, payload: unknown = {}): Promise<void> {
      const exportName = JOB_HANDLERS[name]
      if (!exportName) throw new Error(`harness: no calendar job ${name}`)
      await run(exportName, payload, system)
    },

    /**
     * Runs queued jobs in order until the queue is empty (or `max` jobs ran). Delayed jobs run
     * in turn too (their delay is recorded, not waited); `skipDelayed` leaves them queued.
     * `during` runs while a job is active, before its handler: a webhook arriving mid-sync.
     */
    async drain(
      drainOpts: {
        max?: number
        skipDelayed?: boolean
        only?: (job: HarnessJob) => boolean
        during?: (job: HarnessJob) => Promise<void> | void
      } = {},
    ): Promise<HarnessJob[]> {
      const done: HarnessJob[] = []
      const max = drainOpts.max ?? 200
      for (;;) {
        const index = queue.findIndex(
          (j) => !(drainOpts.skipDelayed && j.delay) && (drainOpts.only ? drainOpts.only(j) : true),
        )
        if (index < 0) break
        if (done.length >= max) throw new Error(`harness: more than ${max} jobs, a job loop?`)
        const [job] = queue.splice(index, 1)
        if (!job) break
        if (job.jobId) active.add(job.jobId)
        try {
          if (drainOpts.during) await drainOpts.during(job)
          await harness.runJob(job.name, job.payload)
        } finally {
          if (job.jobId) active.delete(job.jobId)
        }
        ran.push(job)
        done.push(job)
      }
      return done
    },

    /** Calls a tool as the harness user and returns its result. */
    async tool(name: string, params: unknown): Promise<unknown> {
      const exportName = TOOL_HANDLERS[name]
      if (!exportName) throw new Error(`harness: no calendar tool ${name}`)
      return run(exportName, params, person)
    },

    /** Delivers one push notification (headers as Google posts them) through verify + handler. */
    async webhook(headers: Record<string, string>): Promise<{ valid: boolean }> {
      const verdict = (await runCoreHandler({
        module: CORE_APP_MODULES.calendar!,
        appName: "calendar",
        exportName: "verifyGooglePush",
        params: { headers },
        bridge: verifyMethods,
        holdsTx: true,
      })) as { valid: boolean }
      if (!verdict.valid) return verdict
      await run("onGooglePush", {}, system, [headers])
      return verdict
    },

    /** Every live channel of the Google calendar notifies Liaison of a change. */
    async notify(googleCalendarId: string): Promise<number> {
      const notes = google.notificationsFor(googleCalendarId)
      for (const headers of notes) await harness.webhook(headers)
      return notes.length
    },

    /** A raw read as the harness user, who sees every calendar of the org (assertions). */
    async sql<T>(query: ReturnType<typeof drizzleSql>): Promise<T[]> {
      return withRlsContext(
        { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: { "*": ["*"] } },
        async (tx) => {
          const res: unknown = await tx.execute(query)
          const rows = Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows
          return (rows ?? []) as T[]
        },
      )
    },

    /** The local calendar row for a Google calendar id, on the accounts this harness connected
     * (several harnesses may share an org, each with its own account). */
    async calendar(googleCalendarId: string): Promise<Record<string, unknown> | null> {
      const rows = await harness.sql<Record<string, unknown>>(
        drizzleSql`SELECT * FROM app_calendar.calendars
                   WHERE org_id = ${orgId}::uuid AND google_calendar_id = ${googleCalendarId}
                     AND account_id IN (${ownAccounts()})`,
      )
      return rows[0] ?? null
    },

    /** Local event rows of one Google calendar (tombstones included), by Google id. */
    async events<T = Record<string, unknown>>(googleCalendarId: string): Promise<T[]> {
      return harness.sql<T>(
        drizzleSql`SELECT e.* FROM app_calendar.events e
                   JOIN app_calendar.calendars c ON c.id = e.calendar_id
                   WHERE e.org_id = ${orgId}::uuid AND c.google_calendar_id = ${googleCalendarId}
                     AND c.account_id IN (${ownAccounts()})
                   ORDER BY e.google_event_id NULLS LAST, e.id`,
      )
    },

    /** The local event row for a Google event id, or null. */
    async event(
      googleCalendarId: string,
      googleEventId: string,
    ): Promise<Record<string, unknown> | null> {
      const rows = await harness.events(googleCalendarId)
      return rows.find((r) => r.google_event_id === googleEventId) ?? null
    },
  }
  return harness
}

export type CalendarSyncHarness = ReturnType<typeof createCalendarSyncHarness>
