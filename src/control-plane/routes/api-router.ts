import { dispatchAutomationRoutes } from './automation.ts';
import { dispatchOperatorRoutes } from './operator.ts';
import { dispatchRemoteRoutes } from './remote.ts';
import { dispatchSessionRoutes } from './sessions.ts';
import { dispatchTaskRoutes } from './tasks.ts';
import type { DaemonApiRouteHandlers } from './context.ts';

export async function dispatchDaemonApiRoutes(req: Request, handlers: DaemonApiRouteHandlers): Promise<Response | null> {
  return (
    await dispatchRemoteRoutes(req, handlers)
    ?? await dispatchOperatorRoutes(req, handlers)
    ?? await dispatchAutomationRoutes(req, handlers)
    ?? await dispatchSessionRoutes(req, handlers)
    ?? await dispatchTaskRoutes(req, handlers)
  );
}
