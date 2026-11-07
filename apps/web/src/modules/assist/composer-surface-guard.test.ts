// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S1 STATIC GUARD: every field a person writes a message or content in has the
// writing helpers: the wand (`ComposerAssist`) with the row's tools and the mic
// (`DictationMic`) left of the surface's Send, inside a `RecorderRow`, the ONE
// shared recorder line a take turns the row into (RecorderBar.tsx). A new
// `<RichEditor`, `<textarea` or `<Composer.TextArea` under modules/ fails here
// until its surface mounts them, or the field is listed below with the reason
// it is not a composer surface (settings and configuration, spec
// Definitions). No surface draws a recorder of its own.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const MODULES = join(__dirname, "..")

/** Fields that are not composer surfaces, per file: how many, and why. */
const EXCLUDED: Record<string, { fields: number; reason: string }> = {
  "settings/ProfileSettings.tsx": { fields: 1, reason: "magic wand instructions (a setting)" },
  "tickets/TicketsInboxRouting.tsx": { fields: 4, reason: "inbox configuration" },
  "settings/app-page/fields.tsx": {
    fields: 1,
    reason: "a declarative settings field (reply signature, email footer: settings)",
  },
  "agent/MarkdownEditor.tsx": { fields: 2, reason: "agent and routine instructions" },
  "agent/AgentSkillsTab.tsx": { fields: 1, reason: "skill form" },
  "agent/AgentSettingsTab.tsx": { fields: 1, reason: "agent instructions" },
  "agent/RoutineCreate.tsx": { fields: 1, reason: "routine instructions" },
  "agent/RoutineDetail.tsx": { fields: 1, reason: "routine instructions" },
  "agent/SkillFormFields.tsx": { fields: 1, reason: "skill form" },
  "agent/MemoryTree.tsx": { fields: 1, reason: "agent memory entry (configuration)" },
  "api-connector/AdapterForm.tsx": { fields: 1, reason: "adapter YAML/JSON (configuration)" },
  "app-builder/BuilderView.tsx": { fields: 1, reason: "a preview's JSON params (developer input)" },
  // Not in the spec's list of composer surfaces (Definitions).
  "calendar/EventDialog.tsx": { fields: 1, reason: "event description, not a listed surface" },
  "threads/ChannelDetailsDialog.tsx": { fields: 1, reason: "channel description, not listed" },
  "projects/Checklist.tsx": { fields: 4, reason: "checklist item fields, not listed" },
  "bug-report/BugReportDialog.tsx": { fields: 1, reason: "bug report, not listed" },
  "projects/ProjectEditForm.tsx": { fields: 1, reason: "project description, not listed" },
  "contacts/ContactAddresses.tsx": { fields: 1, reason: "a postal address's note (contact data)" },
  "settings/documents/RichTextEditor.tsx": {
    fields: 1,
    reason: "document template text with {{field}} placeholders (configuration)",
  },
}

/**
 * One helper serving a field that is EITHER rich OR plain (the approval
 * draft's body is a RichEditor for an email, a textarea otherwise): the
 * alternative counts once.
 */
const ALTERNATES: Record<string, number> = {
  "approvals/ApprovalCard.tsx": 2,
}

/**
 * Surfaces whose primary action sits in a footer, with that action's test id
 * (as written in the source) for each mic, in order.
 */
const FOOTER_PRIMARY: Record<string, string[]> = {
  "tickets/NewTicketDialog.tsx": ['"tickets-new-submit"'],
  "tickets/TicketCloseDialog.tsx": ['"tickets-close-submit"'],
  "tickets/TicketNudgeDialog.tsx": ['"tickets-nudge-submit"'],
  "tickets/TicketConvertToMailDialog.tsx": ['"tickets-convert-submit"'],
  "tickets/MailConvertToTicketDialog.tsx": ['"mail-convert-submit"'],
  "threads/NewMessageDialog.tsx": ['"new-message-submit"'],
  "threads/MessageEditField.tsx": ['"message-edit-save"'],
  "sessions/NewSessionDialog.tsx": ['"new-session-start"'],
  "projects/NewTaskDialog.tsx": ['"new-task-dialog.submit"'],
  "projects/ProjectsHome.tsx": ['"projects-home.new-project-confirm"'],
  "knowledge/KnowledgeDocumentView.tsx": ['"knowledge-doc-save"'],
  // The step row's test id is a template: matched by its tail.
  "approvals/ApprovalCard.tsx": ["()}-save`}", '"approval-card-action-save"'],
}

const FIELD = /<(RichEditor|textarea|Composer\.TextArea)\b/g
const WAND = /<ComposerAssist\b/g
const MIC = /<DictationMic\b/g
const RECORDER = /<RecorderRow\b/g
/**
 * What only the shared recorder may touch: the take's live state, the capture
 * boundary and the recorder's own test ids. A surface that reaches for one is
 * drawing a recorder of its own.
 */
const RECORDER_INTERNALS =
  /[dD]ictation\.(elapsedMs|level|autoStopped)\(\)|getUserMedia|MediaRecorder|dictation-recorder|<RecorderBar\b|"voice-dictation-(?!button")[a-z-]+"/g

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return name.endsWith(".tsx") && !name.includes(".test.") ? [path] : []
  })
}

const files = sources(MODULES).map((path) => {
  const text = readFileSync(path, "utf8")
  return {
    file: relative(MODULES, path).split("\\").join("/"),
    fields: text.match(FIELD)?.length ?? 0,
    wands: text.match(WAND)?.length ?? 0,
    mics: text.match(MIC)?.length ?? 0,
    recorders: text.match(RECORDER)?.length ?? 0,
    internals: text.match(RECORDER_INTERNALS) ?? [],
  }
})

describe("S1: every composer surface mounts the writing helpers", () => {
  it("every field outside the exclusion list has the wand and the mic beside it", () => {
    const missing = files
      .filter((f) => f.fields > 0)
      .map((f) => ({
        ...f,
        needed: f.fields - (EXCLUDED[f.file]?.fields ?? 0) - (ALTERNATES[f.file] ?? 0),
      }))
      .filter((f) => f.wands < f.needed || f.mics < f.needed)
      .map((f) => `${f.file}: ${f.needed} field(s), ${f.wands} wand(s), ${f.mics} mic(s)`)
    expect(missing).toEqual([])
  })

  it("every mic's row turns into the shared recorder (one RecorderRow per mic)", () => {
    const own = files
      .filter((f) => !f.file.startsWith("assist/") && f.mics !== f.recorders)
      .map((f) => `${f.file}: ${f.mics} mic(s), ${f.recorders} RecorderRow(s)`)
    expect(own).toEqual([])
  })

  // Where the primary action sits in a footer (Create, Send, Save), the mic
  // sits immediately left of it in that footer, which a take turns into the
  // recorder line: never beside the field, away from the action.
  it("every footer dialog has its mic immediately left of the primary action", () => {
    const wrong = Object.entries(FOOTER_PRIMARY).flatMap(([file, primaries]) => {
      const text = readFileSync(join(MODULES, file), "utf8")
      const mics = [...text.matchAll(/<DictationMic\b[\s\S]*?\/>/g)]
      if (mics.length !== primaries.length) {
        return [`${file}: ${mics.length} mic(s) for ${primaries.length} footer(s)`]
      }
      return mics.flatMap((m, i) => {
        const after = text.slice((m.index ?? 0) + m[0].length)
        const next = /^(?:\s|<\/Show>|\{\/\*[\s\S]*?\*\/\})*<(Button|button)\b[\s\S]*?<\/\1>/.exec(
          after,
        )
        return next?.[0].includes(primaries[i])
          ? []
          : [`${file}: mic ${i + 1} is not before ${primaries[i]}`]
      })
    })
    expect(wrong).toEqual([])
  })

  it("no surface draws a recorder of its own", () => {
    const own = files
      .filter((f) => !f.file.startsWith("assist/") && f.internals.length > 0)
      .map((f) => `${f.file}: ${[...new Set(f.internals)].join(", ")}`)
    expect(own).toEqual([])
  })

  it("the raw-transcript offer is gone", () => {
    const everything = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return everything(path)
        return /\.tsx?$/.test(name) && path !== __filename ? [path] : []
      })
    const raw = everything(join(MODULES, ".."))
      .filter((path) =>
        /useRaw|rawOffered|DictationRawButton|voice-dictation-use-raw/.test(
          readFileSync(path, "utf8"),
        ),
      )
      .map((path) => relative(MODULES, path))
    expect(raw).toEqual([])
  })

  it("the exclusion list is current (no entry outlives its fields)", () => {
    const byFile = new Map(files.map((f) => [f.file, f.fields]))
    const stale = Object.entries(EXCLUDED)
      .filter(([file, entry]) => (byFile.get(file) ?? 0) < entry.fields)
      .map(([file]) => file)
    expect(stale).toEqual([])
  })

  it("scans the composer surfaces it is meant to guard", () => {
    // A path change that hid the modules from the scan would pass vacuously.
    const scanned = files.filter((f) => f.fields > 0).map((f) => f.file)
    expect(scanned).toEqual(
      expect.arrayContaining([
        "tickets/TicketComposer.tsx",
        "threads/ComposeBar.tsx",
        "sessions/SessionComposer.tsx",
        "threads/EntityDiscussion.tsx",
        "tickets/TicketConvertToMailDialog.tsx",
        "tickets/MailConvertToTicketDialog.tsx",
      ]),
    )
  })
})
