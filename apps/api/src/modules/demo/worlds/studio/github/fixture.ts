// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The services world's code history, as a pure function of the seed's anchor.
//
// Built from the world's plan (`seed/worlds/studio/plan.ts`): its projects'
// repositories, their tasks, who worked them and when. Every date is read on
// the anchor's story clock, never the wall clock, so the history a visitor
// reads does not move under them.
//
// Rules, per repository:
// - A task worked from two months before the anchor carries work commits:
//   two, plus one per started two hours of time taken on it, spread from its
//   first day of work to its close (an open task: to the anchor). Each commit
//   names the task's key.
// - The tasks one person closed in one month pair up, in closing order, into
//   merged pull requests, each with its merge commit at the later close. A task
//   in progress has an open pull request.
// - Every weekday after the anchor, to a year past it, the project's open work
//   goes on: two commits a day, naming its open tasks in turn. A reader only
//   ever sees the part of that history at or before the present.
// - Shas are stable: a hash of the repository and the commit's key.
import { createHash } from "node:crypto"
import { addCalendarDays, isoWeekdayOf } from "@liaison/shared"
import { storyClock } from "~/seed/worlds/story-clock"
import { STUDIO_TEAM } from "~/seed/worlds/studio/fiction"
import { parisCivil, type StudioProjectPlan, studioPlan } from "~/seed/worlds/studio/plan"
import { DEMO_GITHUB_OWNER } from "./sentinel"

export interface StandInPerson {
  login: string
  name: string
  email: string
}

export interface StandInCommit {
  sha: string
  repo: string
  message: string
  author: StandInPerson
  date: Date
  taskKeys: string[]
  files: string[]
  parents: string[]
}

export interface StandInPull {
  number: number
  repo: string
  title: string
  body: string
  head: string
  author: StandInPerson
  taskKeys: string[]
  commitShas: string[]
  createdAt: Date
  mergedAt: Date | null
}

export interface StandInRepo {
  name: string
  description: string
  createdAt: Date
}

export interface StandInHistory {
  owner: string
  repos: StandInRepo[]
  /** Newest first, per repository name. */
  commits: Map<string, StandInCommit[]>
  /** Oldest first, per repository name. */
  pulls: Map<string, StandInPull[]>
}

/** The days of future history built after the anchor. */
const FUTURE_DAYS = 366

const DAY_MS = 86_400_000

function personOf(key: string): StandInPerson {
  const found = STUDIO_TEAM.find((p) => p.key === key)
  return {
    login: `${key}-${DEMO_GITHUB_OWNER}`,
    name: found?.name ?? key,
    email: found?.email ?? `${key}@users.noreply.github-standin.example`,
  }
}

function shaOf(repo: string, key: string): string {
  return createHash("sha1").update(`${DEMO_GITHUB_OWNER}/${repo}:${key}`).digest("hex")
}

function slugOf(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

function dayDiff(from: string, to: string): number {
  const ms = (c: string) => {
    const [y, m, d] = c.split("-").map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((ms(to) - ms(from)) / DAY_MS)
}

/** The repository a project's commits go to (the first of its `sourceRepos`, under the owner). */
function repoNameOf(project: StudioProjectPlan): string | null {
  const full = project.sourceRepos[0]
  if (!full) return null
  const [owner, name] = full.split("/")
  return owner === DEMO_GITHUB_OWNER && name ? name : null
}

/** The services world's history at `anchor`. */
export function buildStandInHistory(anchor: Date): StandInHistory {
  const plan = studioPlan(anchor)
  const clock = storyClock(anchor)
  const today = parisCivil(anchor)
  const at = (civil: string, hhmm: string) => clock.d(dayDiff(today, civil), hhmm)
  const [ty, tm] = today.split("-").map(Number) as [number, number]
  const fromIndex = ty * 12 + (tm - 1) - 2
  const windowStart = at(
    `${Math.floor(fromIndex / 12)}-${String((fromIndex % 12) + 1).padStart(2, "0")}-01`,
    "00:00",
  )

  const repos: StandInRepo[] = []
  const commits = new Map<string, StandInCommit[]>()
  const pulls = new Map<string, StandInPull[]>()

  for (const project of plan.projects) {
    const repo = repoNameOf(project)
    if (!repo) continue
    const list: StandInCommit[] = []
    const prs: StandInPull[] = []
    const fileOf = (title: string) => `src/${slugOf(title)}.ts`
    const workOf = new Map<string, StandInCommit[]>()

    // Work commits per task, from its first day of work to its close.
    for (const task of project.tasks) {
      if (task.isMilestone || !task.assignee || task.status === "todo") continue
      const rows = plan.taskTime.filter((r) => r.project === project.key && r.task === task.key)
      const hours = rows.reduce((s, r) => s + r.minutes, 0) / 60
      const end = task.status === "done" ? task.completedAt : anchor
      if (!end) continue
      const firstDay = rows.map((r) => r.workDate).sort()[0]
      let start = firstDay ? at(firstDay, "09:30") : new Date(end.getTime() - DAY_MS)
      if (start.getTime() >= end.getTime()) start = new Date(end.getTime() - 6 * 3_600_000)
      const n = 2 + Math.ceil(hours / 2)
      const author = personOf(task.assignee)
      const own: StandInCommit[] = []
      for (let j = 0; j < n; j++) {
        const date = new Date(
          start.getTime() + Math.floor(((j + 1) * (end.getTime() - start.getTime())) / (n + 1)),
        )
        if (date < windowStart) continue
        const verb =
          j === 0 ? "Start" : j === n - 1 && task.status === "done" ? "Finish" : "Work on"
        own.push({
          sha: shaOf(repo, `${task.key}:${j}`),
          repo,
          message: `${task.key} ${verb} ${task.title.toLowerCase()}`,
          author,
          date,
          taskKeys: [task.key],
          files: [fileOf(task.title)],
          parents: [],
        })
      }
      if (own.length > 0) workOf.set(task.key, own)
      list.push(...own)
    }

    // Closed tasks of one person in one month pair up into merged pull requests.
    const closed = project.tasks
      .filter((t) => t.status === "done" && t.completedAt && workOf.has(t.key) && t.assignee)
      .sort((a, b) => (a.completedAt as Date).getTime() - (b.completedAt as Date).getTime())
    const groups = new Map<string, typeof closed>()
    for (const t of closed) {
      const g = `${parisCivil(t.completedAt as Date).slice(0, 7)}:${t.assignee}`
      groups.set(g, [...(groups.get(g) ?? []), t])
    }
    const merged: Array<{ tasks: typeof closed; at: Date }> = []
    for (const tasks of groups.values()) {
      for (let i = 0; i < tasks.length; i += 2) {
        const pair = tasks.slice(i, i + 2)
        merged.push({ tasks: pair, at: pair[pair.length - 1]?.completedAt as Date })
      }
    }
    merged.sort((a, b) => a.at.getTime() - b.at.getTime())
    const open = project.tasks.filter((t) => t.status === "in_progress" && workOf.has(t.key))
    let number = 0
    for (const m of merged) {
      number++
      const keys = m.tasks.map((t) => t.key)
      const own = keys.flatMap((k) => workOf.get(k) ?? [])
      const head = `${keys[0]?.toLowerCase()}-${slugOf(m.tasks[0]?.title ?? "")}`
      const author = personOf(m.tasks[0]?.assignee as string)
      const mergeCommit: StandInCommit = {
        sha: shaOf(repo, `pr:${number}`),
        repo,
        message: `Merge pull request #${number} from ${DEMO_GITHUB_OWNER}/${head}\n\n${keys.join(", ")}`,
        author,
        date: m.at,
        taskKeys: keys,
        files: m.tasks.map((t) => fileOf(t.title)),
        parents: [],
      }
      list.push(mergeCommit)
      prs.push({
        number,
        repo,
        title: m.tasks.map((t) => `${t.key} ${t.title}`).join(", "),
        body: `Closes ${keys.join(", ")}.`,
        head,
        author,
        taskKeys: keys,
        commitShas: [...own.map((c) => c.sha), mergeCommit.sha],
        createdAt: own[0]?.date ?? m.at,
        mergedAt: m.at,
      })
    }
    for (const t of open) {
      number++
      const own = workOf.get(t.key) ?? []
      prs.push({
        number,
        repo,
        title: `${t.key} ${t.title}`,
        body: `Work on ${t.key}, not merged yet.`,
        head: `${t.key.toLowerCase()}-${slugOf(t.title)}`,
        author: personOf(t.assignee as string),
        taskKeys: [t.key],
        commitShas: own.map((c) => c.sha),
        createdAt: own[0]?.date ?? anchor,
        mergedAt: null,
      })
    }

    // The work that goes on after the anchor: two commits each weekday, the open tasks in turn.
    const ongoing = project.tasks.filter((t) => !t.isMilestone && t.status !== "done")
    const rotation = ongoing.length > 0 ? ongoing : project.tasks.filter((t) => !t.isMilestone)
    if (rotation.length > 0 && project.basis !== "none") {
      let k = 0
      for (let d = 1; d <= FUTURE_DAYS; d++) {
        const civil = addCalendarDays(today, d)
        if (isoWeekdayOf(civil) > 5) continue
        for (const hhmm of ["11:00", "16:00"]) {
          const task = rotation[k % rotation.length]
          k++
          if (!task) continue
          list.push({
            sha: shaOf(repo, `${civil}:${hhmm}`),
            repo,
            message: `${task.key} Work on ${task.title.toLowerCase()}`,
            author: personOf(task.assignee ?? project.owner),
            date: at(civil, hhmm),
            taskKeys: [task.key],
            files: [fileOf(task.title)],
            parents: [],
          })
        }
      }
    }

    list.sort((a, b) => b.date.getTime() - a.date.getTime() || a.sha.localeCompare(b.sha))
    for (let i = 0; i < list.length; i++) {
      const parent = list[i + 1]
      ;(list[i] as StandInCommit).parents = parent ? [parent.sha] : []
    }
    commits.set(repo, list)
    pulls.set(repo, prs)
    repos.push({
      name: repo,
      description: `${project.name}: ${project.description}`.slice(0, 200),
      createdAt: list[list.length - 1]?.date ?? windowStart,
    })
  }
  return { owner: DEMO_GITHUB_OWNER, repos, commits, pulls }
}

const cache = new Map<number, StandInHistory>()

/** The history at `anchor`, built once per anchor in this process. */
export function standInHistory(anchor: Date): StandInHistory {
  const key = anchor.getTime()
  let history = cache.get(key)
  if (!history) {
    if (cache.size >= 32) cache.clear()
    history = buildStandInHistory(anchor)
    cache.set(key, history)
  }
  return history
}
