/**
 * stdin.ts — read the whole of stdin as the message body.
 *
 * Kept out of command.ts so the command stays a pure function of its arguments
 * and its injected dependencies: every test drives it with a stub rather than
 * having to arrange a real pipe on the process running the suite.
 */

/**
 * Read stdin to end, as UTF-8.
 *
 * There is deliberately no timeout. `send` reads stdin only when the operator
 * gave no message argument AND stdin is not a terminal — meaning something is
 * piping into it — so waiting for that producer to finish is the correct
 * behaviour, and cutting it off at an arbitrary deadline would silently
 * truncate a long message.
 */
export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}
