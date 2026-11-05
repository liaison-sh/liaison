// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reference transform: Jira Software (Jira Cloud REST API v3) into projects.project
// and projects.task, pulled through an api-connector connection.
//
// The connection: baseUrl https://<site>.atlassian.net, basic auth (the
// account's email and an API token, saved through a secret card), and
// redirectHosts ["api.media.atlassian.com"] for attachment downloads. Save with
// sourceType "api" and the connection's identifier.
//
// What it reads, page by page (one call of pull per page):
//   1. the software projects (GET /rest/api/3/project/search?typeKey=software),
//      with each project's statuses (GET /rest/api/3/project/{key}/statuses):
//      one projects.project each, statuses marked terminal when Jira files
//      them under the "done" category;
//   2. the issues in three passes over every project, so a parent is always
//      imported before its children: all epics, then all standard issues,
//      then all subtasks (a parent in another project, imported or not, is
//      named in the description and the task imports without the link)
//      (GET /rest/api/3/search/jql, paged by nextPageToken), each with its
//      comments (GET /rest/api/3/issue/{key}/comment) and attachments
//      (downloadToFile on /rest/api/3/attachment/content/{id}?redirect=false).
//
// People: Jira returns an email only when the person's profile shows it; a
// person without one keeps their display name (a comment by an unknown author
// is folded into the description, an unknown assignee leaves the task
// unassigned). Descriptions and comments are Atlassian Document Format,
// turned into plain text with links and mentions kept.
//
// To limit the import to some projects, list their keys in PROJECT_KEYS.

const PROJECT_KEYS = [] // e.g. ["NWA", "OPS"]; empty: every software project
const ISSUES_PER_PAGE = 25
const FIELDS =
  "summary,description,status,assignee,reporter,priority,duedate,created,resolutiondate,parent,issuetype,attachment"
const PASSES = [
  "issuetype = Epic",
  "issuetype in standardIssueTypes() AND issuetype != Epic",
  "issuetype in subTaskIssueTypes()",
]

/** Thrown to give the page back to the host after a 429 (it waits, then calls again). */
function Throttled() {}

async function get(ctx, path) {
  const answer = await ctx.apiGet(path)
  if (answer.status === 429) throw new Throttled()
  if (answer.status === 404) return null
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`GET ${path.split("?")[0]} answered HTTP ${answer.status}`)
  }
  return answer.data
}

/** Atlassian Document Format to plain text. */
function adfText(node) {
  if (!node) return ""
  if (typeof node === "string") return node
  const kids = Array.isArray(node.content) ? node.content.map(adfText) : []
  switch (node.type) {
    case "text": {
      const link = (node.marks || []).filter((m) => m.type === "link" && m.attrs && m.attrs.href)[0]
      return link && link.attrs.href !== node.text
        ? `${node.text} (${link.attrs.href})`
        : node.text || ""
    }
    case "hardBreak":
      return "\n"
    case "mention":
      return node.attrs?.text || "@someone"
    case "emoji":
      return (node.attrs && (node.attrs.text || node.attrs.shortName)) || ""
    case "inlineCard":
    case "blockCard":
      return node.attrs?.url || ""
    case "listItem":
      return `- ${kids.join("").trim()}\n`
    case "bulletList":
    case "orderedList":
      return `${kids.join("")}\n`
    case "codeBlock":
      return `\`\`\`\n${kids.join("")}\n\`\`\`\n\n`
    case "paragraph":
    case "heading":
    case "blockquote":
      return `${kids.join("")}\n\n`
    default:
      return kids.join("")
  }
}

function plain(adf) {
  const t = adfText(adf)
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return t.length > 0 ? t : null
}

function priorityOf(p) {
  const name = (p?.name ? p.name : "").toLowerCase()
  if (name === "highest" || name === "blocker") return "urgent"
  if (name === "high" || name === "critical") return "high"
  if (name === "low" || name === "lowest" || name === "trivial") return "low"
  return "normal"
}

function who(user) {
  return user ? { email: user.emailAddress || null, name: user.displayName || null } : null
}

async function commentsOf(ctx, key) {
  const out = []
  let startAt = 0
  for (;;) {
    const page = await get(
      ctx,
      "/rest/api/3/issue/" +
        encodeURIComponent(key) +
        "/comment?orderBy=created&maxResults=100&startAt=" +
        startAt,
    )
    if (!page) return out
    const list = page.comments || []
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      const body = plain(c.body)
      if (!body) continue
      const a = who(c.author)
      out.push({
        authorEmail: a ? a.email : null,
        authorName: a ? a.name : null,
        body: body,
        createdAt: c.created || null,
      })
    }
    startAt += list.length
    if (list.length === 0 || startAt >= (page.total || 0)) return out
  }
}

/** The project key of an issue key (`FAB-12` → `FAB`). */
function projectKeyOf(issueKey) {
  return String(issueKey).replace(/-\d+$/, "")
}

async function taskOf(ctx, issue, projectName, importedKeys) {
  const f = issue.fields || {}
  const reporter = who(f.reporter)
  const assignee = who(f.assignee)
  const status = f.status || null
  const task = {
    externalRef: issue.key,
    project: { name: projectName },
    title: f.summary || issue.key,
    description: plain(f.description),
    status: status ? status.name : null,
    statusTerminal: !!(status?.statusCategory && status.statusCategory.key === "done"),
    priority: priorityOf(f.priority),
    assigneeEmail: assignee ? assignee.email : null,
    assigneeName: assignee ? assignee.name : null,
    reporterEmail: reporter ? reporter.email : null,
    reporterName: reporter ? reporter.name : null,
    dueDate: f.duedate || null,
    createdAt: f.created || null,
    completedAt: f.resolutiondate || null,
    // Liaison links a subtask to a parent in its own project only: a parent
    // elsewhere is named in the description instead (the task still imports).
    parentExternalRef:
      f.parent && projectKeyOf(f.parent.key) === projectKeyOf(issue.key) ? f.parent.key : null,
    comments: await commentsOf(ctx, issue.key),
  }
  if (f.parent && task.parentExternalRef === null) {
    const where =
      importedKeys.indexOf(projectKeyOf(f.parent.key)) >= 0 ? "in another project" : "not imported"
    const note = `Parent in Jira: ${f.parent.key} (${where})`
    task.description = task.description ? `${task.description}\n\n${note}` : note
  }
  const attachments = f.attachment || []
  if (attachments.length > 0) {
    task.attachments = []
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i]
      const author = who(att.author)
      task.attachments.push({
        filename: att.filename,
        mimeType: att.mimeType || "application/octet-stream",
        fileId: await ctx.downloadToFile(
          `/rest/api/3/attachment/content/${encodeURIComponent(att.id)}?redirect=false`,
          { filename: att.filename },
        ),
        createdAt: att.created || null,
        authorEmail: author ? author.email : null,
        authorName: author ? author.name : null,
      })
    }
  }
  return task
}

async function projectsPage(ctx) {
  const projects = []
  let startAt = 0
  for (;;) {
    const page = await get(
      ctx,
      "/rest/api/3/project/search?typeKey=software&expand=description&maxResults=50&startAt=" +
        startAt,
    )
    const values = page?.values || []
    for (let i = 0; i < values.length; i++) {
      const p = values[i]
      if (PROJECT_KEYS.length === 0 || PROJECT_KEYS.indexOf(p.key) >= 0) projects.push(p)
    }
    startAt += values.length
    if (!page || page.isLast || values.length === 0) break
  }
  const records = []
  for (let j = 0; j < projects.length; j++) {
    const project = projects[j]
    const types =
      (await get(ctx, `/rest/api/3/project/${encodeURIComponent(project.key)}/statuses`)) || []
    const seen = {}
    const statuses = []
    for (let k = 0; k < types.length; k++) {
      const list = types[k].statuses || []
      for (let s = 0; s < list.length; s++) {
        const st = list[s]
        if (seen[st.name]) continue
        seen[st.name] = true
        statuses.push({
          label: st.name,
          terminal: !!(st.statusCategory && st.statusCategory.key === "done"),
        })
      }
    }
    records.push({
      name: project.name,
      description: project.description || null,
      statuses: statuses,
    })
  }
  if (records.length > 0) await ctx.emitRecords("projects.project", records)
  return projects.map((p) => ({ key: p.key, name: p.name }))
}

async function pull(page, ctx) {
  const cursor = page.cursor
  try {
    if (!cursor) {
      const projects = await projectsPage(ctx)
      if (projects.length === 0) return { nextCursor: null }
      return { nextCursor: { projects: projects, p: 0, pass: 0, token: null } }
    }
    // The pass is the outer loop: every project's epics, then every
    // project's standard issues, then every project's subtasks, so a parent
    // in another imported project always comes first.
    const project = cursor.projects[cursor.p]
    const jql = `project = ${JSON.stringify(project.key)} AND ${PASSES[cursor.pass]} ORDER BY created ASC`
    const path =
      "/rest/api/3/search/jql?jql=" +
      encodeURIComponent(jql) +
      "&fields=" +
      FIELDS +
      "&maxResults=" +
      ISSUES_PER_PAGE +
      (cursor.token ? `&nextPageToken=${encodeURIComponent(cursor.token)}` : "")
    const result = (await get(ctx, path)) || { issues: [] }
    const importedKeys = cursor.projects.map((x) => x.key)
    const tasks = []
    for (let i = 0; i < result.issues.length; i++) {
      tasks.push(await taskOf(ctx, result.issues[i], project.name, importedKeys))
    }
    if (tasks.length > 0) await ctx.emitRecords("projects.task", tasks)
    const next = (p, pass, token) => ({
      nextCursor: { projects: cursor.projects, p: p, pass: pass, token: token },
    })
    if (result.nextPageToken && !result.isLast)
      return next(cursor.p, cursor.pass, result.nextPageToken)
    if (cursor.p + 1 < cursor.projects.length) return next(cursor.p + 1, cursor.pass, null)
    if (cursor.pass + 1 < PASSES.length) return next(0, cursor.pass + 1, null)
    return { nextCursor: null }
  } catch (err) {
    if (err instanceof Throttled) return { nextCursor: cursor }
    throw err
  }
}
