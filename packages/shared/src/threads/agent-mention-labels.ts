// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An agent mention is stored as `@[label](agent:<id>)`. The label is a copy of
// the agent's handle taken when the message was written, and a handle can
// change (a personal agent's `@ada` became `@adas-agent`). The id is what the
// mention means, so every surface that shows an agent mention to a reader, or
// to a model, names the agent as it is NOW: this rewrites each agent token's
// label to the current handle, by id. A token whose agent the caller cannot
// resolve keeps its stored label.

const LABEL = String.raw`(?:[^\]\\]|\\.)+`
const AGENT_MENTION_RE = new RegExp(String.raw`@\[(${LABEL})\]\(agent:([^)\s]+)\)`, "g")

function escapeLabel(label: string): string {
  return label.replace(/[\]\\]/g, (ch) => `\\${ch}`)
}

/**
 * `content` with every agent mention labelled by `handleOf(agentId)` (with or
 * without its leading `@`; the token supplies its own). Unchanged when the
 * content has no agent mention or `handleOf` knows none of them.
 */
export function relabelAgentMentions(
  content: string,
  handleOf: (agentId: string) => string | null | undefined,
): string {
  if (!content.includes("](agent:")) return content
  return content.replace(AGENT_MENTION_RE, (token: string, _label: string, id: string) => {
    const handle = handleOf(id)?.trim()
    const bare = handle?.startsWith("@") ? handle.slice(1) : handle
    return bare ? `@[${escapeLabel(bare)}](agent:${id})` : token
  })
}
