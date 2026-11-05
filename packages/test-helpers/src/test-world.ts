// SPDX-License-Identifier: FSL-1.1-ALv2
import { bootstrap, createUserWithScopes, login } from "./auth"
import type { DbClient } from "./db"
import { SeededRng } from "./rng"
import { ThreadsPlugin } from "./test-world-threads"
import { connectWs } from "./ws"

// Realistic name pools — deterministically picked via SeededRng
const FIRST_NAMES = [
  "Alice",
  "Bob",
  "Carlos",
  "Diana",
  "Ethan",
  "Fatima",
  "Gabriel",
  "Hannah",
  "Ivan",
  "Julia",
  "Kai",
  "Lena",
  "Marco",
  "Nadia",
  "Oscar",
  "Priya",
  "Quinn",
  "Rosa",
  "Sam",
  "Tina",
  "Umar",
  "Vera",
  "Will",
  "Xena",
  "Yuki",
  "Zara",
  "Amir",
  "Bianca",
  "Chen",
  "Daria",
  "Eli",
  "Freya",
  "Hugo",
  "Isla",
  "Joel",
  "Kira",
  "Leo",
  "Maya",
  "Nico",
  "Olivia",
  "Pavel",
  "Rita",
  "Sven",
  "Tara",
  "Uma",
  "Viktor",
  "Wendy",
  "Xavier",
]
const LAST_NAMES = [
  "Andersen",
  "Becker",
  "Chen",
  "Dupont",
  "Evans",
  "Ferreira",
  "Garcia",
  "Hansen",
  "Ivanov",
  "Jensen",
  "Kim",
  "Laurent",
  "Morales",
  "Nakamura",
  "Okafor",
  "Petrov",
  "Quinn",
  "Rossi",
  "Santos",
  "Torres",
  "Ueda",
  "Vogt",
  "Wu",
  "Xu",
  "Yamamoto",
  "Zhang",
  "Berg",
  "Costa",
  "Diaz",
  "Fischer",
  "Gomez",
  "Hart",
  "Johansson",
  "Kowalski",
  "Lin",
  "Mendez",
  "Novak",
  "Park",
  "Reeves",
  "Silva",
  "Tanaka",
  "Virtanen",
  "Weber",
]
const THREAD_TOPICS = [
  "Q2 Marketing Plan",
  "Website Redesign",
  "Bug in checkout flow",
  "Onboarding improvements",
  "Sprint retrospective",
  "Hiring update",
  "Customer feedback review",
  "API rate limiting",
  "Launch timeline",
  "Budget approval",
  "Team offsite planning",
  "Security audit findings",
  "Mobile app beta",
  "Sales pipeline review",
  "Infra migration plan",
  "Design system v2",
  "Pricing strategy",
  "Partner integration",
  "Support escalation process",
  "Product roadmap sync",
  "Weekly standup notes",
  "Competitive analysis",
  "Data pipeline issues",
  "Release checklist",
  "Vendor evaluation",
  "Content calendar",
  "Performance review prep",
  "Incident post-mortem",
  "Feature flag cleanup",
  "New office setup",
]

/** Users created at once by `addUsers`. */
const ADD_USERS_CONCURRENCY = 4

interface WorldConfig {
  seed: number
  org?: { name?: string }
  schemaPrefix?: string
  admin?: { email?: string; password?: string; name?: string }
  /** The org and admin already exist (a shared e2e lane): sign in, do not register. */
  existingAdmin?: boolean
}

interface UserSpec {
  role?: string
  scopes?: string[]
  name?: string
  count?: number
}

interface PopulateConfig {
  users?: { count: number }
  threads?: {
    count: number
    participants: string // "random(min-max)"
    messages: string // "random(min-max)"
  }
}

interface PopulateSummary {
  users: number
  threads: number
  messages: number
}

interface WorldUser {
  id: string
  email: string
  token: string
  name: string
}

export class TestWorld {
  readonly serverUrl: string
  readonly admin: { id: string; email: string; token: string; name: string }
  readonly org: { id: string; name: string }
  readonly threads: ThreadsPlugin

  private _users: WorldUser[] = []
  private rng: SeededRng
  private db: DbClient
  private schemaPrefix: string
  private wsConnections: Array<{ close(): void }> = []
  private adminPassword: string

  private constructor(
    serverUrl: string,
    admin: { id: string; email: string; token: string; name: string },
    org: { id: string; name: string },
    db: DbClient,
    seed: number,
    schemaPrefix: string,
    adminPassword: string,
  ) {
    this.serverUrl = serverUrl
    this.admin = admin
    this.org = org
    this.db = db
    this.rng = new SeededRng(seed)
    this.schemaPrefix = schemaPrefix
    this.threads = new ThreadsPlugin(serverUrl)
    this.adminPassword = adminPassword
  }

  /**
   * Re-login the admin and replace the cached token. Useful when a long-lived
   * worker-scope fixture's `admin.token` has gone stale due to a permission
   * mutation in an earlier test.
   */
  async refreshAdminToken(): Promise<string> {
    const res = await login(this.serverUrl, this.admin.email, this.adminPassword)
    ;(this.admin as { token: string }).token = res.accessToken
    return res.accessToken
  }

  get users(): WorldUser[] {
    return [
      {
        id: this.admin.id,
        email: this.admin.email,
        token: this.admin.token,
        name: this.admin.name,
      },
      ...this._users,
    ]
  }

  /** WebSocket helpers — connections are tracked for cleanup in destroy() */
  get ws() {
    const self = this
    return {
      async connect(user: { token: string }, lastEventId?: number) {
        const client = await connectWs(self.serverUrl, user.token, lastEventId)
        self.wsConnections.push(client)
        return client
      },
    }
  }

  static async create(serverUrl: string, db: DbClient, config: WorldConfig): Promise<TestWorld> {
    const adminEmail = config.admin?.email ?? "admin@e2e.test"
    const adminName = config.admin?.name ?? "E2E Admin"
    const adminPassword = config.admin?.password ?? "SecurePass1!"
    const b = await bootstrap(serverUrl, { ...config.admin, existing: config.existingAdmin })
    return new TestWorld(
      serverUrl,
      { id: b.userId, email: adminEmail, token: b.accessToken, name: adminName },
      { id: b.orgId, name: config.org?.name ?? "E2E Org" },
      db,
      config.seed,
      config.schemaPrefix ?? "",
      adminPassword,
    )
  }

  async addUsers(specs: UserSpec[]): Promise<WorldUser[]> {
    // Every random draw happens here, in order, before any request goes out,
    // so the names and emails are exactly what a one-at-a-time loop produced.
    const planned: Array<Parameters<typeof createUserWithScopes>[4]> = []
    for (const spec of specs) {
      const count = spec.count ?? 1
      for (let i = 0; i < count; i++) {
        const name = spec.name ?? `User-${this._users.length + planned.length + 1}`
        const pfx = this.schemaPrefix ? this.schemaPrefix.replace(/_$/, "-") : ""
        const email = `${pfx}${name.toLowerCase().replace(/\s+/g, "-")}-${this.rng.int(100000, 999999)}@test.local`
        planned.push({
          email,
          name,
          scopes: spec.scopes ?? [
            "kernel:threads:read",
            "kernel:threads:write",
            "kernel:users:read",
            "kernel:agent:memory",
            "kernel:agent:web",
          ],
          schemaPrefix: this.schemaPrefix,
        })
      }
    }
    const createOne = async (opts: (typeof planned)[number]): Promise<WorldUser> => {
      try {
        return await createUserWithScopes(
          this.serverUrl,
          this.db.sql,
          this.admin.token,
          this.org.id,
          opts,
        )
      } catch (err) {
        // permission_version drift in long-running fixtures can stale the
        // cached admin token. Re-login once and retry.
        if (err instanceof Error && err.message.includes("401")) {
          await this.refreshAdminToken()
          return createUserWithScopes(
            this.serverUrl,
            this.db.sql,
            this.admin.token,
            this.org.id,
            opts,
          )
        }
        throw err
      }
    }
    // Each user is an invite plus a registration (a password hash on the
    // server): a few at a time instead of one after another. `created` keeps
    // the planned order whatever order the requests finish in.
    const created: WorldUser[] = new Array(planned.length)
    let next = 0
    const lane = async () => {
      while (next < planned.length) {
        const i = next++
        created[i] = await createOne(planned[i])
      }
    }
    await Promise.all(Array.from({ length: Math.min(ADD_USERS_CONCURRENCY, planned.length) }, lane))
    this._users.push(...created)
    return created
  }

  async populate(config: PopulateConfig): Promise<PopulateSummary> {
    let usersCreated = 0
    let threadsCreated = 0
    let messagesCreated = 0

    // Create users if needed
    if (config.users && config.users.count > 0) {
      const currentUserCount = this.users.length
      const needed = config.users.count - currentUserCount
      if (needed > 0) {
        const adminSpecs: UserSpec[] = []
        const memberSpecs: UserSpec[] = []
        const usedNames = new Set<string>()
        const pickName = (): string => {
          for (let attempt = 0; attempt < 100; attempt++) {
            const full = `${this.rng.pick(FIRST_NAMES)} ${this.rng.pick(LAST_NAMES)}`
            if (!usedNames.has(full)) {
              usedNames.add(full)
              return full
            }
          }
          // Fallback for very large pools — append a digit
          const full = `${this.rng.pick(FIRST_NAMES)} ${this.rng.pick(LAST_NAMES)} ${usedNames.size}`
          usedNames.add(full)
          return full
        }
        // 20% admins, 80% members
        const adminCount = Math.max(1, Math.floor(needed * 0.2))
        for (let i = 0; i < adminCount; i++) {
          adminSpecs.push({
            name: pickName(),
            scopes: [
              "kernel:admin",
              "kernel:threads:read",
              "kernel:threads:write",
              "kernel:agent:memory",
              "kernel:agent:web",
            ],
          })
        }
        for (let i = 0; i < needed - adminCount; i++) {
          memberSpecs.push({
            name: pickName(),
            scopes: [
              "kernel:threads:read",
              "kernel:threads:write",
              "kernel:agent:memory",
              "kernel:agent:web",
            ],
          })
        }
        const admins = await this.addUsers(adminSpecs)
        const members = await this.addUsers(memberSpecs)
        usersCreated = admins.length + members.length
      }
    }

    // Create threads
    if (config.threads && config.threads.count > 0) {
      const participantRange = parseRange(config.threads.participants)
      const messageRange = parseRange(config.threads.messages)
      const allUsers = this.users

      // Shuffle topics so each named thread gets a unique one
      const shuffledTopics = [...THREAD_TOPICS]
      for (let i = shuffledTopics.length - 1; i > 0; i--) {
        const j = this.rng.int(0, i)
        ;[shuffledTopics[i], shuffledTopics[j]] = [shuffledTopics[j], shuffledTopics[i]]
      }
      let topicIdx = 0

      for (let t = 0; t < config.threads.count; t++) {
        const creator = this.rng.pick(allUsers)
        const participantCount = this.rng.int(participantRange.min, participantRange.max)
        const others = allUsers.filter((u) => u.id !== creator.id)
        const participants = this.rng.pickN(others, Math.min(participantCount, others.length))

        // ~30% get a real topic title, ~70% have no title (derive display name from participants)
        let title: string | undefined
        if (this.rng.int(0, 2) === 0 && topicIdx < shuffledTopics.length) {
          title = shuffledTopics[topicIdx++]
        }

        const thread = await this.threads.create(creator, {
          participantIds: participants.map((p) => p.id),
          title,
          initialMessage: { content: `Initial message for thread ${t + 1}` },
        })
        threadsCreated++
        messagesCreated++ // initial message

        const messageCount = this.rng.int(messageRange.min, messageRange.max)
        const threadParticipants = [creator, ...participants]
        for (let m = 0; m < messageCount; m++) {
          const sender = this.rng.pick(threadParticipants)
          await this.threads.sendMessage(thread, sender, `Message ${m + 1} in thread ${t + 1}`)
          messagesCreated++
        }
      }
    }

    return {
      users: usersCreated,
      threads: threadsCreated,
      messages: messagesCreated,
    }
  }

  /**
   * Closes all WS connections created via world.ws.connect().
   * DB cleanup is the responsibility of WorkerEnv.teardown() since
   * the DB client is shared and externally owned.
   */
  async destroy(): Promise<void> {
    for (const ws of this.wsConnections) {
      ws.close()
    }
    this.wsConnections = []
  }
}

function parseRange(spec: string): { min: number; max: number } {
  const match = spec.match(/^random\((\d+)-(\d+)\)$/)
  if (!match) {
    const n = Number(spec)
    return { min: n, max: n }
  }
  return { min: Number(match[1]), max: Number(match[2]) }
}
