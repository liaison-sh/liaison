// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Records the social app's contract fixtures (fixtures/social/*.json). Meta and
// YouTube offer no sandbox account a recorder can use, so the provider side is
// the documented response shapes of the endpoints the app calls
// (fake-providers.ts), with a fictional Page, Instagram account,
// app and people; everything else (the database, approvals, the kernel) is the
// real bridge. The plan connects a Facebook Page, lets the jobs sync it, then
// drives every tool on what they found. Not part of any suite run (it skips
// unless CONTRACT_RECORD=1): run it by path when the app's bridge calls
// change, read what it wrote, commit it.
//
//   (cd apps/api && set -a && source ../../.env.test && set +a && CONTRACT_RECORD=1 \
//     bun run ../../scripts/with-test-lock.ts -- \
//     bun test ./scripts/contract/record-social.recorder.ts)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { schemaRef } from "~/db/schema-ref"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { CONTRACT_ORG_ID, CONTRACT_USER_ID } from "~/modules/apps/contract/replay-bridge"
import { createHandlerApprovalRequest } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { type FakeProviders, graphPage, installFakeProviders, on } from "./fake-providers"
import {
  installForRecording,
  type RecordingState,
  type RecordingStep,
  runRecordingPlan,
  uninstallAfterRecording,
} from "./recording-run"

const APP = "social"
const APP_SECRET = "contract-meta-app-secret-not-real"
const USER_TOKEN = "contract-facebook-user-token-not-real"
const PAGE_TOKEN = "contract-facebook-page-token-not-real"
const IG_TOKEN = "contract-instagram-token-not-real"
const YT_TOKEN = "contract-youtube-token-not-real"
const BASE_URL = "https://liaison.example.com"
const CONFIG = {
  socialMetaAppSecret: APP_SECRET,
  webhookVerifyToken: "contract-verify-token-not-real",
}

/** The contract isolate's virtual clock starts here (isolate.ts). */
const NOW = "2026-01-01T00:00:00.000Z"
const PAGE = "104857600000001"
const PAGE_NAME = "Resonant Audio Labs"
const IG = "17841400000000001"
const META_APP = "1029384756000001"
const POST = `${PAGE}_123450000000001`
const POST_2 = `${PAGE}_123450000000002`
const FAN = { id: "6000000000000001", name: "Camille Martin" }
const FAN_2 = { id: "6000000000000002", name: "Jonas Weber" }
const THREAD = "t_10000000000000001"
const VIDEO = "dQw4w9WgXc0"
const CHANNEL = "UCxContractChannel0000001"

const ts = (minutesAgo: number) =>
  new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString().replace(".000Z", "+0000")

const comment = (
  n: number,
  post: string,
  from: { id: string; name: string },
  message: string,
  minutesAgo: number,
) => ({
  id: `${post.split("_")[1]}_99880000000000${n}`,
  message,
  from,
  created_time: ts(minutesAgo),
  permalink_url: `https://www.facebook.com/${PAGE}/posts/${post.split("_")[1]}?comment_id=99880000000000${n}`,
})

const COMMENTS = [
  comment(
    1,
    POST,
    FAN,
    "Do the new bass traps ship to Belgium? I could not find it in the checkout.",
    42,
  ),
  comment(
    2,
    POST,
    FAN_2,
    "Mine arrived with a cracked corner, who do I write to for a replacement?",
    25,
  ),
]
const POSTS = [
  {
    id: POST,
    message: "Our new broadband bass traps are here: 30 % less boom in small rooms.",
    permalink_url: `https://www.facebook.com/${PAGE}/posts/123450000000001`,
    created_time: ts(600),
    comments: { data: COMMENTS.map(({ from, created_time }) => ({ from, created_time })) },
  },
  {
    id: POST_2,
    message: "Studio tour: how we measure every panel before it leaves the workshop.",
    permalink_url: `https://www.facebook.com/${PAGE}/posts/123450000000002`,
    created_time: ts(2000),
    comments: { data: [] },
  },
]
const MESSAGES = [
  {
    id: "m_AaBbCc0000000001",
    from: FAN,
    message: "Hi! Is the 120 cm panel back in stock soon?",
    created_time: ts(30),
  },
  {
    id: "m_AaBbCc0000000002",
    from: { id: PAGE, name: PAGE_NAME },
    message: "Hi Camille, it is back next week.",
    created_time: ts(20),
  },
  {
    id: "m_AaBbCc0000000003",
    from: FAN,
    message: "Great, can you put one aside for me?",
    created_time: ts(10),
  },
]

function metaRoutes(): Parameters<typeof installFakeProviders>[1] {
  const fb = "graph.facebook.com"
  return [
    on(
      "GET",
      "/me/accounts",
      () => graphPage([{ id: PAGE, name: PAGE_NAME, access_token: PAGE_TOKEN }]),
      fb,
    ),
    on(
      "GET",
      "/me/assigned_instagram_accounts",
      () => graphPage([{ id: IG, username: "resonantaudiolabs" }]),
      fb,
    ),
    on("GET", "/me", () => ({ id: "10160000000000001", name: "Contract Recorder" }), fb),
    on("GET", "/app", () => ({ id: META_APP }), fb),
    on(
      "GET",
      "/oauth/access_token",
      () => ({ access_token: `${META_APP}|redacted`, token_type: "bearer" }),
      fb,
    ),
    // The host's client credentials grant (form POST): Meta answers the app access token.
    on(
      "POST",
      "/oauth/access_token",
      () => ({ access_token: `${META_APP}|${APP_SECRET}`, token_type: "bearer" }),
      fb,
    ),
    on(
      "GET",
      `/${META_APP}/subscriptions`,
      () =>
        graphPage([
          {
            object: "page",
            // Already set up: the recorded run checks it and changes nothing.
            callback_url: `${BASE_URL}/webhooks/${CONTRACT_ORG_ID}/social/meta`,
            active: true,
            fields: [
              { name: "feed", version: "v26.0" },
              { name: "messages", version: "v26.0" },
            ],
          },
        ]),
      fb,
    ),
    on("POST", `/${META_APP}/subscriptions`, () => ({ success: true }), fb),
    on(
      "GET",
      `/${PAGE}/subscribed_apps`,
      () => graphPage([{ id: META_APP, name: "Liaison", subscribed_fields: ["feed", "messages"] }]),
      fb,
    ),
    on("POST", `/${PAGE}/subscribed_apps`, () => ({ success: true }), fb),
    on("GET", `/${PAGE}/feed`, () => graphPage(POSTS), fb),
    on("GET", `/${PAGE}/posts`, () => graphPage(POSTS.map(({ comments: _c, ...p }) => p)), fb),
    on("GET", /^\/(\d+_\d+)\/comments$/, (_r, m) => graphPage(m?.[1] === POST ? COMMENTS : []), fb),
    on(
      "POST",
      /^\/(\d+_\d+)\/comments$/,
      (_r, m) => ({ id: `${(m?.[1] ?? "").split("_")[1]}_998800000000009` }),
      fb,
    ),
    on("POST", /^\/(\d+_\d+)\/likes$/, () => ({ success: true }), fb),
    on(
      "GET",
      `/${PAGE}/conversations`,
      () =>
        graphPage([
          {
            id: THREAD,
            updated_time: ts(10),
            participants: { data: [FAN, { id: PAGE, name: PAGE_NAME }] },
            messages: { data: [{ from: FAN, created_time: ts(10) }] },
          },
        ]),
      fb,
    ),
    on("GET", `/${THREAD}/messages`, () => graphPage([...MESSAGES].reverse()), fb),
    on(
      "POST",
      "/me/messages",
      () => ({ recipient_id: FAN.id, message_id: "m_AaBbCc0000000009" }),
      fb,
    ),
    on(
      "POST",
      `/${PAGE}/messages`,
      () => ({ recipient_id: FAN.id, message_id: "m_AaBbCc0000000009" }),
      fb,
    ),
  ]
}

function youtubeRoutes(): Parameters<typeof installFakeProviders>[1] {
  const yt = "www.googleapis.com"
  const snippet = {
    title: "Treating a small home studio: before and after measurements",
    description:
      "We tried Resonant Audio Labs bass traps in a 12 m² room. Here is the waterfall plot.",
    channelTitle: "Mix Room Notes",
    channelId: "UCxMixRoomNotes0000000001",
    publishedAt: "2025-12-30T18:00:00Z",
  }
  const thread = (id: string, text: string, author: string, minutesAgo: number) => ({
    kind: "youtube#commentThread",
    id,
    snippet: {
      videoId: VIDEO,
      topLevelComment: {
        kind: "youtube#comment",
        id,
        snippet: {
          videoId: VIDEO,
          textDisplay: text,
          textOriginal: text,
          authorDisplayName: author,
          authorChannelId: { value: "UCxViewer000000000000001" },
          likeCount: 2,
          publishedAt: ts(minutesAgo).replace("+0000", "Z"),
          updatedAt: ts(minutesAgo).replace("+0000", "Z"),
        },
      },
      canReply: true,
      totalReplyCount: 0,
      isPublic: true,
    },
  })
  return [
    on(
      "GET",
      "/search",
      () => ({
        kind: "youtube#searchListResponse",
        pageInfo: { totalResults: 1, resultsPerPage: 25 },
        items: [
          { kind: "youtube#searchResult", id: { kind: "youtube#video", videoId: VIDEO }, snippet },
        ],
      }),
      yt,
    ),
    on(
      "GET",
      "/commentThreads",
      () => ({
        kind: "youtube#commentThreadListResponse",
        pageInfo: { totalResults: 1, resultsPerPage: 100 },
        items: [
          thread(
            "UgxContractThread000001",
            "Which Resonant panel did you use on the back wall?",
            "Alex R.",
            50,
          ),
        ],
      }),
      yt,
    ),
    on(
      "GET",
      "/videos",
      () => ({ kind: "youtube#videoListResponse", items: [{ id: VIDEO, snippet }] }),
      yt,
    ),
    on(
      "GET",
      "/channels",
      () => ({
        kind: "youtube#channelListResponse",
        items: [{ id: CHANNEL, snippet: { title: PAGE_NAME } }],
      }),
      yt,
    ),
  ]
}

type Rec = Record<string, unknown>
const params = (p: Rec) => ({ params: p })

interface SocialState extends RecordingState {
  values: { findingId?: string; secondFindingId?: string; conversationId?: string; termId?: string }
}

/** Every value under key `key` in `v`, depth first. */
function valuesOf(v: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(v)) for (const x of v) valuesOf(x, key, out)
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Rec)) {
      if (k === key) out.push(x)
      valuesOf(x, key, out)
    }
  }
  return out
}

const pageEvent = (connectionName: string, identifier: string) => ({
  app: "kernel",
  entity: "connected_account",
  action: "create",
  orgId: CONTRACT_ORG_ID,
  entityId: "00000000-0000-4000-8000-0000000000a1",
  data: {
    id: "00000000-0000-4000-8000-0000000000a1",
    appName: APP,
    connectionName,
    identifier,
    kernelPublicBaseUrl: BASE_URL,
  },
})

const WEBHOOK_BODY = {
  object: "page",
  entry: [
    {
      id: PAGE,
      time: Math.floor(Date.parse(NOW) / 1000),
      changes: [
        {
          field: "feed",
          value: {
            from: { id: "6000000000000003", name: "Lena Okafor" },
            post: { status_type: "added_photos", is_published: true, id: POST },
            message: "Are these panels safe to mount above a radiator?",
            post_id: POST,
            comment_id: `${POST.split("_")[1]}_998800000000003`,
            created_time: Math.floor(Date.parse(NOW) / 1000) - 60,
            item: "comment",
            parent_id: POST,
            verb: "add",
          },
        },
      ],
    },
  ],
}

function signedWebhook(): { headers: Record<string, string>; body: string } {
  const body = JSON.stringify(WEBHOOK_BODY)
  return {
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`,
    },
    body,
  }
}

/** A gated tool parks itself on an approval, as its production run does. */
const parksOnApproval = () => ({
  requestApprovalImpl: (input: never) =>
    createHandlerApprovalRequest({
      orgId: CONTRACT_ORG_ID,
      requestedBy: CONTRACT_USER_ID,
      actorScopes: ["*"],
      defaultAppName: APP,
      input,
    }),
})

const finding = (s: SocialState) => {
  if (!s.values.findingId) throw new Error("no finding recorded yet")
  return s.values.findingId
}

const PLAN: RecordingStep<SocialState>[] = [
  // Connecting the Page seeds its sync rows and kicks a discovery run.
  {
    entry: "event:kernel/connected_account:create",
    input: () => params(pageEvent("facebook", PAGE)),
  },
  {
    entry: "event:kernel/connected_account:create",
    record: false,
    input: () => params(pageEvent("google", CHANNEL)),
  },
  {
    entry: "tool:monitor_terms_add",
    input: () =>
      params({
        value: "Resonant Audio Labs",
        kind: "keyword",
        platform: "youtube",
        notes: "Brand name as people write it",
      }),
  },
  {
    entry: "tool:monitor_terms_list",
    input: () => params({}),
    after: (a, s) => {
      s.values.termId = valuesOf(a, "id").find((x) => typeof x === "string") as string | undefined
    },
  },
  { entry: "job:discovery-sync", input: () => params({}) },
  {
    entry: "tool:watch_object",
    input: () =>
      params({
        platform: "facebook",
        external_id: POST_2,
        object_type: "facebook_post",
        priority: 80,
        reason: "manual",
      }),
  },
  { entry: "job:watch-poller", input: () => params({}) },
  { entry: "job:dm-sync", input: () => params({}) },
  { entry: "job:probe-webhook-upstream", input: () => params({}) },
  {
    entry: "webhook-verify:meta",
    input: () => {
      const d = signedWebhook()
      return params({ headers: d.headers, body: d.body, method: "POST", query: {} })
    },
  },
  {
    entry: "webhook:meta",
    input: () => {
      const d = signedWebhook()
      return { params: JSON.parse(d.body), extraArgs: [d.headers] }
    },
  },
  { entry: "job:parse-webhook", input: () => params({ platform: "facebook", body: WEBHOOK_BODY }) },
  {
    entry: "tool:findings_list",
    input: () => params({ platform: "facebook", status: "new", limit: 20 }),
    after: (a, s) => {
      const ids = valuesOf(a, "id").filter((x): x is string => typeof x === "string")
      s.values.findingId = ids[0]
      s.values.secondFindingId = ids[1]
    },
  },
  { entry: "tool:findings_get", input: (s) => params({ finding_id: finding(s) }) },
  {
    entry: "tool:set_triage",
    input: (s) =>
      params({
        finding_id: finding(s),
        triage_category: "question",
        urgency: 40,
        should_reply: true,
        triage_reason: "Shipping question a reply answers",
      }),
  },
  {
    entry: "tool:correct_triage",
    input: (s) =>
      params({
        finding_id: finding(s),
        triage_category: "complaint",
        urgency: 75,
        should_reply: true,
        triage_reason: "The customer says the order failed at checkout",
      }),
  },
  { entry: "tool:counts", input: () => params({}) },
  { entry: "preflight:like_item", input: (s) => params({ finding_id: finding(s) }) },
  {
    entry: "tool:like_item",
    bridgeOptions: parksOnApproval,
    input: (s) => params({ finding_id: finding(s) }),
  },
  {
    entry: "preflight:reply_to_finding",
    input: (s) =>
      params({
        finding_id: finding(s),
        reply_text:
          "Yes, we ship to Belgium. Pick Benelux at checkout, delivery takes 3 to 5 days.",
      }),
  },
  {
    entry: "tool:reply_to_finding",
    bridgeOptions: parksOnApproval,
    input: (s) =>
      params({
        finding_id: finding(s),
        reply_text:
          "Yes, we ship to Belgium. Pick Benelux at checkout, delivery takes 3 to 5 days.",
      }),
  },
  {
    entry: "tool:dismiss_finding",
    input: (s) => params({ finding_id: s.values.secondFindingId ?? finding(s) }),
  },
  {
    entry: "tool:dm_list",
    input: () => params({ status: "open", limit: 20 }),
    after: (a, s) => {
      s.values.conversationId = valuesOf(a, "id").find((x) => typeof x === "string") as
        | string
        | undefined
    },
  },
  {
    entry: "tool:dm_get",
    input: (s) => params({ conversation_id: s.values.conversationId ?? "" }),
  },
  {
    entry: "preflight:send_dm",
    input: (s) =>
      params({
        conversation_id: s.values.conversationId ?? "",
        body: "Of course Camille, one 120 cm panel is set aside in your name until Friday.",
      }),
  },
  {
    entry: "tool:send_dm",
    bridgeOptions: parksOnApproval,
    input: (s) =>
      params({
        conversation_id: s.values.conversationId ?? "",
        body: "Of course Camille, one 120 cm panel is set aside in your name until Friday.",
      }),
  },
  { entry: "tool:watched_list", input: () => params({ status: "active" }) },
  {
    entry: "tool:unwatch_object",
    input: () => params({ platform: "facebook", external_id: POST_2 }),
  },
  { entry: "tool:connections_status", input: () => params({}) },
  { entry: "tool:quota_status", input: () => params({}) },
  { entry: "preflight:webhooks_setup", input: () => params({ callback_base_url: BASE_URL }) },
  { entry: "tool:webhooks_setup", input: () => params({ callback_base_url: BASE_URL }) },
  { entry: "search:search", input: () => params({ query: "bass traps Belgium", limit: 10 }) },
  { entry: "attention:attention", input: () => params({}) },
  {
    entry: "tool:monitor_terms_remove",
    input: (s) =>
      params(
        s.values.termId
          ? { id: s.values.termId }
          : { value: "Resonant Audio Labs", platform: "youtube" },
      ),
  },
]

/** The stand-in token each connected account holds; the host adds it to a call that names it. */
const TOKENS: Record<string, string> = { facebook: USER_TOKEN, google: YT_TOKEN }

describe.skipIf(process.env.CONTRACT_RECORD !== "1")("record social contract fixtures", () => {
  let installed: Awaited<ReturnType<typeof installForRecording>>
  let fakes: FakeProviders

  beforeAll(async () => {
    await acquireTestLock()
    installed = await installForRecording(APP, CONFIG)
    for (const table of [
      "dm_message",
      "dm_conversation",
      "finding",
      "monitor_term",
      "sync_state",
      "watched_object",
    ]) {
      await sql`DELETE FROM ${sql(`app_${APP}`)}.${sql(table)} WHERE org_id = ${CONTRACT_ORG_ID}`
    }
    const K = sql(schemaRef("kernel"))
    await sql`DELETE FROM ${K}.connected_accounts WHERE org_id = ${CONTRACT_ORG_ID} AND app_name = ${APP}`
    for (const [connection, identifier, name] of [
      ["facebook", PAGE, PAGE_NAME],
      ["google", CHANNEL, PAGE_NAME],
    ] as const) {
      const token = encryptSecret(
        TOKENS[connection] as string,
        env.ENCRYPTION_KEY,
        CryptoContext.connectedAccountAccessToken,
      )
      await sql`INSERT INTO ${K}.connected_accounts
        (org_id, app_name, connection_name, owner_type, provider_type, identifier, display_name,
         access_token_encrypted, token_expires_at, status, created_by)
        VALUES (${CONTRACT_ORG_ID}, ${APP}, ${connection}, 'org', 'oauth2', ${identifier}, ${name},
         ${token}, now() + interval '10 years', 'active', ${CONTRACT_USER_ID})`
    }
    // The workspace's own Meta app (its OAuth client): the host's client credentials grant
    // turns it into the app token for the app-level subscription.
    await sql`DELETE FROM ${K}.oauth_providers WHERE org_id = ${CONTRACT_ORG_ID} AND name = 'social:facebook'`
    await sql`INSERT INTO ${K}.oauth_providers (org_id, name, issuer_url, client_id, client_secret_encrypted)
      VALUES (${CONTRACT_ORG_ID}, 'social:facebook', 'https://www.facebook.com', ${META_APP},
       ${encryptSecret(APP_SECRET, env.ENCRYPTION_KEY, CryptoContext.oauthProviderClientSecret)})`
    fakes = installFakeProviders(
      ["graph.facebook.com", "graph.instagram.com", "www.googleapis.com", "youtube.googleapis.com"],
      [...metaRoutes(), ...youtubeRoutes()],
    )
  }, 300_000)

  afterAll(async () => {
    fakes?.uninstall()
    await sql`DELETE FROM ${sql(schemaRef("kernel"))}.oauth_providers
      WHERE org_id = ${CONTRACT_ORG_ID} AND name = 'social:facebook'`
    await uninstallAfterRecording(APP)
    await releaseTestLock()
  })

  it("records every planned entry", async () => {
    const secrets = [
      APP_SECRET,
      USER_TOKEN,
      PAGE_TOKEN,
      IG_TOKEN,
      YT_TOKEN,
      CONFIG.webhookVerifyToken,
    ]
    const report = await runRecordingPlan<SocialState>({
      app: APP,
      manifest: installed.manifest,
      bridgeManifest: installed.bridgeManifest,
      plan: PLAN,
      state: { values: {} },
      replacements: secrets.map((s, i) => ({ from: s, to: `social-secret-stand-in-${i + 1}` })),
      secrets,
      recordedFrom:
        "the contract org on a local stack with documented Meta Graph and YouTube Data API answers (no sandbox account), record-social.recorder.ts",
      fixturesDir: join(import.meta.dir, "../../src/modules/apps/contract/fixtures"),
      appConfig: CONFIG,
    })
    console.log(
      `\n${report.join("\n")}\n\nprovider misses:\n${[...new Set(fakes.misses)].join("\n")}\n`,
    )
    expect(report.filter((l) => !l.startsWith("ok ") && !l.startsWith("  (prereq)"))).toEqual([])
    expect(fakes.misses).toEqual([])
  }, 900_000)
})
