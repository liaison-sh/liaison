// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4m-T01/T02/T03 harness support: capture the EXACT request the agent runtime
// hands the provider, turn after turn, and reduce it to a byte buffer whose
// prefix can be compared across turns (spec-memory.md S23, invariants I1-I5).
//
// WHY A BYTE BUFFER AND NOT A DEEP EQUAL. The contract is a prompt-cache
// contract: providers match a cached prefix byte for byte from position 0. A
// structural comparison would pass on a request that reordered two system
// parts or re-rendered one message, which is exactly the change that costs a
// full cache miss. So every captured request is serialized into an ordered
// list of SEGMENTS (one per system part, one for the tool-name set, one per
// message) and the assertion is `next.subarray(0, prev.length) == prev`.
//
// WHAT IS STRIPPED, and why that is not a weakening. `providerOptions` is
// dropped from every part and message before serialization: the Anthropic
// `cacheControl` marker on the last history message MOVES by design every turn
// (context.ts marks the newest message), so keeping it would make the guard
// fail on the very mechanism it exists to protect. The marker's POSITION is
// kept instead, as the breakpoint index, which is the thing the contract is
// actually about. Tools are serialized by NAME ONLY: a tool's zod schema and
// execute closure are not serializable, and I7 is about the tool SET, whose
// change already invalidates the prefix.

import { streamText } from "ai"
import { readStepUsage } from "~/modules/agent/providers/step-usage"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"

/** One provider request, as the harness keeps it. */
export interface CapturedTurn {
  turnIndex: number
  /** The acting agent this turn ran as. */
  agentKey: string
  /** Ordered segments: system parts, the tool-name set, then the messages. */
  segments: Buffer[]
  /**
   * Index of the LAST segment inside the cacheable prefix: the segment of the
   * message carrying the moving `cacheControl` marker.
   */
  breakpointSegmentIndex: number
  /**
   * The prefix as TEXT rather than as the serialization: system part contents
   * plus the message contents up to the breakpoint. Token estimates for the
   * provider evidence are taken over this, never over the JSON envelope the
   * byte comparison uses, which is larger than the real prompt.
   */
  prefixText: string
  /** Everything after the breakpoint (the ephemeral runtime-context tail). */
  tailText: string
  /** Text of the messages added since the previous captured turn. */
  newMessagesText: string
  /** Provider-reported usage, filled only when a real provider ran the turn. */
  usage: {
    inputTokens: number
    cachedInputTokens: number
    /** inputTokens minus cachedInputTokens: what the provider had to re-read. */
    uncachedInputTokens: number
  } | null
}

/** The raw first argument `streamTextForAgent` receives. */
interface RawRequest {
  system?: unknown
  messages?: unknown
  tools?: Record<string, unknown>
}

/** Deterministic JSON: keys sorted at every depth, `providerOptions` dropped. */
function stableJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v
    if (seen.has(v as object)) return "[circular]"
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(walk)
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      if (k === "providerOptions") continue
      out[k] = walk((v as Record<string, unknown>)[k])
    }
    return out
  }
  return JSON.stringify(walk(value))
}

function hasCacheControl(msg: unknown): boolean {
  const po = (msg as { providerOptions?: { anthropic?: { cacheControl?: unknown } } })
    ?.providerOptions
  return po?.anthropic?.cacheControl != null
}

function messageText(msg: unknown): string {
  const content = (msg as { content?: unknown })?.content
  if (typeof content === "string") return content
  return stableJson(content)
}

const USER_MEMORY_BLOCK = /<user-memory[\s\S]*?<\/user-memory>/
const RECALLED_MEMORY_BLOCK = /<recalled-memory[\s\S]*?<\/recalled-memory>/
/** Every block invariant I2 keeps OUT of the cached prefix. */
const EPHEMERAL_BLOCKS = [USER_MEMORY_BLOCK, RECALLED_MEMORY_BLOCK]

/**
 * The falsifiability switch (test only, never read by production code). With
 * it on, the memory index block AND the recalled memory block are lifted out of
 * the ephemeral tail and appended to the LAST system part, i.e. into the cached
 * prefix: the exact mistake invariant I2 forbids. Scenario 1 must then fail on
 * the first turn after a memory write. Recall is in the switch because a recall
 * that moved into a system part would change the prefix on EVERY turn, and a
 * guard that only watched the index would have called that run clean.
 */
function applyMutation(
  systemParts: Array<{ content?: unknown }>,
  messages: unknown[],
): { systemParts: Array<{ content?: unknown }>; messages: unknown[] } {
  const lastIdx = messages.length - 1
  const last = messages[lastIdx] as { role?: string; content?: unknown } | undefined
  if (!last || typeof last.content !== "string") return { systemParts, messages }
  const moved: string[] = []
  let content = last.content
  for (const block of EPHEMERAL_BLOCKS) {
    const match = content.match(block)
    if (!match) continue
    moved.push(match[0])
    content = content.replace(block, "")
  }
  if (moved.length === 0) return { systemParts, messages }
  const movedMessages = [...messages]
  movedMessages[lastIdx] = { ...last, content }
  const movedSystem = systemParts.map((p) => ({ ...p }))
  const target = movedSystem[movedSystem.length - 1]
  if (target) target.content = `${String(target.content ?? "")}\n\n${moved.join("\n\n")}`
  return { systemParts: movedSystem, messages: movedMessages }
}

function segmentize(
  raw: RawRequest,
  mutate: boolean,
): Pick<CapturedTurn, "segments" | "breakpointSegmentIndex" | "tailText" | "prefixText"> {
  const rawSystem = Array.isArray(raw.system)
    ? (raw.system as Array<{ content?: unknown }>)
    : [{ content: raw.system }]
  const rawMessages = Array.isArray(raw.messages) ? (raw.messages as unknown[]) : []
  // The marker is read BEFORE the mutation rewrites the parts, so the
  // breakpoint is always the one production actually set.
  let bpMsgIdx = -1
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    if (hasCacheControl(rawMessages[i])) {
      bpMsgIdx = i
      break
    }
  }
  if (bpMsgIdx < 0) bpMsgIdx = rawMessages.length - 1

  const { systemParts, messages } = mutate
    ? applyMutation(rawSystem, rawMessages)
    : { systemParts: rawSystem, messages: rawMessages }

  const segments: Buffer[] = []
  for (const part of systemParts) segments.push(Buffer.from(`S${stableJson(part)}\n`))
  const toolNames = Object.keys(raw.tools ?? {}).sort()
  segments.push(Buffer.from(`T${stableJson(toolNames)}\n`))
  const firstMessageSegment = segments.length
  for (const msg of messages) segments.push(Buffer.from(`M${stableJson(msg)}\n`))

  const tailText = messages
    .slice(bpMsgIdx + 1)
    .map(messageText)
    .join("\n")

  const prefixText = [
    ...systemParts.map((p) => String(p.content ?? "")),
    ...messages.slice(0, bpMsgIdx + 1).map(messageText),
  ].join("\n")

  return {
    segments,
    breakpointSegmentIndex: firstMessageSegment + bpMsgIdx,
    tailText,
    prefixText,
  }
}

/** Bytes up to and including the moving breakpoint: the cacheable prefix. */
export function prefixBuffer(turn: CapturedTurn): Buffer {
  return Buffer.concat(turn.segments.slice(0, turn.breakpointSegmentIndex + 1))
}

/** Every byte of the request, prefix plus ephemeral tail. */
export function fullBuffer(turn: CapturedTurn): Buffer {
  return Buffer.concat(turn.segments)
}

export interface CaptureHandle {
  turns: CapturedTurn[]
  /** Turns captured for one acting agent, in order. */
  forAgent(agentKey: string): CapturedTurn[]
  /** Restore the production `streamText`. */
  restore(): void
}

export interface InstallCaptureOptions {
  /**
   * Which agent the NEXT turn runs as. The runtime does not hand the acting
   * agent to `streamText`, so the harness, which scripts the turns, names it.
   */
  currentAgentKey: () => string
  /** Test-only mutation switch — moves ephemeral blocks into the last system part. */
  mutate?: () => boolean
  /**
   * The scripted stream for a captured turn. Omit to delegate to the REAL
   * provider (T03's evidence run), which is also what fills `usage`.
   *
   * The WHOLE captured turn is handed over, not only its index: the long
   * memory harness (T33 to T36) has no funded key, so its scripted reader is
   * the model stand in and it may cite only what this request actually
   * carried. Reading `prefixText` / `tailText` here is what makes "the answer
   * contains the number" a statement about retrieval rather than about the
   * script.
   */
  script?: (turn: CapturedTurn) => unknown
}

/**
 * Install the capture around the agent runtime's one `streamText` seam. Every
 * turn's request is recorded before the call is either scripted or delegated
 * to the real provider.
 */
export function installRequestCapture(options: InstallCaptureOptions): CaptureHandle {
  const turns: CapturedTurn[] = []
  const mutate = options.mutate ?? (() => false)

  AgentServiceTestAccess.setStreamText(((raw: RawRequest) => {
    const agentKey = options.currentAgentKey()
    const previous = turns.filter((t) => t.agentKey === agentKey)
    const turnIndex = previous.length + 1
    const segmented = segmentize(raw, mutate())
    const prior = previous[previous.length - 1]
    // Everything this request carries beyond the previous turn's cached
    // prefix: the new messages plus the ephemeral tail.
    const newFrom = prior ? prior.breakpointSegmentIndex + 1 : 0
    const captured: CapturedTurn = {
      turnIndex,
      agentKey,
      ...segmented,
      newMessagesText: segmented.segments
        .slice(newFrom)
        .map((b) => b.toString("utf8"))
        .join(""),
      usage: null,
    }
    turns.push(captured)

    if (options.script) return options.script(captured)

    // Real provider: delegate, and observe the usage the provider reports
    // without consuming the stream the runtime is about to iterate.
    const result = streamText(raw as never) as unknown as {
      fullStream: AsyncIterable<unknown>
    }
    const inner = result.fullStream
    return {
      ...result,
      fullStream: (async function* () {
        for await (const chunk of inner) {
          const usage = (chunk as { type?: string; usage?: unknown }).usage
          if ((chunk as { type?: string }).type === "finish-step" && usage) {
            const step = readStepUsage(usage)
            const inputTokens = step.inputTokens ?? 0
            const cachedInputTokens = step.cacheReadTokens
            captured.usage = {
              inputTokens,
              cachedInputTokens,
              uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
            }
          }
          yield chunk
        }
      })(),
    }
  }) as never)

  return {
    turns,
    forAgent: (agentKey: string) => turns.filter((t) => t.agentKey === agentKey),
    restore: () => AgentServiceTestAccess.setStreamText(),
  }
}

/**
 * Compare consecutive turns of one agent. Returns the 1-based turn indices
 * whose predecessor's prefix is NOT a byte prefix of them.
 */
export function prefixExceptions(turns: CapturedTurn[]): number[] {
  const failures: number[] = []
  for (let i = 1; i < turns.length; i++) {
    const prev = prefixBuffer(turns[i - 1])
    const next = fullBuffer(turns[i])
    if (!next.subarray(0, prev.length).equals(prev)) failures.push(turns[i].turnIndex)
  }
  return failures
}
