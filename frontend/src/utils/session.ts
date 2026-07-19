/**
 * Session utilities — shared across all pages.
 *
 * In a real app, the JWT comes from the server.  Here we issue a
 * client-side signed placeholder so the ProtectedRoute guard passes.
 */

export interface SessionData {
  userId:     string
  name?:      string
  age?:       number
  publicKey?: string
  safeScore?: number
  flow?:      'high' | 'moderate' | 'low'
  factors?:   string[]
  loginAt?:   string
}

/** Persists session + a placeholder JWT so /dashboard is accessible. */
export function saveSession(data: SessionData) {
  const session: SessionData = { ...data, loginAt: new Date().toISOString() }
  localStorage.setItem('cipher_session', JSON.stringify(session))
  // Real implementation: store the JWT returned by the server.
  // Here we store a non-empty placeholder so the guard passes.
  localStorage.setItem('cipher_jwt', `mock.jwt.${btoa(data.userId)}.${Date.now()}`)
}

export function getSession(): SessionData | null {
  try {
    const raw = localStorage.getItem('cipher_session')
    return raw ? (JSON.parse(raw) as SessionData) : null
  } catch (_e) { return null }
}

export function clearSession() {
  localStorage.removeItem('cipher_session')
  localStorage.removeItem('cipher_jwt')
}

export function hasValidJwt(): boolean {
  return !!localStorage.getItem('cipher_jwt')
}
