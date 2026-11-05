// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Projects, agent first: ask your agent (from the chat dock) to plan a launch
 * as a project with its tasks, review what it created, comment on one of its
 * tasks, then where you can still work by hand. Everything the tour touches
 * is what the person's agent created for this run: the comment goes on a task
 * inside that project, never on existing work. The agent is asked in the
 * person's conversation with it (`talksToAgent`), which holds what earlier
 * turns read: creating the project may then ask for approval first, and the
 * approve-plan beat approves it.
 */
import { approveCreatedSteps, askAgentInRunConversation } from "../agent-steps"
import { defineTour, type TourStep } from "../schema"

const k = (path: string) => `tours.projects.basics.${path}`

/** The project the agent created for the ask beat: later beats work on it, never on existing work. */
const PLANNED_PROJECT = { beat: "ask-plan", attr: "data-project-id" } as const

/**
 * Open the planned project from the projects home (`entry`: its row, or its
 * card on a phone), then one of its tasks, and comment on it.
 */
function commentInPlannedProject(entry: string): TourStep[] {
  return [
    {
      click: { testid: entry, created: PLANNED_PROJECT },
      unlessVisible: { testid: "project-workspace", created: PLANNED_PROJECT },
    },
    { waitFor: { testid: "project-workspace", created: PLANNED_PROJECT } },
    { click: "project-list-view.row", unlessVisible: "task-discussion.composer" },
    { waitFor: "task-discussion.composer" },
    {
      type: { testid: "task-discussion.composer", text: k("comment.text") },
    },
    { click: "task-discussion.send" },
    { waitEvent: true },
  ]
}

export const projectsBasicsTour = defineTour({
  id: "projects.basics",
  app: "projects",
  title: k("title"),
  summary: k("summary"),
  talksToAgent: true,
  beats: [
    {
      id: "home",
      kind: "show",
      title: k("home.title"),
      body: k("home.body"),
      anchor: "projects-home",
      route: "/projects",
    },
    {
      id: "ask-plan",
      kind: "do",
      title: k("askPlan.title"),
      body: k("askPlan.body"),
      anchor: "dock-chats",
      anchorPhone: "phone-tab-chats",
      route: "/projects",
      // Creating the project may park for approval instead (heldAs): a turn that
      // read data some project readers cannot see asks a person first. The next
      // beat approves it.
      event: {
        app: "projects",
        entity: "project",
        action: "created",
        actor: "user-or-agent",
        heldAs: "projects:createProject",
      },
      autoplay: askAgentInRunConversation(k("askPlan.text")),
    },
    {
      // Only when creating the project asked first; a project created at once skips it.
      // Its project is then the plan's: what later beats pin to `ask-plan`.
      id: "approve-plan",
      kind: "do",
      title: k("approvePlan.title"),
      body: k("approvePlan.body"),
      anchor: "approval-card[data-request-id={ask-plan}]",
      whenHeld: "ask-plan",
      event: { app: "projects", entity: "project", action: "created", actor: "user-or-agent" },
      waitsOn: "agent",
      autoplay: [{ openRunConversation: true }, ...approveCreatedSteps("ask-plan")],
    },
    {
      id: "review",
      kind: "show",
      title: k("review.title"),
      body: k("review.body"),
      anchor: "projects-home.project-list",
      route: "/projects",
    },
    {
      id: "comment",
      kind: "do",
      title: k("comment.title"),
      body: k("comment.body"),
      anchor: "task-discussion.composer",
      // A comment is a message in the task's own thread (`threadOrigin`).
      event: {
        app: "kernel",
        entity: "message",
        action: "create",
        match: { threadOrigin: "projects:task" },
      },
      // In the project the agent created: open it from the home (the
      // scenario playing on), then one of its tasks.
      autoplay: commentInPlannedProject("projects-home-row-*"),
      // A phone lists the projects as cards (walk D68: the row's testid found
      // nothing there, and the step never opened the project).
      autoplayPhone: commentInPlannedProject("projects-home-card-*"),
    },
    {
      id: "yourself",
      kind: "show",
      title: k("yourself.title"),
      body: k("yourself.body"),
      anchor: "task-detail.assignee",
    },
  ],
})
