import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';

// ---------------------------------------------------------------------------
// Mocks — must be declared/awaited before importing the module under test.
// ---------------------------------------------------------------------------

const mockConfigGet = mock((key: string): unknown => {
  if (key === 'tools.autoHeal') return true;
  return undefined;
});

await mock.module('../../../config/index.ts', () => ({
  configManager: {
    get: mockConfigGet,
    setDynamic: mock(() => {}),
  },
}));

const mockToolLLMChat = mock(async (_prompt: string, _opts?: unknown): Promise<string> => '');

await mock.module('../../../config/tool-llm.ts', () => ({
  toolLLM: {
    chat: mockToolLLMChat,
  },
  ToolLLM: {
    getInstance: () => ({ chat: mockToolLLMChat }),
    _reset: () => {},
  },
  resolveToolLLM: () => null,
}));

await mock.module('../../../utils/logger.ts', () => ({
  logger: {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}));

// Import AFTER mocks are registered
const { AutoHealer } = await import('../../../tools/shared/auto-heal.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TS = `export function hello(): string {
  return 'world';
}\n`;

const INVALID_TS = `export function hello(): string {
  return 'world'
  // missing brace`;

/** Patch Bun.which to return null (disable formatter/linter detection). */
function disableWhich(): () => void {
  const original = Bun.which.bind(Bun);
  (Bun as unknown as Record<string, unknown>).which = () => null;
  return () => { (Bun as unknown as Record<string, unknown>).which = original; };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutoHealer — config gate', () => {
  beforeEach(() => {
    AutoHealer._reset();
    mockConfigGet.mockImplementation((key: string) => {
      if (key === 'tools.autoHeal') return false;
      return undefined;
    });
  });

  afterEach(() => {
    AutoHealer._reset();
  });

  test('returns healed=false when tools.autoHeal is false', async () => {
    const healer = AutoHealer.getInstance();
    const result = await healer.heal('test.ts', VALID_TS, ['some error']);
    expect(result.healed).toBe(false);
    expect(result.content).toBe(VALID_TS);
    expect(result.method).toBeUndefined();
  });

  test('preserves original content when disabled', async () => {
    const healer = AutoHealer.getInstance();
    const result = await healer.heal('test.ts', 'some content', ['error1', 'error2']);
    expect(result.healed).toBe(false);
    expect(result.content).toBe('some content');
  });
});

describe('AutoHealer — no errors passthrough', () => {
  beforeEach(() => {
    AutoHealer._reset();
    mockConfigGet.mockImplementation((key: string) => {
      if (key === 'tools.autoHeal') return true;
      return undefined;
    });
  });

  afterEach(() => {
    AutoHealer._reset();
  });

  test('returns healed=false when errors array is empty', async () => {
    const healer = AutoHealer.getInstance();
    const result = await healer.heal('test.ts', VALID_TS, []);
    expect(result.healed).toBe(false);
    expect(result.content).toBe(VALID_TS);
  });
});

describe('AutoHealer — singleton', () => {
  beforeEach(() => {
    AutoHealer._reset();
  });

  afterEach(() => {
    AutoHealer._reset();
  });

  test('getInstance returns same instance', () => {
    const a = AutoHealer.getInstance();
    const b = AutoHealer.getInstance();
    expect(a).toBe(b);
  });

  test('_reset creates new instance', () => {
    const a = AutoHealer.getInstance();
    AutoHealer._reset();
    const b = AutoHealer.getInstance();
    expect(a).not.toBe(b);
  });
});

describe('AutoHealer — LLM stage (no formatter/linter)', () => {
  let restore: () => void;

  beforeEach(() => {
    AutoHealer._reset();
    mockConfigGet.mockImplementation((key: string) => {
      if (key === 'tools.autoHeal') return true;
      return undefined;
    });
    mockToolLLMChat.mockReset();
    restore = disableWhich();
  });

  afterEach(() => {
    restore();
    AutoHealer._reset();
  });

  test('returns healed=false when LLM returns empty string', async () => {
    mockToolLLMChat.mockImplementation(async () => '');
    const healer = AutoHealer.getInstance();
    const result = await healer.heal('test.ts', INVALID_TS, ['SyntaxError']);
    expect(result.healed).toBe(false);
    expect(result.content).toBe(INVALID_TS);
  });

  test('returns healed=true with method=llm when LLM returns fixed content', async () => {
    const fixedContent = 'export function hello(): string { return \'world\'; }\n';
    mockToolLLMChat.mockImplementation(async () => fixedContent);
    const healer = AutoHealer.getInstance();
    const result = await healer.heal('test.ts', INVALID_TS, ['Unexpected end of input']);
    expect(result.healed).toBe(true);
    expect(result.content).toBe(fixedContent);
    expect(result.method).toBe('llm');
  });

  test('returns healed=true with method=llm for non-ts files', async () => {
    const fixedContent = 'fixed content';
    mockToolLLMChat.mockImplementation(async () => fixedContent);
    const healer = AutoHealer.getInstance();
    const result = await healer.heal('test.txt', 'broken content', ['Error: invalid']);
    expect(result.healed).toBe(true);
    expect(result.content).toBe(fixedContent);
    expect(result.method).toBe('llm');
  });
});

describe('AutoHealer — never throws', () => {
  let restore: () => void;

  beforeEach(() => {
    AutoHealer._reset();
    mockConfigGet.mockImplementation((key: string) => {
      if (key === 'tools.autoHeal') return true;
      return undefined;
    });
    mockToolLLMChat.mockReset();
    restore = disableWhich();
  });

  afterEach(() => {
    restore();
    AutoHealer._reset();
  });

  test('does not throw when LLM throws internally', async () => {
    mockToolLLMChat.mockImplementation(async () => {
      throw new Error('Network error');
    });
    const healer = AutoHealer.getInstance();
    const result = await healer.heal('test.ts', INVALID_TS, ['error']);
    expect(result.healed).toBe(false);
    expect(result.content).toBe(INVALID_TS);
  });

  test('does not throw on empty inputs', async () => {
    mockToolLLMChat.mockImplementation(async () => '');
    const healer = AutoHealer.getInstance();
    const result = await healer.heal('', '', ['']);
    expect(typeof result.healed).toBe('boolean');
    expect(typeof result.content).toBe('string');
  });
});

describe('AutoHealer — HealResult shape', () => {
  beforeEach(() => {
    AutoHealer._reset();
    mockConfigGet.mockImplementation((key: string) => {
      if (key === 'tools.autoHeal') return true;
      return undefined;
    });
  });

  afterEach(() => {
    AutoHealer._reset();
  });

  test('result always has healed (boolean) and content (string)', async () => {
    const healer = AutoHealer.getInstance();
    const result = await healer.heal('test.ts', VALID_TS, ['some error']);
    expect(typeof result.healed).toBe('boolean');
    expect(typeof result.content).toBe('string');
  });

  test('result.method is undefined when config gate blocks execution', async () => {
    mockConfigGet.mockImplementation((key: string) => {
      if (key === 'tools.autoHeal') return false;
      return undefined;
    });
    const healer = AutoHealer.getInstance();
    const result = await healer.heal('test.ts', VALID_TS, ['error']);
    expect(result.healed).toBe(false);
    expect(result.method).toBeUndefined();
  });

  test('result.method is one of formatter|linter|llm|undefined', async () => {
    const validMethods = ['formatter', 'linter', 'llm', undefined];
    const healer = AutoHealer.getInstance();
    const result = await healer.heal('test.ts', VALID_TS, ['error']);
    expect(validMethods).toContain(result.method);
  });
});

afterAll(() => {
  mock.restore();
});

afterAll(() => {
  mock.restore();
});
