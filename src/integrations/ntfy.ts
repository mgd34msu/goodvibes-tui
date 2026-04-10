export interface NtfyPublishOptions {
  readonly title?: string;
  readonly priority?: 1 | 2 | 3 | 4 | 5;
  readonly tags?: readonly string[];
  readonly click?: string;
  readonly attach?: string;
  readonly actions?: readonly string[];
}

export interface NtfyMessage {
  readonly id?: string;
  readonly time?: number;
  readonly event: 'open' | 'keepalive' | 'message' | 'message_delete' | 'message_clear' | 'poll_request' | string;
  readonly topic?: string;
  readonly message?: string;
  readonly title?: string;
  readonly priority?: number;
  readonly tags?: readonly string[];
  readonly click?: string;
  readonly actions?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface NtfySubscribeOptions {
  readonly since?: string;
  readonly scheduled?: boolean;
  readonly poll?: boolean;
  readonly filters?: Record<string, string | number | boolean | readonly string[]>;
  readonly signal?: AbortSignal;
}

export interface NtfyWebSocketOptions extends NtfySubscribeOptions {
  readonly WebSocketImpl?: typeof WebSocket;
}

export class NtfyIntegration {
  constructor(
    private readonly baseUrl = 'https://ntfy.sh',
    private readonly token?: string,
  ) {}

  async publish(topic: string, message: string, options: NtfyPublishOptions = {}): Promise<void> {
    const target = `${this.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`;
    const headers = new Headers({
      'Content-Type': 'text/plain; charset=utf-8',
    });
    if (options.title) headers.set('Title', options.title);
    if (options.priority) headers.set('Priority', String(options.priority));
    if (options.tags?.length) headers.set('Tags', options.tags.join(','));
    if (options.click) headers.set('Click', options.click);
    if (options.attach) headers.set('Attach', options.attach);
    if (options.actions?.length) headers.set('Actions', options.actions.join(';'));
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);

    const response = await fetch(target, {
      method: 'POST',
      headers,
      body: message,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`NtfyIntegration.publish failed (${response.status}): ${body}`);
    }
  }

  buildSubscribeUrl(topic: string, mode: 'json' | 'sse' | 'raw' | 'ws' = 'json', options: NtfySubscribeOptions = {}): string {
    const pathTopic = topic.split(',').map((entry) => encodeURIComponent(entry.trim())).filter(Boolean).join(',');
    const url = new URL(`${this.baseUrl.replace(/\/+$/, '')}/${pathTopic}/${mode}`);
    if (options.poll) url.searchParams.set('poll', '1');
    if (options.since) url.searchParams.set('since', options.since);
    if (options.scheduled) url.searchParams.set('scheduled', '1');
    for (const [key, value] of Object.entries(options.filters ?? {})) {
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    if (mode === 'ws') {
      url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    }
    return url.toString();
  }

  async poll(topic: string, options: Omit<NtfySubscribeOptions, 'poll'> = {}): Promise<NtfyMessage[]> {
    const url = this.buildSubscribeUrl(topic, 'json', { ...options, poll: true });
    const headers = this.buildAuthHeaders();
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: options.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`NtfyIntegration.poll failed (${response.status}): ${body}`);
    }
    const raw = await response.text();
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NtfyMessage);
  }

  async subscribeJsonStream(
    topic: string,
    onMessage: (message: NtfyMessage) => void | Promise<void>,
    options: NtfySubscribeOptions = {},
  ): Promise<void> {
    const url = this.buildSubscribeUrl(topic, 'json', options);
    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildAuthHeaders(),
      signal: options.signal,
    });
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '');
      throw new Error(`NtfyIntegration.subscribeJsonStream failed (${response.status}): ${body}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        await onMessage(JSON.parse(trimmed) as NtfyMessage);
      }
    }
    if (buffer.trim()) {
      await onMessage(JSON.parse(buffer.trim()) as NtfyMessage);
    }
  }

  connectWebSocket(
    topic: string,
    onMessage: (message: NtfyMessage) => void | Promise<void>,
    options: NtfyWebSocketOptions = {},
  ): WebSocket {
    const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    const socket = new WebSocketImpl(this.buildSubscribeUrl(topic, 'ws', options));
    socket.addEventListener('message', (event) => {
      void (async () => {
        const raw = typeof event.data === 'string'
          ? event.data
          : event.data instanceof Buffer
            ? event.data.toString('utf-8')
            : String(event.data);
        if (!raw.trim()) return;
        await onMessage(JSON.parse(raw) as NtfyMessage);
      })();
    });
    return socket;
  }

  private buildAuthHeaders(): Headers {
    const headers = new Headers();
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    return headers;
  }
}
