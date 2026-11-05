// SPDX-License-Identifier: FSL-1.1-ALv2
import { api } from "./http"

interface User {
  id: string
  token: string
}

interface Thread {
  id: string
  handle: string
  title: string | null
  initialMessageId?: string
}

interface Message {
  id: string
  threadId: string
  content: string
}

export class ThreadsPlugin {
  private serverUrl: string

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl
  }

  async create(
    user: User,
    opts: {
      participantIds: string[]
      title?: string
      isPinned?: boolean
      initialMessage?: { content: string }
      createdFrom?: { app: string; entityType: string; entityId: string }
      forceCreate?: boolean
    },
  ): Promise<Thread> {
    // A seeded world deliberately builds many distinct threads over the same
    // small cast, which the duplicate-thread guard would otherwise refuse with
    // 409 (that guard exists for agents messaging a teammate, not for fixtures).
    // Callers can still pass forceCreate: false to exercise the guard itself.
    const body = { forceCreate: true, ...opts }
    const res = await api(this.serverUrl, "/api/threads", { token: user.token, body })
    if (res.status !== 200) {
      throw new Error(`threads.create failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
    return res.body.data
  }

  async sendMessage(thread: Thread, user: User, content: string): Promise<Message> {
    const res = await api(this.serverUrl, `/api/threads/${thread.id}/messages`, {
      token: user.token,
      body: { content },
    })
    if (res.status !== 200) {
      throw new Error(`threads.sendMessage failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
    return { id: res.body.data.id, threadId: thread.id, content }
  }
}
