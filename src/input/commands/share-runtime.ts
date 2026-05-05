import { writeFile } from 'node:fs/promises';
import { resolve } from 'path';
import type { CommandRegistry } from '../command-registry.ts';
import {
  type ExportMessage,
  defaultExportPath,
  exportToHTML,
  exportToJSON,
  exportToMarkdownExtended,
} from '@pellux/goodvibes-sdk/platform/export';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

export function registerShareRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'share',
    aliases: [],
    description: 'Export the current session to a shareable format (html, json, md)',
    usage: '<html|json|md> [path] [--redact]',
    argsHint: '<html|json|md> [path]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const FORMATS = ['html', 'json', 'md'] as const;
      type Format = typeof FORMATS[number];

      const format = args[0]?.toLowerCase() as Format | undefined;
      if (!format || !FORMATS.includes(format)) {
        ctx.print(
          'Usage: /share <html|json|md> [path] [--redact]\n'
          + '  html  — self-contained HTML with syntax highlighting\n'
          + '  json  — structured JSON (machine-readable)\n'
          + '  md    — Markdown\n\n'
          + 'Options:\n'
          + '  --redact  Redact API keys and personal paths from output\n\n'
          + 'Default path: ~/goodvibes-exports/session-<timestamp>.<ext>',
        );
        return;
      }

      const remainingArgs = args.slice(1);
      const redact = remainingArgs.includes('--redact');
      const pathArgs = remainingArgs.filter(a => a !== '--redact');
      const outputPath = pathArgs.length > 0
        ? shellPaths.resolveWorkspacePath(pathArgs[0])
        : defaultExportPath(format, shellPaths.homeDirectory);

      const convData = ctx.session.conversationManager.toJSON() as {
        messages: Array<{
          role: string;
          content: unknown;
          toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
          callId?: string;
          toolName?: string;
          reasoningContent?: string;
          reasoningSummary?: string;
          usage?: {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          };
          cancelled?: boolean;
        }>;
      };

      if (!convData.messages || convData.messages.length === 0) {
        ctx.print('Nothing to export — conversation is empty.');
        return;
      }

      const messages: ExportMessage[] = convData.messages.map(m => ({
        role: m.role as ExportMessage['role'],
        content: m.content as string,
        toolCalls: m.toolCalls,
        callId: m.callId,
        toolName: m.toolName,
        reasoningContent: m.reasoningContent,
        reasoningSummary: m.reasoningSummary,
        usage: m.usage,
        cancelled: m.cancelled,
      }));
      const metadata = {
        model: ctx.session.runtime.model,
        provider: ctx.session.runtime.provider,
        sessionId: ctx.session.runtime.sessionId,
        title: ctx.session.conversationManager.title || undefined,
      };
      const options = { redact };

      let outputContent: string;
      try {
        if (format === 'html') outputContent = exportToHTML(messages, metadata, options);
        else if (format === 'json') outputContent = exportToJSON(messages, metadata, options);
        else outputContent = exportToMarkdownExtended(messages, metadata, options);
      } catch (err) {
        ctx.print(`Export failed: ${summarizeError(err)}`);
        return;
      }

      const { mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      try {
        mkdirSync(dirname(outputPath), { recursive: true });
      } catch (mkdirErr) {
        logger.warn(`[share] mkdir failed for ${dirname(outputPath)}:`, mkdirErr instanceof Error ? { message: mkdirErr.message } : undefined);
      }

      try {
        await writeFile(outputPath, outputContent, 'utf-8');
      } catch (err) {
        ctx.print(`Failed to write export: ${summarizeError(err)}`);
        return;
      }

      ctx.print(`Exported ${format.toUpperCase()} session to ${outputPath}${redact ? ' (sensitive data redacted)' : ''}`);
    },
  });
}
