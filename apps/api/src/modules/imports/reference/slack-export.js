// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reference transform: a standard Slack export (the zip a workspace admin
// downloads) into chat.thread (channels) and chat.message (their history).
//
// Input (uploads): the zip, read entry by entry. Its directories come first,
// then one folder per channel holding one JSON file per day:
//   users.json      [{id, name, real_name, deleted, is_bot, profile: {email, real_name, display_name}}]
//   channels.json   public channels  [{id, name, created, creator, is_archived, members, topic: {value}, purpose: {value}}]
//   groups.json     private channels (same shape), when the export has them
//   <channel>/<YYYY-MM-DD>.json   that day's messages [{ts, user, text, thread_ts, subtype, ...}]
// Preview and start it with file rules that read the directories first:
//   files: [{ match: "users.json" }, { match: "channels.json" }, { match: "groups.json" }, { match: "*/*.json" }]
// Folders that are no known channel (direct messages, group DMs) are skipped.
//
// Each channel keeps its name, topic, purpose, creation date, creator and the
// members with an email; an archived channel stays archived, a private one
// private. Each message keeps its time (Slack's `ts`, also its dedup key) and
// author: a person by the email of their Slack profile, a bot by its bot id
// (a deactivated placeholder with `placeholders: true`). A reply names its
// thread's root (`thread_ts`); "also send to channel" replies stay in the
// channel too. Joins, leaves and topic changes are system messages. Mentions
// and links read as text (`@Name`, `#channel`, `[label](url)`); reactions keep
// their people. Files are not in a Slack export (only links to Slack's
// servers, which need a token), so a message names its files instead.

const SYSTEM = {
  channel_join: true,
  channel_leave: true,
  channel_topic: true,
  channel_purpose: true,
  channel_name: true,
  channel_archive: true,
  channel_unarchive: true,
  pinned_item: true,
  unpinned_item: true,
}

const EMOJI = {
  "+1": "👍",
  thumbsup: "👍",
  "-1": "👎",
  thumbsdown: "👎",
  heart: "❤️",
  smile: "😄",
  slightly_smiling_face: "🙂",
  joy: "😂",
  laughing: "😆",
  tada: "🎉",
  eyes: "👀",
  pray: "🙏",
  fire: "🔥",
  rocket: "🚀",
  100: "💯",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  raised_hands: "🙌",
  clap: "👏",
  thinking_face: "🤔",
  ok_hand: "👌",
  wave: "👋",
  muscle: "💪",
  star: "⭐",
  warning: "⚠️",
  x: "❌",
}

/** A Slack `ts` ("1709287200.000100") as ISO 8601. */
function isoOfTs(ts) {
  return new Date(Math.round(Number(ts) * 1000)).toISOString()
}

/** Seconds since the epoch as ISO 8601, or undefined. */
function isoOfSeconds(s) {
  const n = Number(s)
  return n > 0 ? new Date(n * 1000).toISOString() : undefined
}

function baseName(file) {
  const parts = String(file || "").split("/")
  return parts[parts.length - 1]
}

/** Slack's markup as readable text: mentions, channel links, links, entities. */
function readable(text, users, channels) {
  let out = String(text || "").replace(/<([^<>]+)>/g, (_whole, inner) => {
    const bar = inner.indexOf("|")
    const target = bar >= 0 ? inner.slice(0, bar) : inner
    const label = bar >= 0 ? inner.slice(bar + 1) : ""
    if (target.charAt(0) === "@") {
      const u = users[target.slice(1)]
      return `@${(u?.name) || label || target.slice(1)}`
    }
    if (target.charAt(0) === "#") return `#${label || channels[target.slice(1)] || target.slice(1)}`
    if (target.charAt(0) === "!") {
      const word = target.slice(1).split("^")[0]
      return label || `@${word}`
    }
    return label ? `[${label}](${target})` : target
  })
  out = out.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  return out
}

function emailOf(users, id) {
  const u = id ? users[id] : undefined
  return u?.email ? u.email : undefined
}

function channelRecord(c, users, isPrivate) {
  const memberEmails = []
  const members = c.members || []
  for (let i = 0; i < members.length; i++) {
    const e = emailOf(users, members[i])
    if (e) memberEmails.push(e)
  }
  const record = {
    externalRef: c.name,
    name: c.name,
    archived: c.is_archived === true,
    private: isPrivate,
  }
  const topic = c.topic?.value ? String(c.topic.value).slice(0, 250) : ""
  const purpose = c.purpose?.value ? String(c.purpose.value).slice(0, 2000) : ""
  if (topic) record.topic = topic
  if (purpose) record.description = purpose
  const created = isoOfSeconds(c.created)
  if (created) record.createdAt = created
  const creator = emailOf(users, c.creator)
  if (creator) record.creatorEmail = creator
  if (memberEmails.length > 0) record.memberEmails = memberEmails
  return record
}

function messageRecord(m, channel, users, channels) {
  const record = {
    externalRef: m.ts,
    threadRef: channel,
    content: readable(m.text, users, channels).slice(0, 200000),
    createdAt: isoOfTs(m.ts),
  }
  const author = m.user ? users[m.user] : undefined
  if (m.subtype === "bot_message" || m.bot_id || author?.bot) {
    record.botKey = m.bot_id || m.user || m.username || "bot"
    const name = m.username || m.bot_profile?.name || author?.name
    if (name) record.authorName = String(name).slice(0, 200)
  } else if (author) {
    if (author.email) record.authorEmail = author.email
    if (author.name) record.authorName = author.name.slice(0, 200)
  } else if (m.user_profile?.real_name) {
    record.authorName = String(m.user_profile.real_name).slice(0, 200)
  }
  if (SYSTEM[m.subtype]) record.system = true
  if (m.subtype === "tombstone") record.deleted = true
  if (m.thread_ts && m.thread_ts !== m.ts) {
    record.replyToRef = m.thread_ts
    if (m.subtype === "thread_broadcast") record.alsoInChannel = true
  }
  if (m.edited?.ts) record.editedAt = isoOfTs(m.edited.ts)
  const reactions = []
  const rs = m.reactions || []
  for (let i = 0; i < rs.length; i++) {
    const name = String(rs[i].name || "").split("::")[0]
    if (!name) continue
    const userEmails = []
    const who = rs[i].users || []
    for (let j = 0; j < who.length; j++) {
      const e = emailOf(users, who[j])
      if (e) userEmails.push(e)
    }
    if (userEmails.length > 0) reactions.push({ emoji: EMOJI[name] || `:${name}:`, userEmails })
  }
  if (reactions.length > 0) record.reactions = reactions
  const files = (m.files || []).map((f) => f.name || f.title).filter(Boolean)
  if (files.length > 0) {
    record.content = `${record.content}${record.content ? "\n\n" : ""}Files on Slack, not imported: ${files.join(", ")}`
  }
  record.metadata = { slack: { ts: m.ts, channel: channel } }
  return record
}

async function transform(batch, ctx) {
  const state = batch.state || { users: {}, channels: {}, known: {} }
  const file = baseName(batch.file)
  const folder = String(batch.file || "").indexOf("/") >= 0 ? batch.file.split("/")[0] : null
  if (!folder && file === "users.json") {
    for (let i = 0; i < batch.records.length; i++) {
      const u = batch.records[i]
      const p = u.profile || {}
      state.users[u.id] = {
        email: p.email || "",
        name: p.real_name || u.real_name || p.display_name || u.name || "",
        bot: u.is_bot === true || Boolean(p.bot_id),
      }
    }
    return { state: state }
  }
  if (!folder && (file === "channels.json" || file === "groups.json")) {
    const records = []
    for (let i = 0; i < batch.records.length; i++) {
      const c = batch.records[i]
      if (!c.name) continue
      state.channels[c.id] = c.name
      state.known[c.name] = true
      records.push(channelRecord(c, state.users, file === "groups.json"))
    }
    if (records.length > 0) await ctx.emitRecords("chat.thread", records)
    return { state: state }
  }
  if (folder && state.known[folder]) {
    const records = []
    for (let i = 0; i < batch.records.length; i++) {
      const m = batch.records[i]
      if (m?.ts) records.push(messageRecord(m, folder, state.users, state.channels))
    }
    if (records.length > 0) await ctx.emitRecords("chat.message", records)
  }
  return { state: state }
}
