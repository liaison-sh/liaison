// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { kernel } from "./organizations"

export const deviceFlowStateEnum = kernel.enum("device_flow_state", [
  "pending",
  "approved",
  "denied",
  "expired",
])

export const deviceFlowRequests = kernel.table(
  "device_flow_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    deviceCode: text("device_code").notNull().unique(),
    userCode: text("user_code").notNull(),
    clientId: text("client_id").notNull(),
    state: deviceFlowStateEnum("state").notNull().default("pending"),
    userId: uuid("user_id"),
    scopes: text("scopes"),
    // Shown to the approver. deviceLabel is declared by the client (unverified);
    // requestIp is the address the initiate request actually came from.
    deviceLabel: text("device_label"),
    requestIp: text("request_ip"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("device_flow_user_code_idx").on(table.userCode),
    // A user_code is the human-typed handle the approver enters; a collision
    // among concurrently-pending requests would let an approver bind a session
    // to the wrong device request (cross-account grant). Enforce uniqueness of
    // user_code among PENDING requests only — once a request is approved/denied/
    // expired its code is free to be reused. Generation retries on the resulting
    // 23505 (see device-flow-routes initiate).
    uniqueIndex("device_flow_pending_user_code_uq")
      .on(table.userCode)
      .where(sql`${table.state} = 'pending'`),
  ],
)
