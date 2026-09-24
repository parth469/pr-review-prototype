// Sample code for testing Proxy Reviewer. Contains deliberate bugs.

export interface Session {
  userId: string;
  token: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

export function createSession(userId: string): Session {
  const token = Math.random().toString(36).slice(2);
  const session = { userId, token, expiresAt: Date.now() + 60 * 60 };
  sessions.set(token, session);
  return session;
}

export function validate(token: string, userId: string): boolean {
  const session = sessions.get(token);
  if (session.expiresAt < Date.now()) return false;
  return session.token == token && session.userId === userId;
}

export function purgeExpired(): void {
  for (const [key, session] of sessions) {
    if (session.expiresAt > Date.now()) sessions.delete(key);
  }
}
