// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agents and approvals: your agent, what it can do, talking to it, and the
 * requests it sends you before it acts. Deciding a request stays a show
 * beat: "Do it for me" never approves or declines a real action.
 */
import { defineTour } from "../schema"

const k = (path: string) => `tours.kernel.agents.${path}`

export const kernelAgentsTour = defineTour({
  id: "kernel.agents",
  app: "kernel",
  title: k("title"),
  summary: k("summary"),
  beats: [
    {
      id: "profile",
      kind: "show",
      title: k("profile.title"),
      body: k("profile.body"),
      anchor: "agent-profile",
      route: "/agents/self",
    },
    {
      id: "capabilities",
      kind: "show",
      title: k("capabilities.title"),
      body: k("capabilities.body"),
      anchor: "agent-overview-capabilities",
      route: "/agents/self",
    },
    {
      id: "ask",
      kind: "do",
      title: k("ask.title"),
      body: k("ask.body"),
      anchor: "agent-page-message",
      route: "/agents/self",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [
        { click: "agent-page-message" },
        { waitFor: "compose-editor" },
        { type: { testid: "compose-editor", text: "tours.kernel.agents.ask.text" } },
        { click: "compose-send" },
        { waitEvent: true },
      ],
    },
    {
      id: "asks-first",
      kind: "show",
      title: k("asksFirst.title"),
      body: k("asksFirst.body"),
    },
    {
      id: "approvals",
      kind: "show",
      title: k("approvals.title"),
      body: k("approvals.body"),
      anchor: "approvals-screen",
      route: "/approvals",
    },
    {
      id: "decide",
      kind: "show",
      title: k("decide.title"),
      body: k("decide.body"),
      anchor: "approval-card",
      route: "/approvals",
    },
  ],
})
