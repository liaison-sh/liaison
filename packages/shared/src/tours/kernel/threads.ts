// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Messages: post in a conversation, speak instead of typing, and bring an
 * agent in with @. The conversation is the person's (one they opened, with
 * colleagues in it), so "Do it for me" writes each message but never sends
 * it: the person reads it and presses Send.
 */
import { defineTour } from "../schema"

const k = (path: string) => `tours.kernel.threads.${path}`

export const kernelThreadsTour = defineTour({
  id: "kernel.threads",
  app: "kernel",
  title: k("title"),
  summary: k("summary"),
  beats: [
    {
      id: "messages",
      kind: "show",
      title: k("messages.title"),
      body: k("messages.body"),
      anchor: "activity-messages",
      anchorPhone: "phone-tab-chats",
      route: "/chats",
    },
    {
      id: "post",
      kind: "do",
      title: k("post.title"),
      body: k("post.body"),
      anchor: "compose-editor",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [
        { type: { testid: "compose-editor", text: "tours.kernel.threads.post.text" } },
        { waitEvent: true },
      ],
    },
    {
      id: "dictation",
      kind: "show",
      title: k("dictation.title"),
      body: k("dictation.body"),
      anchor: "voice-dictation-button",
    },
    {
      id: "mention-agent",
      kind: "do",
      title: k("mentionAgent.title"),
      body: k("mentionAgent.body"),
      anchor: "compose-editor",
      // Only a message that @-mentions an agent (the write point flags it).
      event: { app: "kernel", entity: "message", action: "create", match: { mentionsAgent: true } },
      autoplay: [
        { type: { testid: "compose-editor", text: "tours.kernel.threads.mentionAgent.trigger" } },
        { waitFor: "mention-result-agent" },
        { click: "mention-result-agent" },
        {
          type: {
            testid: "compose-editor",
            text: "tours.kernel.threads.mentionAgent.text",
            append: true,
          },
        },
        { waitEvent: true },
      ],
    },
    {
      id: "agent-answers",
      kind: "show",
      title: k("agentAnswers.title"),
      body: k("agentAnswers.body"),
    },
    {
      id: "attach",
      kind: "show",
      title: k("attach.title"),
      body: k("attach.body"),
      anchor: "composer-plus",
    },
  ],
})
