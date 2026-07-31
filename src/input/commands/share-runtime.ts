import { writeFile } from 'node:fs/promises';
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
import { calcSessionCost, isModelPriced } from '@pellux/goodvibes-sdk/platform/providers';
import {
  GistUploadTarget,
  NO_TOKEN_GUIDANCE,
  resolveGithubToken,
} from '../../export/gist-uploader.ts';
import { copyToClipboard } from '../../utils/clipboard.ts';
import { openBrowser } from '../../utils/browser.ts';

export function registerShareRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'share',
    aliases: [],
    description: 'Export the current session to a shareable format (html, json, md)',
    usage: '<html|json|md> [path] [--redact] [--upload] [--copy] [--open]',
    argsHint: '<html|json|md> [path]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const FORMATS = ['html', 'json', 'md'] as const;
      type Format = typeof FORMATS[number];

      const format = args[0]?.toLowerCase() as Format | undefined;
      if (!format || !FORMATS.includes(format)) {
        ctx.print(
          'Usage: /share <html|json|md> [path] [--redact] [--upload] [--copy] [--open]\n'
          + '  html  — self-contained HTML with syntax highlighting\n'
          + '  json  — structured JSON (machine-readable)\n'
          + '  md    — Markdown\n\n'
          + 'Options:\n'
          + '  --redact  Redact API keys and personal paths from output\n'
          + '  --upload  Upload export as a secret GitHub Gist and print the share link\n'
          + '  --copy    Copy the export file path to the clipboard\n'
          + '  --open    Open HTML export in the default browser\n\n'
          + 'Default path: ~/goodvibes-exports/session-<timestamp>.<ext>',
        );
        return;
      }

      const remainingArgs = args.slice(1);
      const redact  = remainingArgs.includes('--redact');
      const upload  = remainingArgs.includes('--upload');
      const doCopy  = remainingArgs.includes('--copy');
      const doOpen  = remainingArgs.includes('--open');
      const pathArgs = remainingArgs.filter(
        (a) => a !== '--redact' && a !== '--upload' && a !== '--copy' && a !== '--open',
      );
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

      const messages: ExportMessage[] = convData.messages.map((m) => ({
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

      // Accumulate per-message usage totals for session cost calculation.
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      for (const m of convData.messages) {
        if (m.usage) {
          totalInput      += m.usage.inputTokens ?? 0;
          totalOutput     += m.usage.outputTokens ?? 0;
          totalCacheRead  += m.usage.cacheReadTokens ?? 0;
          totalCacheWrite += m.usage.cacheWriteTokens ?? 0;
        }
      }
      const sessionModel = ctx.session.runtime.model;
      const sessionCostUsd = calcSessionCost(
        totalInput, totalOutput, totalCacheRead, totalCacheWrite, sessionModel,
      );
      // The exported document has no field for "this cost is a placeholder" —
      // omit `cost` entirely rather than embed a misleading 0 when the model
      // never resolved to a real price.
      const costIsUnpriced = !isModelPriced(sessionModel);
      if (costIsUnpriced) {
        ctx.print(`Note: cost omitted from export — no pricing data for model "${sessionModel}".`);
      }

      const metadata = {
        model: sessionModel,
        provider: ctx.session.runtime.provider,
        sessionId: ctx.session.runtime.sessionId,
        title: ctx.session.conversationManager.title || undefined,
      };
      const options = { redact, cost: costIsUnpriced ? undefined : sessionCostUsd };

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
      const { dirname, basename } = await import('node:path');
      try {
        mkdirSync(dirname(outputPath), { recursive: true });
      } catch (mkdirErr) {
        logger.warn(
          `[share] mkdir failed for ${dirname(outputPath)}:`,
          mkdirErr instanceof Error ? { message: mkdirErr.message } : undefined,
        );
      }

      try {
        await writeFile(outputPath, outputContent, 'utf-8');
      } catch (err) {
        ctx.print(`Failed to write export: ${summarizeError(err)}`);
        return;
      }

      // Optional Gist upload: resolve auth token then push content as a secret gist.
      let shareLink: string | undefined;
      if (upload) {
        let authHeaders: Record<string, string> | null = null;
        try {
          const svcRegistry = ctx.platform.serviceRegistry;
          if (svcRegistry) {
            authHeaders = await svcRegistry.resolveAuth('github').catch(() => null);
          }
        } catch {
          // serviceRegistry absent or resolveAuth threw — fall through to env var
        }

        const token = resolveGithubToken(authHeaders ?? undefined);
        if (!token) {
          ctx.print(NO_TOKEN_GUIDANCE);
        } else {
          const gistFilename = basename(outputPath);
          const description = metadata.title
            ? `GoodVibes session: ${metadata.title}`
            : 'GoodVibes session export';
          const uploader = new GistUploadTarget(token, description);
          const result = await uploader.upload(outputContent, gistFilename);
          if (result.ok) {
            shareLink = result.url;
          } else {
            ctx.print(`Upload failed: ${result.error}`);
          }
        }
      }

      // Copy export path to clipboard if requested.
      if (doCopy) {
        copyToClipboard(outputPath);
      }

      // Open the exported HTML in the default browser if requested.
      if (doOpen && format === 'html') {
        openBrowser(`file://${outputPath}`);
      }

      // Emit the summary line, with all post-export hints inline.
      const hints: string[] = [];
      if (redact) hints.push('(sensitive data redacted)');
      if (shareLink) hints.push(`Share link: ${shareLink}`);
      if (doCopy) hints.push('(path copied to clipboard)');
      if (doOpen && format === 'html') hints.push('(opened in browser)');
      if (doOpen && format !== 'html') hints.push('(--open ignored: only applies to html)');

      const hint = hints.length > 0 ? '  ' + hints.join('  ') : '';
      ctx.print(`Exported ${format.toUpperCase()} session to ${outputPath}${hint}`);
    },
  });
}
