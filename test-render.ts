import { Compositor } from './src/renderer/compositor.ts';
import { UIFactory } from './src/renderer/ui-factory.ts';
import { TerminalBuffer } from './src/renderer/buffer.ts';
import { DiffEngine } from './src/renderer/diff.ts';

// Mock stdout
const mockStdout = {
  write: (data: string) => {
    console.log(`[STDOUT WRITE] Length: ${data.length}, Preview: ${JSON.stringify(data.slice(0, 50))}`);
  },
  columns: 80,
  rows: 24
} as any;

function test() {
  console.log("--- Starting Render Diagnostic ---");
  
  const width = 80;
  const height = 24;
  const compositor = new Compositor(mockStdout);
  
  const header = UIFactory.createHeader(width, "mercury-2", "inception");
  const viewport = [UIFactory.stringToLine("Diagnostic Test Line", width, { fg: '15' })];
  const footer = UIFactory.createFooter(width, "test prompt", { up: 0, down: 0 }, false, 0);

  console.log(`Header lines: ${header.length}`);
  console.log(`Viewport lines: ${viewport.length}`);
  console.log(`Footer lines: ${footer.length}`);

  try {
    compositor.composite({ width, height, header, viewport, footer });
  } catch (e) {
    console.error("Compositor Crashed:", e);
  }
}

test();
