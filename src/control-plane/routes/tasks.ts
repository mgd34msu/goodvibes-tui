import type { DaemonApiRouteHandlers } from './context.ts';

export async function dispatchTaskRoutes(
  req: Request,
  handlers: Pick<
    DaemonApiRouteHandlers,
    | 'getIntegrationTasks'
    | 'getRuntimeTask'
    | 'runtimeTaskAction'
    | 'getTaskStatus'
    | 'postTask'
  >,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/task' && method === 'POST') return handlers.postTask(req);
  if (pathname === '/task' && method === 'GET') return null;

  if (pathname === '/api/tasks' && method === 'GET') return handlers.getIntegrationTasks();
  const taskDetailMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskDetailMatch && method === 'GET') return handlers.getRuntimeTask(taskDetailMatch[1]);

  const taskActionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(cancel|retry)$/);
  if (taskActionMatch && method === 'POST') {
    return handlers.runtimeTaskAction(taskActionMatch[1], taskActionMatch[2] as 'cancel' | 'retry', req);
  }

  const taskStatusMatch = pathname.match(/^\/task\/([^/]+)$/);
  if (taskStatusMatch && method === 'GET') return handlers.getTaskStatus(taskStatusMatch[1]);

  return null;
}
