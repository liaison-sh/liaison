// SPDX-License-Identifier: FSL-1.1-ALv2
import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { threads } from "~/db/schema/kernel/threads"
import { appMcpManager, mcpConnections } from "./connections"

// Bound to appMcpManager (see comment in connections.ts).
export const mcpSubscriberActorTypeEnum = appMcpManager.enum("mcp_subscriber_actor_type", [
  "user",
  "agent",
])

export const mcpResourceSubscription = appMcpManager.table(
  "mcp_resource_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    resourceUri: text("resource_uri").notNull(),
    subscriberActorId: uuid("subscriber_actor_id").notNull(),
    subscriberActorType: mcpSubscriberActorTypeEnum("subscriber_actor_type").notNull(),
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_mcp_resource_subscription_unique").on(
      t.connectionId,
      t.resourceUri,
      t.subscriberActorId,
      t.subscriberActorType,
    ),
  ],
)
