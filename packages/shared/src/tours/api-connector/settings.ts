// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * API connector (admins): the connections list, each connection's status
 * and roles, the Test panel, adding a connection, then the point of it:
 * asking your agent about a customer, which it answers from the connected
 * system, and the customer card the same reads fill. "Do it for me" opens the
 * add form (the adapter itself is the admin's to paste) and types the
 * question to the agent.
 */
import { askAgentInRunConversation } from "../agent-steps"
import { defineTour, RUN_CONVERSATION } from "../schema"

const k = (path: string) => `tours.api-connector.settings.${path}`

export const apiConnectorSettingsTour = defineTour({
  id: "api-connector.settings",
  app: "api-connector",
  title: k("title"),
  summary: k("summary"),
  requires: { scopes: ["api-connector:admin"] },
  // The question goes to the person's agent, in their one conversation with it.
  talksToAgent: true,
  beats: [
    {
      id: "page",
      kind: "show",
      title: k("page.title"),
      body: k("page.body"),
      anchor: "api-connector-settings",
      route: "/settings/connectors?open=api-connector",
    },
    {
      id: "connections",
      kind: "show",
      title: k("connections.title"),
      body: k("connections.body"),
      anchor: "api-connector-settings-list",
      route: "/settings/connectors?open=api-connector",
    },
    {
      id: "test",
      kind: "show",
      title: k("test.title"),
      body: k("test.body"),
      anchor: "api-connector-settings-list",
      route: "/settings/connectors?open=api-connector",
    },
    {
      id: "result",
      kind: "show",
      title: k("result.title"),
      body: k("result.body"),
      anchor: "api-connector-test-panel",
    },
    {
      id: "add",
      kind: "do",
      title: k("add.title"),
      body: k("add.body"),
      anchor: "api-connector-add",
      route: "/settings/connectors?open=api-connector",
      // A demo org's page is read-only (its sample connection only): no Add there.
      optional: { whenFeature: "connector-add" },
      // Saving the new connection's credentials (the generic credentials
      // route, multiInstance) announces this, the saving admin as actor; the
      // adapter save itself announces nothing.
      event: {
        app: "kernel",
        entity: "connected_account",
        action: "create",
        match: { appName: "api-connector" },
      },
      autoplay: [
        { click: "api-connector-add" },
        { waitFor: "api-connector-adapter-text" },
        { waitEvent: true },
      ],
    },
    {
      id: "ask",
      kind: "do",
      title: k("ask.title"),
      body: k("ask.body"),
      anchor: "dock-chats",
      anchorPhone: "phone-tab-chats",
      // The agent's answer, from a turn that really read the connected system:
      // an answer saying every read failed is not one (it waits: Try again, Skip).
      event: {
        app: "kernel",
        entity: "message",
        action: "create",
        match: { authorType: "agent", threadId: `{${RUN_CONVERSATION}}` },
        actor: "user-or-agent",
        turnUsed: { app: "api-connector", tools: ["connector_read"] },
      },
      autoplay: askAgentInRunConversation(k("ask.text")),
    },
    {
      id: "card",
      kind: "show",
      title: k("card.title"),
      body: k("card.body"),
    },
  ],
})
