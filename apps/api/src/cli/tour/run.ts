// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison tour start` / `liaison tour list`: start a guided tour for one
 * member from the command line (the setup skill offers one after each thing it
 * configures) and wait while they play it.
 *
 *   liaison tour start tickets.basics --user owner@acme.example [--org acme] [--timeout 1800]
 *   liaison tour list [--org acme]
 *
 * `start` writes the member's progress row (back to the first beat, active,
 * source cli) and queues `kernel/tour:start` for them in the same transaction.
 * The CLI never hosts jobs: the running server's outbox worker delivers the
 * frame to the member's open tabs. The deep link `<org base URL>/?tour=<id>` is
 * always printed (it starts the tour on open), with a note when an open tab or
 * desktop app was seen. Then it polls the row every 2 s and prints one line per
 * beat reached, ending on the outcome:
 *   exit 0 completed ("completed, skipped k"), 3 abandoned, 4 timed out,
 *   2 usage / unknown tour / unknown member / tour not available in the org.
 *
 * Beat titles are printed in the member's language (serverT, `tours` namespace).
 */
import { resolveLocale, type ShippedLocale, type Tour, type TourProgress } from "@liaison/shared"
import { eq } from "drizzle-orm"
import { resolveMember } from "~/cli/lib/resolve-member"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { withPrivilegedDb } from "~/db/privileged"
import { organizations, users } from "~/db/schema/kernel"
import { orgPublicBaseUrl } from "~/lib/org-public-url"
import { serverT } from "~/modules/i18n/server-i18n"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { runConversationId } from "~/modules/tours/conversation"
import {
  availableTours,
  findServerTour,
  loadTourOrgContext,
  progressOf,
  readProgressRow,
  serverTourCatalogue,
  skippedCount,
  startTour,
  tourBeats,
} from "~/modules/tours/service"

export const TOUR_USAGE = `usage: liaison tour start <tourId> --user <member email> [--org <slug>] [--timeout <seconds>]
       liaison tour list [--org <slug>]`

export const TOUR_EXIT = { completed: 0, usage: 2, abandoned: 3, timeout: 4 } as const

export interface TourCliIo {
  out: (line: string) => void
  err: (line: string) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Whether the member has a live browser tab or desktop app (websocket presence). */
  hasOpenClient: (orgId: string, userId: string) => Promise<boolean>
  pollMs: number
}

async function defaultHasOpenClient(orgId: string, userId: string): Promise<boolean> {
  const [{ redis }, { readNotifyPresence }] = await Promise.all([
    import("~/lib/redis"),
    import("~/infra/websocket"),
  ])
  const entries = await readNotifyPresence(redis, orgId, userId)
  return entries.some((e) => e.kind === "browser" || e.kind === "desktop_app")
}

export const defaultTourCliIo: TourCliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
  hasOpenClient: defaultHasOpenClient,
  pollMs: 2000,
}

/** The member's language: their own choice, else the org's default. */
async function memberLocale(orgId: string, userId: string): Promise<ShippedLocale> {
  return withPrivilegedDb(orgId, "cli-tour-locale", async (tx) => {
    const [u] = await tx.select({ locale: users.locale }).from(users).where(eq(users.id, userId))
    const [o] = await tx
      .select({ locale: organizations.defaultLocale })
      .from(organizations)
      .where(eq(organizations.id, orgId))
    return resolveLocale(u?.locale, o?.locale)
  })
}

export async function tourDeepLink(orgId: string, tourId: string): Promise<string> {
  return `${(await orgPublicBaseUrl(orgId)).replace(/\/+$/, "")}/?tour=${encodeURIComponent(tourId)}`
}

function beatLine(
  _tour: Tour,
  progress: TourProgress,
  beats: ReturnType<typeof tourBeats>,
  locale: ShippedLocale,
): string {
  const beat = beats[progress.beatIndex]
  const title = beat ? serverT(locale, beat.title) : ""
  return `beat ${progress.beatIndex + 1}/${progress.beatCount} ${title}`.trimEnd()
}

export interface TourStartOptions {
  tourId: string
  userEmail: string
  orgSlug?: string
  timeoutSeconds: number
}

export async function runTourStart(
  opts: TourStartOptions,
  io: TourCliIo = defaultTourCliIo,
): Promise<number> {
  const tour = findServerTour(opts.tourId)
  if (!tour) {
    io.err(`tour start: unknown tour '${opts.tourId}' (liaison tour list shows the tours)`)
    return TOUR_EXIT.usage
  }
  const member = await resolveMember(opts.orgSlug, opts.userEmail)
  if (typeof member === "string") {
    io.err(`tour start: ${member}`)
    return TOUR_EXIT.usage
  }
  const { orgId, userId } = member
  const orgCtx = await loadTourOrgContext(orgId)
  const scopes = await withPrivilegedDb(orgId, "cli-tour-scopes", async (tx) => {
    return (await loadEffectivePermissions(tx, userId, orgId)).scopes
  })
  if (availableTours([tour], { installedApps: orgCtx.installedApps, scopes }).length === 0) {
    const needs = [
      ...(tour.app !== "kernel" ? [`the ${tour.app} app`] : []),
      ...(tour.requires?.apps ?? []).map((a) => `the ${a} app`),
      ...(tour.requires?.scopes ?? []).map((s) => `scope ${s}`),
    ]
    io.err(
      `tour start: '${tour.id}' is not available to ${opts.userEmail} in this org (needs ${needs.join(", ")})`,
    )
    return TOUR_EXIT.usage
  }
  const beats = tourBeats(tour, orgCtx)
  const locale = await memberLocale(orgId, userId)
  const conversationId = await runConversationId(orgId, userId, tour)
  const started = await withPrivilegedDb(orgId, "cli-tour-start", (tx) =>
    startTour(tx, {
      orgId,
      userId,
      tour,
      beats,
      source: "cli",
      actor: { userId: null, actorType: "system" },
      conversationId,
    }),
  )

  io.out(`tour ${tour.id} started for ${opts.userEmail}: ${serverT(locale, tour.title)}`)
  let openClient = false
  try {
    openClient = await io.hasOpenClient(orgId, userId)
  } catch {
    openClient = false
  }
  if (openClient) io.out("open tab detected: the tour opens there now")
  io.out(`deep link: ${await tourDeepLink(orgId, tour.id)}`)

  const deadline = io.now() + opts.timeoutSeconds * 1000
  let lastLine = ""
  let lastStatus = started.status
  const report = (progress: TourProgress) => {
    if (progress.status === "active") {
      const line = beatLine(tour, progress, beats, locale)
      if (line !== lastLine) io.out(line)
      lastLine = line
    } else if (progress.status === "paused" && lastStatus !== "paused") {
      io.out(`paused at beat ${progress.beatIndex + 1}/${progress.beatCount}`)
      lastLine = ""
    }
    lastStatus = progress.status
  }
  report(started)
  for (;;) {
    const row = await withPrivilegedDb(orgId, "cli-tour-poll", (tx) =>
      readProgressRow(tx, { orgId, userId, tourId: tour.id }),
    )
    if (!row) {
      io.err(`tour start: the progress row of ${tour.id} disappeared`)
      return TOUR_EXIT.abandoned
    }
    const progress = progressOf(tour, row, beats)
    if (progress.status === "completed") {
      io.out(`completed, skipped ${skippedCount(progress)}`)
      return TOUR_EXIT.completed
    }
    if (progress.status === "abandoned") {
      io.out(`abandoned at beat ${progress.beatIndex + 1}/${progress.beatCount}`)
      return TOUR_EXIT.abandoned
    }
    report(progress)
    if (io.now() >= deadline) {
      io.out(
        `timed out after ${opts.timeoutSeconds}s at beat ${progress.beatIndex + 1}/${progress.beatCount}`,
      )
      return TOUR_EXIT.timeout
    }
    await io.sleep(io.pollMs)
  }
}

/** `liaison tour list`: the tours this org can play (its installed apps), one per line. */
export async function runTourList(
  opts: { orgSlug?: string },
  io: Pick<TourCliIo, "out" | "err"> = defaultTourCliIo,
): Promise<number> {
  const org = await resolveOrgId(opts.orgSlug, "more than one org exists: pass --org <slug>")
  if (!org.ok) {
    io.err(`tour list: ${org.message}`)
    return TOUR_EXIT.usage
  }
  const [orgCtx, locale] = await Promise.all([
    loadTourOrgContext(org.orgId),
    withPrivilegedDb(org.orgId, "cli-tour-list-locale", async (tx) => {
      const [o] = await tx
        .select({ locale: organizations.defaultLocale })
        .from(organizations)
        .where(eq(organizations.id, org.orgId))
      return resolveLocale(o?.locale)
    }),
  ])
  // Every scope: the list is the org's; `tour start` checks the member's own.
  for (const tour of availableTours(serverTourCatalogue(), {
    installedApps: orgCtx.installedApps,
    scopes: ["*"],
  })) {
    const count = tourBeats(tour, orgCtx).length
    io.out(`${tour.id}\t${count} beats\t${serverT(locale, tour.title)}`)
  }
  return 0
}

/** argv after `tour`. */
export async function runTourCli(
  argv: string[],
  io: TourCliIo = defaultTourCliIo,
): Promise<number> {
  const valued = new Set(["--user", "--org", "--timeout"])
  const flag = (name: string) => {
    const i = argv.indexOf(name)
    const v = i >= 0 ? argv[i + 1] : undefined
    return v === undefined || v.startsWith("--") ? undefined : v
  }
  const positional = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1] ?? ""))
  const sub = positional[0]
  const orgSlug = flag("--org")
  if (sub === "list" && positional.length === 1) {
    return runTourList(orgSlug !== undefined ? { orgSlug } : {}, io)
  }
  if (sub === "start" && positional.length === 2) {
    const userEmail = flag("--user")
    const timeoutRaw = flag("--timeout")
    const timeoutSeconds = timeoutRaw !== undefined ? Number(timeoutRaw) : 1800
    if (userEmail && Number.isInteger(timeoutSeconds) && timeoutSeconds > 0) {
      return runTourStart(
        {
          tourId: positional[1]!,
          userEmail,
          timeoutSeconds,
          ...(orgSlug !== undefined ? { orgSlug } : {}),
        },
        io,
      )
    }
  }
  io.err(TOUR_USAGE)
  return TOUR_EXIT.usage
}
