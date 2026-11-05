// SPDX-License-Identifier: FSL-1.1-ALv2
import type { JSX } from "solid-js"
import type { AgentDisplay } from "~/modules/threads/agent-directory"

/**
 * A role agent's row in Agents, messaged yet or not, under one test id named
 * by the agent: a guided step rings the desk to ask
 * (`chats-agent-row[data-agent-name=Operations Desk]`) whether its DM exists
 * yet in this list or not.
 */
export function RoleAgentRowFrame(props: { agent: AgentDisplay; children: JSX.Element }) {
  return (
    <div role="none" data-testid="chats-agent-row" data-agent-name={props.agent.name}>
      {props.children}
    </div>
  )
}
