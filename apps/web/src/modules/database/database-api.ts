// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The database connector's settings client: the only place the web app names
// its routes.

import type { DatabaseDomainAccess, DatabaseDomainAccessView } from "@liaison/shared"
import type { ApiClient } from "~/lib/api-client"

const BASE = "/database"

export function getDomainAccess(api: ApiClient): Promise<DatabaseDomainAccessView> {
  return api.get<DatabaseDomainAccessView>(`${BASE}/domain-access`, { suppressGlobalError: true })
}

export function putDomainAccess(
  api: ApiClient,
  domainAccess: DatabaseDomainAccess,
): Promise<DatabaseDomainAccessView> {
  return api.put<DatabaseDomainAccessView>(
    `${BASE}/domain-access`,
    { domainAccess },
    { suppressGlobalError: true },
  )
}
