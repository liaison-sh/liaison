// SPDX-License-Identifier: FSL-1.1-ALv2
//
// INFRA-2 — host-mock interceptor for the Social app's own UI surfaces.
//
// Lifted verbatim from the Boxtal `installHostMockInterceptor` pattern
// (`boxtal/visual.scenario.test.ts`): a `page.addInitScript` that wraps
// `window.__liaisonHost.invokeTool` so the social read tools return CANNED shapes
// per state — no live tool round-trips, deterministic pixels. The host splits the
// combined tool name on the first colon, so the interceptor key is
// `social:<toolName>` (underscore-named, `.`↔`_` normalized exactly as Boxtal).
//
// SCOPE: this wraps ONLY `__liaisonHost.invokeTool`, which the social app's own
// surfaces (Findings / Messages / Watched / Settings / sidebar) read through. It
// does NOT cover the Agent app's SkillsList/RoutinesList (kernel data path) nor
// `app.openConnect` (a real apiClient.post → navigate/throw, never intercepted).
import type { Page } from "@playwright/test"

// ─────────────────────────────────────────────────────────────────────────
// Canned tool shapes — derived from the social UI components' `app.invokeTool`
// calls (see the E2E plan "Canned tool shapes" table).
// ─────────────────────────────────────────────────────────────────────────

export interface FindingFixture {
  id: string
  platform: "facebook" | "instagram" | "youtube"
  relation: string
  status: string
  author_handle?: string | null
  content_text?: string | null
  triage_category?: string | null
  urgency?: number | null
  should_reply?: boolean | null
  suggested_reply?: string | null
  edited_after_reply?: boolean | null
}

export interface ConversationFixture {
  id: string
  platform: "facebook" | "instagram"
  participant_handle?: string | null
  last_inbound_at?: string | null
  status: string
}

export interface WatchedFixture {
  id: string
  platform: "facebook" | "instagram" | "youtube"
  external_id: string
  kind: string
  status: "active" | "decayed" | "stopped"
  cadence_seconds: number
  priority?: number | null
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** A mixed, representative findings set (FB+IG+YT, varied triage + status). */
export const FINDINGS_MIXED: FindingFixture[] = [
  {
    id: "f-lead-1",
    platform: "facebook",
    relation: "comment_on_our_content",
    status: "awaiting_approval",
    author_handle: "@superfan",
    content_text: "Love this! Where can I buy one?",
    triage_category: "lead_question",
    urgency: 4,
    should_reply: true,
    suggested_reply:
      "Thanks so much! 🙌 You can grab one over at fabrikam.example/shop — happy to answer any questions before you order.",
  },
  {
    id: "f-complaint-2",
    platform: "instagram",
    relation: "comment_on_our_content",
    status: "new",
    author_handle: "@unhappy_user",
    content_text: "My order never arrived and support is silent.",
    triage_category: "complaint",
    urgency: 5,
    should_reply: true,
  },
  {
    id: "f-praise-3",
    platform: "youtube",
    relation: "comment_on_our_content",
    status: "triaged",
    author_handle: "@channel_lover",
    content_text: "Best gear demo on YouTube, subscribed!",
    triage_category: "praise",
    urgency: 1,
    should_reply: false,
  },
  {
    id: "f-mention-4",
    platform: "facebook",
    relation: "keyword_match",
    status: "handled",
    author_handle: "@brand_watch",
    content_text: "Anyone tried the new Tessera controller?",
    triage_category: "lead_question",
    urgency: 2,
    should_reply: true,
  },
]

/** ~30 rows for the overflow/storm-density state. */
export const FINDINGS_OVERFLOW: FindingFixture[] = Array.from({ length: 32 }, (_, i) => ({
  id: `f-overflow-${i}`,
  platform: (["facebook", "instagram", "youtube"] as const)[i % 3],
  relation: "keyword_match",
  status: i % 5 === 0 ? "awaiting_approval" : "new",
  author_handle: `@user_${i}`,
  content_text: `Comment number ${i} mentioning the brand in a high-volume storm.`,
  triage_category: (["lead_question", "complaint", "praise"] as const)[i % 3],
  urgency: (i % 5) + 1,
  should_reply: i % 2 === 0,
}))

export function findingFromRelationFixtures(): { yt: FindingFixture; fb: FindingFixture } {
  return {
    yt: {
      id: "f-yt-unsupported",
      platform: "youtube",
      relation: "comment_on_our_content",
      status: "new",
      author_handle: "@yt_commenter",
      content_text: "Liking this would be nice but YouTube has no like-as-channel API.",
      triage_category: "praise",
      urgency: 1,
      should_reply: false,
    },
    fb: {
      id: "f-fb-supported",
      platform: "facebook",
      relation: "comment_on_our_content",
      status: "new",
      author_handle: "@fb_commenter",
      content_text: "This is great — would love a like!",
      triage_category: "praise",
      urgency: 1,
      should_reply: false,
    },
  }
}

export const CONVERSATIONS_WINDOWS: ConversationFixture[] = [
  {
    id: "c-open",
    platform: "instagram",
    participant_handle: "@open_dm",
    last_inbound_at: new Date(Date.now() - 1 * HOUR).toISOString(),
    status: "open",
  },
  {
    id: "c-human-agent",
    platform: "instagram",
    participant_handle: "@human_agent_dm",
    last_inbound_at: new Date(Date.now() - 3 * DAY).toISOString(),
    status: "open",
  },
  {
    id: "c-closed",
    platform: "instagram",
    participant_handle: "@closed_dm",
    last_inbound_at: new Date(Date.now() - 8 * DAY).toISOString(),
    status: "open",
  },
]

export const WATCHED_CADENCE: WatchedFixture[] = [
  {
    id: "w-hot",
    platform: "youtube",
    external_id: "vid-hot-001",
    kind: "video",
    status: "active",
    cadence_seconds: 300,
    priority: 5,
  },
  {
    id: "w-warm",
    platform: "facebook",
    external_id: "post-warm-002",
    kind: "post",
    status: "active",
    cadence_seconds: 3600,
    priority: 3,
  },
  {
    id: "w-cool",
    platform: "instagram",
    external_id: "media-cool-003",
    kind: "media",
    status: "active",
    cadence_seconds: 86400,
    priority: 1,
  },
  {
    id: "w-decayed",
    platform: "youtube",
    external_id: "vid-decayed-004",
    kind: "video",
    status: "decayed",
    cadence_seconds: 86400,
    priority: 0,
  },
]

// Settings: the YouTube quota readout (`quota_status`), in the tool's own shape.
export function youtubeQuota(consumed: number, cap: number, deferred: number) {
  return {
    youtube: {
      day: "2026-10-16",
      resetsAt: "2026-10-17T07:00:00.000Z",
      cap,
      consumed,
      remaining: Math.max(0, cap - consumed),
      deferred,
      exhaustedUntil: consumed >= cap ? "2026-10-17T07:00:00.000Z" : null,
    },
    rateLimits: [],
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Interceptor — wraps window.__liaisonHost.invokeTool with canned shapes.
// Keyed `social:<tool>`, `.`↔`_` normalized, exactly as Boxtal.
// ─────────────────────────────────────────────────────────────────────────
export async function installSocialHostMock(
  page: Page,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const mocks = { ...overrides }
  await page.addInitScript((m: Record<string, unknown>) => {
    const norm = (k: string) => k.replace(/\./g, "_")
    const lookup = (key: string): { hit: boolean; value: unknown } => {
      if (Object.hasOwn(m, key)) return { hit: true, value: m[key] }
      const n = norm(key)
      for (const mk of Object.keys(m)) {
        if (norm(mk) === n) return { hit: true, value: m[mk] }
      }
      return { hit: false, value: undefined }
    }
    let real: unknown
    Object.defineProperty(window as unknown as Record<string, unknown>, "__liaisonHost", {
      configurable: true,
      get() {
        return real
      },
      set(h: unknown) {
        const original = h as Record<string, unknown>
        real = {
          ...original,
          invokeTool: async (appName: string, toolName: string, args: Record<string, unknown>) => {
            const { hit, value } = lookup(`${appName}:${toolName}`)
            if (hit) return value
            const orig = original.invokeTool as
              | ((a: string, t: string, args: Record<string, unknown>) => Promise<unknown>)
              | undefined
            if (orig) return orig.call(original, appName, toolName, args)
            throw new Error(`unmocked tool: ${appName}:${toolName}`)
          },
        }
      },
    })
  }, mocks)
}
