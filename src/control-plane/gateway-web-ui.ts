function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

function safeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function renderControlPlaneGatewayWebUi(authTokenHint = ''): Response {
  const escapedAuthTokenHint = escapeHtmlAttribute(authTokenHint);
  const initialAuthTokenJson = safeJsonForInlineScript(authTokenHint);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>goodvibes control plane</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: rgba(15, 23, 42, 0.82);
      --panel-border: rgba(148, 163, 184, 0.22);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #22c55e;
      --accent-2: #38bdf8;
      --warn: #fb7185;
      --shadow: 0 30px 60px rgba(2, 6, 23, 0.45);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(34, 197, 94, 0.22), transparent 30%),
        radial-gradient(circle at top right, rgba(56, 189, 248, 0.22), transparent 24%),
        linear-gradient(160deg, #020617 0%, #0f172a 52%, #111827 100%);
      min-height: 100vh;
      padding: 24px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: 18px;
      padding: 18px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(14px);
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 2rem; font-weight: 700; letter-spacing: -0.03em; }
    h2 { font-size: 1rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.12em; }
    p { color: var(--muted); line-height: 1.45; }
    .hero { display: flex; flex-direction: column; gap: 12px; margin-bottom: 18px; }
    .kpis { display: flex; gap: 12px; flex-wrap: wrap; }
    .kpi { padding: 10px 12px; border-radius: 14px; background: rgba(15, 23, 42, 0.65); border: 1px solid rgba(148, 163, 184, 0.16); min-width: 110px; }
    .kpi strong { display: block; font-size: 1.35rem; color: var(--text); }
    form { display: grid; gap: 10px; }
    input, textarea, button, select {
      width: 100%;
      border-radius: 12px;
      border: 1px solid rgba(148, 163, 184, 0.24);
      background: rgba(15, 23, 42, 0.75);
      color: var(--text);
      padding: 12px 14px;
      font: inherit;
    }
    textarea { min-height: 120px; resize: vertical; }
    button {
      background: linear-gradient(135deg, var(--accent), #16a34a);
      color: #04130a;
      font-weight: 700;
      cursor: pointer;
    }
    button.secondary {
      background: linear-gradient(135deg, var(--accent-2), #0ea5e9);
      color: #042335;
    }
    .list { display: grid; gap: 10px; max-height: 360px; overflow: auto; }
    .item {
      padding: 12px;
      border-radius: 14px;
      border: 1px solid rgba(148, 163, 184, 0.16);
      background: rgba(15, 23, 42, 0.62);
    }
    .item strong { display: block; margin-bottom: 4px; }
    .meta { color: var(--muted); font-size: 0.9rem; }
    .actions { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
    .live {
      min-height: 240px;
      max-height: 420px;
      overflow: auto;
      font-family: "IBM Plex Mono", monospace;
      font-size: 0.86rem;
      white-space: pre-wrap;
      line-height: 1.4;
    }
    .ok { color: var(--accent); }
    .warn { color: var(--warn); }
  </style>
</head>
<body>
  <section class="hero">
    <h1>goodvibes control plane</h1>
    <p>Daemon-backed automation, tasks, and omnichannel state. Submit work, manage scheduled jobs, and watch the live event bus.</p>
  </section>

  <div class="grid">
    <section class="panel">
      <h2>Auth</h2>
      <form id="auth-form">
        <input id="token" type="password" placeholder="Bearer token or session token" value="${escapedAuthTokenHint}">
        <button type="submit" class="secondary">Connect</button>
      </form>
      <p id="auth-status" class="meta">Set a token to unlock API and event-stream access.</p>
    </section>

    <section class="panel">
      <h2>Task</h2>
      <form id="task-form">
        <input id="task-session" placeholder="Optional shared session id">
        <textarea id="task-text" placeholder="Ask goodvibes to do something useful."></textarea>
        <button type="submit">Submit task</button>
      </form>
    </section>

    <section class="panel">
      <h2>Session</h2>
      <form id="session-form">
        <input id="session-id" placeholder="Shared session id">
        <textarea id="session-text" placeholder="Continue an existing shared session"></textarea>
        <button type="submit" class="secondary">Send to session</button>
      </form>
    </section>

    <section class="panel">
      <h2>Automation</h2>
      <form id="job-form">
        <input id="job-name" placeholder="Job name">
        <select id="job-kind">
          <option value="every">Every</option>
          <option value="cron">Cron</option>
          <option value="at">At</option>
        </select>
        <input id="job-schedule" placeholder="15m | */30 * * * * | 2026-04-10T09:00:00">
        <textarea id="job-prompt" placeholder="Automation prompt"></textarea>
        <button type="submit">Create automation</button>
      </form>
    </section>
  </div>

  <div class="grid" style="margin-top: 16px;">
    <section class="panel">
      <h2>Snapshot</h2>
      <div class="kpis">
        <div class="kpi"><span class="meta">Tasks</span><strong id="tasks-count">0</strong></div>
        <div class="kpi"><span class="meta">Jobs</span><strong id="jobs-count">0</strong></div>
        <div class="kpi"><span class="meta">Runs</span><strong id="runs-count">0</strong></div>
        <div class="kpi"><span class="meta">Clients</span><strong id="clients-count">0</strong></div>
        <div class="kpi"><span class="meta">Routes</span><strong id="routes-count">0</strong></div>
        <div class="kpi"><span class="meta">Watchers</span><strong id="watchers-count">0</strong></div>
        <div class="kpi"><span class="meta">Sessions</span><strong id="sessions-count">0</strong></div>
        <div class="kpi"><span class="meta">Approvals</span><strong id="approvals-count">0</strong></div>
      </div>
      <div id="clients" class="list" style="margin-top: 14px;"></div>
    </section>

    <section class="panel">
      <h2>Jobs</h2>
      <div id="jobs" class="list"></div>
    </section>

    <section class="panel">
      <h2>Runs</h2>
      <div id="runs" class="list"></div>
    </section>

    <section class="panel">
      <h2>Live bus</h2>
      <div id="events" class="live"></div>
    </section>
  </div>

  <div class="grid" style="margin-top: 16px;">
    <section class="panel">
      <h2>Sessions</h2>
      <div id="sessions" class="list"></div>
    </section>

    <section class="panel">
      <h2>Tasks</h2>
      <div id="tasks-list" class="list"></div>
    </section>

    <section class="panel">
      <h2>Approvals</h2>
      <div id="approvals" class="list"></div>
    </section>
  </div>

  <div class="grid" style="margin-top: 16px;">
    <section class="panel">
      <h2>Routes</h2>
      <div id="routes" class="list"></div>
    </section>

    <section class="panel">
      <h2>Surfaces</h2>
      <div id="surfaces" class="list"></div>
    </section>

    <section class="panel">
      <h2>Watchers</h2>
      <div id="watchers" class="list"></div>
    </section>

    <section class="panel">
      <h2>Deliveries</h2>
      <div id="deliveries" class="list"></div>
    </section>
  </div>

  <div class="grid" style="margin-top: 16px;">
    <section class="panel">
      <h2>Service</h2>
      <div id="service" class="list"></div>
      <div class="grid" style="margin-top: 12px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));">
        <button id="service-install" class="secondary">Install</button>
        <button id="service-start">Start</button>
        <button id="service-stop" class="secondary">Stop</button>
        <button id="service-restart">Restart</button>
        <button id="service-uninstall" class="secondary">Uninstall</button>
      </div>
    </section>

    <section class="panel">
      <h2>Surface messages</h2>
      <div id="messages" class="list"></div>
    </section>
  </div>

  <script>
    const state = {
      token: ${initialAuthTokenJson},
      stream: null,
      streamMode: 'sse',
    };

    const els = {
      token: document.getElementById('token'),
      authForm: document.getElementById('auth-form'),
      authStatus: document.getElementById('auth-status'),
      taskForm: document.getElementById('task-form'),
      taskSession: document.getElementById('task-session'),
      taskText: document.getElementById('task-text'),
      sessionForm: document.getElementById('session-form'),
      sessionId: document.getElementById('session-id'),
      sessionText: document.getElementById('session-text'),
      jobForm: document.getElementById('job-form'),
      jobName: document.getElementById('job-name'),
      jobKind: document.getElementById('job-kind'),
      jobSchedule: document.getElementById('job-schedule'),
      jobPrompt: document.getElementById('job-prompt'),
      jobs: document.getElementById('jobs'),
      runs: document.getElementById('runs'),
      sessions: document.getElementById('sessions'),
      tasksList: document.getElementById('tasks-list'),
      approvals: document.getElementById('approvals'),
      clients: document.getElementById('clients'),
      routes: document.getElementById('routes'),
      surfaces: document.getElementById('surfaces'),
      watchers: document.getElementById('watchers'),
      deliveries: document.getElementById('deliveries'),
      service: document.getElementById('service'),
      messages: document.getElementById('messages'),
      events: document.getElementById('events'),
      tasksCount: document.getElementById('tasks-count'),
      jobsCount: document.getElementById('jobs-count'),
      runsCount: document.getElementById('runs-count'),
      clientsCount: document.getElementById('clients-count'),
      routesCount: document.getElementById('routes-count'),
      watchersCount: document.getElementById('watchers-count'),
      sessionsCount: document.getElementById('sessions-count'),
      approvalsCount: document.getElementById('approvals-count'),
      serviceInstall: document.getElementById('service-install'),
      serviceStart: document.getElementById('service-start'),
      serviceStop: document.getElementById('service-stop'),
      serviceRestart: document.getElementById('service-restart'),
      serviceUninstall: document.getElementById('service-uninstall'),
    };

    els.token.value = state.token;
    const initialParams = new URLSearchParams(window.location.search);
    if (initialParams.get('session')) {
      els.taskSession.value = initialParams.get('session');
      els.sessionId.value = initialParams.get('session');
    }

    function authHeaders() {
      return state.token ? { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
    }

    function clearList(el) {
      el.replaceChildren();
    }

    function appendText(parent, tag, text, className = '') {
      const node = document.createElement(tag);
      if (className) node.className = className;
      node.textContent = text == null ? '' : String(text);
      parent.appendChild(node);
      return node;
    }

    function makeItem(title, metaLines = []) {
      const item = document.createElement('div');
      item.className = 'item';
      appendText(item, 'strong', title);
      for (const line of metaLines) {
        appendText(item, 'div', line, 'meta');
      }
      return item;
    }

    function makeButton(label, data = {}, className = '') {
      const button = document.createElement('button');
      button.textContent = label;
      if (className) button.className = className;
      for (const [key, value] of Object.entries(data)) {
        button.setAttribute(key, value == null ? '' : String(value));
      }
      return button;
    }

    function appendActions(item, buttons) {
      const row = document.createElement('div');
      row.className = 'actions';
      buttons.forEach((button) => row.appendChild(button));
      item.appendChild(row);
      return row;
    }

    function appendEvent(line, cls = '') {
      const div = document.createElement('div');
      if (cls) div.className = cls;
      div.textContent = line;
      els.events.prepend(div);
    }

    async function loadSnapshot() {
      if (!state.token) return;
      const [tasksRes, automationRes, sessionsRes, approvalsRes, deliveriesRes, controlPlaneRes, routesRes, surfacesRes, watchersRes, serviceRes, messagesRes] = await Promise.all([
        fetch('/api/tasks', { headers: authHeaders() }),
        fetch('/api/automation', { headers: authHeaders() }),
        fetch('/api/sessions', { headers: authHeaders() }),
        fetch('/api/approvals', { headers: authHeaders() }),
        fetch('/api/deliveries', { headers: authHeaders() }),
        fetch('/api/control-plane', { headers: authHeaders() }),
        fetch('/api/routes/bindings', { headers: authHeaders() }),
        fetch('/api/surfaces', { headers: authHeaders() }),
        fetch('/api/watchers', { headers: authHeaders() }),
        fetch('/api/service/status', { headers: authHeaders() }),
        fetch('/api/control-plane/messages', { headers: authHeaders() }),
      ]);
      if (!tasksRes.ok || !automationRes.ok || !sessionsRes.ok || !approvalsRes.ok || !deliveriesRes.ok || !controlPlaneRes.ok || !routesRes.ok || !surfacesRes.ok || !watchersRes.ok || !serviceRes.ok || !messagesRes.ok) {
        els.authStatus.textContent = 'Authentication failed or control plane unavailable.';
        els.authStatus.className = 'warn';
        return;
      }
      const tasks = await tasksRes.json();
      const automation = await automationRes.json();
      const sessions = await sessionsRes.json();
      const approvals = await approvalsRes.json();
      const deliveries = await deliveriesRes.json();
      const controlPlane = await controlPlaneRes.json();
      const routes = await routesRes.json();
      const surfaces = await surfacesRes.json();
      const watchers = await watchersRes.json();
      const service = await serviceRes.json();
      const messages = await messagesRes.json();
      state.streamMode = controlPlane.server && controlPlane.server.streamingMode ? controlPlane.server.streamingMode : 'sse';
      els.tasksCount.textContent = String(tasks.queued + tasks.running + tasks.blocked);
      els.jobsCount.textContent = String(automation.totals.jobs);
      els.runsCount.textContent = String(automation.totals.runs);
      els.clientsCount.textContent = String(controlPlane.totals.clients);
      els.routesCount.textContent = String(routes.bindings.length);
      els.watchersCount.textContent = String(watchers.watchers.length);
      els.sessionsCount.textContent = String(sessions.totals.sessions);
      els.approvalsCount.textContent = String((approvals.approvals || []).filter((approval) => approval.status === 'pending' || approval.status === 'claimed').length);
      clearList(els.jobs);
      for (const job of automation.jobs) {
        const item = makeItem(job.name, [job.id + ' · ' + job.status + ' · next ' + (job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : 'n/a')]);
        appendActions(item, [
          makeButton('Run', { 'data-job-action': 'run', 'data-job-id': job.id }),
          makeButton(job.enabled ? 'Pause' : 'Resume', { 'data-job-action': job.enabled ? 'disable' : 'enable', 'data-job-id': job.id }, 'secondary'),
          makeButton('Remove', { 'data-job-action': 'delete', 'data-job-id': job.id }, 'secondary'),
        ]);
        els.jobs.appendChild(item);
      }
      clearList(els.runs);
      for (const run of automation.recentRuns || []) {
        const item = makeItem(run.id, [run.jobId + ' · ' + run.status + ' · ' + new Date(run.queuedAt).toLocaleTimeString()]);
        appendActions(item, [
          makeButton('Retry', { 'data-run-action': 'retry', 'data-run-id': run.id }),
          makeButton('Cancel', { 'data-run-action': 'cancel', 'data-run-id': run.id }, 'secondary'),
        ]);
        els.runs.appendChild(item);
      }
      clearList(els.sessions);
      for (const session of sessions.sessions || []) {
        const item = makeItem(session.title, [session.id + ' · ' + session.status + ' · messages ' + session.messageCount]);
        appendActions(item, [
          makeButton('Use', { 'data-session-fill': session.id }),
          makeButton(session.status === 'closed' ? 'Reopen' : 'Close', { 'data-session-action': session.status === 'closed' ? 'reopen' : 'close', 'data-session-id': session.id }, 'secondary'),
        ]);
        els.sessions.appendChild(item);
      }
      clearList(els.tasksList);
      for (const task of tasks.tasks || []) {
        const item = makeItem(task.title, [task.id + ' · ' + task.kind + ' · ' + task.status]);
        appendActions(item, [
          makeButton('Retry', { 'data-task-action': 'retry', 'data-task-id': task.id }),
          makeButton('Cancel', { 'data-task-action': 'cancel', 'data-task-id': task.id }, 'secondary'),
        ]);
        els.tasksList.appendChild(item);
      }
      clearList(els.approvals);
      for (const approval of approvals.approvals || []) {
        const item = makeItem(approval.request && approval.request.tool ? approval.request.tool : approval.id, [
          approval.id + ' · ' + approval.status + ' · ' + (approval.request && approval.request.analysis ? approval.request.analysis.summary : ''),
        ]);
        appendActions(item, [
          makeButton('Claim', { 'data-approval-action': 'claim', 'data-approval-id': approval.id }, 'secondary'),
          makeButton('Approve', { 'data-approval-action': 'approve', 'data-approval-id': approval.id }),
          makeButton('Deny', { 'data-approval-action': 'deny', 'data-approval-id': approval.id }, 'secondary'),
        ]);
        els.approvals.appendChild(item);
      }
      clearList(els.clients);
      for (const client of controlPlane.clients) {
        const item = makeItem(client.label, [
          client.surface + ' · last seen ' + new Date(client.lastSeenAt).toLocaleTimeString(),
          client.userId || 'anonymous',
        ]);
        els.clients.appendChild(item);
      }
      clearList(els.routes);
      for (const binding of routes.bindings.slice(0, 20)) {
        const item = makeItem(binding.title || binding.externalId, [binding.surfaceKind + ' · ' + binding.kind + ' · ' + binding.id]);
        els.routes.appendChild(item);
      }
      clearList(els.surfaces);
      for (const surface of surfaces.surfaces) {
        const item = makeItem(surface.label, [surface.kind + ' · ' + surface.state + ' · ' + (surface.enabled ? 'enabled' : 'disabled')]);
        els.surfaces.appendChild(item);
      }
      clearList(els.watchers);
      for (const watcher of watchers.watchers) {
        const item = makeItem(watcher.label, [watcher.id + ' · ' + watcher.state + ' · ' + (watcher.intervalMs ? watcher.intervalMs + 'ms' : 'manual')]);
        appendActions(item, [
          makeButton('Start', { 'data-watcher-action': 'start', 'data-watcher-id': watcher.id }, 'secondary'),
          makeButton('Run', { 'data-watcher-action': 'run', 'data-watcher-id': watcher.id }),
          makeButton('Stop', { 'data-watcher-action': 'stop', 'data-watcher-id': watcher.id }, 'secondary'),
        ]);
        els.watchers.appendChild(item);
      }
      clearList(els.deliveries);
      for (const delivery of deliveries.attempts || []) {
        const item = makeItem(delivery.id, [delivery.runId + ' · ' + delivery.status + ' · ' + (delivery.target.surfaceKind || delivery.target.kind)]);
        els.deliveries.appendChild(item);
      }
      clearList(els.service);
      const serviceItem = makeItem(service.platform, [
        service.path,
        'installed: ' + service.installed + ' · running: ' + Boolean(service.running),
      ]);
      els.service.appendChild(serviceItem);
      clearList(els.messages);
      for (const message of messages.messages) {
        const item = makeItem(message.title, [
          message.surface + ' · ' + new Date(message.createdAt).toLocaleTimeString(),
          message.body,
        ]);
        els.messages.appendChild(item);
      }
      els.authStatus.textContent = 'Connected.';
      els.authStatus.className = 'ok';
    }

    function connectStream() {
      if (!state.token) return;
      if (state.stream) state.stream.close();
      const domains = ['session','tasks','agents','automation','routes','control-plane','deliveries'];
      const renderPayload = (payload) => typeof payload === 'string' ? payload : JSON.stringify(payload);
      const handleLiveEvent = (eventName, payload) => {
        const rendered = renderPayload(payload);
        if (eventName === 'ready') {
          appendEvent('ready ' + rendered, 'ok');
          return;
        }
        if (eventName === 'heartbeat' || eventName === 'pong') return;
        if (eventName === 'surface-message' || eventName === 'session-update' || eventName === 'approval-update') {
          appendEvent(eventName + ' ' + rendered, 'ok');
          loadSnapshot();
          return;
        }
        if (eventName === 'api-request') {
          appendEvent('api-request ' + rendered);
          return;
        }
        appendEvent(eventName + ' ' + rendered);
      };
      const controller = new AbortController();
      state.stream = { close: () => controller.abort() };
      const parseEventBlock = (block) => {
        let eventName = 'message';
        const data = [];
        for (const line of block.split(/\\r?\\n/)) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length > 0) handleLiveEvent(eventName, data.join('\\n'));
      };
      void (async () => {
        try {
          const res = await fetch('/api/control-plane/events?domains=' + encodeURIComponent(domains.join(',')), {
            headers: authHeaders(),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            appendEvent('event stream unavailable: HTTP ' + res.status, 'warn');
            return;
          }
          appendEvent('event stream connected', 'ok');
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            let boundary = buffer.indexOf('\\n\\n');
            while (boundary >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              if (block.trim()) parseEventBlock(block);
              boundary = buffer.indexOf('\\n\\n');
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) appendEvent('event stream disconnected', 'warn');
        }
      })();
    }

    async function postJson(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: authHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await res.json().catch(() => ({}));
      appendEvent(url + ' ' + JSON.stringify(payload), res.ok ? 'ok' : 'warn');
      await loadSnapshot();
      return payload;
    }

    els.authForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      state.token = els.token.value.trim();
      await loadSnapshot();
      connectStream();
    });

    els.taskForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const task = els.taskText.value.trim();
      if (!task) return;
      const sessionId = els.taskSession.value.trim();
      const res = await fetch('/task', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ task, ...(sessionId ? { sessionId, surfaceKind: 'web', surfaceId: 'surface:web' } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      appendEvent('task ' + JSON.stringify(body), res.ok ? 'ok' : 'warn');
      els.taskText.value = '';
      await loadSnapshot();
    });

    els.sessionForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const sessionId = els.sessionId.value.trim();
      const message = els.sessionText.value.trim();
      if (!sessionId || !message) return;
      const res = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/messages', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ body: message, surfaceKind: 'web', surfaceId: 'surface:web' }),
      });
      const body = await res.json().catch(() => ({}));
      appendEvent('session ' + JSON.stringify(body), res.ok ? 'ok' : 'warn');
      els.sessionText.value = '';
      await loadSnapshot();
    });

    els.jobForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const kind = els.jobKind.value;
      const payload = {
        kind,
        name: els.jobName.value.trim(),
        prompt: els.jobPrompt.value.trim(),
      };
      if (kind === 'every') payload.every = els.jobSchedule.value.trim();
      if (kind === 'cron') payload.cron = els.jobSchedule.value.trim();
      if (kind === 'at') payload.at = els.jobSchedule.value.trim();
      const res = await fetch('/api/automation/jobs', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      appendEvent('automation ' + JSON.stringify(body), res.ok ? 'ok' : 'warn');
      els.jobName.value = '';
      els.jobPrompt.value = '';
      await loadSnapshot();
    });

    els.watchers.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-watcher-action');
      const watcherId = target.getAttribute('data-watcher-id');
      if (!action || !watcherId) return;
      await postJson('/api/watchers/' + encodeURIComponent(watcherId) + '/' + action, {});
    });

    els.jobs.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-job-action');
      const jobId = target.getAttribute('data-job-id');
      if (!action || !jobId) return;
      if (action === 'delete') {
        const res = await fetch('/api/automation/jobs/' + encodeURIComponent(jobId), {
          method: 'DELETE',
          headers: authHeaders(),
        });
        appendEvent('job-delete ' + JSON.stringify(await res.json().catch(() => ({}))), res.ok ? 'ok' : 'warn');
        await loadSnapshot();
        return;
      }
      await postJson('/api/automation/jobs/' + encodeURIComponent(jobId) + '/' + action, {});
    });

    els.runs.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-run-action');
      const runId = target.getAttribute('data-run-id');
      if (!action || !runId) return;
      await postJson('/api/automation/runs/' + encodeURIComponent(runId) + '/' + action, {});
    });

    els.tasksList.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-task-action');
      const taskId = target.getAttribute('data-task-id');
      if (!action || !taskId) return;
      await postJson('/api/tasks/' + encodeURIComponent(taskId) + '/' + action, {});
    });

    els.approvals.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-approval-action');
      const approvalId = target.getAttribute('data-approval-id');
      if (!action || !approvalId) return;
      await postJson('/api/approvals/' + encodeURIComponent(approvalId) + '/' + action, {});
    });

    els.sessions.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const fillId = target.getAttribute('data-session-fill');
      if (fillId) {
        els.taskSession.value = fillId;
        els.sessionId.value = fillId;
        return;
      }
      const action = target.getAttribute('data-session-action');
      const sessionId = target.getAttribute('data-session-id');
      if (!action || !sessionId) return;
      await postJson('/api/sessions/' + encodeURIComponent(sessionId) + '/' + action, {});
    });

    els.serviceInstall.addEventListener('click', async () => postJson('/api/service/install', {}));
    els.serviceStart.addEventListener('click', async () => postJson('/api/service/start', {}));
    els.serviceStop.addEventListener('click', async () => postJson('/api/service/stop', {}));
    els.serviceRestart.addEventListener('click', async () => postJson('/api/service/restart', {}));
    els.serviceUninstall.addEventListener('click', async () => postJson('/api/service/uninstall', {}));

    if (state.token) {
      loadSnapshot();
      connectStream();
    }
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
    },
  });
}
