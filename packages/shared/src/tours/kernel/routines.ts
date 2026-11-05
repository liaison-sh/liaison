// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Routines: work your agent does on a schedule or when something happens.
 * The tour creates one personal routine (the form's defaults: recurring,
 * personal), which the person can pause or delete afterwards.
 */
import { defineTour } from "../schema"

const k = (path: string) => `tours.kernel.routines.${path}`

export const kernelRoutinesTour = defineTour({
  id: "kernel.routines",
  app: "kernel",
  title: k("title"),
  summary: k("summary"),
  beats: [
    {
      id: "tab",
      kind: "show",
      title: k("tab.title"),
      body: k("tab.body"),
      anchor: "agent-page-panel-routines",
      route: "/agents/self/routines",
    },
    {
      id: "list",
      kind: "show",
      title: k("list.title"),
      body: k("list.body"),
      anchor: "routines-list",
      route: "/agents/self/routines",
    },
    {
      id: "templates",
      kind: "show",
      title: k("templates.title"),
      body: k("templates.body"),
      anchor: "routine-templates-section",
      route: "/agents/self/routines",
    },
    {
      id: "create",
      kind: "do",
      title: k("create.title"),
      body: k("create.body"),
      anchor: "routines-new-routine",
      route: "/agents/self/routines",
      event: { app: "kernel", entity: "routine", action: "create", actor: "user-or-agent" },
      autoplay: [
        { click: "routines-new-routine" },
        { waitFor: "routines-new-name" },
        { type: { testid: "routines-new-name", text: "tours.kernel.routines.create.name" } },
        {
          type: {
            testid: "routines-new-prompt",
            text: "tours.kernel.routines.create.text",
          },
        },
        { click: "routines-new-save" },
        { waitEvent: true },
      ],
    },
    {
      id: "activity",
      kind: "show",
      title: k("activity.title"),
      body: k("activity.body"),
      anchor: "agent-page-panel-activity",
      route: "/agents/self/activity",
    },
  ],
})
