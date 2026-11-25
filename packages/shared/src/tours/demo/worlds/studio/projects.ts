// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The services world's projects scenario: the project lead asks for help on a
 * task of the fixed-price client's project, then the weekly client report of
 * the retainer client: its draft, sent by the visitor, and the report as the
 * client reads it, hours included because that client shares hours. The client
 * report beats are named extra beats on the projects builder, never a fork.
 */
import { buildProjectsTour, type ProjectsScenarioCfg } from "../../projects"
import { hop, lastHop, railHop, scenarioKey } from "../../shared"

/** The injector of the scenario's world beat (`modules/demo/worlds/studio/projects-comment.ts`). */
export const STUDIO_PROJECTS_COMMENT_INJECTOR = "studio-projects-comment"

/** The project the task sits in, by its name on the Projects home. */
export const STUDIO_PROJECT_NAME = "Partner portal rebuild"

/** The retainer client's project, whose weekly report the extra beats send. */
export const STUDIO_REPORT_PROJECT_NAME = "Publishing retainer"

/** The report's own panel in the project, and the section the client reads its hours in. */
export const STUDIO_REPORT_PANEL = "client-report"
export const STUDIO_REPORT_HOURS_SECTION = "client-report.section-project_hours"

const k = scenarioKey("studioProjects")

/** The retainer project's row on the Projects home. */
const reportProjectRow = {
  testid: "projects-home-row-*",
  where: { attr: "data-project-name", value: [STUDIO_REPORT_PROJECT_NAME] },
}

/** From the rail to the report: the retainer project, its client reports, this week's. */
const toReport = (last: string) => [
  railHop("Projects"),
  hop(
    k("reportDraft.way2"),
    `projects-home-row-*[data-project-name=${STUDIO_REPORT_PROJECT_NAME}]`,
  ),
  hop(k("reportDraft.way3"), "client-reports.toggle"),
  lastHop(last),
]

/** Open the retainer project and its report, unless the report is on screen already. */
const reachReport = [
  { click: reportProjectRow, unlessVisible: "client-reports" },
  { click: "client-reports.toggle", unlessVisible: "client-reports.item-*" },
  { click: "client-reports.item-*", unlessVisible: STUDIO_REPORT_PANEL },
]

export const STUDIO_PROJECTS_CFG: ProjectsScenarioCfg = {
  world: "studio",
  copy: "studioProjects",
  injector: STUDIO_PROJECTS_COMMENT_INJECTOR,
  projectName: STUDIO_PROJECT_NAME,
  // The task beats, then the client report (about a minute more).
  minutes: 4,
  extraBeats: [
    {
      after: "board",
      beat: {
        id: "report-draft",
        kind: "show",
        title: k("reportDraft.title"),
        body: k("reportDraft.body"),
        role: k("reportDraft.role"),
        anchor: STUDIO_REPORT_PANEL,
        path: toReport(k("reportDraft.way4")),
        route: "/projects",
        reach: reachReport,
      },
    },
    {
      after: "report-draft",
      beat: {
        id: "send-report",
        kind: "do",
        title: k("sendReport.title"),
        body: k("sendReport.body"),
        role: k("sendReport.role"),
        anchor: "client-report.send",
        path: toReport(k("sendReport.way4")),
        route: "/projects",
        // The person's own send of the report: an agent's or a routine's never completes it.
        event: { app: "projects", entity: "client_report", action: "sent", actor: "user" },
        autoplay: [
          ...reachReport,
          { waitFor: "client-report.send" },
          { click: "client-report.send" },
          { waitEvent: true },
        ],
      },
    },
    {
      after: "send-report",
      beat: {
        id: "report-preview",
        kind: "show",
        title: k("reportPreview.title"),
        body: k("reportPreview.body"),
        role: k("reportPreview.role"),
        anchor: STUDIO_REPORT_HOURS_SECTION,
        path: toReport(k("reportPreview.way4")),
        route: "/projects",
        reach: reachReport,
      },
    },
  ],
}

export const scenarioStudioProjectsTour = buildProjectsTour(STUDIO_PROJECTS_CFG)
