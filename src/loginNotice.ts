import type { EmbeddedWebAppApi } from './types.js';

export type LoginNotice = 'none' | 'log-in' | 'read-only';

/**
 * Which access notice the panel shows for the admin UI's login status.
 *
 * Reading needs no login; muting, feedback, rules and replay need write
 * access. The login's own level is `userLevel` ("admin", "readwrite" or
 * "readonly"). `readOnlyAccess` is not about this login at all: it is the
 * server's "Allow Readonly Access" security setting (read access for visitors
 * who have not logged in), so it is true for an admin on such a server too.
 */
export function loginNotice(status: EmbeddedWebAppApi['loginStatus']): LoginNotice {
  if (!status) return 'none';
  if (status.status !== 'loggedIn') return status.authenticationRequired ? 'log-in' : 'none';
  const level = typeof status.userLevel === 'string' ? status.userLevel.toLowerCase() : '';
  return level === 'readonly' ? 'read-only' : 'none';
}
