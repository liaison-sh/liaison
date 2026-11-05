// SPDX-License-Identifier: FSL-1.1-ALv2
export type ImapFetchMode = "incremental" | "initial"

export type ImapFakeMessage = {
  messageId: string
  uid?: number
  subject?: string
  from?: { email: string; name?: string }
  to?: Array<{ email: string; name?: string }>
  cc?: Array<{ email: string; name?: string }>
  textBody?: string
  htmlBody?: string
  inReplyTo?: string
  references?: string[]
  receivedAt?: string
  raw?: string
}

export type ImapFetchResult = {
  messages: ImapFakeMessage[]
  cursor?: string
  uidValidity?: string
}

export type ImapFetchCall = {
  accountEmail: string
  mode: ImapFetchMode
  cursor?: string
  receivedAt: number
}

export type ImapInjectedError = { code: string; message: string }

export type ImapFakeController = {
  queueMessages(accountEmail: string, messages: ImapFakeMessage[]): void
  injectError(accountEmail: string, error: ImapInjectedError): void
  setUidValidity(accountEmail: string, uidValidity: string): void
  callFetch(
    accountEmail: string,
    opts: { mode: ImapFetchMode; cursor?: string },
  ): Promise<ImapFetchResult>
  fetchCalls(accountEmail?: string): ImapFetchCall[]
  assertFetched(accountEmail: string): ImapFetchCall[]
  uninstall(): void
}

const accountState = new Map<
  string,
  { messages: ImapFakeMessage[]; error: ImapInjectedError | null; uidValidity?: string }
>()
const fetchLog: ImapFetchCall[] = []
let installed = false

function getState(account: string) {
  let state = accountState.get(account)
  if (!state) {
    state = { messages: [], error: null }
    accountState.set(account, state)
  }
  return state
}

export function installImapFake(): ImapFakeController {
  installed = true
  return {
    queueMessages(account, messages) {
      getState(account).messages.push(...messages)
    },
    injectError(account, error) {
      getState(account).error = error
    },
    setUidValidity(account, uidValidity) {
      getState(account).uidValidity = uidValidity
    },
    async callFetch(account, opts) {
      if (!installed) throw new Error("imap fake not installed")
      fetchLog.push({
        accountEmail: account,
        mode: opts.mode,
        cursor: opts.cursor,
        receivedAt: Date.now(),
      })
      const state = getState(account)
      if (state.error) {
        const err = state.error
        state.error = null
        const e = new Error(err.message) as Error & { code?: string }
        e.code = err.code
        throw e
      }
      const messages = state.messages.splice(0, state.messages.length)
      return {
        messages,
        cursor: messages.length > 0 ? String(Date.now()) : opts.cursor,
        uidValidity: state.uidValidity,
      }
    },
    fetchCalls(account) {
      if (!account) return fetchLog.slice()
      return fetchLog.filter((c) => c.accountEmail === account)
    },
    assertFetched(account) {
      return fetchLog.filter((c) => c.accountEmail === account)
    },
    uninstall() {
      installed = false
      accountState.clear()
      fetchLog.length = 0
    },
  }
}
