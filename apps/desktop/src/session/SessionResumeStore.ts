// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which Claude Code session a (agent, folder) pair is already in the middle
// of, so reopening the same folder with the same agent continues the
// conversation instead of meeting a stranger.
//
// Keyed by the folder's DIGEST rather than its path (`folder-hash.ts`). The
// server is the reason the digest exists, but the key benefits too: the digest
// normalizes the casing and the trailing separator, so the same folder picked
// twice from a native dialog is one key rather than two.
//
// localStorage, and nothing depends on it surviving: a window that refuses
// storage starts a fresh session, which is the same thing that happens the
// first time. It is never authority for anything the server cares about.

export function sessionIdKey(agentId: string, folderHash: string): string {
  return `liaison-desktop:session-id:${agentId}:${folderHash}`
}

/**
 * One stored session: its id, and the checksum of the agent definition it was
 * CREATED with (2026-09-23). A resumed session carries its whole transcript,
 * and a transcript beats a system prompt: an org fixed its agent's definition
 * after a wrong answer, the desktop resumed the session holding that answer,
 * and the model repeated it about one run in three. So a definition that
 * changed since the session was created starts a new one
 * (`start-local-session.ts`), and that needs the checksum it was created with.
 *
 * `definitionChecksum` is null for an entry written before this field existed
 * (a bare id string): which definition that session ran with is unknown.
 */
export interface StoredSession {
  sessionId: string
  definitionChecksum: string | null
}

export function getSessionEntry(agentId: string, folderHash: string): StoredSession | null {
  let stored: string | null
  try {
    stored = localStorage.getItem(sessionIdKey(agentId, folderHash))
  } catch {
    return null
  }
  if (!stored) return null
  if (!stored.startsWith("{")) return { sessionId: stored, definitionChecksum: null }
  try {
    const parsed = JSON.parse(stored) as { sessionId?: unknown; definitionChecksum?: unknown }
    if (typeof parsed.sessionId !== "string" || !parsed.sessionId) return null
    return {
      sessionId: parsed.sessionId,
      definitionChecksum:
        typeof parsed.definitionChecksum === "string" && parsed.definitionChecksum
          ? parsed.definitionChecksum
          : null,
    }
  } catch {
    // An entry this build cannot read is a session it cannot resume.
    return null
  }
}

export function getSessionId(agentId: string, folderHash: string): string | null {
  return getSessionEntry(agentId, folderHash)?.sessionId ?? null
}

/**
 * A null id FORGETS the pair: a stale id is worse than a fresh session. The
 * checksum is the definition the session was created with; without one the
 * entry reads back as a session of unknown definition.
 */
export function setSessionId(
  agentId: string,
  folderHash: string,
  sessionId: string | null,
  definitionChecksum: string | null = null,
): void {
  try {
    const key = sessionIdKey(agentId, folderHash)
    if (!sessionId) {
      localStorage.removeItem(key)
      return
    }
    localStorage.setItem(key, JSON.stringify({ sessionId, definitionChecksum }))
  } catch {
    // A window that refuses storage simply never resumes.
  }
}
