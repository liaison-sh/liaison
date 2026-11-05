// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The matrix runner's HTTP side: sign in as a test user, set their
// notification settings, fire real producers, read the delivery log.
// Everything goes through the public API (plus the QA routes A11/T11 that the
// target serves with LIAISON_QA_ROUTES=1).

import type { Credentials } from "./config"
import type { DeliveryRow, GridCells, ReceiptRow } from "./types"

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message)
  }
}

/** An MCP connection credential: a static access token, or the refresh token it is minted from. */
export type McpCredentialSource = { accessToken: string } | { refreshToken: string }

/** Re-mint before the server's 15 minute access-token life runs out. */
const MCP_TOKEN_REUSE_MS = 10 * 60_000

/**
 * The access token for one MCP connection. An access token lives 15 minutes
 * and a full matrix run lasts longer, so with a refresh token the credential
 * mints through the `refresh_token` grant, reuses the token while it is fresh,
 * and mints again before it expires or when a call answers 401.
 */
export class McpCredential {
  private access: string | null = null
  private mintedAt = 0

  constructor(
    readonly baseUrl: string,
    private readonly source: McpCredentialSource,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get canRefresh(): boolean {
    return "refreshToken" in this.source
  }

  async token(force = false): Promise<string> {
    if (!("refreshToken" in this.source)) return this.source.accessToken
    if (!force && this.access && this.now() - this.mintedAt < MCP_TOKEN_REUSE_MS) {
      return this.access
    }
    const res = await this.fetchImpl(`${this.baseUrl}/mcp/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.source.refreshToken,
      }).toString(),
    })
    const body = (await res.json().catch(() => null)) as { access_token?: string } | null
    if (!res.ok || typeof body?.access_token !== "string") {
      throw new ApiError(`MCP token refresh failed (${res.status})`, res.status, body)
    }
    this.access = body.access_token
    this.mintedAt = this.now()
    return this.access
  }
}

export interface NotificationSettingsView {
  grid: Record<string, Record<string, boolean>>
  workHours: { start: string; end: string; days: number[]; timezone: string; explicit: boolean }
  digestCadence: string
}

export interface DeviceView {
  deviceId: string
  surface: string
  lastSeenAt?: string | null
  [k: string]: unknown
}

/** The session cookie a browser-less login answers with (the refresh token). */
function sessionCookie(res: Response): string | null {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(";")[0]?.trim() ?? ""
    if (pair.startsWith("liaison_rt=") && pair.length > "liaison_rt=".length) return pair
  }
  return null
}

export class ApiClient {
  private token: string | null = null
  /** This client's own session (`liaison_rt`), refreshed instead of signing in again. */
  private cookie: string | null = null
  userId = ""
  orgId = ""

  constructor(
    readonly baseUrl: string,
    private readonly creds: Credentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get email(): string {
    return this.creds.email
  }

  async login(extraHeaders: Record<string, string> = {}): Promise<{
    accessToken: string
    refreshToken?: string
  }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify({ email: this.creds.email, password: this.creds.password }),
    })
    const body = (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null
    const data = body?.data
    if (!res.ok || !data || typeof data.accessToken !== "string") {
      if (data && "totpRequired" in data) {
        throw new ApiError(`${this.creds.email}: TOTP is on; use a test user without it`, 401, body)
      }
      throw new ApiError(`login failed for ${this.creds.email} (${res.status})`, res.status, body)
    }
    // A session for the shell (capacitor origin) is not this client's session.
    if (Object.keys(extraHeaders).length === 0) {
      this.token = data.accessToken
      this.cookie = sessionCookie(res) ?? this.cookie
      this.userId = String(data.userId ?? "")
      this.orgId = String(data.orgId ?? "")
      // A browser-origin login answers the token alone; the profile names the user.
      if (!this.userId) {
        const me = await this.request<{ id: string; orgId?: string }>("GET", "/users/me")
        this.userId = me.id
        this.orgId = me.orgId ?? this.orgId
      }
    }
    return {
      accessToken: data.accessToken,
      ...(typeof data.refreshToken === "string" ? { refreshToken: data.refreshToken } : {}),
    }
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) await this.login()
    let res = await this.send(method, path, body)
    if (res.status === 401) {
      // Refresh this client's own session: a fresh login is a new server
      // session, and the oldest of a user's 10 is evicted, which signs the
      // simulator or the desktop app out mid-run.
      if (!(await this.refresh())) await this.login()
      res = await this.send(method, path, body)
    }
    if (res.status === 204) return undefined as T
    const json = (await res.json().catch(() => null)) as { data?: T; error?: unknown } | null
    if (!res.ok) {
      const why = (json?.error as { message?: string } | undefined)?.message
      throw new ApiError(
        `${method} ${path} -> ${res.status}${why ? `: ${why}` : ""}`,
        res.status,
        json,
      )
    }
    return (json?.data ?? json) as T
  }

  private async refresh(): Promise<boolean> {
    if (!this.cookie) return false
    const res = await this.fetchImpl(`${this.baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { Cookie: this.cookie },
    })
    const body = (await res.json().catch(() => null)) as { data?: { accessToken?: unknown } } | null
    if (!res.ok || typeof body?.data?.accessToken !== "string") return false
    this.token = body.data.accessToken
    this.cookie = sessionCookie(res) ?? this.cookie
    return true
  }

  private send(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  // --- settings ---

  getSettings(): Promise<NotificationSettingsView> {
    return this.request("GET", "/notifications/settings")
  }

  patchSettings(patch: Record<string, unknown>): Promise<NotificationSettingsView> {
    return this.request("PATCH", "/notifications/settings", patch)
  }

  /** A9: only the cells named; the rest of the grid is left as it is. */
  async setGrid(cells: GridCells): Promise<void> {
    const grid: Record<string, Record<string, boolean>> = {}
    for (const [group, row] of Object.entries(cells)) grid[group] = { ...(row ?? {}) }
    if (Object.keys(grid).length > 0) await this.patchSettings({ grid })
  }

  /** Explicit work hours that exclude now: a one-minute window 12 h away, UTC. */
  async setQuietNow(now = new Date()): Promise<void> {
    const away = new Date(now.getTime() + 12 * 3600_000)
    const hh = String(away.getUTCHours()).padStart(2, "0")
    const mm = away.getUTCMinutes()
    const start = `${hh}:${String(mm === 59 ? 58 : mm).padStart(2, "0")}`
    const end = `${hh}:${String(mm === 59 ? 59 : mm + 1).padStart(2, "0")}`
    await this.patchSettings({
      workHours: { start, end, days: [0, 1, 2, 3, 4, 5, 6], timezone: "UTC", explicit: true },
    })
  }

  /** Puts back what `getSettings` answered before the case. */
  async restoreSettings(saved: NotificationSettingsView): Promise<void> {
    await this.patchSettings({
      grid: saved.grid,
      workHours: {
        start: saved.workHours.start,
        end: saved.workHours.end,
        days: saved.workHours.days.length > 0 ? saved.workHours.days : [1, 2, 3, 4, 5],
        timezone: saved.workHours.timezone,
        explicit: saved.workHours.explicit,
      },
      digestCadence: saved.digestCadence,
    })
  }

  // --- threads ---

  /** The 1:1 room with `otherId` (the existing one when there is one). */
  async directThread(otherId: string): Promise<string> {
    try {
      const t = await this.request<{ id: string }>("POST", "/threads", {
        participantIds: [otherId],
      })
      return t.id
    } catch (err) {
      const existing = (err as ApiError).body as { error?: { existingThread?: { id?: string } } }
      const id = existing?.error?.existingThread?.id
      if (err instanceof ApiError && err.status === 409 && id) return id
      throw err
    }
  }

  /** A titled room with the recipient: its messages are `replies`, its @mentions `direct`. */
  /** Reuses the caller's live thread with this exact title, so repeated runs
   * do not fill the org's channel list with one channel per run. */
  async groupThread(otherId: string, title: string): Promise<string> {
    const mine = await this.request<{ id: string; title: string | null }[]>(
      "GET",
      "/threads?limit=100",
    )
    const existing = mine.find((t) => t.title === title)
    if (existing) return existing.id
    const t = await this.request<{ id: string }>("POST", "/threads", {
      title,
      participantIds: [otherId],
      forceCreate: true,
    })
    return t.id
  }

  async post(threadId: string, content: string, replyRootId?: string): Promise<string> {
    const m = await this.request<{ id: string }>("POST", `/threads/${threadId}/messages`, {
      content,
      ...(replyRootId ? { replyRootId } : {}),
    })
    return m.id
  }

  setMuted(threadId: string, isMuted: boolean): Promise<unknown> {
    return this.request("PATCH", `/threads/${threadId}/state`, { isMuted })
  }

  // --- per-app rules ---

  async addAppRule(source: string, kinds: string[]): Promise<string> {
    const r = await this.request<{ id: string }>("POST", "/attention/subscriptions", {
      source,
      kinds,
      filters: {},
      enabled: true,
    })
    return r.id
  }

  deleteAppRule(id: string): Promise<unknown> {
    return this.request("DELETE", `/attention/subscriptions/${id}`)
  }

  // --- producers ---

  async qaInject(userId: string, kind: string, urgent = false): Promise<string> {
    const r = await this.request<{ notificationId: string }>("POST", "/qa/notifications/inject", {
      userId,
      kind,
      summary: `Push matrix: ${kind}`,
      ...(urgent ? { urgent: true } : {}),
    })
    return r.notificationId
  }

  async testRoute(): Promise<string[]> {
    const r = await this.request<{ devices?: Array<{ notificationId: string }> }>(
      "POST",
      "/notifications/test",
      {},
    )
    return (r.devices ?? []).map((d) => d.notificationId)
  }

  /** One MCP tool call over the stateless transport (JSON or SSE answer). */
  async mcpTool(
    credential: string | McpCredential,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const cred =
      typeof credential === "string"
        ? new McpCredential(this.baseUrl, { accessToken: credential }, this.fetchImpl)
        : credential
    const call = async (token: string) =>
      this.fetchImpl(`${this.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: { name, arguments: args },
        }),
      })
    let res = await call(await cred.token())
    if (res.status === 401 && cred.canRefresh) res = await call(await cred.token(true))
    const text = await res.text()
    if (!res.ok) throw new ApiError(`MCP ${name} -> ${res.status}`, res.status, text)
    const json = text.trimStart().startsWith("{")
      ? JSON.parse(text)
      : JSON.parse(
          text
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5))
            .pop() ?? "null",
        )
    if (json?.error) throw new ApiError(`MCP ${name}: ${JSON.stringify(json.error)}`, 400, json)
    if (json?.result?.isError) {
      throw new ApiError(`MCP ${name}: ${JSON.stringify(json.result.content)}`, 400, json)
    }
    return json?.result
  }

  // --- reading back ---

  log(since: Date): Promise<{ deliveries: DeliveryRow[]; receipts: ReceiptRow[] }> {
    return this.request(
      "GET",
      `/qa/notifications/log?since=${encodeURIComponent(since.toISOString())}`,
    )
  }

  devices(): Promise<DeviceView[]> {
    return this.request("GET", "/notifications/devices")
  }

  deleteBrowserDevice(deviceId: string): Promise<unknown> {
    return this.request(
      "DELETE",
      `/notifications/browser-subscriptions/${encodeURIComponent(deviceId)}`,
    )
  }

  deleteIosToken(token: string): Promise<unknown> {
    return this.request("DELETE", "/push/tokens", { platform: "ios", token })
  }
}
