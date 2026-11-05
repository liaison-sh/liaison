// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The effect-ledger key of a write tool call inside a turn (S10, C2 rule 4).
 *
 *   tool:<turnId>:<toolName>:<argsHash>:<occurrence>
 *
 * `argsHash` is the canonical-JSON hash of the call's arguments (key order
 * does not matter). `occurrence` counts the identical (tool, argsHash) calls
 * the turn made before this one, so it is deterministic: a turn resumed after
 * a cut step re-issues that step, the model asks for the same call again with
 * a new toolCallId, and the re-call gets the SAME key as the cut call. The
 * ledger then answers with the stored result (the call finished) or "outcome
 * unknown" (its claimer died mid-call), never a second effect. A deliberate
 * second identical call in one turn gets the next occurrence and runs.
 *
 * The counter is per turn and is journaled with every complete step
 * (`snapshot`), so a resume seeds it with the calls of the complete steps
 * only: the cut step's calls are not counted, which is exactly what makes the
 * re-call match.
 */
import { hashParams } from "~/modules/apps/idempotency"

export function toolEffectKey(
  turnId: string,
  toolName: string,
  argsHash: string,
  occurrence: number,
): string {
  return `tool:${turnId}:${toolName}:${argsHash}:${occurrence}`
}

/** One reserved occurrence of a call. */
export interface ToolEffectSlot {
  key: string
  occurrence: number
  /**
   * Give the occurrence back: the call's outcome is unknown, so an identical
   * re-call in this turn must hit the same key (and get the same answer)
   * instead of running as "the next" identical call.
   */
  release: () => void
}

export class TurnEffectKeys {
  private readonly counts: Map<string, number>

  constructor(
    readonly turnId: string,
    seed: Record<string, number> = {},
  ) {
    this.counts = new Map(Object.entries(seed))
  }

  /** Reserve the next occurrence of `toolName(args)` in this turn. */
  reserve(toolName: string, args: unknown): ToolEffectSlot {
    const argsHash = hashParams(args ?? {})
    const id = `${toolName}:${argsHash}`
    const occurrence = (this.counts.get(id) ?? 0) + 1
    this.counts.set(id, occurrence)
    return {
      key: toolEffectKey(this.turnId, toolName, argsHash, occurrence),
      occurrence,
      release: () => {
        if (this.counts.get(id) === occurrence) this.counts.set(id, occurrence - 1)
      },
    }
  }

  /** The counts as journaled with a complete step. */
  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counts].filter(([, n]) => n > 0))
  }
}
