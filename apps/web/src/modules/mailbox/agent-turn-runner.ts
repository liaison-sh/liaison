// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PHASE 9 FILLS PHASE 11'S INTEGRATION POINT.
//
// `client-job-drainer.ts` declares an `AgentTurnRunner` and deliberately ships
// no default: a stand-in that posted the decrypted mail in the prompt would be a
// different, worse mechanism wearing this one's name. This is the real one.
//
// The sequence, and why it is this way round:
//
//   1. Open a turn scope for the job's ids and the plaintext the drainer already
//      decrypted, and mint the nonce THAT scope belongs to. The scope exists
//      before the turn does, so the turn cannot race its own decrypt request.
//   2. Submit a normal SERVER-SIDE turn (`POST /api/agent/chat`) carrying the
//      nonce and an envelope-only prompt. The browser never runs an agent.
//   3. The turn's mail tool returns a marker, the server asks this client to
//      decrypt, and the responder answers from the pre-opened plaintext.
//   4. Close the scope when the turn ends, whatever way it ends.

import type { AgentTurnSession } from "~/modules/mailbox/agent-turn-session"
import type { AgentTurnRequest, AgentTurnRunner } from "~/modules/mailbox/client-job-drainer"

export interface AgentTurnRunnerDeps {
  session: AgentTurnSession
  /**
   * Submits the chat turn and resolves with its final text. Injected because the
   * transport is an SSE stream owned by the chat surface, not by the mailbox
   * module, and because a job turn must not open a second one.
   */
  submitTurn(input: { prompt: string; turnNonce: string }): Promise<{ text: string }>
}

export function createJobAgentTurnRunner(deps: AgentTurnRunnerDeps): AgentTurnRunner {
  return async (request: AgentTurnRequest) => {
    // The drainer mints a nonce of its own for the job row. The scope has to be
    // registered under the nonce the TURN will carry, so this opens the scope and
    // uses the nonce it gets back, ignoring the drainer's placeholder.
    const turnNonce = deps.session.begin({
      allowedIds: request.messageIds,
      preOpened: request.plaintext,
    })
    try {
      return await deps.submitTurn({ prompt: request.prompt, turnNonce })
    } finally {
      // A turn that failed still has to give up its decrypt scope: an open scope
      // is standing permission to decrypt those ids.
      deps.session.end(turnNonce)
    }
  }
}
