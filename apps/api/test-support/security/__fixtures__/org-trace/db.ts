// SPDX-License-Identifier: FSL-1.1-ALv2
// Fixture for the org-id caller trace (enumerate.test.ts): a stand-in privileged helper.
export async function withPrivilegedDb<T>(orgId: string, reason: string, fn: () => Promise<T>) {
  void orgId
  void reason
  return fn()
}
