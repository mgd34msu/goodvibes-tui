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
    | 'getSharedSessionInputs'
    | 'postSharedSessionSteer'
    | 'postSharedSessionFollowUp'
    | 'cancelSharedSessionInput'
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

  const sharedSessionInputsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/inputs$/);
  if (sharedSessionInputsMatch && method === 'GET') return handlers.getSharedSessionInputs(sharedSessionInputsMatch[1], url);

  const sharedSessionSteerMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/steer$/);
  if (sharedSessionSteerMatch && method === 'POST') return handlers.postSharedSessionSteer(sharedSessionSteerMatch[1], req);

  const sharedSessionFollowUpMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/follow-up$/);
  if (sharedSessionFollowUpMatch && method === 'POST') return handlers.postSharedSessionFollowUp(sharedSessionFollowUpMatch[1], req);

  const sharedSessionCancelInputMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/inputs\/([^/]+)\/cancel$/);
  if (sharedSessionCancelInputMatch && method === 'POST') {
    return handlers.cancelSharedSessionInput(sharedSessionCancelInputMatch[1], sharedSessionCancelInputMatch[2]);
  }

  return null;
}
