// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { boolean, check, index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/** The two stores a wrapped mobile build can be delivered through. */
export const pushPlatformEnum = kernel.enum("push_platform", ["ios", "android"])

/** The APNs host a token belongs to (S11). FCM tokens carry `production`. */
export const PUSH_ENVIRONMENTS = ["sandbox", "production"] as const
export type PushEnvironment = (typeof PUSH_ENVIRONMENTS)[number]

/**
 * One registered device token per (user, platform, token).
 *
 * A device token is the ADDRESS of one person's phone, so the row is owned by
 * the user, not by the org: RLS is ownership (0088), which is narrower than
 * every other kernel table's membership rule and deliberately so. The push
 * fanout worker reads across users, and it does that privileged, the way every
 * other background reader in the tree does.
 *
 * `lastSeenAt` is what the registration route touches on a repeat POST, so a
 * client that re-registers the same token on every launch (the Capacitor
 * default) writes one row forever instead of accumulating one per launch, and
 * a token nothing has refreshed in months is identifiable as stale.
 *
 * `environment` is the APNs host the token was issued for (S11): an Xcode build
 * holds a sandbox token, a TestFlight or App Store build a production one. The
 * sender picks the host per row and rewrites the row when the other host is
 * the one that accepts it (0107).
 */
export const pushTokens = kernel.table(
  "push_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: pushPlatformEnum("platform").notNull(),
    token: text("token").notNull(),
    environment: text("environment", { enum: PUSH_ENVIRONMENTS }).notNull().default("production"),
    /** The app knows several servers: its pushes name their organisation (0158). */
    multiServer: boolean("multi_server").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("push_tokens_user_platform_token_idx").on(t.userId, t.platform, t.token),
    index("push_tokens_org_user_idx").on(t.orgId, t.userId),
    check("push_tokens_environment_check", sql`${t.environment} IN ('sandbox', 'production')`),
  ],
)

export type PushToken = typeof pushTokens.$inferSelect
export type NewPushToken = typeof pushTokens.$inferInsert
