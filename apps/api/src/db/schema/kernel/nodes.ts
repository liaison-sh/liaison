// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The local node (0127, spec-node.md S19-S25, A17-A27, A50).
 *
 * A node is a desktop install its owner turned into "my node": bound to the
 * realtime deviceId the app announces in its hello (F11), holding a node
 * credential stored hashed (A25). Node jobs are the work the server hands it,
 * fenced by a lease generation (A20). Profiles and attachments are per (node
 * owner, agent).
 */

import {
  AUTONOMY_LEVELS,
  EFFORT_LEVELS,
  FINISH_WITH,
  NODE_CHAT_PERMISSION_MODES,
  NODE_IMPORT_FROM,
  NODE_IMPORT_MODES,
  NODE_LEVELS,
  NODE_SESSION_CONFIG_KINDS,
  NODE_SESSION_EVENT_TYPES,
  NODE_SESSION_SOURCES,
  NODE_SESSION_STATUSES,
  type NodeChatPermissionMode,
  type NodeLevel,
  type NodeSessionAtelierState,
} from "@liaison/shared"
import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

export const NODE_JOB_STATUSES = [
  "queued",
  "offered",
  "running",
  "done",
  "failed",
  "refused",
  "cancelled",
  "fell_back",
  "interrupted",
] as const
export type NodeJobStatus = (typeof NODE_JOB_STATUSES)[number]

export const NODE_JOB_SOURCES = [
  "routine",
  "chat",
  "agent_tag",
  "dispatch",
  "app",
  "import",
] as const
export type NodeJobSource = (typeof NODE_JOB_SOURCES)[number]

export const NODE_RUNS_ON = ["node", "node_else_cloud"] as const
export type NodeRunsOn = (typeof NODE_RUNS_ON)[number]

/** 0159: `follow` only reads a session's transcript and streams it (A45, A53). */
export const NODE_JOB_KINDS = ["unattended", "interactive", "follow"] as const
export type NodeJobKind = (typeof NODE_JOB_KINDS)[number]

/** The permission modes a remotely driven node chat may use (A24: never bypass). */
export const NODE_PERMISSION_MODES = NODE_CHAT_PERMISSION_MODES
export type NodePermissionMode = NodeChatPermissionMode

export const NODE_JOB_RESUME_AFTER = ["offline", "message", "crash", "level"] as const
export type NodeJobResumeAfter = (typeof NODE_JOB_RESUME_AFTER)[number]

export const NODE_LEVEL_CONFIRMATION_PURPOSES = [
  "profile_raise",
  "session_start",
  "session_raise",
] as const
export type NodeLevelConfirmationPurpose = (typeof NODE_LEVEL_CONFIRMATION_PURPOSES)[number]

export const NODE_SESSION_COMMAND_OUTCOMES = ["applied", "noop", "cancelled", "failed"] as const
export type NodeSessionCommandOutcome = (typeof NODE_SESSION_COMMAND_OUTCOMES)[number]

export const nodes = kernel.table(
  "nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    os: text("os"),
    appVersion: text("app_version"),
    credentialHash: text("credential_hash"),
    credentialIssuedAt: timestamp("credential_issued_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    // 0141 (D35, G8): live session caps; background = routine and agent_tag runs.
    maxLiveSessions: integer("max_live_sessions").notNull().default(4),
    maxLiveBackground: integer("max_live_background").notNull().default(2),
    // 0193: a demo org's recorded node (modules/demo/replay): no machine, never
    // a credential (CHECK), only in a demo org and fixed at insert (trigger).
    // Every node-auth path, offer and sweep leaves it out.
    simulated: boolean("simulated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("nodes_owner_device_idx").on(t.ownerUserId, t.deviceId),
    uniqueIndex("nodes_credential_hash_idx")
      .on(t.credentialHash)
      .where(sql`credential_hash IS NOT NULL`),
    index("nodes_org_owner_idx").on(t.orgId, t.ownerUserId),
    uniqueIndex("nodes_id_org_idx").on(t.id, t.orgId),
  ],
)

/** The node's connected intervals (0127 `node_sessions`, renamed by 0140, L1). */
export const nodeConnections = kernel.table(
  "node_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull(),
    connId: text("conn_id").notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    closeReason: text("close_reason", { enum: ["disconnect", "stale", "revoked"] }),
  },
  (t) => [index("node_connections_node_idx").on(t.nodeId, t.connectedAt)],
)

export const nodeJobs = kernel.table(
  "node_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    // 0140 (D32): null only for an app job (`node_jobs_thread_required`).
    threadId: uuid("thread_id"),
    targetNodeId: uuid("target_node_id"),
    nodeId: uuid("node_id"),
    source: text("source", { enum: NODE_JOB_SOURCES }).notNull(),
    sourceRef: text("source_ref"),
    routineId: uuid("routine_id"),
    runsOn: text("runs_on", { enum: NODE_RUNS_ON }).notNull().default("node"),
    // 0130 (S24, A24): an interactive node chat turn, or an unattended job.
    kind: text("kind", { enum: NODE_JOB_KINDS }).notNull().default("unattended"),
    permissionMode: text("permission_mode", { enum: NODE_PERMISSION_MODES }),
    sdkSessionId: text("sdk_session_id"),
    prompt: text("prompt").notNull(),
    trigger: jsonb("trigger"),
    sourceRequiredScopes: jsonb("source_required_scopes").$type<string[]>().notNull().default([]),
    tokenBudget: integer("token_budget"),
    hardTokenLimit: integer("hard_token_limit"),
    requesterUserId: uuid("requester_user_id"),
    requesterAgentId: uuid("requester_agent_id"),
    replyThreadId: uuid("reply_thread_id"),
    replyMessageId: uuid("reply_message_id"),
    status: text("status", { enum: NODE_JOB_STATUSES }).notNull().default("queued"),
    backlog: boolean("backlog").notNull().default(false),
    skippedCount: integer("skipped_count").notNull().default(0),
    leaseHolder: uuid("lease_holder"),
    leaseGeneration: integer("lease_generation").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    mcpConnectionId: uuid("mcp_connection_id"),
    resultMessageId: uuid("result_message_id"),
    resultGeneration: integer("result_generation"),
    resultRequiredScopes: jsonb("result_required_scopes").$type<string[]>(),
    refusals: jsonb("refusals").$type<unknown[]>().notNull().default([]),
    usage: jsonb("usage"),
    error: text("error"),
    errorCode: text("error_code"),
    offeredAt: timestamp("offered_at", { withTimezone: true }),
    // 0141 (D36): a resume run of an existing session, and the message that woke it.
    resumeAfter: text("resume_after", { enum: NODE_JOB_RESUME_AFTER }),
    resumeCommandId: uuid("resume_command_id"),
    /** 0144: the protocol version the claiming node announced. */
    nodeProtocol: integer("node_protocol"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("node_jobs_owner_status_idx").on(t.orgId, t.ownerUserId, t.status, t.createdAt)],
)

export const nodeProfiles = kernel.table(
  "node_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    nodeOwnerUserId: uuid("node_owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    // 0140 (S20, D18): a profile is the level plus Liaison tools, nothing else.
    level: text("level", { enum: NODE_LEVELS }).notNull().default("strict"),
    liaisonTools: boolean("liaison_tools").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("node_profiles_owner_agent_idx").on(t.nodeOwnerUserId, t.agentId)],
)

export const nodeAttachments = kernel.table(
  "node_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    nodeOwnerUserId: uuid("node_owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    nodeId: uuid("node_id"),
    allowedRequesters: jsonb("allowed_requesters").$type<unknown[]>().notNull().default([]),
    maxJobsPerDay: integer("max_jobs_per_day").notNull().default(10),
    maxTokensPerDay: integer("max_tokens_per_day").notNull().default(2_000_000),
    agentAllowedBy: uuid("agent_allowed_by"),
    agentAllowedAt: timestamp("agent_allowed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("node_attachments_owner_agent_idx").on(t.nodeOwnerUserId, t.agentId)],
)

/** A conversation's node runtime for one agent (0130, S24, A24). No row = the cloud. */
export const threadNodeSettings = kernel.table(
  "thread_node_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runsOn: text("runs_on", { enum: NODE_RUNS_ON }).notNull(),
    permissionMode: text("permission_mode", { enum: NODE_PERMISSION_MODES })
      .notNull()
      .default("manual"),
    targetNodeId: uuid("target_node_id"),
    /** 0170: the model the node chat runs on; null, the agent's preference. */
    model: text("model"),
    sdkSessionId: text("sdk_session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("thread_node_settings_thread_agent_idx").on(t.threadId, t.agentId)],
)

export const NODE_PROMPT_STATUSES = ["pending", "allowed", "denied"] as const
export type NodePromptStatus = (typeof NODE_PROMPT_STATUSES)[number]

/** A permission prompt of a remotely driven node chat, relayed to its owner (0130, A24). */
export const nodePermissionPrompts = kernel.table("node_permission_prompts", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  toolName: text("tool_name").notNull(),
  summary: text("summary").notNull(),
  status: text("status", { enum: NODE_PROMPT_STATUSES }).notNull().default("pending"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
})

// ── Node sessions (0140, spec-protocol.md) ───────────────────────────────────

/** One Claude Code session run on a node. Owner-only; written privileged. */
export const nodeSessions = kernel.table(
  "node_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id"),
    /** The current run's job; with its lease generation, the run fence (D33). */
    jobId: uuid("job_id").references(() => nodeJobs.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").notNull(),
    source: text("source", { enum: NODE_SESSION_SOURCES }).notNull(),
    configKind: text("config_kind", { enum: NODE_SESSION_CONFIG_KINDS }).notNull(),
    configDir: text("config_dir"),
    sourceThreadId: uuid("source_thread_id"),
    sourceMessageId: uuid("source_message_id"),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    folderName: text("folder_name"),
    folderPath: text("folder_path"),
    /** D49: a dispatch's repo, a git URL or a shared repo folder's name. */
    repo: text("repo"),
    branch: text("branch"),
    pushed: boolean("pushed").notNull().default(false),
    prUrl: text("pr_url"),
    model: text("model").notNull(),
    level: text("level", { enum: NODE_LEVELS }).notNull(),
    /** 0144: reasoning effort (null = the model's default). */
    effort: text("effort", { enum: EFFORT_LEVELS }),
    /** 0144: the owner muted this session's notifications. */
    muted: boolean("muted").notNull().default(false),
    /** 0158: guided (asks the person) or autonomous (decides on its own). */
    autonomy: text("autonomy", { enum: AUTONOMY_LEVELS }).notNull().default("guided"),
    /** 0158: how the work ends; null = a pull request for a repository, nothing otherwise. */
    finishWith: text("finish_with", { enum: FINISH_WITH }),
    /** 0158: the last valid Atelier state the node reported. */
    atelier: jsonb("atelier").$type<NodeSessionAtelierState>(),
    /** 0158 (A38): the ended_at already posted back into the source thread. */
    postedBackEndedAt: timestamp("posted_back_ended_at", { withTimezone: true }),
    /** 0159 (A51): an import is a follow (read only) or a take over (steerable); null otherwise. */
    importMode: text("import_mode", { enum: NODE_IMPORT_MODES }),
    /** 0159: the imported CLI session id, immutable (`sdkSessionId` starts equal and may move). */
    importSdkSessionId: text("import_sdk_session_id"),
    /** 0159: which Claude Code started the imported session. */
    importFrom: text("import_from", { enum: NODE_IMPORT_FROM }),
    /** 0159: the recorded cwd relative to the shared folder ('' = the folder); display only. */
    cwdSubdir: text("cwd_subdir"),
    /** 0160 (D53): the shared repo's own worktree outside the folder an import ran in; cwdSubdir is then relative to it. */
    worktreePath: text("worktree_path"),
    /** 0159: a follow job of this session holds its lease. */
    following: boolean("following").notNull().default(false),
    /** 0159 (A62): where a Take over's replay stopped; consumed by the first resume's claim. */
    importReplayOffset: bigint("import_replay_offset", { mode: "number" }),
    status: text("status", { enum: NODE_SESSION_STATUSES }).notNull().default("queued"),
    pendingCount: integer("pending_count").notNull().default(0),
    waitingReason: text("waiting_reason"),
    sdkSessionId: text("sdk_session_id"),
    claudeCode: text("claude_code"),
    lastSeq: integer("last_seq").notNull().default(0),
    lastBatchNo: integer("last_batch_no").notNull().default(0),
    lastBatchHash: text("last_batch_hash"),
    lastCommandSeq: integer("last_command_seq").notNull().default(0),
    latestActivity: text("latest_activity"),
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
    /** 0144 (D23): the cumulative cache split; tokens_in already counts it. */
    tokensCacheRead: bigint("tokens_cache_read", { mode: "number" }).notNull().default(0),
    tokensCacheWrite5m: bigint("tokens_cache_write_5m", { mode: "number" }).notNull().default(0),
    tokensCacheWrite1h: bigint("tokens_cache_write_1h", { mode: "number" }).notNull().default(0),
    resultSummary: text("result_summary"),
    // The row's reason line as a code the client localises (null: the
    // session's own words, `result_summary`, are the reason). 0157.
    reasonCode: text("reason_code"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("node_sessions_owner_status_idx").on(t.orgId, t.ownerUserId, t.status, t.updatedAt),
    index("node_sessions_owner_ended_idx").on(t.orgId, t.ownerUserId, t.endedAt),
    uniqueIndex("node_sessions_job_idx").on(t.jobId).where(sql`job_id IS NOT NULL`),
    uniqueIndex("node_sessions_import_once")
      .on(t.orgId, t.ownerUserId, t.importSdkSessionId)
      .where(sql`import_sdk_session_id IS NOT NULL`),
  ],
)

/** A session's steps, numbered by the server (D33). Append-only. */
export const nodeSessionEvents = kernel.table(
  "node_session_events",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => nodeSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    type: text("type", { enum: NODE_SESSION_EVENT_TYPES }).notNull(),
    parentToolUseId: text("parent_tool_use_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    truncated: boolean("truncated").notNull().default(false),
    fullBytes: integer("full_bytes"),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
)

/** Owner-to-node commands, in per-session order (P3). */
export const nodeSessionCommands = kernel.table(
  "node_session_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => nodeSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    jobId: uuid("job_id"),
    outcome: text("outcome", { enum: NODE_SESSION_COMMAND_OUTCOMES }),
    result: jsonb("result"),
  },
  (t) => [unique("node_session_commands_seq_key").on(t.sessionId, t.seq)],
)

/** An owner's in-app confirmation of a level (D24, D38, D41). */
export const nodeLevelConfirmations = kernel.table(
  "node_level_confirmations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id").notNull(),
    agentId: uuid("agent_id"),
    sessionId: uuid("session_id").references(() => nodeSessions.id, { onDelete: "cascade" }),
    level: text("level", { enum: NODE_LEVELS }).notNull(),
    purpose: text("purpose", { enum: NODE_LEVEL_CONFIRMATION_PURPOSES }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    attachedAt: timestamp("attached_at", { withTimezone: true }),
    attachedSessionId: uuid("attached_session_id").references(() => nodeSessions.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [
    index("node_level_confirmations_open_idx")
      .on(t.nodeId, t.agentId, t.purpose)
      .where(sql`consumed_at IS NULL`),
  ],
)

/** A shared folder a node offers (name and absolute path; the path stays owner-only). */
export interface NodeSharedFolder {
  name: string
  path: string
}

/** What a node offers, owner-only (D37, D42). */
export const nodeCapabilities = kernel.table("node_capabilities", {
  nodeId: uuid("node_id").primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  sharedFolders: jsonb("shared_folders").$type<NodeSharedFolder[]>().notNull().default([]),
  models: jsonb("models").$type<unknown[]>().notNull().default([]),
  levelPins: jsonb("level_pins")
    .$type<Array<{ agentId: string; level: NodeLevel }>>()
    .notNull()
    .default([]),
  /** 0159 (S40): the import protocol the node published; null for an older desktop. */
  importProtocol: integer("import_protocol"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})
