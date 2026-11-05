// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Sessions: the coding agent at work on a computer you paired. Starting one
 * needs a paired computer; without one the beat says so and the person
 * skips it (there is no app to gate it on, so it stays in the list). "Do it
 * for me" only fills the instruction: the person picks the folder and
 * presses Start, since the session runs on their machine.
 */
import { defineTour } from "../schema"

const k = (path: string) => `tours.kernel.sessions.${path}`

export const kernelSessionsTour = defineTour({
  id: "kernel.sessions",
  app: "kernel",
  title: k("title"),
  summary: k("summary"),
  beats: [
    {
      id: "list",
      kind: "show",
      title: k("list.title"),
      body: k("list.body"),
      anchor: "session-list",
      route: "/sessions",
    },
    {
      id: "computers",
      kind: "show",
      title: k("computers.title"),
      body: k("computers.body"),
      anchor: "node-line",
      route: "/sessions",
    },
    {
      id: "start",
      kind: "do",
      title: k("start.title"),
      body: k("start.body"),
      anchor: "session-list-new",
      route: "/sessions",
      event: { app: "kernel", entity: "node_session", action: "create" },
      autoplay: [
        { click: "session-list-new" },
        { waitFor: "new-session-prompt" },
        {
          type: {
            testid: "new-session-prompt",
            text: "tours.kernel.sessions.start.text",
          },
        },
        { waitEvent: true },
      ],
    },
    {
      id: "steer",
      kind: "show",
      title: k("steer.title"),
      body: k("steer.body"),
      anchor: "session-composer-field",
    },
    {
      id: "status",
      kind: "show",
      title: k("status.title"),
      body: k("status.body"),
      anchor: "session-header",
    },
  ],
})
