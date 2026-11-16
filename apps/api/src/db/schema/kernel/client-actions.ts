// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { companies } from "./companies"
import { contacts } from "./contacts"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

export const CLIENT_ACTION_KINDS = ["sign", "accept", "approve"] as const
export const CLIENT_ACTION_DECISIONS = ["signed", "accepted", "approved", "declined"] as const
export const CLIENT_ACTION_REVOKE_REASONS = [
  "withdrawn",
  "replaced",
  "access_ended",
  "person_removed",
  "sender_voided",
] as const
export const CLIENT_ACTION_EVENTS = [
  "created",
  "sent",
  "reminded",
  "rotated",
  "link_loaded",
  "opened",
  "document_shown",
  "document_downloaded",
  "reached_end",
  "code_sent",
  "code_ok",
  "code_wrong",
  "paused",
  "locked",
  "decided",
  "declined",
  "revoked",
  "expired",
  "copy_resent",
  "not_me",
  "new_link_asked",
  "invite_asked",
  "question_asked",
] as const
export const CLIENT_ACTION_ACTOR_KINDS = [
  "holder",
  "portal_user",
  "staff",
  "agent",
  "system",
] as const

/**
 * kernel.client_actions (migration 0329): one request to a person outside the
 * org to sign, accept or approve one target. Members read it with
 * kernel:client_actions:read, never its two token hash columns (the request role
 * has no column right on them); a restricted document's action only by the
 * people in `visibleTo`. Written only by the privileged path. Its state is
 * derived, never stored (`clientActionState`).
 */
export const clientActions = kernel.table(
  "client_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The signers of one version share it. */
    groupId: uuid("group_id").notNull(),
    kind: text("kind", { enum: CLIENT_ACTION_KINDS }).notNull(),
    targetApp: text("target_app").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    /** The target's hash when the action was made; checked again at decide. */
    targetSha256: text("target_sha256").notNull(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    /** Set when the invited person is staff of this org. */
    signerUserId: uuid("signer_user_id"),
    invitedEmail: text("invited_email").notNull(),
    invitedName: text("invited_name").notNull(),
    /** Null: any order. */
    signOrder: integer("sign_order"),
    /** Null until the person's turn. */
    tokenHash: text("token_hash"),
    /** Earlier tokens after a rotation: they open only the replaced page. */
    priorTokenHashes: text("prior_token_hashes").array().notNull().default(sql`'{}'::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }),
    documentShownAt: timestamp("document_shown_at", { withTimezone: true }),
    codeWrongTotal: integer("code_wrong_total").notNull().default(0),
    codeLockedAt: timestamp("code_locked_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decision: text("decision", { enum: CLIENT_ACTION_DECISIONS }),
    decidedVia: text("decided_via", { enum: ["link", "portal"] }),
    decidedUserId: uuid("decided_user_id"),
    codeVerifiedAt: timestamp("code_verified_at", { withTimezone: true }),
    typedName: text("typed_name"),
    capacity: text("capacity"),
    wordsShown: text("words_shown"),
    wordsKey: text("words_key"),
    wordsLang: text("words_lang"),
    requiredPhrase: text("required_phrase"),
    typedPhrase: text("typed_phrase"),
    /** Null: as the target. Set: only these people read the action. */
    visibleTo: uuid("visible_to").array(),
    /** Client text: fenced wherever it is read. */
    declineReason: text("decline_reason"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    revokeReason: text("revoke_reason", { enum: CLIENT_ACTION_REVOKE_REASONS }),
    createdByUserId: uuid("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("client_actions_token_hash_key").on(t.tokenHash).where(sql`token_hash IS NOT NULL`),
    index("client_actions_prior_token_hashes_idx").using("gin", t.priorTokenHashes),
    index("client_actions_target_idx").on(t.orgId, t.targetApp, t.targetType, t.targetId),
    index("client_actions_open_company_idx")
      .on(t.orgId, t.companyId)
      .where(sql`decided_at IS NULL AND revoked_at IS NULL`),
    index("client_actions_invited_email_idx").on(t.orgId, t.invitedEmail),
    index("client_actions_group_idx").on(t.orgId, t.groupId),
  ],
)

/**
 * kernel.client_action_events (migration 0329): a client action's trail, append
 * only (immutable trigger, one year). `meta` never holds a token, a code or a
 * proof. The address and browser an event came from live in
 * kernel.client_action_devices.
 */
export const clientActionEvents = kernel.table(
  "client_action_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actionId: uuid("action_id")
      .notNull()
      .references(() => clientActions.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    event: text("event", { enum: CLIENT_ACTION_EVENTS }).notNull(),
    actorKind: text("actor_kind", { enum: CLIENT_ACTION_ACTOR_KINDS }).notNull(),
    actorUserId: uuid("actor_user_id"),
    mailId: text("mail_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index("client_action_events_action_idx").on(t.actionId, t.at),
    index("client_action_events_mail_idx").on(t.orgId, t.mailId).where(sql`mail_id IS NOT NULL`),
    index("client_action_events_retention_idx").on(t.orgId, t.at),
  ],
)

/** kernel.client_action_devices (migration 0329): read only with kernel:portal:logs. */
export const clientActionDevices = kernel.table("client_action_devices", {
  eventId: uuid("event_id")
    .primaryKey()
    .references(() => clientActionEvents.id, { onDelete: "cascade" }),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  ip: text("ip"),
  userAgent: text("user_agent"),
})

/** Every kind a share can open. Nothing else can ever be shown to a client. */
export const PORTAL_SHARE_KINDS = [
  "project_progress",
  "project_reports",
  "project_hours",
  "invoices",
  "requests",
  "agreement",
  "change_request",
  "file",
  "ticket",
] as const
export type PortalShareKind = (typeof PORTAL_SHARE_KINDS)[number]

/**
 * kernel.portal_shares (migration 0329): what a client company may see, closed
 * unless a row is open. Read with kernel:portal:admin or kernel:portal:share;
 * written only by the privileged path.
 */
export const portalShares = kernel.table(
  "portal_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: PORTAL_SHARE_KINDS }).notNull(),
    /** Null for the company-wide kinds only. */
    objectId: uuid("object_id"),
    sharedByUserId: uuid("shared_by_user_id").notNull(),
    sharedAt: timestamp("shared_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null: the whole company. Otherwise only these portal people. */
    onlyUserIds: uuid("only_user_ids").array(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: uuid("closed_by_user_id"),
  },
  (t) => [
    // NULLS NOT DISTINCT in the migration: one open company-wide share per kind too.
    uniqueIndex("portal_shares_open_key")
      .on(t.companyId, t.kind, t.objectId)
      .where(sql`closed_at IS NULL`),
    index("portal_shares_org_company_idx").on(t.orgId, t.companyId),
  ],
)

/**
 * kernel.portal_people (migration 0329): one row per client who signs in to the
 * portal, linking the external user to its contact. Read with kernel:portal:admin.
 */
export const portalPeople = kernel.table(
  "portal_people",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    contactId: uuid("contact_id").notNull(),
    title: text("title"),
    invitedByUserId: uuid("invited_by_user_id"),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    noticeAckAt: timestamp("notice_ack_at", { withTimezone: true }),
    noticeVersion: integer("notice_version"),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    /** After a company merge: the shares and contacts this person still sees. */
    seesOnlyShareIds: uuid("sees_only_share_ids").array(),
    seesOnlyContactIds: uuid("sees_only_contact_ids").array(),
  },
  (t) => [
    uniqueIndex("portal_people_contact_key")
      .on(t.orgId, t.contactId)
      .where(sql`removed_at IS NULL`),
    index("portal_people_company_idx").on(t.orgId, t.companyId),
  ],
)

export type ClientAction = typeof clientActions.$inferSelect
export type PortalShare = typeof portalShares.$inferSelect
export type PortalPerson = typeof portalPeople.$inferSelect
