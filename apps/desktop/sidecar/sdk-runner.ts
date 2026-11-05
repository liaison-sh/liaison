// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shipping turn runner: the Claude Agent SDK hosted in process, inside the
// Bun compiled sidecar. The day one spike proved
// the shape works against a real Liaison MCP gateway, so this is the path the
// desktop ships; the CLI stream fallback was never built.
//
// Every SDK option name used here was re-verified against the pinned SDK
// version's own `sdk.d.ts` rather than taken from the spec, per the spec's own
// instruction that option names are checked at the spike date.

import { readFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import path from "node:path"
import type {
  HookCallbackMatcher,
  McpHttpServerConfig,
  ModelInfo,
  Options,
  PreToolUseHookInput,
  Query,
  SDKUserMessage,
  PermissionMode as SdkPermissionMode,
} from "@anthropic-ai/claude-agent-sdk"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { parseClaudeModelId } from "../../../packages/shared/src/node-models"
import { EFFORT_LEVELS, type EffortLevel } from "../../../packages/shared/src/node-session-protocol"
import { folderSpellings, realLocation } from "./auto-policy"
import { isolationEnv, prepareIsolatedConfig } from "./config-isolation"
import type {
  McpConfigFile,
  PermissionMode,
  SidecarConfig,
  SidecarUserMessage,
  ToolGuard,
} from "./index"
import { headersHelperCommand } from "./mcp-token"

/**
 * Liaison presents five permission modes. The SDK has six values; only these
 * are ever reachable from the product, so an unknown mode is a bug in the
 * caller and throws rather than quietly running in the SDK's default mode.
 *
 * Auto is NOT the SDK's own `auto`: the CLI refuses that on Haiku 4.5 and on
 * plans without it, and falls back to asking for everything. Liaison's Auto
 * runs the SDK in `acceptEdits` (edits inside the folder need no prompt) and
 * answers the rest in the sidecar's broker (auto-policy.ts).
 */
const SDK_PERMISSION_MODE: Record<PermissionMode, SdkPermissionMode> = {
  auto: "acceptEdits",
  manual: "default",
  edit: "acceptEdits",
  plan: "plan",
  bypass: "bypassPermissions",
}

/** The SDK's own name for a mode, re-exported so `index.ts` never imports the SDK. */
/** The SDK's own model row, re-exported for the same reason. */
export type { ModelInfo as SdkModelInfo, SdkPermissionMode }

export function mapPermissionMode(mode: PermissionMode): SdkPermissionMode {
  const mapped = SDK_PERMISSION_MODE[mode]
  if (!mapped) throw new Error(`unknown permission mode: ${mode}`)
  return mapped
}

export function readMcpConfig(path: string): McpConfigFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<McpConfigFile>
  if (!parsed.liaisonMcpUrl) throw new Error(`${path}: missing liaisonMcpUrl`)
  if (!parsed.agentScopedToken) throw new Error(`${path}: missing agentScopedToken`)
  return {
    liaisonMcpUrl: parsed.liaisonMcpUrl,
    agentScopedToken: parsed.agentScopedToken,
    agentDefinition: parsed.agentDefinition ?? "",
  }
}

/**
 * Where a local session runs, stated after the agent definition. The
 * definition is written for server turns ("what you can do is listed in the
 * runtime context at its end"), and Claude Haiku 4.5 read it as running on the
 * server: asked for the monthly report, it followed the skill's "no tool that
 * runs a command" branch and told the person to open a local session, from
 * inside one, with Bash available.
 */
export function localRuntimeNote(cwd: string, user: string): string {
  return [
    "# Where this session runs",
    `You are running on ${user}'s computer, in the Liaison desktop app's local session, in the folder ${cwd}.`,
    "You have a shell: Bash, Read, Write and Edit act on this computer, and the Liaison tools reach the organization through the Liaison MCP server.",
    "This is not a conversation served by the server, and it is interactive: the person is here and answers you.",
    "Any procedure that must run on the person's computer or in a local session runs here, by you, now. Never tell the person to open a local session: this is one.",
  ].join("\n")
}

function currentUser(): string {
  try {
    return userInfo().username || "the person"
  } catch {
    return "the person"
  }
}

/**
 * The composed Liaison agent definition is APPENDED to Claude Code's own
 * system prompt, never substituted for it: a local session is a full Claude
 * Code session that also knows who it is inside Liaison. The runtime note
 * follows it, so it has the last word on where the session runs.
 */
export function composeSystemPrompt(
  mcp: McpConfigFile,
  cwd: string,
  user: string = currentUser(),
): Options["systemPrompt"] {
  const note = localRuntimeNote(cwd, user)
  const append = mcp.agentDefinition ? `${mcp.agentDefinition}\n\n${note}` : note
  return { type: "preset", preset: "claude_code", append }
}

/**
 * A checksum of the definition the turn actually ran with. An external harness
 * that drops or truncates the system prompt is otherwise invisible: the agent
 * simply behaves oddly. With this on every turn, the two turns can be compared
 * byte for byte from the audit trail instead.
 *
 * It covers the agent definition ONLY, deliberately not the local runtime note
 * appended after it: the note carries this machine's folder and user, and the
 * checksum is compared with the server's own definition.
 */
export function systemPromptChecksum(mcp: McpConfigFile): string {
  return new Bun.CryptoHasher("sha256").update(mcp.agentDefinition).digest("hex")
}

export function turnSystemPromptChecksum(config: SidecarConfig): string {
  return systemPromptChecksum(readMcpConfig(config.mcpConfigPath))
}

/**
 * The environment the SDK's CLI child runs with, or nothing when this session
 * is not isolated. The directory is created here (once per machine, reused
 * after that) because this is the first moment the session knows whether it
 * needs one.
 */
export function claudeConfigEnv(config: SidecarConfig): Record<string, string> | undefined {
  if (!config.isolateConfig) return undefined
  const { dir } = prepareIsolatedConfig()
  return isolationEnv(dir)
}

/**
 * The Agent SDK's own local `Skill` tool, which a local session never offers.
 * Liaison's skills are served by the Liaison MCP (`kernel__skill_read`,
 * `kernel__skill_search`), and a model shown both called the local one with a
 * Liaison skill name first, every time: "Unknown skill: rapport-mensuel-hub",
 * a red row in the conversation, and a wasted round trip. A preamble naming
 * the right tool did not stop Claude Haiku 4.5 doing it; removing the tool
 * does.
 */
export const DISALLOWED_SDK_TOOLS = ["Skill"] as const

/**
 * The other spellings of the session folder, handed to the SDK as additional
 * directories. The CLI realpaths its cwd and then compares a path that does
 * not exist yet as spelled, so a log written to `~/Documents/X/run.log` when
 * `~/Documents` is a symlink was "outside" the session folder and asked.
 */
export function folderAliases(cwd: string, home: string = homedir()): string[] {
  const real = realLocation(cwd)
  return folderSpellings(cwd, home).filter((spelling) => spelling !== real)
}

/**
 * The Liaison server as the CLI is told about it. `headersHelper` is the CLI's
 * own field (its --mcp-config schema carries it for http servers) that the
 * SDK's type does not list yet; the SDK passes the object through verbatim.
 */
export type LiaisonMcpServer = McpHttpServerConfig & { headersHelper: string }

/**
 * NO STATIC TOKEN. The header is produced by a command the CLI runs when it
 * connects and again whenever a Liaison call comes back 401 (CLI 2.1.270:
 * "re-running headersHelper and retrying once"), and that command renews the
 * 15 minute agent token (`mcp-token.ts`). A static `Authorization` header was
 * the token the session was spawned with, for the whole session: every call
 * after its fifteen minutes was a 401 the model reported as Liaison being down.
 */
export function liaisonMcpServer(
  mcp: McpConfigFile,
  mcpConfigPath: string,
  helperCommand: string = headersHelperCommand(path.resolve(mcpConfigPath)),
): LiaisonMcpServer {
  return {
    type: "http",
    url: mcp.liaisonMcpUrl,
    headersHelper: helperCommand,
  }
}

/** The SDK options a session runs with. Separated so a test can read them. */
export function turnOptions(
  config: SidecarConfig,
  mcp: McpConfigFile,
  configEnv?: Record<string, string>,
): Options {
  const permissionMode = mapPermissionMode(config.permissionMode)
  const aliases = folderAliases(config.cwd)
  return {
    cwd: config.cwd,
    ...(aliases.length > 0 ? { additionalDirectories: aliases } : {}),
    disallowedTools: [...DISALLOWED_SDK_TOOLS],
    // Resuming is the SDK's own: it loads the named session's history, and the
    // sidecar never reconstructs a transcript of its own.
    ...(config.resumeSessionId ? { resume: config.resumeSessionId } : {}),
    model: config.model,
    permissionMode,
    // ALWAYS, not only when the session STARTS in Bypass. The SDK refuses a
    // later switch into bypassPermissions on a session launched without it
    // ("the session was not launched with --dangerously-skip-permissions"),
    // so a running session could never be moved to Bypass: the user confirmed
    // the native dialog and got "That permission mode was not applied". It
    // makes the mode reachable, not active: the session runs in the mode
    // above, and entering Bypass still goes through the shell's own
    // confirmation (sidecar.rs `validate_permission_mode_change`).
    allowDangerouslySkipPermissions: true,
    mcpServers: {
      liaison: {
        ...liaisonMcpServer(mcp, config.mcpConfigPath),
        // `alwaysLoad` is deliberately NOT set. It means "never deferred behind
        // tool search", and the Liaison catalog is the whole org: 478 tools and
        // 439 KB of JSON Schema on a demo org, ~170k prompt tokens. With it set,
        // every local turn died before it started ("Prompt is too long, the
        // request is ~208663 tokens, limit 200000"), measured against a stub MCP
        // server serving a catalog of that size. Left unset, the SDK's own tool
        // search defers the schemas out of the window and loads only what a turn
        // selects: the same catalog then costs ~6k prompt tokens, and turn one
        // still resolves a tool by name through ToolSearch. The cold-start cost
        // this flag used to buy (a blocking connect) is not worth a session that
        // cannot run at all.
      },
    },
    // The folder's own CLAUDE.md and .claude/ are loaded. "user" is left out of
    // the setting sources, which is not isolation on its own: the SDK spawns
    // the Claude Code CLI, which reads the machine owner's own config
    // directory, and the spike measured a turn seeing that operator's personal
    // claude.ai connectors (Drive, Gmail, Calendar). `--isolate-config` is what
    // removes them, by moving CLAUDE_CONFIG_DIR while pinning the credential
    // store to the default one so the login survives (config-isolation.ts).
    // The shell sets it for every kind of agent except a personal one (A29).
    // The whole environment is REPLACED when it is set, so process.env is
    // spread back in: the SDK documents `env` as a replacement, not a merge.
    ...(configEnv ? { env: { ...process.env, ...configEnv } } : {}),
    systemPrompt: composeSystemPrompt(mcp, config.cwd),
    settingSources: ["project", "local"],
    // Partial assistant text, so the shell can render a turn as it is written
    // instead of after it finishes.
    includePartialMessages: true,
  }
}

/**
 * One SESSION. The SDK's own `Query` is returned rather than a fresh generator
 * because it is already an async iterable of the streamed messages AND carries
 * `interrupt()` and `close()`, which the shell needs to stop a running turn
 * and to end the session.
 *
 * The prompt is the host's streamed turn input, so every turn runs inside this
 * one query: the session id, the accumulated context and the resume semantics
 * are the SDK's own rather than something reassembled here.
 */
export function runSession(
  config: SidecarConfig,
  prompts: AsyncIterable<SidecarUserMessage>,
  cliPath?: string | null,
  // Read once by the caller and handed in, so a --mcp-config that is a pipe
  // rather than a file still works, and so a session never reads the token twice.
  mcp: McpConfigFile = readMcpConfig(config.mcpConfigPath),
  canUseTool?: Options["canUseTool"],
  guardTool?: ToolGuard,
): Query {
  const options = turnOptions(config, mcp, claudeConfigEnv(config))
  if (cliPath) options.pathToClaudeCodeExecutable = cliPath
  if (canUseTool) options.canUseTool = canUseTool
  if (guardTool) options.hooks = { PreToolUse: [guardHook(guardTool)] }
  return query({ prompt: prompts as AsyncIterable<SDKUserMessage>, options })
}

/**
 * A ToolGuard as the SDK's PreToolUse hook. An SDK callback hook runs under
 * the config isolation's `disableAllHooks`, which silences only the hooks of
 * settings files. A refusal is a `deny`; anything else leaves the call to the
 * permission mode and `canUseTool`, exactly as without the hook.
 */
export function guardHook(guard: ToolGuard): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        const pre = input as PreToolUseHookInput
        if (pre.hook_event_name !== "PreToolUse") return {}
        const toolInput =
          pre.tool_input && typeof pre.tool_input === "object"
            ? (pre.tool_input as Record<string, unknown>)
            : {}
        const refusal = await guard(pre.tool_name, toolInput)
        if (refusal === null) return {}
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: refusal,
          },
        }
      },
    ],
  }
}

/** One model a local session can run on, as the shell offers it. */
export interface LocalModel {
  id: string
  label: string
  /** S25: the reasoning levels the model takes; absent when it takes none. */
  efforts?: EffortLevel[]
}

/**
 * THE MODELS THE INSTALLED SDK RUNS, in the shell's shape.
 *
 * `Query.supportedModels()` answers what the CLI's own model picker shows:
 * a "default" row, family aliases ("opus", "sonnet", "haiku") carrying the
 * full id they resolve to today (`resolvedModel`), and explicit ids such as
 * `claude-fable-5-1[1m]`. The shell wants ids that name the model that
 * actually answers, so an alias becomes its resolved id and an explicit id is
 * kept as written (its `[1m]` context suffix included). The "default" row is
 * dropped: it always repeats another row, and "default" would follow whatever
 * the CLI's default becomes rather than what the person picked.
 *
 * The label is the model's own name from the description ("Opus 5.5 · Best
 * for ..." gives "Claude Opus 5.5"), because the display name alone ("Opus")
 * does not say which version answers. A description without that shape falls
 * back to the display name.
 */
export function localModelsFrom(infos: readonly ModelInfo[]): LocalModel[] {
  const models: LocalModel[] = []
  const bareAliases: Array<{ model: LocalModel; family: string }> = []
  for (const info of infos) {
    if (!info || typeof info.value !== "string" || info.value === "default") continue
    const explicit = info.value.startsWith("claude-")
    const id = explicit ? info.value : (info.resolvedModel ?? info.value)
    if (!id || models.some((model) => model.id === id)) continue
    const efforts = modelEfforts(info)
    const model: LocalModel = { id, label: modelLabel(info), ...(efforts ? { efforts } : {}) }
    models.push(model)
    // An alias the SDK did not resolve ("opus") names its family, not a model.
    if (!explicit && !info.resolvedModel) {
      bareAliases.push({ model, family: info.value.replace(/\[.*\]$/, "") })
    }
  }
  // A bare alias is dropped when its family is listed by id: it would sit in
  // the list beside the very model it stands for, and an id-shaped filter
  // (`currentNodeModels`) could never tell it is the same model.
  const listed = new Set(models.map((model) => parseClaudeModelId(model.id)?.family))
  const dropped = new Set(
    bareAliases.filter((alias) => listed.has(alias.family)).map((alias) => alias.model),
  )
  // EVERY model the SDK runs, pinned older versions included (2026-10-15):
  // this list is what a session may START on (the node's checks, the
  // server's resolution), so a session on an older version keeps running.
  // What is OFFERED is narrowed to each family's current model downstream
  // (`currentNodeModels`), wherever a list is shown or chosen from.
  return models.filter((model) => !dropped.has(model))
}

/** S25: the levels the SDK says a model takes, known levels only, in the SDK's order. */
function modelEfforts(info: ModelInfo): EffortLevel[] | null {
  if (info.supportsEffort !== true || !Array.isArray(info.supportedEffortLevels)) return null
  const levels = info.supportedEffortLevels.filter((level): level is EffortLevel =>
    (EFFORT_LEVELS as readonly string[]).includes(level),
  )
  return levels.length > 0 ? levels : null
}

function modelLabel(info: ModelInfo): string {
  const separator = info.description?.indexOf(" · ") ?? -1
  const before = separator > 0 ? info.description.slice(0, separator).trim() : ""
  // Only a versioned name counts: SDK 0.3.296 describes a superseded row as
  // "Newer version available · select Haiku for Haiku 5.5", whose first part
  // names no model at all.
  const described = /\d/.test(before) ? before : ""
  // Some logins describe a row without its name ("Opus 5.5" / "For complex
  // work"): the display name then carries the version and gets the same prefix.
  const name = described || info.displayName
  if (!name) return info.value
  return name.startsWith("Claude") ? name : `Claude ${name}`
}

/**
 * A QUERY THAT ONLY ANSWERS WHICH MODELS THE BUNDLED SDK OFFERS
 * (`--local-models`). Its prompt never yields, so no turn is ever sent: the
 * list is part of the CLI's initialization answer. No setting source and no
 * MCP server is loaded, so nothing of the owner's configuration starts; the
 * login is the owner's own, which is what decides the list.
 */
export function modelDiscoveryQuery(cliPath: string | null, cwd: string): Query {
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await new Promise<never>(() => {})
  }
  const options: Options = {
    cwd,
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
  }
  if (cliPath) options.pathToClaudeCodeExecutable = cliPath
  return query({ prompt: idle(), options })
}
