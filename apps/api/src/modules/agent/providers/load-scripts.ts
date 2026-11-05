// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The load harness's agent turns (lib/load-harness.ts): a load org never
 * reaches a model provider. Its turns run on the scripted model
 * (scripted-model-provider.ts) with a script from this fixed catalog, picked
 * by a hash of the thread id, so a stress run knows every turn's final reply
 * and spends nothing. The agent loop, the turn ledger and the streaming are
 * the real ones; only the token source is fixed.
 */
import { LOAD_SCRIPT_REPLIES, loadScriptIndex } from "~/modules/agent/providers/load-script-catalog"
import {
  type ScriptedStep,
  setScriptedTurnIfAbsent,
} from "~/modules/agent/providers/scripted-model-provider"

export { LOAD_SCRIPT_REPLIES }

/** The script a load thread plays: its catalog entry, by a hash of the thread id. */
export function loadScriptFor(threadId: string | null | undefined): ScriptedStep[] {
  return [{ text: LOAD_SCRIPT_REPLIES[loadScriptIndex(threadId)] }]
}

/**
 * The script key of a load org's call, its script stored under
 * `load:<thread>` on first use. A later turn of the thread, once the script
 * is played, answers the scripted provider's fixed line.
 */
export async function loadScriptKey(threadId: string | null | undefined): Promise<string> {
  const key = `load:${threadId ?? "no-thread"}`
  await setScriptedTurnIfAbsent(key, loadScriptFor(threadId))
  return key
}
