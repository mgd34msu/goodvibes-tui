export type AgentLogFilterType = 'all' | 'assistant' | 'tool' | 'error';

export interface AgentLogEntry {
  raw: Record<string, unknown>;
  type: string;
  text: string;
  color: string;
  bold: boolean;
}

export const AGENT_LOG_FILTER_LABELS: Record<AgentLogFilterType, string> = {
  all: 'All',
  assistant: 'Assistant',
  tool: 'Tool',
  error: 'Error',
};

export const AGENT_LOG_FILTER_CYCLE: AgentLogFilterType[] = ['all', 'assistant', 'tool', 'error'];

export const AGENT_LOG_COLORS = {
  header_bg: '235',
  header_fg: '250',
  header_accent: '#00ffff',
  header_label: '244',
  agent_selected: '#00ffff',
  agent_running: '#00ff87',
  agent_pending: '220',
  agent_done: '244',
  agent_error: '#ff5f5f',
  assistant: '255',
  tool: '#00e5ff',
  error: '#ff5f5f',
  dim: '240',
  paused: '220',
  auto_follow: '#00ff87',
  session_start: '238',
  separator: '237',
  filter_active: '#00ffff',
  filter_inactive: '244',
} as const;

export function parseAgentJsonl(content: string): AgentLogEntry[] {
  const entries: AgentLogEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      entries.push(toAgentLogEntry(obj));
    } catch {
      // ignore malformed lines
    }
  }
  return entries;
}

export function toAgentLogEntry(obj: Record<string, unknown>): AgentLogEntry {
  const type = typeof obj.type === 'string' ? obj.type : 'unknown';
  switch (type) {
    case 'meta':
    case 'session_start': {
      const agentId = String(obj.agentId ?? '');
      const model = String(obj.model ?? '');
      const provider = String(obj.provider ?? '');
      const ts = String(obj.timestamp ?? '').replace('T', ' ').replace(/\.\d+Z$/, '');
      return {
        raw: obj,
        type: 'session_start',
        text: `[${ts}] Session started  agent=${agentId}  model=${model}  provider=${provider}`,
        color: AGENT_LOG_COLORS.session_start,
        bold: false,
      };
    }
    case 'assistant':
      return {
        raw: obj,
        type: 'assistant',
        text: String(obj.content ?? obj.text ?? ''),
        color: AGENT_LOG_COLORS.assistant,
        bold: false,
      };
    case 'tool_call': {
      const tool = String(obj.tool ?? obj.name ?? '');
      const args = obj.args ?? obj.arguments ?? {};
      const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
      return {
        raw: obj,
        type: 'tool',
        text: `[tool] ${tool}  ${argsStr.slice(0, 120)}`,
        color: AGENT_LOG_COLORS.tool,
        bold: false,
      };
    }
    case 'tool_result': {
      const tool = String(obj.tool ?? obj.name ?? '');
      const result = obj.result ?? obj.output ?? '';
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      return {
        raw: obj,
        type: 'tool',
        text: `[result] ${tool}  ${resultStr.slice(0, 120)}`,
        color: AGENT_LOG_COLORS.tool,
        bold: false,
      };
    }
    case 'error':
      return {
        raw: obj,
        type: 'error',
        text: `[error] ${String(obj.error ?? obj.message ?? obj.msg ?? JSON.stringify(obj))}`,
        color: AGENT_LOG_COLORS.error,
        bold: true,
      };
    default: {
      const text = typeof obj.text === 'string'
        ? obj.text
        : typeof obj.content === 'string'
          ? obj.content
          : `[${type}] ${JSON.stringify(obj).slice(0, 120)}`;
      return {
        raw: obj,
        type,
        text,
        color: AGENT_LOG_COLORS.dim,
        bold: false,
      };
    }
  }
}
