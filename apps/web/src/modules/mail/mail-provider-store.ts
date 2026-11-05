// SPDX-License-Identifier: FSL-1.1-ALv2
import { createStore } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"

interface MailApi {
  get: <T = unknown>(path: string) => Promise<T>
}

export interface MailProvider {
  id: string
  label: string
  kind: string
  enabled: boolean
  integrationConfigured: boolean
  configurationSource: "org" | "deployment" | null
  supportedOwnerTypes: Array<"user" | "org">
}

interface MailProviderStoreState {
  byId: Record<string, MailProvider>
}

const [mailProviderStore, setMailProviderStore] = createStore<MailProviderStoreState>({
  byId: {},
})

export { mailProviderStore }

export function getMailProvider(providerId: string): MailProvider | undefined {
  return mailProviderStore.byId[providerId]
}

export async function loadMailProviders(api: MailApi): Promise<void> {
  const providers = await api.get<MailProvider[]>("/mail/providers")
  const byId: Record<string, MailProvider> = {}

  for (const provider of providers) {
    byId[provider.id] = provider
  }

  setMailProviderStore({ byId })
}

export function resetMailProviderStore(): void {
  setMailProviderStore({ byId: {} })
}

onSessionTeardown(resetMailProviderStore)
