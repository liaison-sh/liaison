// SPDX-License-Identifier: FSL-1.1-ALv2
/** Remove all localStorage and sessionStorage keys with the `liaison:` prefix.
 *  Called on logout to prevent cross-session data leaks. */
export function clearLiaisonStorage(): void {
  const lsKeys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith("liaison:")) lsKeys.push(k)
  }
  for (const k of lsKeys) localStorage.removeItem(k)

  const ssKeys: string[] = []
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i)
    if (k?.startsWith("liaison:")) ssKeys.push(k)
  }
  for (const k of ssKeys) sessionStorage.removeItem(k)
}
