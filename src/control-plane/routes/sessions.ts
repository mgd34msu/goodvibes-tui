import type { DaemonApiRouteHandlers } from './context.ts';

export async function dispatchSessionRoutes(
  req: Request,
  handlers: Pick<
    DaemonApiRouteHandlers,
    | 'getIntegrationSessions'
    | 'createSharedSession'
    | 'getSharedSession'
    | 'closeSharedSession'
    | 'reopenSharedSession'
    | 'getSharedSessionMessages'
    | 'postSharedSessionMessage'
  >,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/sessions' && method === 'GET') return handlers.getIntegrationSessions();
  if (pathname === '/api/sessions' && method === 'POST') return handlers.createSharedSession(req);

  const sharedSessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sharedSessionMatch && method === 'GET') return handlers.getSharedSession(sharedSessionMatch[1]);

  const sharedSessionCloseMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(close|reopen)$/);
  if (sharedSessionCloseMatch && method === 'POST') {
    return sharedSessionCloseMatch[2] === 'close'
      ? handlers.closeSharedSession(sharedSessionCloseMatch[1])
      : handlers.reopenSharedSession(sharedSessionCloseMatch[1]);
  }

  const sharedSessionMessagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (sharedSessionMessagesMatch && method === 'GET') return handlers.getSharedSessionMessages(sharedSessionMessagesMatch[1], url);
  if (sharedSessionMessagesMatch && method === 'POST') return handlers.postSharedSessionMessage(sharedSessionMessagesMatch[1], req);

  return null;
}
