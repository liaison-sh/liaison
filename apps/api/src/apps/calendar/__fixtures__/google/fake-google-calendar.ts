// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A stateful fake of the Google Calendar API v3, for tests. It keeps calendars, events,
// watch channels and sync tokens in memory and answers the requests the calendar app makes
// (through `ctx.fetch`) the way Google documents them:
//
// - events.list with `syncToken` (changes since, deleted ones included), `pageToken`
//   (`maxResults`, default 250, at most 2500), `showDeleted`, and 410 `fullSyncRequired`
//   once a calendar's tokens are invalidated; recurring series as one master plus exception
//   resources (`recurringEventId`, `originalStartTime`), `singleEvents=false`.
// - events.get / insert / update / patch / delete with etags and If-Match (412), client
//   ids (409 duplicate), instance ids `<master>_<YYYYMMDDTHHMMSSZ>` materialized on write,
//   a `timeZone` required on recurring events, the exclusive end of all-day events, a Meet
//   link for `conferenceData.createRequest` with `conferenceDataVersion=1`, and 403
//   `requiredAccessLevel` on calendars the account may only read.
// - events.watch and channels.stop, plus the push notification headers a channel would post.
// - calendarList.list with `minAccessRole` and paging.
// - injected failures (403 rate limit, 429, 5xx, 401, 410, any status) and hooks that run
//   just before a request is served, to interleave a Google-side change with a sync or a push.
//
// The "Google side" is driven directly (`createEvent`, `updateEvent`, `cancelOccurrence`,
// `addCalendar`...): what a person editing in Google Calendar would do. The error bodies come
// from `errors.json`, the starting data from `calendar-list.json` and `events-initial.json`.

import calendarListFixture from "./calendar-list.json"
import errorFixtures from "./errors.json"
import eventsFixture from "./events-initial.json"

export const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3"

export interface GoogleTime {
  dateTime?: string
  date?: string
  timeZone?: string
}

/** A Google event resource. Fields the fake does not model are kept as they were written. */
export interface GoogleEvent {
  kind?: string
  id: string
  etag?: string
  status?: string
  summary?: string
  description?: string
  location?: string
  start?: GoogleTime
  end?: GoogleTime
  recurrence?: string[]
  recurringEventId?: string
  originalStartTime?: GoogleTime
  attendees?: Array<Record<string, unknown>>
  organizer?: Record<string, unknown>
  creator?: Record<string, unknown>
  created?: string
  updated?: string
  sequence?: number
  iCalUID?: string
  hangoutLink?: string
  conferenceData?: Record<string, unknown> | null
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> }
  [key: string]: unknown
}

export interface GoogleCalendarListEntry {
  kind?: string
  etag?: string
  id: string
  summary?: string
  timeZone?: string
  backgroundColor?: string
  foregroundColor?: string
  colorId?: string
  accessRole: "owner" | "writer" | "reader" | "freeBusyReader"
  primary?: boolean
  selected?: boolean
  deleted?: boolean
  [key: string]: unknown
}

export type GoogleOp =
  | "calendarList.list"
  | "events.list"
  | "events.get"
  | "events.insert"
  | "events.update"
  | "events.patch"
  | "events.delete"
  | "events.watch"
  | "channels.stop"
  | "freebusy.query"
  | "unknown"

export interface FakeRequest {
  op: GoogleOp
  method: string
  /** Path below the API base, decoded segments joined back with "/". */
  path: string
  calendarId: string | null
  eventId: string | null
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
}

export interface FakeResponse {
  status: number
  headers: Record<string, string>
  /** The JSON body as text ("" for 204), as ctx.fetch answers it. */
  body: string
}

export type GoogleErrorName = Exclude<keyof typeof errorFixtures, "_source">

/** A Google error response from the documented bodies in errors.json. */
export function googleError(name: GoogleErrorName): FakeResponse {
  const fixture = errorFixtures[name]
  return {
    status: fixture.status,
    headers: { "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify(fixture.body),
  }
}

export interface WatchChannel {
  id: string
  resourceId: string
  calendarId: string
  token: string | null
  address: string
  expiration: number
  stopped: boolean
  messageNumber: number
}

interface StoredEvent {
  resource: GoogleEvent
  /** The change counter value of this event's last change (sync tokens compare it). */
  seq: number
}

interface StoredCalendar {
  entry: GoogleCalendarListEntry
  events: Map<string, StoredEvent>
  /** Tokens minted before this epoch answer 410 fullSyncRequired. */
  tokenEpoch: number
}

interface ListSnapshot {
  calendarId: string
  ids: string[]
  syncSeq: number
  epoch: number
}

type RequestMatcher = GoogleOp | ((req: FakeRequest) => boolean)

interface Injected {
  match: RequestMatcher
  remaining: number
  respond: (req: FakeRequest) => FakeResponse
}

interface Hook {
  match: RequestMatcher
  remaining: number
  run: (req: FakeRequest) => void
}

const WRITE_ROLES = new Set(["owner", "writer"])
const ROLE_RANK: Record<string, number> = { freeBusyReader: 0, reader: 1, writer: 2, owner: 3 }
const DEFAULT_PAGE_SIZE = 250
const MAX_PAGE_SIZE = 2500
const WATCH_TTL_MS = 7 * 24 * 3_600_000
/** Read-only resource fields a PUT does not replace. */
const SERVER_FIELDS = [
  "kind",
  "id",
  "etag",
  "created",
  "updated",
  "creator",
  "organizer",
  "iCalUID",
  "htmlLink",
  "sequence",
  "recurringEventId",
  "originalStartTime",
] as const

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

function unb64<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T
  } catch {
    return null
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): FakeResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", ...headers },
    body: JSON.stringify(body),
  }
}

/** The instant a Google time point names (an all-day date reads as UTC midnight). */
function instantOf(point: GoogleTime | undefined): number | null {
  if (!point) return null
  if (point.dateTime) {
    const t = Date.parse(point.dateTime)
    return Number.isNaN(t) ? null : t
  }
  if (point.date) {
    const t = Date.parse(`${point.date}T00:00:00Z`)
    return Number.isNaN(t) ? null : t
  }
  return null
}

/** `<master>_<YYYYMMDD>` or `<master>_<YYYYMMDDTHHMMSSZ>`: the master id and the original start. */
export function parseInstanceId(
  id: string,
): { masterId: string; originalStart: GoogleTime } | null {
  const m = /^(.+)_(\d{8})(?:T(\d{6})Z)?$/.exec(id)
  if (!m) return null
  const [, masterId, day, time] = m
  const date = `${day!.slice(0, 4)}-${day!.slice(4, 6)}-${day!.slice(6, 8)}`
  if (!time) return { masterId: masterId!, originalStart: { date } }
  const dateTime = `${date}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`
  return { masterId: masterId!, originalStart: { dateTime } }
}

/** The instance id Google gives an occurrence of `masterId` starting at `originalStart`. */
export function instanceIdOf(masterId: string, originalStart: GoogleTime): string {
  if (originalStart.date) return `${masterId}_${originalStart.date.replace(/-/g, "")}`
  const iso = new Date(instantOf(originalStart) ?? 0).toISOString()
  return `${masterId}_${iso.slice(0, 10).replace(/-/g, "")}T${iso.slice(11, 19).replace(/:/g, "")}Z`
}

function matches(match: RequestMatcher, req: FakeRequest): boolean {
  return typeof match === "function" ? match(req) : match === req.op
}

export interface FakeGoogleCalendarOptions {
  /** The connected account's address (organizer and creator of events written through the API). */
  accountEmail?: string
  /** Start of the fake clock (`updated`, `created`, channel expirations); default: now. */
  now?: string
}

export class FakeGoogleCalendar {
  readonly accountEmail: string
  /** Every request served, in order. */
  readonly requests: FakeRequest[] = []
  /** Requests no route matched (a test can assert this stays empty). */
  readonly unhandled: FakeRequest[] = []
  readonly channels = new Map<string, WatchChannel>()
  private readonly calendars = new Map<string, StoredCalendar>()
  private readonly snapshots = new Map<string, ListSnapshot>()
  private readonly injected: Injected[] = []
  private readonly hooks: Hook[] = []
  private seq = 0
  private clock: number
  private idCounter = 0
  private authRevoked = false
  /** Other people's busy times or errors, as freebusy.query reports them, by address. */
  private readonly freeBusy = new Map<
    string,
    { busy: { start: string; end: string }[] } | { errors: { domain: string; reason: string }[] }
  >()
  /** Whether the token carries the free/busy scope (false: freebusy.query answers 403). */
  private freeBusyGranted = true

  constructor(opts: FakeGoogleCalendarOptions = {}) {
    this.accountEmail = opts.accountEmail ?? "owner@example.test"
    // Real time by default: Liaison compares Google's `updated` with its own row times.
    this.clock = opts.now ? Date.parse(opts.now) : Date.now()
  }

  /** A fake holding the recorded calendar list and events (calendar-list.json, events-initial.json). */
  static fromFixtures(opts: FakeGoogleCalendarOptions = {}): FakeGoogleCalendar {
    const fake = new FakeGoogleCalendar(opts)
    for (const entry of calendarListFixture.items) {
      fake.addCalendar(entry as GoogleCalendarListEntry)
    }
    for (const [calendarId, items] of Object.entries(eventsFixture)) {
      if (calendarId === "_source" || !Array.isArray(items)) continue
      for (const item of items) fake.putRaw(calendarId, item as GoogleEvent)
    }
    return fake
  }

  // --- clock -----------------------------------------------------------------------------

  now(): number {
    return this.clock
  }

  setNow(iso: string): void {
    this.clock = Date.parse(iso)
  }

  advance(ms: number): void {
    this.clock += ms
  }

  /** Each change moves the clock on by one second, so `updated` values are strictly ordered. */
  private tick(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }

  private nextEtag(): string {
    return `"${String(3_500_000_000_000_000 + this.seq * 1000)}"`
  }

  private newId(): string {
    this.idCounter += 1
    // base32hex (a-v, 0-9), like the ids Google generates.
    return `fake${this.idCounter.toString(32).padStart(6, "0")}`
  }

  // --- the Google side (what a person does in Google Calendar) ----------------------------

  addCalendar(entry: GoogleCalendarListEntry): void {
    this.calendars.set(entry.id, {
      entry: { kind: "calendar#calendarListEntry", etag: `"${Date.now()}"`, ...cloneJson(entry) },
      events: new Map(),
      tokenEpoch: 0,
    })
  }

  /** The account leaves the calendar (unsubscribed or deleted): it disappears from the list. */
  removeCalendar(calendarId: string): void {
    this.calendars.delete(calendarId)
  }

  updateCalendar(calendarId: string, patch: Partial<GoogleCalendarListEntry>): void {
    const cal = this.requireCalendar(calendarId)
    cal.entry = { ...cal.entry, ...cloneJson(patch), id: calendarId }
  }

  calendarIds(): string[] {
    return [...this.calendars.keys()]
  }

  /** Stores a resource exactly as given (fixtures): no validation, a fresh change counter. */
  putRaw(calendarId: string, resource: GoogleEvent): void {
    const cal = this.requireCalendar(calendarId)
    this.seq += 1
    cal.events.set(resource.id, { resource: cloneJson(resource), seq: this.seq })
  }

  /** A person creates an event in Google. Returns the stored resource. */
  createEvent(calendarId: string, fields: Partial<GoogleEvent>): GoogleEvent {
    const cal = this.requireCalendar(calendarId)
    const id = fields.id ?? this.newId()
    const stamp = this.tick()
    this.seq += 1
    const resource: GoogleEvent = {
      kind: "calendar#event",
      status: "confirmed",
      created: stamp,
      creator: { email: this.accountEmail, self: true },
      organizer: { email: this.accountEmail, self: true },
      iCalUID: `${id}@google.com`,
      sequence: 0,
      ...cloneJson(fields),
      id,
      etag: this.nextEtag(),
      updated: stamp,
    }
    cal.events.set(id, { resource, seq: this.seq })
    return cloneJson(resource)
  }

  /** A person edits an event in Google: the fields given replace the stored ones. */
  updateEvent(calendarId: string, eventId: string, patch: Partial<GoogleEvent>): GoogleEvent {
    const cal = this.requireCalendar(calendarId)
    const stored = cal.events.get(eventId)
    if (!stored) throw new Error(`fake google: no event ${eventId} on ${calendarId}`)
    const timeChanged = "start" in patch || "end" in patch || "recurrence" in patch
    this.seq += 1
    stored.resource = {
      ...stored.resource,
      ...cloneJson(patch),
      id: eventId,
      etag: this.nextEtag(),
      updated: this.tick(),
      sequence: (stored.resource.sequence ?? 0) + (timeChanged ? 1 : 0),
    }
    stored.seq = this.seq
    return cloneJson(stored.resource)
  }

  /** A person deletes an event in Google (a series: the master and its exceptions). */
  deleteEvent(calendarId: string, eventId: string): void {
    const cal = this.requireCalendar(calendarId)
    const stored = cal.events.get(eventId)
    if (!stored) throw new Error(`fake google: no event ${eventId} on ${calendarId}`)
    this.cancel(stored)
    for (const other of cal.events.values()) {
      if (other.resource.recurringEventId === eventId) this.cancel(other)
    }
  }

  /** A person deletes one occurrence of a series in Google ("this event" only). */
  cancelOccurrence(calendarId: string, masterId: string, originalStart: GoogleTime): string {
    const cal = this.requireCalendar(calendarId)
    const master = cal.events.get(masterId)
    if (!master) throw new Error(`fake google: no series ${masterId} on ${calendarId}`)
    const id = instanceIdOf(masterId, originalStart)
    const existing = cal.events.get(id)
    if (existing) {
      this.cancel(existing)
      return id
    }
    const zone = master.resource.start?.timeZone
    this.seq += 1
    cal.events.set(id, {
      resource: {
        kind: "calendar#event",
        id,
        etag: this.nextEtag(),
        status: "cancelled",
        recurringEventId: masterId,
        originalStartTime: { ...originalStart, ...(zone ? { timeZone: zone } : {}) },
        updated: this.tick(),
      },
      seq: this.seq,
    })
    return id
  }

  /** A person moves one occurrence of a series in Google (an exception resource). */
  moveOccurrence(
    calendarId: string,
    masterId: string,
    originalStart: GoogleTime,
    start: GoogleTime,
    end: GoogleTime,
  ): GoogleEvent {
    const cal = this.requireCalendar(calendarId)
    const master = cal.events.get(masterId)
    if (!master) throw new Error(`fake google: no series ${masterId} on ${calendarId}`)
    const id = instanceIdOf(masterId, originalStart)
    const { recurrence: _recurrence, ...rest } = master.resource
    const zone = master.resource.start?.timeZone
    return this.createEvent(calendarId, {
      ...rest,
      id,
      start,
      end,
      recurringEventId: masterId,
      originalStartTime: { ...originalStart, ...(zone ? { timeZone: zone } : {}) },
      sequence: (master.resource.sequence ?? 0) + 1,
    })
  }

  /** The stored resource (cancelled ones included), or null. */
  getEvent(calendarId: string, eventId: string): GoogleEvent | null {
    const stored = this.calendars.get(calendarId)?.events.get(eventId)
    return stored ? cloneJson(stored.resource) : null
  }

  /** Every stored resource of a calendar; `includeCancelled` false leaves deleted ones out. */
  listEvents(calendarId: string, opts: { includeCancelled?: boolean } = {}): GoogleEvent[] {
    const cal = this.requireCalendar(calendarId)
    return [...cal.events.values()]
      .filter((e) => opts.includeCancelled || e.resource.status !== "cancelled")
      .map((e) => cloneJson(e.resource))
  }

  /** Google expires every sync token of the calendar: the next incremental list answers 410. */
  invalidateSyncTokens(calendarId: string): void {
    this.requireCalendar(calendarId).tokenEpoch += 1
  }

  /** Every later request answers 401 until `restoreAccess` (a revoked or expired grant). */
  revokeAccess(): void {
    this.authRevoked = true
  }

  restoreAccess(): void {
    this.authRevoked = false
  }

  // --- push notifications -------------------------------------------------------------------

  /** Live channels watching a calendar's events. */
  activeChannels(calendarId: string): WatchChannel[] {
    return [...this.channels.values()].filter(
      (c) => c.calendarId === calendarId && !c.stopped && c.expiration > this.clock,
    )
  }

  /** The headers each live channel of the calendar would POST to its address for a change. */
  notificationsFor(
    calendarId: string,
    state: "exists" | "sync" = "exists",
  ): Array<Record<string, string>> {
    return this.activeChannels(calendarId).map((c) => {
      c.messageNumber += 1
      return {
        "x-goog-channel-id": c.id,
        "x-goog-channel-token": c.token ?? "",
        "x-goog-channel-expiration": new Date(c.expiration).toUTCString(),
        "x-goog-resource-id": c.resourceId,
        "x-goog-resource-uri": `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(c.calendarId)}/events?alt=json`,
        "x-goog-resource-state": state,
        "x-goog-message-number": String(c.messageNumber),
      }
    })
  }

  // --- injection ------------------------------------------------------------------------------

  /** The next `times` requests matching `match` answer `response` instead of being served. */
  failNext(match: RequestMatcher, response: FakeResponse | GoogleErrorName, times = 1): void {
    const res = typeof response === "string" ? googleError(response) : response
    this.injected.push({ match, remaining: times, respond: () => res })
  }

  /** Runs `run` just before the next `times` matching requests are served (a concurrent change). */
  beforeNext(match: RequestMatcher, run: (req: FakeRequest) => void, times = 1): void {
    this.hooks.push({ match, remaining: times, run })
  }

  /** The requests served for one operation. */
  requestsFor(op: GoogleOp): FakeRequest[] {
    return this.requests.filter((r) => r.op === op)
  }

  // --- transport ------------------------------------------------------------------------------

  /** `ctx.fetch(url, optsJson)` as the calendar app calls it: answers the `{status, headers, body}` JSON. */
  readonly fetch = async (url: string, optsJson: string): Promise<string> => {
    const opts = (optsJson ? JSON.parse(optsJson) : {}) as {
      method?: string
      headers?: Record<string, string>
      body?: string
    }
    return JSON.stringify(
      this.handle({
        method: opts.method ?? "GET",
        url,
        headers: opts.headers ?? {},
        body: opts.body,
      }),
    )
  }

  // --- free/busy ---------------------------------------------------------------------------

  /** Someone's busy times as Google's free/busy shows them to this account. */
  setBusy(email: string, busy: { start: string; end: string }[]): void {
    this.freeBusy.set(email.toLowerCase(), { busy: cloneJson(busy) })
  }

  /** Google cannot tell this account about someone (another organization's calendar). */
  setFreeBusyError(email: string, reason = "notFound"): void {
    this.freeBusy.set(email.toLowerCase(), { errors: [{ domain: "global", reason }] })
  }

  /** The token lacks (false) or carries (true) the free/busy scope. */
  grantFreeBusy(granted: boolean): void {
    this.freeBusyGranted = granted
  }

  private serveFreeBusy(req: FakeRequest): FakeResponse {
    if (!this.freeBusyGranted) {
      return {
        status: 403,
        headers: { "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
          error: {
            code: 403,
            message: "Request had insufficient authentication scopes.",
            errors: [{ domain: "global", reason: "insufficientPermissions" }],
            status: "PERMISSION_DENIED",
          },
        }),
      }
    }
    const body = (req.body ?? {}) as {
      timeMin?: string
      timeMax?: string
      items?: { id?: string }[]
    }
    const min = Date.parse(body.timeMin ?? "")
    const max = Date.parse(body.timeMax ?? "")
    const calendars: Record<string, unknown> = {}
    for (const item of body.items ?? []) {
      const id = item.id ?? ""
      const known = this.freeBusy.get(id.toLowerCase())
      if (!known) {
        calendars[id] = { errors: [{ domain: "global", reason: "notFound" }], busy: [] }
      } else if ("errors" in known) {
        calendars[id] = { errors: cloneJson(known.errors), busy: [] }
      } else {
        calendars[id] = {
          busy: known.busy.filter((b) => Date.parse(b.start) < max && Date.parse(b.end) > min),
        }
      }
    }
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        kind: "calendar#freeBusy",
        timeMin: body.timeMin,
        timeMax: body.timeMax,
        calendars,
      }),
    }
  }

  /** Serves one request. */
  handle(input: {
    method: string
    url: string
    headers?: Record<string, string>
    body?: string | null
  }): FakeResponse {
    const req = this.parse(input)
    this.requests.push(req)
    for (const hook of this.hooks) {
      if (hook.remaining > 0 && matches(hook.match, req)) {
        hook.remaining -= 1
        hook.run(req)
      }
    }
    const injected = this.injected.find((i) => i.remaining > 0 && matches(i.match, req))
    if (injected) {
      injected.remaining -= 1
      return injected.respond(req)
    }
    const auth = req.headers.authorization ?? ""
    if (this.authRevoked || !auth.startsWith("Bearer ")) return googleError("authError")
    switch (req.op) {
      case "calendarList.list":
        return this.serveCalendarList(req)
      case "events.list":
        return this.serveEventsList(req)
      case "events.get":
        return this.serveGet(req)
      case "events.insert":
        return this.serveInsert(req)
      case "events.update":
        return this.serveWrite(req, "replace")
      case "events.patch":
        return this.serveWrite(req, "merge")
      case "events.delete":
        return this.serveDelete(req)
      case "events.watch":
        return this.serveWatch(req)
      case "channels.stop":
        return this.serveStop(req)
      case "freebusy.query":
        return this.serveFreeBusy(req)
      default:
        this.unhandled.push(req)
        return googleError("notFound")
    }
  }

  private parse(input: {
    method: string
    url: string
    headers?: Record<string, string>
    body?: string | null
  }): FakeRequest {
    const url = new URL(input.url)
    const method = input.method.toUpperCase()
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v
    const query: Record<string, string> = {}
    for (const [k, v] of url.searchParams) query[k] = v
    let body: unknown = null
    if (input.body) {
      try {
        body = JSON.parse(input.body)
      } catch {
        body = input.body
      }
    }
    const base = new URL(GOOGLE_CALENDAR_API_BASE).pathname
    const rest = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname
    const segs = rest.split("/").filter(Boolean).map(decodeURIComponent)
    let op: GoogleOp = "unknown"
    let calendarId: string | null = null
    let eventId: string | null = null
    if (
      segs[0] === "users" &&
      segs[1] === "me" &&
      segs[2] === "calendarList" &&
      segs.length === 3
    ) {
      if (method === "GET") op = "calendarList.list"
    } else if (segs[0] === "freeBusy" && segs.length === 1 && method === "POST") {
      op = "freebusy.query"
    } else if (segs[0] === "channels" && segs[1] === "stop" && method === "POST") {
      op = "channels.stop"
    } else if (segs[0] === "calendars" && segs[2] === "events") {
      calendarId = segs[1] ?? null
      if (segs.length === 3)
        op = method === "GET" ? "events.list" : method === "POST" ? "events.insert" : "unknown"
      else if (segs.length === 4 && segs[3] === "watch" && method === "POST") op = "events.watch"
      else if (segs.length === 4) {
        eventId = segs[3] ?? null
        op =
          method === "GET"
            ? "events.get"
            : method === "PUT"
              ? "events.update"
              : method === "PATCH"
                ? "events.patch"
                : method === "DELETE"
                  ? "events.delete"
                  : "unknown"
      }
    }
    return { op, method, path: segs.join("/"), calendarId, eventId, query, headers, body }
  }

  private requireCalendar(calendarId: string): StoredCalendar {
    const cal = this.calendars.get(calendarId)
    if (!cal) throw new Error(`fake google: no calendar ${calendarId}`)
    return cal
  }

  private cancel(stored: StoredEvent): void {
    if (stored.resource.status === "cancelled") return
    this.seq += 1
    stored.resource = {
      ...stored.resource,
      status: "cancelled",
      etag: this.nextEtag(),
      updated: this.tick(),
    }
    stored.seq = this.seq
  }

  /** What events.list shows of a resource: a cancelled one carries only its identity. */
  private listView(resource: GoogleEvent): GoogleEvent {
    if (resource.status !== "cancelled") return cloneJson(resource)
    return {
      kind: "calendar#event",
      etag: resource.etag,
      id: resource.id,
      status: "cancelled",
      ...(resource.recurringEventId
        ? {
            recurringEventId: resource.recurringEventId,
            originalStartTime: cloneJson(resource.originalStartTime),
          }
        : {}),
    }
  }

  private serveCalendarList(req: FakeRequest): FakeResponse {
    const minRank = ROLE_RANK[req.query.minAccessRole ?? "freeBusyReader"] ?? 0
    const all = [...this.calendars.values()]
      .map((c) => c.entry)
      .filter((e) => (ROLE_RANK[e.accessRole] ?? 0) >= minRank)
    const size = Math.min(Number(req.query.maxResults ?? 100) || 100, 250)
    const offset = req.query.pageToken ? (unb64<{ o: number }>(req.query.pageToken)?.o ?? 0) : 0
    const items = all.slice(offset, offset + size).map((e) => cloneJson(e))
    const next = offset + size < all.length ? b64({ o: offset + size }) : undefined
    return json(200, {
      kind: "calendar#calendarList",
      etag: `"${this.seq}"`,
      items,
      ...(next ? { nextPageToken: next } : { nextSyncToken: b64({ list: this.seq }) }),
    })
  }

  private serveEventsList(req: FakeRequest): FakeResponse {
    const cal = this.calendars.get(req.calendarId ?? "")
    if (!cal) return googleError("notFound")
    if (ROLE_RANK[cal.entry.accessRole] === 0) return googleError("notFound")
    const size = Math.min(
      Math.max(Number(req.query.maxResults ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    )
    let snapshot: ListSnapshot | undefined
    let offset = 0
    let key: string
    if (req.query.pageToken) {
      const token = unb64<{ s: string; o: number }>(req.query.pageToken)
      snapshot = token ? this.snapshots.get(token.s) : undefined
      if (!token || !snapshot) return googleError("invalidResourceId")
      offset = token.o
      key = token.s
    } else {
      const syncToken = req.query.syncToken
      let sinceSeq: number | null = null
      if (syncToken) {
        const forbidden = ["timeMin", "timeMax", "updatedMin", "q", "orderBy", "iCalUID"]
        if (forbidden.some((k) => k in req.query)) return googleError("invalidSyncTokenParams")
        const decoded = unb64<{ c: string; seq: number; epoch: number }>(syncToken)
        if (!decoded || decoded.c !== req.calendarId || decoded.epoch !== cal.tokenEpoch) {
          return googleError("fullSyncRequired")
        }
        sinceSeq = decoded.seq
      }
      const showDeleted = req.query.showDeleted === "true"
      const timeMin = req.query.timeMin ? Date.parse(req.query.timeMin) : null
      const timeMax = req.query.timeMax ? Date.parse(req.query.timeMax) : null
      const ids = [...cal.events.values()]
        .filter((e) => {
          if (sinceSeq !== null) return e.seq > sinceSeq
          const r = e.resource
          // Google: with singleEvents=false and showDeleted=false, cancelled instances of a
          // series are still listed; only cancelled masters and one-off events are left out.
          if (r.status === "cancelled" && !showDeleted && !r.recurringEventId) return false
          const start = instantOf(r.start ?? r.originalStartTime)
          const end = instantOf(r.end) ?? start
          if (timeMax !== null && start !== null && start >= timeMax) return false
          if (timeMin !== null && end !== null && end <= timeMin && !r.recurrence) return false
          return true
        })
        .sort((a, b) => a.seq - b.seq)
        .map((e) => e.resource.id)
      key = `s${this.snapshots.size + 1}`
      snapshot = { calendarId: cal.entry.id, ids, syncSeq: this.seq, epoch: cal.tokenEpoch }
      this.snapshots.set(key, snapshot)
    }
    const pageIds = snapshot.ids.slice(offset, offset + size)
    const items = pageIds
      .map((id) => cal.events.get(id))
      .filter((e): e is StoredEvent => e !== undefined)
      .map((e) => this.listView(e.resource))
    const more = offset + size < snapshot.ids.length
    return json(200, {
      kind: "calendar#events",
      etag: `"${this.seq}"`,
      summary: cal.entry.summary ?? cal.entry.id,
      timeZone: cal.entry.timeZone ?? "UTC",
      accessRole: cal.entry.accessRole,
      updated: new Date(this.clock).toISOString(),
      items,
      ...(more
        ? { nextPageToken: b64({ s: key, o: offset + size }) }
        : {
            nextSyncToken: b64({
              c: snapshot.calendarId,
              seq: snapshot.syncSeq,
              epoch: snapshot.epoch,
            }),
          }),
    })
  }

  /** A stored event, or the occurrence a recurring master would have at that instance id. */
  private lookup(
    cal: StoredCalendar,
    eventId: string,
  ): { stored: StoredEvent | null; virtual: GoogleEvent | null } {
    const stored = cal.events.get(eventId)
    if (stored) return { stored, virtual: null }
    const parsed = parseInstanceId(eventId)
    const master = parsed ? cal.events.get(parsed.masterId) : undefined
    if (!parsed || !master?.resource.recurrence) return { stored: null, virtual: null }
    if (master.resource.status === "cancelled") return { stored: null, virtual: null }
    const m = master.resource
    const zone = m.start?.timeZone
    const originalStart = { ...parsed.originalStart, ...(zone ? { timeZone: zone } : {}) }
    const startMs = instantOf(m.start)
    const endMs = instantOf(m.end)
    const occStart = instantOf(parsed.originalStart)
    const shift = (point: GoogleTime | undefined, ms: number | null): GoogleTime | undefined => {
      if (!point || ms === null || startMs === null || occStart === null) return point
      const at = new Date(occStart + (ms - startMs)).toISOString()
      return point.date
        ? { date: at.slice(0, 10) }
        : { dateTime: at, ...(zone ? { timeZone: zone } : {}) }
    }
    const { recurrence: _recurrence, ...rest } = m
    return {
      stored: null,
      virtual: {
        ...cloneJson(rest),
        id: eventId,
        recurringEventId: parsed.masterId,
        originalStartTime: originalStart,
        start: shift(m.start, startMs),
        end: shift(m.end, endMs),
      },
    }
  }

  private serveGet(req: FakeRequest): FakeResponse {
    const cal = this.calendars.get(req.calendarId ?? "")
    if (!cal) return googleError("notFound")
    const { stored, virtual } = this.lookup(cal, req.eventId ?? "")
    if (stored) return json(200, cloneJson(stored.resource), { etag: stored.resource.etag ?? "" })
    if (virtual) return json(200, virtual, { etag: virtual.etag ?? "" })
    return googleError("notFound")
  }

  /** The 400 Google answers for an event body it will not store, or null when it is valid. */
  private validate(resource: GoogleEvent): FakeResponse | null {
    if (resource.status === "cancelled") return null
    const { start, end } = resource
    if (!start || (!start.date && !start.dateTime)) return googleError("missingEndTime")
    if (!end || (!end.date && !end.dateTime)) return googleError("missingEndTime")
    if (
      resource.recurrence &&
      resource.recurrence.length > 0 &&
      start.dateTime &&
      !start.timeZone
    ) {
      return googleError("missingTimeZone")
    }
    const s = instantOf(start)
    const e = instantOf(end)
    if (s === null || e === null) return googleError("missingEndTime")
    if (start.date ? e <= s : e < s) return googleError("timeRangeEmpty")
    return null
  }

  private canWrite(cal: StoredCalendar): boolean {
    return WRITE_ROLES.has(cal.entry.accessRole)
  }

  private conference(
    resource: GoogleEvent,
    query: Record<string, string>,
    prior: GoogleEvent | null,
  ): void {
    if (query.conferenceDataVersion !== "1") {
      // Without conferenceDataVersion=1 Google ignores conference changes.
      if (prior?.conferenceData) resource.conferenceData = cloneJson(prior.conferenceData)
      else delete resource.conferenceData
      if (prior?.hangoutLink) resource.hangoutLink = prior.hangoutLink
      else delete resource.hangoutLink
      return
    }
    const data = resource.conferenceData as
      | { createRequest?: { requestId?: string } }
      | null
      | undefined
    if (data === null || data === undefined) {
      delete resource.conferenceData
      delete resource.hangoutLink
      return
    }
    if (data.createRequest && !(data as { conferenceId?: string }).conferenceId) {
      const code = `${this.newId().slice(-3)}-${this.newId().slice(-4)}-${this.newId().slice(-3)}`
      const uri = `https://meet.google.com/${code}`
      resource.conferenceData = {
        createRequest: { ...data.createRequest, status: { statusCode: "success" } },
        conferenceId: code,
        conferenceSolution: { key: { type: "hangoutsMeet" }, name: "Google Meet" },
        entryPoints: [{ entryPointType: "video", uri, label: uri.slice(8) }],
      }
      resource.hangoutLink = uri
    }
  }

  private serveInsert(req: FakeRequest): FakeResponse {
    const cal = this.calendars.get(req.calendarId ?? "")
    if (!cal) return googleError("notFound")
    if (!this.canWrite(cal)) return googleError("requiredAccessLevel")
    const body = (req.body ?? {}) as GoogleEvent
    if (body.id !== undefined && !/^[a-v0-9]{5,1024}$/.test(body.id)) {
      return googleError("invalidResourceId")
    }
    if (body.id !== undefined && cal.events.has(body.id)) return googleError("duplicate")
    const invalid = this.validate(body)
    if (invalid) return invalid
    const resource = cloneJson(body)
    for (const field of SERVER_FIELDS) {
      if (field !== "id") delete resource[field]
    }
    this.conference(resource, req.query, null)
    const created = this.createEvent(cal.entry.id, {
      ...resource,
      organizer: { email: cal.entry.id, self: true },
    })
    return json(200, created, { etag: created.etag ?? "" })
  }

  private serveWrite(req: FakeRequest, mode: "replace" | "merge"): FakeResponse {
    const cal = this.calendars.get(req.calendarId ?? "")
    if (!cal) return googleError("notFound")
    const eventId = req.eventId ?? ""
    const { stored, virtual } = this.lookup(cal, eventId)
    const current = stored?.resource ?? virtual
    if (!current) return googleError("notFound")
    if (!this.canWrite(cal)) return googleError("requiredAccessLevel")
    const ifMatch = req.headers["if-match"]
    if (ifMatch && ifMatch !== current.etag) return googleError("conditionNotMet")
    const body = (req.body ?? {}) as GoogleEvent
    const next: GoogleEvent =
      mode === "merge" ? { ...cloneJson(current), ...cloneJson(body) } : cloneJson(body)
    const kept: Record<string, unknown> = next
    for (const field of SERVER_FIELDS) {
      if (current[field] !== undefined) kept[field] = cloneJson(current[field])
      else delete kept[field]
    }
    next.id = eventId
    if (!("status" in body))
      next.status = current.status === "cancelled" ? "confirmed" : current.status
    const invalid = this.validate(next)
    if (invalid) return invalid
    this.conference(next, req.query, current)
    const timeChanged =
      JSON.stringify(next.start) !== JSON.stringify(current.start) ||
      JSON.stringify(next.end) !== JSON.stringify(current.end) ||
      JSON.stringify(next.recurrence) !== JSON.stringify(current.recurrence)
    this.seq += 1
    const written: GoogleEvent = {
      ...next,
      etag: this.nextEtag(),
      updated: this.tick(),
      sequence: (current.sequence ?? 0) + (timeChanged ? 1 : 0),
    }
    cal.events.set(eventId, { resource: written, seq: this.seq })
    return json(200, cloneJson(written), { etag: written.etag ?? "" })
  }

  private serveDelete(req: FakeRequest): FakeResponse {
    const cal = this.calendars.get(req.calendarId ?? "")
    if (!cal) return googleError("notFound")
    const eventId = req.eventId ?? ""
    const { stored, virtual } = this.lookup(cal, eventId)
    if (!stored && !virtual) return googleError("notFound")
    if (!this.canWrite(cal)) return googleError("requiredAccessLevel")
    const current = stored?.resource ?? virtual!
    if (current.status === "cancelled") return googleError("deleted")
    const ifMatch = req.headers["if-match"]
    if (ifMatch && ifMatch !== current.etag) return googleError("conditionNotMet")
    if (virtual) {
      const parsed = parseInstanceId(eventId)!
      this.cancelOccurrence(cal.entry.id, parsed.masterId, parsed.originalStart)
    } else {
      this.deleteEvent(cal.entry.id, eventId)
    }
    return { status: 204, headers: {}, body: "" }
  }

  private serveWatch(req: FakeRequest): FakeResponse {
    const cal = this.calendars.get(req.calendarId ?? "")
    if (!cal) return googleError("notFound")
    const body = (req.body ?? {}) as {
      id?: string
      type?: string
      address?: string
      token?: string
      params?: { ttl?: string }
    }
    if (!body.id || this.channels.has(body.id)) return googleError("channelIdNotUnique")
    if (!body.address?.startsWith("https://")) {
      return googleError("pushWebhookBadDomain")
    }
    const ttlMs = body.params?.ttl ? Number(body.params.ttl) * 1000 : WATCH_TTL_MS
    const channel: WatchChannel = {
      id: body.id,
      // Google's resource id names the watched collection: the same for every channel on it.
      resourceId: `res-${Buffer.from(cal.entry.id).toString("hex").slice(0, 24)}`,
      calendarId: cal.entry.id,
      token: body.token ?? null,
      address: body.address,
      expiration: this.clock + Math.min(ttlMs, WATCH_TTL_MS),
      stopped: false,
      messageNumber: 0,
    }
    this.channels.set(channel.id, channel)
    return json(200, {
      kind: "api#channel",
      id: channel.id,
      resourceId: channel.resourceId,
      resourceUri: `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(cal.entry.id)}/events?alt=json`,
      ...(channel.token ? { token: channel.token } : {}),
      expiration: String(channel.expiration),
    })
  }

  private serveStop(req: FakeRequest): FakeResponse {
    const body = (req.body ?? {}) as { id?: string; resourceId?: string }
    const channel = body.id ? this.channels.get(body.id) : undefined
    if (!channel || channel.resourceId !== body.resourceId || channel.stopped) {
      return googleError("channelNotFound")
    }
    channel.stopped = true
    return { status: 204, headers: {}, body: "" }
  }
}
