// SPDX-License-Identifier: FSL-1.1-ALv2
//
// E2E harness: the mail app's sandboxed Gmail calls name Google directly
// (`https://gmail.googleapis.com/...`), while the tickets host code already
// honours TICKETS_E2E_GMAIL_API_BASE_URL. With that variable set, this routes
// the sandbox's Gmail calls to the same fixture, so a scenario can send mail
// from either app. Without it nothing changes.

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

const GMAIL_HOST = "gmail.googleapis.com"

function fixtureBase(): string | null {
  const base = process.env.TICKETS_E2E_GMAIL_API_BASE_URL
  return base ? base.replace(/\/gmail\/v1\/?$/, "").replace(/\/+$/, "") : null
}

export function gmailFixtureHandlesHost(hostname: string): boolean {
  return fixtureBase() !== null && hostname === GMAIL_HOST
}

export function makeGmailFixtureFetch(inner: typeof fetch): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const base = fixtureBase()
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return inner(input, init)
    }
    if (!base || parsed.hostname !== GMAIL_HOST) return inner(input, init)
    return inner(`${base}${parsed.pathname}${parsed.search}`, init)
  }) as typeof fetch
}
