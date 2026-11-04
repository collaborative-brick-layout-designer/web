// Revocation notifications, so long-lived connections (the realtime
// WebSocket) can be dropped the moment the credential that opened them
// ends — logout, "revoke all sessions", user deletion, or an API token
// being revoked — instead of living on until the socket closes by itself.

export type CredentialRevocation =
  | { sessionId: string }
  | { tokenId: string }
  /**
   * Every credential of one person. `reason`, when the account itself
   * changed (privacy) or the demo was reset or turned off, is the
   * WebSocket close reason, so the web and the
   * desktop can say why instead of "not signed in".
   */
  | { userId: string; reason?: 'account_pending_deletion' | 'account_restricted' | 'demo_reset' | 'demo_off' };

const revocationListeners = new Set<(r: CredentialRevocation) => void>();

export function onCredentialRevoked(listener: (r: CredentialRevocation) => void): () => void {
  revocationListeners.add(listener);
  return () => revocationListeners.delete(listener);
}

export function notifyCredentialRevoked(r: CredentialRevocation): void {
  for (const l of revocationListeners) {
    try {
      l(r);
    } catch {
      /* a listener's failure must not break logout / revoke */
    }
  }
}
