// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The fixture's one read tool. A real metrics app proxies a service; this one
// answers a fixed registry so the scenario can assert exactly what the UI lists.

export const METRICS = [
  { id: "members.active", title: "Active members", version: "1.2.0" },
  { id: "revenue.monthly", title: "Monthly revenue", version: "2.0.1" },
  { id: "basket.average", title: "Average basket", version: "1.0.0" },
]

export async function metricsListHandler(): Promise<{
  data: { formulaVersion: string; metrics: typeof METRICS }
}> {
  return { data: { formulaVersion: "3.1.0", metrics: METRICS } }
}
