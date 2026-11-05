// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `seedStandardWorld`: the `standard` tier. The QA world (`seed/world/qa.ts`)
// in an org that already has its admin: four teammates, fourteen channels and
// chats, contacts, knowledge, agent-app content and memory, tickets, Elodie's
// home feed, approvals in every resting state, saved views and mail.
//
// The api e2e and Playwright lanes seed it once per lane through the CLI
// (`liaison seed --tier standard --admin <email>`) and snapshot it; `bun run
// dev` seeds it into the dev database. People, threads, contacts and knowledge
// go through the services the product's routes call, as the person who acts;
// the resting rows are named privileged writers (`rows.ts`). Every instant is
// an offset from one `now`.
//
// Not idempotent: a second run into the same org is refused (the teammates
// exist), so a lane or a dev reset starts from an org with only its admin.
import { and, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { type SeedContext, seedContext } from "~/seed/context"
import { orgUserIdsByEmail } from "~/seed/factories/people/people"
import { QA_MEMBERS, type QaContactSpec, type QaThreadKey } from "~/seed/world/qa"
import { type StandardKnowledge, seedQaKnowledge } from "./knowledge"
import {
  applyApproverSplit,
  existingQaMembers,
  grantKnowledgeDimensions,
  type StandardPeople,
  type StandardPerson,
  seedQaMembers,
} from "./people"
import {
  type StandardMail,
  type StandardTickets,
  seedQaAgentApp,
  seedQaApprovals,
  seedQaAttention,
  seedQaMail,
  seedQaMemory,
  seedQaSavedViews,
  seedQaTickets,
} from "./rows"
import {
  qaActors,
  type StandardContact,
  type StandardThread,
  seedQaContacts,
  seedQaThreads,
} from "./threads"

export interface SeedStandardOptions {
  /** The org's admin (the instance's first account): the org is theirs. */
  adminEmail: string
  /** The world's `now`. Defaults to the moment of the call. */
  now?: Date
  log?: (msg: string) => void
}

/** What a lane hands its specs: every person, thread and contact by key. */
export interface StandardWorld extends StandardPeople {
  orgId: string
  threads: Record<QaThreadKey, StandardThread>
  contacts: Record<QaContactSpec["key"], StandardContact>
  knowledge: StandardKnowledge
  tickets: StandardTickets
  mail: StandardMail
}

/** The world's `now`: the one given, else the moment of the call. */
function worldNow(now: Date | undefined): Date {
  return now ?? new Date()
}

async function findAdmin(email: string): Promise<StandardPerson & { orgId: string }> {
  const rows = await withSystemDb("seed-standard:admin", (tx) =>
    tx
      .select({ id: users.id, email: users.email, name: users.name, orgId: users.orgId })
      .from(users)
      .where(and(eq(users.email, email.toLowerCase()))),
  )
  if (rows.length !== 1) {
    throw new Error(
      rows.length === 0
        ? `standard seed: no account ${email}; create the org and its admin first`
        : `standard seed: ${email} has an account in ${rows.length} orgs; seed one org at a time`,
    )
  }
  const [row] = rows as [(typeof rows)[number]]
  return { id: row.id, email: row.email, name: row.name ?? email, orgId: row.orgId }
}

export async function seedStandardWorld(options: SeedStandardOptions): Promise<StandardWorld> {
  const log = options.log ?? (() => {})
  const admin = await findAdmin(options.adminEmail)
  const present = await existingQaMembers(admin.orgId)
  if (present.length > 0) {
    throw new Error(
      `standard seed: the org already has ${present.join(", ")}; seed the standard world into an org with only its admin`,
    )
  }
  const ctx: SeedContext = seedContext({
    orgId: admin.orgId,
    now: worldNow(options.now),
    log,
  })
  const encryptionKey = env.ENCRYPTION_KEY
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now()
    const out = await fn()
    log(`${name} ${((performance.now() - t0) / 1000).toFixed(1)}s`)
    return out
  }

  const people = await step("people", async () => {
    const p = await seedQaMembers(ctx, { id: admin.id, email: admin.email, name: admin.name })
    await applyApproverSplit(ctx, p)
    return p
  })
  const actors = await qaActors(ctx, people)
  const contacts = await step("contacts", () => seedQaContacts(ctx, actors))
  const threads = await step("threads", () => seedQaThreads(ctx, people, actors))
  await step("agent app", () => seedQaAgentApp(ctx, people))
  await step("knowledge grants", () => grantKnowledgeDimensions(ctx, people))
  await step("memory", () => seedQaMemory(ctx, people))
  const knowledge = await step("knowledge", () => seedQaKnowledge(ctx, admin.id, encryptionKey))
  const tickets = await step("tickets", () => seedQaTickets(ctx, people))
  await step("attention", () => seedQaAttention(ctx, people))
  await step("approvals", () =>
    seedQaApprovals(ctx, people, {
      primary: threads.q2Marketing.id,
      originating: threads.bugCheckout.id,
    }),
  )
  await step("saved views", () => seedQaSavedViews(ctx, people))
  const mail = await step("mail", () => seedQaMail(ctx, people, encryptionKey))

  return { orgId: admin.orgId, ...people, threads, contacts, knowledge, tickets, mail }
}

/**
 * Put the agent-app baseline back (skills, routines, agent chats, past runs)
 * in an org the standard world was seeded into: rows already there are kept.
 */
export async function seedStandardAgentApp(options: SeedStandardOptions): Promise<void> {
  const admin = await findAdmin(options.adminEmail)
  const ids = await orgUserIdsByEmail(admin.orgId)
  const people = { admin: { id: admin.id, email: admin.email, name: admin.name } } as StandardPeople
  for (const m of QA_MEMBERS) {
    const id = ids.get(m.email)
    if (!id)
      throw new Error(`standard seed: ${m.email} is not in this org; seed the standard world first`)
    people[m.key] = { id, email: m.email, name: m.name }
  }
  const ctx = seedContext({ orgId: admin.orgId, now: worldNow(options.now), log: options.log })
  await seedQaAgentApp(ctx, people)
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0) return argv[i + 1]
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
}

/**
 * `liaison seed --tier standard --admin <email> [--now <iso>] [--only agent-app]`.
 * Progress goes to stderr; the seeded world (ids by key) is the one line
 * printed on stdout, as JSON, for the lane or script that ran it. `--only
 * agent-app` puts the agent-app baseline back in an already seeded org.
 */
export async function runSeedStandardCli(
  argv: readonly string[],
): Promise<{ exitCode: 0 | 1 | 2; world?: StandardWorld }> {
  const adminEmail = flag(argv, "admin")
  if (!adminEmail) {
    console.error("[standard-seed] --admin <email> is required")
    return { exitCode: 2 }
  }
  const nowFlag = flag(argv, "now")
  const now = nowFlag ? new Date(nowFlag) : undefined
  if (now && Number.isNaN(now.getTime())) {
    console.error(`[standard-seed] --now ${nowFlag} is not an instant`)
    return { exitCode: 2 }
  }
  const only = flag(argv, "only")
  if (only !== undefined && only !== "agent-app") {
    console.error(`[standard-seed] --only ${only}: the one part that re-runs is agent-app`)
    return { exitCode: 2 }
  }
  const started = performance.now()
  try {
    if (only === "agent-app") {
      await seedStandardAgentApp({ adminEmail, now })
      console.error(`[standard-seed] agent-app baseline restored`)
      return { exitCode: 0 }
    }
    const world = await seedStandardWorld({
      adminEmail,
      now,
      log: (msg) => console.error(`[standard-seed] ${msg}`),
    })
    console.error(
      `[standard-seed] org ${world.orgId} seeded in ${((performance.now() - started) / 1000).toFixed(1)}s`,
    )
    process.stdout.write(`${JSON.stringify(world)}\n`)
    return { exitCode: 0, world }
  } catch (err) {
    console.error(
      `[standard-seed] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    )
    return { exitCode: 1 }
  }
}
