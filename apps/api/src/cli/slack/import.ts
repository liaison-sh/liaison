// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison slack import` — bulk-import a Slack export (channels.json,
 * users.json, per-channel directories of daily message JSON files) into
 * Liaison channels, so the imported history reads the way Slack did.
 *
 *   bun run --cwd apps/api liaison slack import --export-dir <path> \
 *     --org <orgId|slug> --user-map <path.json> \
 *     [--channels a,b,c] [--skip-channels ...] [--files-cache <dir>] \
 *     [--dry-run] [--skip-files] [--max-file-mb <n>] [--download-concurrency <n>] \
 *     [--limit <n>] [--index-search] [--search-vectors]
 *
 * How each Slack feature lands:
 *  - Channel → one discoverable channel thread (`handle` = `slack-<name>`),
 *    topic → `threads.topic`, purpose → `threads.description`, created_at
 *    and creator kept. An archived channel is archived for each of its
 *    members (`user_thread_state.is_archived`) and says so in its
 *    description.
 *  - Members → `thread_participants` for the Slack members that map to a
 *    Liaison user (the creator, when mapped, as the thread admin).
 *  - Messages → `kernel.messages` with the original timestamp and author.
 *    Thread replies (`thread_ts` ≠ `ts`) → reply-thread replies
 *    (`reply_root_id` = their root); "also send to channel" replies
 *    (`thread_broadcast`) carry `also_in_channel`. A deleted root that still
 *    has replies is imported as a soft-deleted root so its replies keep
 *    their place.
 *  - Followers → `reply_thread_followers` the way the live send path fills
 *    them: the root's author, every replier and every member mentioned in a
 *    reply, restricted to channel members, marked read up to the last reply.
 *  - `<@U…>` → a live mention `@[Name](user:<uuid>)` (mentions column filled
 *    by the same `parseMentions` the send path uses); `<#C…>` → a link to the
 *    imported channel thread `@[name](thread:<uuid>)`.
 *  - Reactions → `message_reactions`, keyed by the mapped user.
 *  - Pinned messages → `metadata.slack.pinned` (Liaison pins threads, not
 *    messages).
 *  - Bot/app posts: their Block Kit sections and legacy attachments are
 *    rendered to markdown; the author is a per-bot placeholder user.
 *  - Files on files.slack.com → downloaded (the export's own tokenised URLs,
 *    concurrently, cached by file id) and re-hosted as message attachments.
 *
 * Invariants:
 *  - Written through the import framework (modules/imports): one
 *    `chat.thread` run for the channels, one `chat.message` run for their
 *    history, both on the runs list and undoable. This file reads the export,
 *    resolves people and downloads files; the kinds write. NO live side
 *    effects: no outbox events, so no attention items, no push, no email, no
 *    websocket fan-out.
 *  - Idempotent and create-only. Threads are keyed on handle (an existing
 *    channel is left as it is), placeholder users on email, messages on
 *    their `slack:<ts>` external ref (or `metadata.slack.ts` for rows an
 *    earlier version imported); a re-run inserts only what is missing.
 *  - Real people come from `--user-map` (slackUserId → Liaison userId), then
 *    from the users.json profile email: a non-bot Slack user whose email
 *    matches (case-insensitively) a user of the org is that user. The map
 *    wins when both apply. Everyone else (leavers, bots) becomes a
 *    deactivated placeholder user (`slack-import+<slack name>@import.invalid`)
 *    that cannot log in. A re-run after a person gained an email match uses
 *    the real user for every row it inserts; rows an earlier run attributed
 *    to the placeholder are left as they are (merging them is a separate step).
 *  - Search: the messages emit no events, so the message indexer never sees
 *    them. `--index-search` backfills them into the search index afterwards
 *    (keyword only unless `--search-vectors`).
 *  - The export's file URLs carry a Slack token: they are never logged.
 */
import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readdir, readFile, rename, stat, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { Readable } from "node:stream"
import { finished } from "node:stream/promises"
import { importPlaceholderEmail } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { slackReactionToEmoji } from "~/cli/slack/emoji"
import { messageToMarkdown, type SlackRefs } from "~/cli/slack/markdown"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { putObject as defaultPutObject } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { fetchWithRedirectValidation } from "~/lib/outbound-fetch"
import { threadHandle } from "~/modules/imports/kernel-kinds/chat"
import { runImport } from "~/modules/imports/runner"

const log = rootLogger.child({ module: "cli-slack-import" })

/** The import runs' source label: handles `slack-<channel>`, refs `slack:<ts>`. */
const SOURCE_LABEL = "slack"

function kernelRel(name: string): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("kernel")}.${name}`)
}

// ─────────────────────────────────────────────────────────────────────────
// Slack export shapes (permissive: the export carries many more fields)
// ─────────────────────────────────────────────────────────────────────────

const slackFileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  title: z.string().optional(),
  mimetype: z.string().optional(),
  filetype: z.string().optional(),
  size: z.number().optional(),
  url_private: z.string().optional(),
  url_private_download: z.string().optional(),
  permalink: z.string().optional(),
  mode: z.string().optional(),
})
export type SlackFile = z.infer<typeof slackFileSchema>

const slackReactionSchema = z.object({
  name: z.string(),
  users: z.array(z.string()).default([]),
  count: z.number().optional(),
})

const slackMessageSchema = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  ts: z.string(),
  thread_ts: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  username: z.string().optional(),
  bot_profile: z.object({ name: z.string().optional() }).optional(),
  user_profile: z
    .object({
      real_name: z.string().optional(),
      display_name: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  text: z.string().optional(),
  blocks: z.array(z.record(z.string(), z.unknown())).optional(),
  attachments: z.array(z.record(z.string(), z.unknown())).optional(),
  files: z.array(slackFileSchema).optional(),
  reactions: z.array(slackReactionSchema).optional(),
  edited: z.object({ user: z.string().optional(), ts: z.string().optional() }).optional(),
  purpose: z.string().optional(),
  topic: z.string().optional(),
  name: z.string().optional(), // channel_name subtype: new name
  old_name: z.string().optional(),
  hidden: z.boolean().optional(),
})
export type SlackMessage = z.infer<typeof slackMessageSchema>

const slackChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  creator: z.string().optional(),
  is_archived: z.boolean().optional(),
  members: z.array(z.string()).default([]),
  topic: z.object({ value: z.string().optional() }).optional(),
  purpose: z.object({ value: z.string().optional() }).optional(),
  pins: z.array(z.object({ id: z.string(), type: z.string().optional() })).optional(),
})
export type SlackChannel = z.infer<typeof slackChannelSchema>

const slackUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  deleted: z.boolean().optional(),
  is_bot: z.boolean().optional(),
  real_name: z.string().optional(),
  profile: z
    .object({
      real_name: z.string().optional(),
      display_name: z.string().optional(),
      email: z.string().optional(),
      bot_id: z.string().optional(),
    })
    .optional(),
})
export type SlackUser = z.infer<typeof slackUserSchema>

// ─────────────────────────────────────────────────────────────────────────
// Pure rules (unit-tested)
// ─────────────────────────────────────────────────────────────────────────

/** Subtypes that carry no user-facing content — never imported. */
const SKIP_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "group_join",
  "group_leave",
  "sh_room_created",
  "retention_threshold",
  "bot_add",
  "bot_remove",
  "tombstone",
  "huddle_thread",
])

/** Subtypes imported as `authorType: 'system'` short-sentence messages. */
const SYSTEM_SUBTYPES = new Set([
  "channel_purpose",
  "group_purpose",
  "channel_topic",
  "channel_name",
  "group_name",
  "channel_archive",
  "channel_convert_to_public",
])

/** Replies that Slack ALSO showed in the channel ("Also send to #channel"). */
const BROADCAST_SUBTYPES = new Set(["thread_broadcast", "reply_broadcast"])

export function shouldSkipMessage(m: SlackMessage): boolean {
  if (m.hidden) return true
  if (!m.subtype) return false
  return SKIP_SUBTYPES.has(m.subtype)
}

/** Build the short system-sentence content for the channel-event subtypes. */
export function systemSubtypeContent(m: SlackMessage): string {
  if (m.subtype === "channel_purpose" || m.subtype === "group_purpose")
    return `Channel purpose set: ${m.purpose ?? ""}`
  if (m.subtype === "channel_topic") return `Channel topic set: ${m.topic ?? ""}`
  if (m.subtype === "channel_name" || m.subtype === "group_name")
    return `Channel renamed: ${m.old_name ?? "?"} → ${m.name ?? "?"}`
  if (m.subtype === "channel_archive") return "Channel archived"
  if (m.subtype === "channel_convert_to_public") return "Channel made public"
  return m.text ?? ""
}

/** Slack `ts` is epoch-seconds with fractional part, e.g. "1649672651.246279". */
export function slackTsToDate(ts: string): Date {
  return new Date(Number.parseFloat(ts) * 1000)
}

/** Order two Slack ts values (numerically, then textually for equal floats). */
export function compareSlackTs(a: string, b: string): number {
  const d = Number.parseFloat(a) - Number.parseFloat(b)
  if (d !== 0) return d
  return a < b ? -1 : a > b ? 1 : 0
}

/** True when a Slack message is a reply inside a Slack thread (not its root). */
export function isSlackReply(m: Pick<SlackMessage, "ts" | "thread_ts">): boolean {
  return !!m.thread_ts && m.thread_ts !== m.ts
}

/**
 * How one Slack message lands in the reply-thread model: its root (null for a
 * channel message, or for an orphan reply whose root was never exported) and
 * whether it also shows in the channel.
 */
export function replyPlacement(
  m: Pick<SlackMessage, "ts" | "thread_ts" | "subtype">,
  rootIdByTs: ReadonlyMap<string, string>,
): { replyRootId: string | null; alsoInChannel: boolean; orphan: boolean } {
  if (!isSlackReply(m)) return { replyRootId: null, alsoInChannel: false, orphan: false }
  const rootId = rootIdByTs.get(m.thread_ts as string) ?? null
  if (!rootId) return { replyRootId: null, alsoInChannel: false, orphan: true }
  return {
    replyRootId: rootId,
    alsoInChannel: !!m.subtype && BROADCAST_SUBTYPES.has(m.subtype),
    orphan: false,
  }
}

/** Cut a string to `max` characters, marking the cut. */
export function clip(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** Replace any `token=`/`t=` query value so a URL is safe to log. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:token|t)=)[^&]+/g, "$1REDACTED")
}

/** The channel description: the Slack purpose, prefixed by an archive note. */
export function channelDescription(channel: SlackChannel, archivedAt: Date | null): string | null {
  const purpose = channel.purpose?.value?.trim() || ""
  const note = channel.is_archived
    ? `Archived in Slack${archivedAt ? ` on ${archivedAt.toISOString().slice(0, 10)}` : ""}.`
    : ""
  const text = [note, purpose].filter(Boolean).join("\n\n")
  return text ? clip(text, 2000) : null
}

/** True for a users.json entry that is a bot or app, never a person. */
export function isSlackBotUser(u: SlackUser): boolean {
  return u.is_bot === true || u.id === "USLACKBOT" || !!u.profile?.bot_id
}

/**
 * The users.json people to match to org users by email: lower-cased profile
 * email → the Slack ids carrying it. Bots never match, and a Slack user the
 * explicit map already places is left to the map.
 */
export function slackEmailsToMatch(
  users: SlackUser[],
  userMap: Record<string, string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const u of users) {
    if (isSlackBotUser(u) || Object.hasOwn(userMap, u.id)) continue
    const email = u.profile?.email?.trim().toLowerCase()
    if (!email?.includes("@")) continue
    const ids = out.get(email)
    if (ids) ids.push(u.id)
    else out.set(email, [u.id])
  }
  return out
}

/** The placeholder email for a Slack user or bot (stable across runs). */
export function placeholderEmail(key: string): string {
  return importPlaceholderEmail("slack-import", key)
}

// ─────────────────────────────────────────────────────────────────────────
// Options and report
// ─────────────────────────────────────────────────────────────────────────

export interface SlackImportOpts {
  exportDir: string
  orgSlug?: string
  userMapPath: string
  channels?: string[]
  skipChannels?: string[]
  filesCacheDir?: string
  dryRun?: boolean
  skipFiles?: boolean
  /** Files larger than this are linked as "too large", not re-hosted. Default 50. */
  maxFileMb?: number
  /** Parallel file downloads per channel. Default 8. */
  downloadConcurrency?: number
  limit?: number
  /** After importing, backfill the imported channels into the search index. */
  indexSearch?: boolean
  /** Embed the backfilled documents with the org's key (provider cost). */
  searchVectors?: boolean
  putObject?: typeof defaultPutObject
  /** Injectable for tests — defaults to a real `fetch`-based downloader. */
  downloadFile?: (url: string, destPath: string, maxBytes?: number) => Promise<{ bytes: number }>
  /** Injectable for tests — defaults to the bulk message indexer. */
  indexThread?: (orgId: string, threadId: string) => Promise<{ messages: number; windows: number }>
}

export interface ChannelSummary {
  channel: string
  threadCreated: boolean
  messagesImported: number
  repliesImported: number
  orphanReplies: number
  messagesAlreadyImported: number
  messagesSkipped: number
  reactionsImported: number
  followers: number
  members: number
  filesDownloaded: number
  filesUploaded: number
  filesFailed: number
  filesTooLarge: number
  bytesDownloaded: number
}

export interface SlackImportReport {
  ok: boolean
  dryRun: boolean
  channels: ChannelSummary[]
  threadsCreated: number
  placeholdersCreated: number
  mappedUsers: number
  /** Slack users matched to an existing org user by their users.json email. */
  matchedByEmail: number
  totalMessagesImported: number
  totalRepliesImported: number
  totalOrphanReplies: number
  totalMessagesAlreadyImported: number
  totalMessagesSkipped: number
  totalReactionsImported: number
  totalFollowers: number
  totalFilesDownloaded: number
  totalFilesUploaded: number
  totalFilesFailed: number
  totalFilesTooLarge: number
  totalBytesDownloaded: number
  unparseableMessages: number
  /** Channels in channels.json with no folder in the export (empty, or a mangled unzip). */
  channelsWithoutFolder: string[]
  search?: { threads: number; messages: number; windows: number }
  errors: Array<{ channel: string; error: string }>
}

export interface SlackImportResult {
  exitCode: number
  report: SlackImportReport
}

// ─────────────────────────────────────────────────────────────────────────
// File download (streamed to disk, retried, cached by file id)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The file id names the file's place in the cache (`<cache dir>/<id>`), and it
 * comes from the export's day files, data written outside the company. Only a
 * Slack-shaped id (letters, digits, `_`, `-`) is used as a path; any other is
 * reported as an unavailable file, never joined onto the cache dir.
 */
const SAFE_FILE_ID = /^[A-Za-z0-9_-]{1,64}$/

function cachePathFor(cacheDir: string, fileId: string): string | null {
  if (!SAFE_FILE_ID.test(fileId)) return null
  const root = resolve(cacheDir)
  const p = resolve(root, fileId)
  return dirname(p) === root ? p : null
}

async function defaultDownloadFile(
  url: string,
  destPath: string,
  maxBytes?: number,
): Promise<{ bytes: number }> {
  // The URL comes out of the export archive, which is DATA: the SSRF-safe
  // helper pins DNS and re-validates every redirect hop.
  // A stalled transfer must fail (and be retried) rather than hang the run:
  // files.slack.com serves an export at a few hundred KB/s per connection.
  const res = await fetchWithRedirectValidation(url, { signal: AbortSignal.timeout(600_000) })
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status}`)
  }
  const tmpPath = `${destPath}.part`
  const nodeStream = Readable.fromWeb(res.body)
  const out = createWriteStream(tmpPath)
  let bytes = 0
  nodeStream.on("data", (chunk: Buffer) => {
    bytes += chunk.length
    // The size in the export is the author's claim: cap the stream itself.
    if (maxBytes != null && bytes > maxBytes) {
      nodeStream.destroy(new Error(`download exceeds ${maxBytes} bytes`))
    }
  })
  try {
    await finished(nodeStream.pipe(out))
  } catch (e) {
    out.destroy()
    await unlink(tmpPath).catch(() => {})
    throw e
  }
  await rename(tmpPath, destPath)
  return { bytes }
}

async function downloadWithRetry(
  url: string,
  destPath: string,
  downloadFn: (url: string, destPath: string, maxBytes?: number) => Promise<{ bytes: number }>,
  fileId: string,
  maxBytes: number,
): Promise<{ bytes: number }> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await downloadFn(url, destPath, maxBytes)
    } catch (e) {
      lastErr = e
      // Never log the URL: the export's file URLs carry a Slack token.
      const msg = e instanceof Error ? redactUrl(e.message) : "unknown"
      log.warn({ fileId, attempt, error: msg }, "slack import: file download attempt failed")
    }
  }
  const msg = lastErr instanceof Error ? redactUrl(lastErr.message) : String(lastErr)
  throw new Error(msg)
}

export function isSlackHosted(url: string | undefined): url is string {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    return host === "files.slack.com" || host.endsWith(".files.slack.com")
  } catch {
    return false
  }
}

async function runPool<T>(items: T[], concurrency: number, fn: (t: T) => Promise<void>) {
  let next = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        await fn(items[i] as T)
      }
    },
  )
  await Promise.all(workers)
}

// ─────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────

export async function runSlackImport(opts: SlackImportOpts): Promise<SlackImportResult> {
  const putObject = opts.putObject ?? defaultPutObject
  const downloadFile = opts.downloadFile ?? defaultDownloadFile
  const maxFileBytes = (opts.maxFileMb ?? 50) * 1024 * 1024
  const dryRun = !!opts.dryRun
  const err = (s: string) => process.stderr.write(`${s}\n`)

  const resolved = await resolveOrgId(
    opts.orgSlug,
    "multiple orgs exist — pass --org <slug> to choose the import target",
  )
  if (!resolved.ok) throw new Error(resolved.message)
  const orgId = resolved.orgId

  const usersRaw = JSON.parse(
    await readFile(join(opts.exportDir, "users.json"), "utf8"),
  ) as unknown[]
  const slackUsers = usersRaw.map((u) => slackUserSchema.parse(u))
  const slackUserById = new Map(slackUsers.map((u) => [u.id, u]))
  const slackUserByBotId = new Map(
    slackUsers.flatMap((u) => (u.profile?.bot_id ? [[u.profile.bot_id, u] as const] : [])),
  )

  const userMap = JSON.parse(await readFile(opts.userMapPath, "utf8")) as Record<string, string>

  const channelsRaw = JSON.parse(
    await readFile(join(opts.exportDir, "channels.json"), "utf8"),
  ) as unknown[]
  const allChannels = channelsRaw.map((c) => slackChannelSchema.parse(c))
  let channels = allChannels
  if (opts.channels?.length) {
    const wanted = new Set(opts.channels)
    channels = channels.filter((c) => wanted.has(c.name))
  }
  if (opts.skipChannels?.length) {
    const skip = new Set(opts.skipChannels)
    channels = channels.filter((c) => !skip.has(c.name))
  }

  const displayName = (u: SlackUser | undefined, fallback: string): string =>
    u?.profile?.real_name || u?.profile?.display_name || u?.real_name || u?.name || fallback

  // Pre-pass over the selected channels: the people and bots that post or
  // react without being in users.json (Slack Connect guests, removed
  // accounts, integrations). Their messages carry a `user_profile` with the
  // name users.json lacks, and each gets its placeholder in one batch.
  const extraProfiles = new Map<string, { name: string; handle: string }>()
  const extraUserIds = new Set<string>()
  const botKeys = new Map<string, string>() // key → label
  const archivedAtByChannel = new Map<string, Date>()
  for (const channel of channels) {
    for (const m of await loadChannelMessages(opts.exportDir, channel.name)) {
      if (m.subtype === "channel_archive" && !archivedAtByChannel.has(channel.name)) {
        archivedAtByChannel.set(channel.name, slackTsToDate(m.ts))
      }
      if (m.user && !slackUserById.has(m.user)) {
        extraUserIds.add(m.user)
        const p = m.user_profile
        const name = p?.real_name || p?.display_name || p?.name
        if (name && !extraProfiles.has(m.user))
          extraProfiles.set(m.user, { name, handle: p?.name || m.user })
      }
      for (const r of m.reactions ?? [])
        for (const u of r.users) if (!slackUserById.has(u)) extraUserIds.add(u)
      if (isBotPost(m) && !m.user && !(m.bot_id && slackUserByBotId.has(m.bot_id))) {
        const { key, label } = botKey(m)
        if (!botKeys.has(key)) botKeys.set(key, label)
      }
    }
  }

  const resolveUserName = (slackId: string): string =>
    slackUserById.has(slackId)
      ? displayName(slackUserById.get(slackId), slackId)
      : (extraProfiles.get(slackId)?.name ?? slackId)

  if (opts.filesCacheDir) await mkdir(opts.filesCacheDir, { recursive: true })

  const report: SlackImportReport = {
    ok: true,
    dryRun,
    channels: [],
    threadsCreated: 0,
    placeholdersCreated: 0,
    mappedUsers: 0,
    matchedByEmail: 0,
    totalMessagesImported: 0,
    totalRepliesImported: 0,
    totalOrphanReplies: 0,
    totalMessagesAlreadyImported: 0,
    totalMessagesSkipped: 0,
    totalReactionsImported: 0,
    totalFollowers: 0,
    totalFilesDownloaded: 0,
    totalFilesUploaded: 0,
    totalFilesFailed: 0,
    totalFilesTooLarge: 0,
    totalBytesDownloaded: 0,
    unparseableMessages: 0,
    channelsWithoutFolder: [],
    errors: [],
  }

  // ── Users. Mapped people keep their Liaison id (checked to exist in this
  // org); everyone else in users.json gets a placeholder up front, so the
  // markdown converter can resolve any mention synchronously.
  const liaisonIdBySlackId = new Map<string, string>()
  const placeholderIds = new Set<string>()
  const emailById = new Map<string, string>()

  const mappedIds = Object.values(userMap)
  const existingMapped = new Set(
    extractRows<{ id: string }>(
      await withPrivilegedDb(orgId, "cli-slack-import-mapped-users", (tx) =>
        tx.execute(drizzleSql`
          SELECT id::text AS id FROM ${kernelRel("users")}
          WHERE org_id = ${orgId}::uuid
            AND id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(mappedIds)}::jsonb))
        `),
      ),
    ).map((r) => r.id),
  )
  for (const [slackId, liaisonId] of Object.entries(userMap)) {
    if (!existingMapped.has(liaisonId)) {
      throw new Error(`user map: ${slackId} → ${liaisonId} is not a user of this org`)
    }
    liaisonIdBySlackId.set(slackId, liaisonId)
  }
  report.mappedUsers = liaisonIdBySlackId.size

  // Then the profile email: without it, a person missing from the map (or on
  // a second Slack account) became a placeholder beside their real account.
  // Placeholder addresses are excluded, so a Slack user can never "match" a
  // placeholder an earlier run created; when one address is held by several
  // org users (emails are unique per org, but not case-insensitively), the
  // active, oldest one wins.
  const emailsToMatch = slackEmailsToMatch(slackUsers, userMap)
  if (emailsToMatch.size > 0) {
    const matches = extractRows<{ id: string; email: string }>(
      await withPrivilegedDb(orgId, "cli-slack-import-email-match", (tx) =>
        tx.execute(drizzleSql`
          SELECT DISTINCT ON (lower(email)) id::text AS id, lower(email) AS email
          FROM ${kernelRel("users")}
          WHERE org_id = ${orgId}::uuid
            AND lower(email) IN (SELECT jsonb_array_elements_text(${JSON.stringify([...emailsToMatch.keys()])}::jsonb))
            AND email NOT LIKE '%@import.invalid'
          ORDER BY lower(email), (status = 'active') DESC, created_at ASC, id ASC
        `),
      ),
    )
    for (const m of matches) {
      for (const slackId of emailsToMatch.get(m.email) ?? []) {
        liaisonIdBySlackId.set(slackId, m.id)
        report.matchedByEmail += 1
      }
    }
  }

  async function ensurePlaceholders(
    wanted: Array<{ key: string; email: string; name: string }>,
  ): Promise<void> {
    const missing = wanted.filter((w) => !liaisonIdBySlackId.has(w.key))
    if (missing.length === 0) return
    const existing = new Map(
      extractRows<{ id: string; email: string }>(
        await withPrivilegedDb(orgId, "cli-slack-import-placeholder-lookup", (tx) =>
          tx.execute(drizzleSql`
            SELECT id::text AS id, email FROM ${kernelRel("users")}
            WHERE org_id = ${orgId}::uuid
              AND email IN (SELECT jsonb_array_elements_text(${JSON.stringify(missing.map((m) => m.email))}::jsonb))
          `),
        ),
      ).map((r) => [r.email, r.id]),
    )
    const toCreate: Array<{ id: string; email: string; name: string }> = []
    for (const w of missing) {
      const id = existing.get(w.email) ?? randomUUID()
      if (!existing.has(w.email)) toCreate.push({ id, email: w.email, name: w.name })
      liaisonIdBySlackId.set(w.key, id)
      placeholderIds.add(id)
      emailById.set(id, w.email)
    }
    if (toCreate.length && !dryRun) {
      await withPrivilegedDb(orgId, "cli-slack-import-placeholder-create", (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO ${kernelRel("users")} (id, org_id, email, name, status)
          SELECT r.id, ${orgId}::uuid, r.email, r.name, 'deactivated'
          FROM jsonb_to_recordset(${JSON.stringify(toCreate)}::jsonb) AS r(id uuid, email text, name text)
          ON CONFLICT DO NOTHING
        `),
      )
    }
    report.placeholdersCreated += toCreate.length
  }

  await ensurePlaceholders([
    ...slackUsers
      .filter((u) => !liaisonIdBySlackId.has(u.id))
      .map((u) => ({
        key: u.id,
        email: placeholderEmail(u.name),
        name:
          u.is_bot || u.id === "USLACKBOT"
            ? `${displayName(u, u.name)} (bot)`
            : displayName(u, u.name),
      })),
    ...[...extraUserIds].map((id) => ({
      key: id,
      email: placeholderEmail(id),
      name: extraProfiles.get(id)?.name ?? id,
    })),
    ...[...botKeys].map(([key, label]) => ({
      key,
      email: placeholderEmail(key.slice(1).replace(":", "-")),
      name: `${label} (bot)`,
    })),
    { key: "@system", email: placeholderEmail("system"), name: "Slack Import" },
  ])
  const systemUserId = liaisonIdBySlackId.get("@system") as string

  /** A user id for a Slack user id that is not in users.json (rare). */
  async function userIdFor(slackId: string): Promise<string> {
    const known = liaisonIdBySlackId.get(slackId)
    if (known) return known
    await ensurePlaceholders([{ key: slackId, email: placeholderEmail(slackId), name: slackId }])
    return liaisonIdBySlackId.get(slackId) as string
  }

  /** The author of a bot/app post: its users.json bot user, else a per-bot placeholder. */
  async function botUserIdFor(m: SlackMessage): Promise<string> {
    const botUser = m.bot_id ? slackUserByBotId.get(m.bot_id) : undefined
    if (botUser) return userIdFor(botUser.id)
    const { key, label } = botKey(m)
    const known = liaisonIdBySlackId.get(key)
    if (known) return known
    await ensurePlaceholders([
      { key, email: placeholderEmail(key.slice(1).replace(":", "-")), name: `${label} (bot)` },
    ])
    return liaisonIdBySlackId.get(key) as string
  }

  // ── Emails. The import kinds name people by email: the exact address of the
  // user each Slack id resolved to (a real person, or a placeholder above).
  {
    const missing = [...new Set(liaisonIdBySlackId.values())].filter((id) => !emailById.has(id))
    if (missing.length > 0) {
      for (const r of extractRows<{ id: string; email: string }>(
        await withPrivilegedDb(orgId, "cli-slack-import-emails", (tx) =>
          tx.execute(drizzleSql`
            SELECT id::text AS id, email FROM ${kernelRel("users")}
            WHERE org_id = ${orgId}::uuid
              AND id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(missing)}::jsonb))
          `),
        ),
      )) {
        emailById.set(r.id, r.email)
      }
    }
  }
  const emailOf = (userId: string): string => emailById.get(userId) ?? ""

  // The person the runs are attributed to: the org's first active user, else
  // the import's own placeholder.
  const actorUserId =
    extractRows<{ id: string }>(
      await withPrivilegedDb(orgId, "cli-slack-import-actor", (tx) =>
        tx.execute(drizzleSql`
          SELECT id::text AS id FROM ${kernelRel("users")}
          WHERE org_id = ${orgId}::uuid AND status = 'active'
          ORDER BY created_at ASC, id ASC LIMIT 1
        `),
      ),
    )[0]?.id ?? systemUserId
  const actor: UserContext = {
    actorType: "user",
    userId: actorUserId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }

  // ── Channels: one `chat.thread` run (handle `slack-<name>`; an existing
  // channel is kept as it is). Every selected channel gets its thread first,
  // so a `<#C…>` link anywhere resolves to the imported channel; channels
  // outside this run still resolve when a previous run imported them.
  const summaries = new Map<string, ChannelSummary>()
  for (const c of channels) {
    summaries.set(c.name, {
      channel: c.name,
      threadCreated: false,
      messagesImported: 0,
      repliesImported: 0,
      orphanReplies: 0,
      messagesAlreadyImported: 0,
      messagesSkipped: 0,
      reactionsImported: 0,
      followers: 0,
      members: 0,
      filesDownloaded: 0,
      filesUploaded: 0,
      filesFailed: 0,
      filesTooLarge: 0,
      bytesDownloaded: 0,
    })
  }
  const membersOf = (channel: SlackChannel): string[] => [
    // Two Slack accounts of one person (the map, or the same profile email)
    // are one Liaison user.
    ...new Set(
      channel.members
        .map((s) => liaisonIdBySlackId.get(s))
        .filter((id): id is string => !!id && !placeholderIds.has(id)),
    ),
  ]
  const threadRecords = channels.map((channel) => {
    const members = membersOf(channel)
    const summary = summaries.get(channel.name) as ChannelSummary
    summary.members = members.length
    const creatorId = channel.creator ? liaisonIdBySlackId.get(channel.creator) : undefined
    const archivedAt = archivedAtByChannel.get(channel.name) ?? null
    const topic = channel.topic?.value?.trim() ? clip(channel.topic.value, 250) : null
    const description = channelDescription(channel, archivedAt)
    return {
      externalRef: channel.name,
      name: channel.name,
      ...(topic ? { topic } : {}),
      ...(description ? { description } : {}),
      createdAt: new Date(channel.created * 1000).toISOString(),
      creatorEmail: emailOf(creatorId ?? systemUserId),
      memberEmails: members.map(emailOf).filter(Boolean),
      ...(channel.is_archived ? { archived: true } : {}),
    }
  })
  const threadIdByChannelId = new Map<string, string>()
  const channelNameById = new Map(allChannels.map((c) => [c.id, c.name]))
  if (!dryRun && threadRecords.length > 0) {
    const threads = await runImport({
      orgId,
      actor,
      kinds: ["chat.thread"],
      source: {
        type: "records",
        records: threadRecords.map((record, i) => ({ line: i + 1, record })),
      },
      sourceLabel: SOURCE_LABEL,
      mode: "cli",
      onRecord: (e) => {
        const summary = summaries.get(e.dedupKey)
        if (e.status === "created" && summary) summary.threadCreated = true
        if (e.status === "failed") {
          report.errors.push({ channel: e.dedupKey, error: redactUrl(e.error ?? "failed") })
        }
      },
    })
    report.threadsCreated = threads.counts["chat.thread"]?.created ?? 0
  }
  const existingThreads = new Map(
    extractRows<{ id: string; handle: string }>(
      await withPrivilegedDb(orgId, "cli-slack-import-thread-lookup", (tx) =>
        tx.execute(drizzleSql`
          SELECT id::text AS id, handle FROM ${kernelRel("threads")}
          WHERE org_id = ${orgId}::uuid AND handle LIKE 'slack-%'
        `),
      ),
    ).map((r) => [r.handle, r.id]),
  )
  for (const c of allChannels) {
    const id = existingThreads.get(threadHandle(SOURCE_LABEL, c.name))
    if (id) threadIdByChannelId.set(c.id, id)
  }
  for (const c of channels) {
    // A dry run creates nothing: a new channel gets a stand-in id for links.
    if (!threadIdByChannelId.has(c.id)) {
      threadIdByChannelId.set(c.id, randomUUID())
      if (dryRun) (summaries.get(c.name) as ChannelSummary).threadCreated = true
    }
  }
  if (dryRun)
    report.threadsCreated = channels.filter((c) => summaries.get(c.name)?.threadCreated).length

  const refs: SlackRefs = {
    userMention: (slackId) => {
      const id = liaisonIdBySlackId.get(slackId)
      return id ? `@[${resolveUserName(slackId).replace(/[[\]]/g, "")}](user:${id})` : null
    },
    channelLink: (channelId, name) => {
      const id = threadIdByChannelId.get(channelId)
      const label = (name || channelNameById.get(channelId) || channelId).replace(/[[\]]/g, "")
      return id ? `@[${label}](thread:${id})` : null
    },
  }

  // ── History: one `chat.message` run over every selected channel, each
  // channel's files downloaded just before its messages are emitted.
  const importedThreadIds = channels
    .filter((c) => !report.errors.some((e) => e.channel === c.name))
    .map((c) => threadIdByChannelId.get(c.id) as string)
  const followersBefore = dryRun
    ? new Map<string, number>()
    : await followerCounts(importedThreadIds)
  const records = (async function* (): AsyncGenerator<{
    line: number
    record: Record<string, unknown>
  }> {
    let line = 0
    for (const channel of channels) {
      if (report.errors.some((e) => e.channel === channel.name)) continue
      try {
        for await (const record of channelRecords(channel)) {
          line += 1
          yield { line, record }
        }
      } catch (e) {
        const msg = e instanceof Error ? redactUrl(e.message) : String(e)
        report.errors.push({ channel: channel.name, error: msg })
        log.error({ error: msg, channel: channel.name }, "slack import: channel failed")
      }
    }
  })()
  if (dryRun) {
    for await (const { record } of records) {
      const summary = summaries.get(String(record.threadRef)) as ChannelSummary
      summary.messagesImported += 1
      if (record.replyToRef) summary.repliesImported += 1
      const reactions = (record.reactions as Array<{ userEmails: string[] }> | undefined) ?? []
      for (const r of reactions) summary.reactionsImported += r.userEmails.length
    }
  } else {
    await runImport({
      orgId,
      actor,
      kinds: ["chat.message"],
      source: { type: "records", records },
      sourceLabel: SOURCE_LABEL,
      mode: "cli",
      // People resolve to the users above; bots and leavers already have
      // their placeholders.
      placeholders: false,
      kindOptions: {
        "chat.message": {
          // `--index-search` backfills once at the end instead.
          deferIndexing: true,
          // A file that cannot be stored is noted in its message, not fatal.
          lenientAttachments: true,
          putObject,
          // The selected channels: their history goes into the existing
          // `slack-<name>` channel even when an earlier tool created it.
          existingChannels: channels.map((c) => c.name),
        },
      },
      onRecord: (e) => {
        const ref = (e.record as { threadRef?: unknown } | undefined)?.threadRef
        const summary = typeof ref === "string" ? summaries.get(ref) : undefined
        if (!summary) return
        const r = e.report ?? {}
        const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0)
        if (e.status === "created") {
          summary.messagesImported += 1
          summary.repliesImported += n("repliesImported")
          summary.reactionsImported += n("reactionsImported")
          summary.filesUploaded += n("attachmentsStored")
          summary.filesFailed += n("attachmentsSkipped")
        } else if (e.status === "skipped") {
          summary.messagesAlreadyImported += 1
        } else {
          report.errors.push({
            channel: summary.channel,
            error: redactUrl(`${e.dedupKey}: ${e.error ?? "failed"}`),
          })
        }
      },
    })
    const followersAfter = await followerCounts(importedThreadIds)
    for (const c of channels) {
      const id = threadIdByChannelId.get(c.id) as string
      ;(summaries.get(c.name) as ChannelSummary).followers =
        (followersAfter.get(id) ?? 0) - (followersBefore.get(id) ?? 0)
    }
  }

  for (const channel of channels) {
    const summary = summaries.get(channel.name) as ChannelSummary
    report.channels.push(summary)
    report.totalMessagesImported += summary.messagesImported
    report.totalRepliesImported += summary.repliesImported
    report.totalOrphanReplies += summary.orphanReplies
    report.totalMessagesAlreadyImported += summary.messagesAlreadyImported
    report.totalMessagesSkipped += summary.messagesSkipped
    report.totalReactionsImported += summary.reactionsImported
    report.totalFollowers += summary.followers
    report.totalFilesDownloaded += summary.filesDownloaded
    report.totalFilesUploaded += summary.filesUploaded
    report.totalFilesFailed += summary.filesFailed
    report.totalFilesTooLarge += summary.filesTooLarge
    report.totalBytesDownloaded += summary.bytesDownloaded
    err(
      `#${channel.name}: imported ${summary.messagesImported} (${summary.repliesImported} replies), ` +
        `already ${summary.messagesAlreadyImported}, skipped ${summary.messagesSkipped}, ` +
        `reactions ${summary.reactionsImported}, followers ${summary.followers}, ` +
        `files ${summary.filesUploaded} up / ${summary.filesFailed} failed / ${summary.filesTooLarge} too large`,
    )
  }

  if (opts.indexSearch && !dryRun) {
    const indexThread =
      opts.indexThread ??
      (async (o: string, t: string) => {
        const { indexThreadMessagesBulk } = await import("~/modules/search/message-indexer")
        return indexThreadMessagesBulk(o, t, { withVectors: !!opts.searchVectors })
      })
    const search = { threads: 0, messages: 0, windows: 0 }
    for (const threadId of importedThreadIds) {
      try {
        const r = await indexThread(orgId, threadId)
        search.threads += 1
        search.messages += r.messages
        search.windows += r.windows
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        report.errors.push({ channel: `search:${threadId}`, error: msg })
        err(`search index ${threadId}: FAILED — ${msg}`)
      }
    }
    report.search = search
    err(
      `search: ${search.messages} messages + ${search.windows} windows in ${search.threads} channels`,
    )
  }

  report.ok = report.errors.length === 0
  return { exitCode: report.ok ? 0 : 1, report }

  // ───────────────────────────────────────────────────────────────────────
  /** Reply-thread followers per channel thread. */
  async function followerCounts(threadIds: string[]): Promise<Map<string, number>> {
    if (threadIds.length === 0) return new Map()
    return new Map(
      extractRows<{ thread_id: string; n: number }>(
        await withPrivilegedDb(orgId, "cli-slack-import-followers", (tx) =>
          tx.execute(drizzleSql`
            SELECT thread_id::text AS thread_id, count(*)::int AS n
            FROM ${kernelRel("reply_thread_followers")}
            WHERE org_id = ${orgId}::uuid
              AND thread_id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(threadIds)}::jsonb))
            GROUP BY thread_id
          `),
        ),
      ).map((r) => [r.thread_id, r.n]),
    )
  }

  /** One channel's messages as `chat.message` records, in ts order (a root before its replies). */
  async function* channelRecords(channel: SlackChannel): AsyncGenerator<Record<string, unknown>> {
    const summary = summaries.get(channel.name) as ChannelSummary
    const threadId = threadIdByChannelId.get(channel.id) as string

    // Load every day file, in ts order: a root always precedes its replies.
    const messages = await loadChannelMessages(
      opts.exportDir,
      channel.name,
      () => {
        report.unparseableMessages += 1
      },
      () => {
        report.channelsWithoutFolder.push(channel.name)
      },
    )
    const rootsWithReplies = new Set(
      messages.filter(isSlackReply).map((m) => m.thread_ts as string),
    )
    const pinnedTs = new Set((channel.pins ?? []).map((p) => p.id))

    // Already imported messages (by this tool before, or an earlier run):
    // their ts, so a reply in a later run still finds its root.
    const knownTs = new Map<string, string>()
    if (!summary.threadCreated) {
      for (const r of extractRows<{ ts: string }>(
        await withPrivilegedDb(orgId, "cli-slack-import-ts-lookup", (tx) =>
          tx.execute(drizzleSql`
            SELECT metadata->'slack'->>'ts' AS ts FROM ${kernelRel("messages")}
            WHERE org_id = ${orgId}::uuid AND thread_id = ${threadId}::uuid
              AND metadata->'slack'->>'ts' IS NOT NULL
          `),
        ),
      )) {
        knownTs.set(r.ts, r.ts)
      }
    }
    const alreadyImported = new Set(knownTs.keys())

    // Select what this run imports.
    const todo: SlackMessage[] = []
    for (const m of messages) {
      const deletedRoot = m.subtype === "tombstone" && rootsWithReplies.has(m.ts)
      if (shouldSkipMessage(m) && !deletedRoot) {
        summary.messagesSkipped += 1
        continue
      }
      if (alreadyImported.has(m.ts)) {
        summary.messagesAlreadyImported += 1
        continue
      }
      if (opts.limit && todo.length >= opts.limit) break
      todo.push(m)
    }

    // Files: download concurrently into the cache before the records.
    const cacheDir = opts.filesCacheDir ?? (await mkdtempCache())
    const downloadable: SlackFile[] = []
    if (!opts.skipFiles) {
      for (const m of todo) {
        for (const f of m.files ?? []) {
          const url = f.url_private_download || f.url_private
          if (
            isSlackHosted(url) &&
            f.mode !== "tombstone" &&
            (f.size ?? 0) <= maxFileBytes &&
            cachePathFor(cacheDir, f.id)
          ) {
            downloadable.push(f)
          }
        }
      }
    }
    const downloaded = new Map<string, number>() // file id → bytes on disk
    const failedDownloads = new Set<string>()
    if (!dryRun && downloadable.length) {
      const unique = [...new Map(downloadable.map((f) => [f.id, f])).values()]
      await runPool(unique, opts.downloadConcurrency ?? 8, async (f) => {
        const cachePath = cachePathFor(cacheDir, f.id)
        if (!cachePath) {
          failedDownloads.add(f.id)
          return
        }
        const cached = await stat(cachePath).catch(() => null)
        if (cached && (f.size == null || cached.size === f.size)) {
          downloaded.set(f.id, cached.size)
          return
        }
        try {
          const dl = await downloadWithRetry(
            (f.url_private_download || f.url_private) as string,
            cachePath,
            downloadFile,
            f.id,
            maxFileBytes,
          )
          downloaded.set(f.id, dl.bytes)
          summary.filesDownloaded += 1
          summary.bytesDownloaded += dl.bytes
        } catch {
          failedDownloads.add(f.id)
        }
      })
    }

    for (const m of todo) {
      const isSystem = !!m.subtype && SYSTEM_SUBTYPES.has(m.subtype)
      const isBot = isBotPost(m)
      const deletedRoot = m.subtype === "tombstone"

      let authorId: string
      let system = false
      if (isSystem || deletedRoot) {
        authorId = m.user ? await userIdFor(m.user) : systemUserId
        if (isSystem) system = true
      } else if (m.user) {
        authorId = await userIdFor(m.user)
      } else if (isBot) {
        authorId = await botUserIdFor(m)
      } else {
        authorId = systemUserId
        system = true
      }

      let content = isSystem
        ? systemSubtypeContent(m)
        : deletedRoot
          ? "_This message was deleted._"
          : messageToMarkdown(m, resolveUserName, refs)

      const placement = replyPlacement(m, knownTs)
      if (placement.orphan) summary.orphanReplies += 1

      // Files: downloaded ones become attachments, the rest a note.
      const attachments: Array<{ filePath: string; filename: string; mimeType: string }> = []
      for (const f of m.files ?? []) {
        const label = f.title || f.name || f.id
        const url = f.url_private_download || f.url_private
        if (opts.skipFiles) {
          content += `\n\n_[file omitted: ${label}]_`
          continue
        }
        if (f.mode === "tombstone" || f.mode === "hidden_by_limit" || !url) {
          content += `\n\n_[file deleted in Slack: ${label}]_`
          continue
        }
        if (!isSlackHosted(url)) {
          content += `\n\n📎 [${label}](${f.permalink ?? url})`
          continue
        }
        if ((f.size ?? 0) > maxFileBytes) {
          summary.filesTooLarge += 1
          content += `\n\n_[file too large to import: ${label} (${Math.round((f.size ?? 0) / 1048576)} MB)]_`
          continue
        }
        if (dryRun) continue
        const cachePath = cachePathFor(cacheDir, f.id)
        if (!cachePath || failedDownloads.has(f.id) || !downloaded.has(f.id)) {
          summary.filesFailed += 1
          content += `\n\n_[file unavailable: ${label}]_`
          continue
        }
        attachments.push({
          filePath: cachePath,
          filename: (f.name || label).replaceAll("\u0000", ""),
          mimeType: f.mimetype || "application/octet-stream",
        })
      }

      const reactions: Array<{ emoji: string; userEmails: string[] }> = []
      for (const r of m.reactions ?? []) {
        const emails: string[] = []
        for (const reactor of new Set(r.users)) emails.push(emailOf(await userIdFor(reactor)))
        reactions.push({ emoji: slackReactionToEmoji(r.name), userEmails: emails.filter(Boolean) })
      }

      if (!isSlackReply(m)) knownTs.set(m.ts, m.ts)
      yield {
        externalRef: m.ts,
        threadRef: channel.name,
        authorEmail: emailOf(authorId),
        ...(isBot
          ? { botKey: botKey(m).key, authorName: m.username || m.bot_profile?.name || "Slack bot" }
          : {}),
        ...(system ? { system: true } : {}),
        content: content.replaceAll("\u0000", ""),
        createdAt: slackTsToDate(m.ts).toISOString(),
        ...(placement.replyRootId ? { replyToRef: m.thread_ts as string } : {}),
        ...(placement.alsoInChannel ? { alsoInChannel: true } : {}),
        ...(m.edited?.ts ? { editedAt: slackTsToDate(m.edited.ts).toISOString() } : {}),
        ...(deletedRoot ? { deleted: true } : {}),
        ...(reactions.length ? { reactions } : {}),
        ...(attachments.length ? { attachments } : {}),
        metadata: {
          channel: channel.name,
          ts: m.ts,
          ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}),
          ...(m.user ? { user: m.user } : {}),
          ...(m.bot_id ? { bot_id: m.bot_id } : {}),
          ...(m.subtype ? { subtype: m.subtype } : {}),
          ...(pinnedTs.has(m.ts) ? { pinned: true } : {}),
          ...(placement.orphan ? { orphan_reply: true } : {}),
        },
      }
    }
  }
}

/** A bot or app post (no human author). */
export function isBotPost(m: Pick<SlackMessage, "subtype" | "bot_id" | "user">): boolean {
  return m.subtype === "bot_message" || (!!m.bot_id && !m.user)
}

/**
 * The placeholder identity of a bot post that users.json does not describe:
 * one per (bot id, display name), since one integration (a webhook, a test
 * runner) often posts under several names.
 */
export function botKey(m: Pick<SlackMessage, "bot_id" | "username" | "bot_profile">): {
  key: string
  label: string
} {
  const label = m.username || m.bot_profile?.name || m.bot_id || "Slack bot"
  return { key: `@bot:${m.bot_id ?? "none"}:${label}`, label }
}

/**
 * The channel's folder in the export (`<export>/<channel name>`). The name comes
 * from the export's channels.json, data written outside the company: one that
 * is not a single folder name directly inside the export (a separator, `.`,
 * `..`, NUL) gets no folder, so it can never read files outside the export.
 */
function channelDirFor(exportDir: string, channelName: string): string | null {
  if (
    channelName === "" ||
    channelName === "." ||
    channelName === ".." ||
    /[/\\]/.test(channelName) ||
    channelName.includes("\0")
  ) {
    return null
  }
  const root = resolve(exportDir)
  const dir = resolve(root, channelName)
  return dirname(dir) === root ? dir : null
}

/** Every message of one channel folder, parsed and in ts order. */
async function loadChannelMessages(
  exportDir: string,
  channelName: string,
  onUnparseable?: () => void,
  onMissingFolder?: () => void,
): Promise<SlackMessage[]> {
  const channelDir = channelDirFor(exportDir, channelName)
  if (!channelDir) {
    onMissingFolder?.()
    return []
  }
  let dayFiles: string[] = []
  try {
    dayFiles = (await readdir(channelDir)).filter((f) => f.endsWith(".json")).sort()
  } catch {
    onMissingFolder?.()
    return []
  }
  const messages: SlackMessage[] = []
  for (const dayFile of dayFiles) {
    const raw = JSON.parse(await readFile(join(channelDir, dayFile), "utf8")) as unknown[]
    for (const r of raw) {
      const parsed = slackMessageSchema.safeParse(r)
      if (parsed.success) messages.push(parsed.data)
      else onUnparseable?.()
    }
  }
  messages.sort((a, b) => compareSlackTs(a.ts, b.ts))
  return messages
}

// ─────────────────────────────────────────────────────────────────────────
// tmp cache dir fallback when --files-cache is not supplied
// ─────────────────────────────────────────────────────────────────────────

let _fallbackCacheDir: string | null = null
async function mkdtempCache(): Promise<string> {
  if (_fallbackCacheDir) return _fallbackCacheDir
  const { mkdtemp } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  _fallbackCacheDir = await mkdtemp(join(tmpdir(), "slack-import-"))
  return _fallbackCacheDir
}
