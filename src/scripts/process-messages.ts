import { readFileSync } from 'fs';
import { AgentMessageBus } from '../agents/message-bus.ts';

// Simple script to read messages from a file and broadcast them via the AgentMessageBus.
// Expected file format: each line contains an optional index and a message separated by '|', e.g. "1 | Hello".
// Empty lines or lines without a '|' are ignored.

const MESSAGE_FILE = `${__dirname}/../msg_target.txt`;

function parseMessages(fileContent: string): string[] {
  const lines = fileContent.split(/\r?\n/);
  const messages: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('|');
    if (parts.length < 2) continue;
    const msg = parts[1].trim();
    if (msg) messages.push(msg);
  }
  return messages;
}

function main() {
  try {
    const raw = readFileSync(MESSAGE_FILE, { encoding: 'utf-8' });
    const msgs = parseMessages(raw);
    const bus = AgentMessageBus.getInstance();
    for (const m of msgs) {
      bus.broadcast('system', m);
      console.log(`Broadcasted: ${m}`);
    }
  } catch (err) {
    console.error('Failed to process messages:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
