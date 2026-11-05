// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

import { reasoningLevelSchema } from "../reasoning"

/**
 * Team thread messages routinely carry pasted agent transcripts, tool output
 * and logs; a chat-sized cap made those sends fail silently. The column is
 * unbounded text, so this only bounds request bodies.
 */
export const THREAD_MESSAGE_MAX_CHARS = 100_000

/** The longest excerpt a quote may carry; a client cuts longer ones with "…". */
export const QUOTE_EXCERPT_MAX_CHARS = 500

/**
 * A channel's display name: leading `#` characters and the whitespace around
 * the name are dropped, inner whitespace is kept ("#general" -> "general",
 * " ## a b " -> "a b"). The `#` is how a channel is written, not part of its
 * name. The text is NFKC normalised first, so a fullwidth `＃` is a `#`, and
 * invisible format marks (zero-width spaces, bidi marks) at either end go with
 * the whitespace: "\u200B#general" is "general", not a channel that looks
 * like "#general" beside the real one. Inner ones stay (an emoji's joiner).
 * Idempotent. The server applies it to channels on create and rename (not to
 * an agent chat's title); the web dialog shows the same result as a preview.
 */
export function normalizeChannelTitle(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/^[\s#\p{Cf}]+/u, "")
    .replace(/[\s\p{Cf}]+$/u, "")
}

/** The wire form of a thread title. Whether it is a channel name (normalised,
 *  refused when it collapses to nothing) is the server's to decide: it knows
 *  the room's type. An empty string stays empty (untitled). */
const channelTitleSchema = z.string().max(200)

export const createThreadSchema = z
  .object({
    title: channelTitleSchema.optional(),
    /** The OTHER people to seat. May be empty for a channel: a channel is
     *  created by one member and joined by the rest, so nobody else has to be
     *  named up front. A DM (untitled) needs at least one counterpart. */
    participantIds: z.array(z.string().uuid()).max(100),
    isPinned: z.boolean().optional(),
    /** A35: a public channel, one any member of the workspace can find and
     *  join. Only a TITLED room may carry it (see the refine below). */
    discoverable: z.boolean().optional(),
    type: z.enum(["thread", "agent_chat"]).default("thread").optional(),
    /** Override the duplicate-thread guard: create a second plain thread for
     *  participants who already have one. */
    forceCreate: z.boolean().optional(),
    createdFrom: z
      .object({
        app: z.string().min(1),
        entityType: z.string().min(1),
        entityId: z.string().min(1),
      })
      .optional(),
    references: z
      .array(
        z.object({
          app: z.string().min(1),
          entityType: z.string().min(1),
          entityId: z.string().min(1),
        }),
      )
      .max(100)
      .optional(),
    initialMessage: z
      .object({
        content: z.string().min(1).max(THREAD_MESSAGE_MAX_CHARS),
      })
      .optional(),
  })
  // A35: a channel is a TITLED room. `discoverable` on an untitled thread would
  // publish a DM to the whole workspace, so it is refused at the edge rather
  // than silently dropped.
  .refine((v) => !v.discoverable || !!v.title?.trim(), {
    message: "Only a titled channel can be discoverable",
    path: ["discoverable"],
  })
  // An untitled room is a DM, and a DM with nobody in it is not a conversation.
  .refine((v) => v.participantIds.length > 0 || !!v.title?.trim(), {
    message: "A direct message needs at least one participant",
    path: ["participantIds"],
  })

export const sendMessageSchema = z
  .object({
    // Attachment-only sends are supported, so content can be empty when at
    // least one staged file is present on `attachmentSessionId`.
    content: z.string().max(THREAD_MESSAGE_MAX_CHARS).default(""),
    correlationId: z.string().max(100).optional(),
    attachmentSessionId: z.string().min(1).optional(),
    /**
     * The message this one is nested under (P3b). Absent, the normal case, is
     * a post flattened to the thread root. A nested post names a message of the
     * SAME thread; anything else is refused.
     */
    parentMessageId: z.string().uuid().optional(),
    /**
     * The ROOT of the reply thread this message is posted into. Absent is a
     * channel message. The root must be a message of the same thread that is
     * neither a reply itself nor deleted.
     */
    replyRootId: z.string().uuid().optional(),
    /** "Also send to channel": the reply shows in the channel list too. Only
     *  meaningful with `replyRootId`. */
    alsoSendToChannel: z.boolean().optional(),
    /**
     * Quote an excerpt of another message of the SAME thread. The server
     * checks the excerpt against that message (whitespace-normalised; a
     * trailing ellipsis from a client-side cut is allowed), names its author
     * itself, and stores the result as `metadata.quote`.
     */
    quote: z
      .object({
        messageId: z.string().uuid(),
        excerpt: z.string().trim().min(1).max(QUOTE_EXCERPT_MAX_CHARS),
      })
      .optional(),
  })
  .refine((v) => (v.content && v.content.length > 0) || !!v.attachmentSessionId, {
    message: "Message must have text or an attachment session",
    path: ["content"],
  })
  .refine((v) => !v.alsoSendToChannel || !!v.replyRootId, {
    message: "alsoSendToChannel needs a replyRootId",
    path: ["alsoSendToChannel"],
  })

/**
 * WHERE THE HUMAN SENDING AN AGENT MESSAGE IS: the desktop app, a web browser
 * or the mobile app. A server turn has no shell on the person's computer, and
 * how the person reaches one (computer mode) depends on this, so the agent is
 * told which steps to give. Absent means unknown: routines, agents_ask, email
 * and other channels, and clients older than the field.
 */
export const clientSurfaceSchema = z.enum(["desktop", "web", "mobile"])
export type ClientSurface = z.infer<typeof clientSurfaceSchema>

export const editMessageSchema = z.object({
  content: z.string().min(1).max(THREAD_MESSAGE_MAX_CHARS),
})

export const updateThreadSchema = z.object({
  title: channelTitleSchema.optional(),
  isPinned: z.boolean().optional(),
  /**
   * A35: promote a titled room to a PUBLIC channel (`true`) or return it to a
   * private one (`false`). Whether the row is titled is a database fact, so the
   * "channels only" half of the rule is enforced in `updateThread`, which has
   * the row in hand; a DM is refused there with `discoverable_requires_title`.
   */
  discoverable: z.boolean().optional(),
  /**
   * The Slack/Buzz pair, editable by any member who may rename the room.
   *
   * `topic` is the one line beside the channel name, `description` the standing
   * few sentences in the channel details. Both NULLABLE on the wire, and that
   * is the clear: a member who empties the field sends `null` and the header
   * goes back to rendering nothing, which omitting the key (leave unchanged)
   * could never express.
   *
   * Whether the row is a titled channel is a database fact, so the "channels
   * only" half of the rule is enforced in `updateThread`, which has the row in
   * hand; a DM is refused there with `channel_details_require_title`.
   */
  topic: z.string().max(250).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  type: z.enum(["thread", "agent_chat"]).optional(),
  agentModelId: z.string().max(200).nullable().optional(),
  // Per-model reasoning level map; values constrained to the level vocabulary.
  agentReasoningLevels: z.record(z.string(), reasoningLevelSchema).optional(),
  // Promote (false) or demote (true) the thread in the global thread list.
  // Used by entity-embedded threads (task discussion etc.).
  hiddenFromList: z.boolean().optional(),
})

/** Longest reaction emoji accepted, in UTF-16 units (S17). */
export const REACTION_EMOJI_MAX_UNITS = 32

// One RGI emoji and nothing else: skin-tone, keycap, flag and ZWJ sequences
// are single RGI emoji. The `v` flag's \p{RGI_Emoji} is built at runtime so an
// engine without it (older browsers) falls back to an equivalent pattern
// rather than failing to parse the module (A14).
const RGI_EMOJI_RE: RegExp = (() => {
  try {
    // biome-ignore lint/complexity/useRegexLiterals: a /v literal is a parse error where the flag is missing
    return new RegExp("^\\p{RGI_Emoji}$", "v")
  } catch {
    return /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F\u20E3|\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*|\p{Extended_Pictographic}[\u{E0020}-\u{E007F}]+)$/u
  }
})()

/** True when `value` is a single emoji a reaction may carry (S17). */
export function isReactionEmoji(value: string): boolean {
  return value.length >= 1 && value.length <= REACTION_EMOJI_MAX_UNITS && RGI_EMOJI_RE.test(value)
}

export const reactionEmojiSchema = z
  .string()
  .min(1)
  .max(REACTION_EMOJI_MAX_UNITS)
  .refine(isReactionEmoji, { message: "Must be a single emoji" })

export const addReactionSchema = z.object({
  emoji: reactionEmojiSchema,
})

/**
 * One seat, of either kind. A human seat names `userId`; an AGENT seat names
 * `agentId`, the shape `thread_participants` already stores
 * (`participantType: 'agent'`). The agent page's "Add to channel" used to post
 * the AGENT's id under `userId`, which the route resolved as a user and
 * refused with 404.
 */
export const addParticipantSchema = z
  .object({
    userId: z.string().uuid().optional(),
    agentId: z.string().uuid().optional(),
  })
  .refine((v) => (v.userId === undefined) !== (v.agentId === undefined), {
    message: "name exactly one of userId or agentId",
  })

export const addReferenceSchema = z.object({
  app: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
})

export const listReferencesResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      app: z.string(),
      entityType: z.string(),
      entityId: z.string(),
      tabType: z.string(),
      label: z.string(),
      icon: z.string(),
      lastVisitedAt: z.string(),
    }),
  ),
})

export type ListReferencesResponse = z.infer<typeof listReferencesResponseSchema>

export const updateThreadStateSchema = z.object({
  isArchived: z.boolean().optional(),
  isMuted: z.boolean().optional(),
  isPinned: z.boolean().optional(),
  /** Be interrupted by every post of this channel, not only by mentions. */
  notifyAllPosts: z.boolean().optional(),
})

export const markReadSchema = z.object({
  lastReadMessageId: z.string().uuid().optional(),
})

/** One reply thread in the caller's followed list (`GET /threads/followed-replies`). */
export interface FollowedReplyThread {
  rootMessage: {
    id: string
    threadId: string
    authorId: string
    authorName: string | null
    authorAvatarUrl: string | null
    authorType: string
    authorAgentId: string | null
    /** Null once the root is deleted. */
    content: string | null
    createdAt: string
    deletedAt: string | null
  }
  channel: { id: string; name: string | null }
  replyCount: number
  lastReplyAt: string
  unreadCount: number
}

/** The quote a message carries, as the server stored it in `metadata.quote`. */
export interface MessageQuote {
  messageId: string
  excerpt: string
  authorName: string
  /** The quoted message's reply root, when the quoted message is a reply. */
  replyRootId: string | null
}

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(20).default(5),
})

export const mentionQuerySchema = z.object({
  // `q` may be empty: the bare-`@` trigger fires before the user types,
  // and the popup needs a starter list of top mentionables so the user
  // sees feedback that the trigger worked (Linear/Slack pattern).
  q: z.string().max(100).default(""),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  // "addressable" is the `@` trigger's narrowing: the org's members, the only
  // thing a message ADDRESSES that the server searches (agents come from the
  // client's agent directory). "reference" is `#`'s: everything else, i.e.
  // channels, contacts, approval requests and app records. The two are
  // disjoint.
  type: z.enum(["user", "thread", "entity", "addressable", "reference"]).optional(),
})

const dimensionFiltersSchema = z.preprocess(
  (raw) => {
    if (!raw) return {}
    let parsed: unknown
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw)
      } catch {
        // Malformed JSON in the query param — treat as empty filters rather
        // than letting JSON.parse throw a 500 up to the caller.
        return {}
      }
    } else {
      parsed = raw
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [
        k,
        Array.isArray(v) ? v.map(String) : [String(v)],
      ]),
    )
  },
  z.record(z.string(), z.array(z.string()).max(20)),
)

export const searchPageQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  app: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
    ),
  entityType: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? s
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
    ),
  filters: dimensionFiltersSchema.default({}),
})

export type CreateThread = z.infer<typeof createThreadSchema>
export type SendMessage = z.infer<typeof sendMessageSchema>
export type EditMessage = z.infer<typeof editMessageSchema>
export type UpdateThread = z.infer<typeof updateThreadSchema>
export type AddReaction = z.infer<typeof addReactionSchema>
export type AddParticipant = z.infer<typeof addParticipantSchema>
export type AddReference = z.infer<typeof addReferenceSchema>
export type UpdateThreadState = z.infer<typeof updateThreadStateSchema>
export type MarkRead = z.infer<typeof markReadSchema>
export type SearchQuery = z.infer<typeof searchQuerySchema>
export type MentionQuery = z.infer<typeof mentionQuerySchema>
export type SearchPageQuery = z.infer<typeof searchPageQuerySchema>
