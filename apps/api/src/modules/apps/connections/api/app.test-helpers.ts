// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only: register the api-connector catalog app for a test org, from its
// source, as an org that installed it has it (its tools, its approvals).
import { apiConnectorSourceDescriptor } from "~/db/apply-app-schemas"
import { registerApps } from "~/modules/apps/runtime"

export async function registerApiConnectorApp(orgId: string): Promise<void> {
  const { failedApps } = await registerApps([apiConnectorSourceDescriptor()], orgId)
  if (failedApps.length > 0) throw new Error("api-connector did not register")
}
