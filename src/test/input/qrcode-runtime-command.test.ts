import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerQrcodeRuntimeCommands } from '../../input/commands/qrcode-runtime.ts';

function ctx(out: string[], opened: string[]): CommandContext {
  return {
    print: (m: string) => out.push(m),
    openModal: (n: string) => opened.push(n),
    workspace: { shellPaths: { homeDirectory: '/tmp' } },
  } as unknown as CommandContext;
}

describe('/qrcode command', () => {
  test('no args opens the pairing modal', async () => {
    const registry = new CommandRegistry();
    registerQrcodeRuntimeCommands(registry);
    const opened: string[] = [];
    await registry.execute('qrcode', [], ctx([], opened));
    expect(opened).toEqual(['pairing-modal']);
  });

  test('regenerate opens a fresh pairing QR (each open mints its own device token, no shared-token rotation)', async () => {
    const registry = new CommandRegistry();
    registerQrcodeRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    await registry.execute('qrcode', ['regenerate'], ctx(out, opened));

    // The modal (re-)opens and mints a new token itself; the command no longer
    // rotates a shared token out from under a live device.
    expect(opened).toEqual(['pairing-modal']);
    expect(out.join('\n')).toContain('mints a new device token');
  });
});
