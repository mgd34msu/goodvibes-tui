import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { getPanelManager } from '../../panels/panel-manager.ts';
import { CodeIntelligence } from '../../intelligence/facade.ts';
import type { DocumentSymbol } from '../../intelligence/lsp/protocol.ts';
import type { SymbolInfo } from '../../intelligence/tree-sitter/queries.ts';

function resolveTargetPath(pathArg: string): string {
  return resolve(process.cwd(), pathArg);
}

function parsePosition(lineArg: string | undefined, columnArg: string | undefined): { line: number; column: number } | null {
  const line = Number.parseInt(lineArg ?? '', 10);
  const column = Number.parseInt(columnArg ?? '', 10);
  if (!Number.isFinite(line) || line < 1 || !Number.isFinite(column) || column < 1) return null;
  return { line: line - 1, column: column - 1 };
}

function formatSymbolKind(kind: number | string | undefined): string {
  if (typeof kind === 'number') return `kind=${kind}`;
  if (typeof kind === 'string' && kind.trim().length > 0) return kind;
  return 'symbol';
}

function formatDocumentSymbol(symbol: DocumentSymbol): string {
  const line = (symbol.selectionRange?.start.line ?? symbol.range.start.line) + 1;
  const column = (symbol.selectionRange?.start.character ?? symbol.range.start.character) + 1;
  return `  ${symbol.name}  ${formatSymbolKind(symbol.kind)}  ${line}:${column}`;
}

function formatTreeSitterSymbol(symbol: SymbolInfo): string {
  return `  ${symbol.name}  ${formatSymbolKind(symbol.kind)}  ${symbol.line + 1}:${symbol.column + 1}`;
}

function ensureExistingFile(pathArg: string | undefined, ctx: CommandContext): string | null {
  if (!pathArg) {
    ctx.print('Intelligence Review\n  Missing file path.');
    return null;
  }
  const targetPath = resolveTargetPath(pathArg);
  if (!existsSync(targetPath)) {
    ctx.print(`Intelligence Review\n  File not found: ${targetPath}`);
    return null;
  }
  return targetPath;
}

export function registerIntelligenceRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'intelligence',
    aliases: ['intel'],
    description: 'Review workspace intelligence readiness, diagnostics posture, and symbol search availability',
    usage: '[review|panel|diagnostics [file]|symbols <file>|outline <file>|definition <file> <line> <column>|references <file> <line> <column>|hover <file> <line> <column>|repair]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      if (sub === 'panel' || sub === 'open') {
        if (ctx.showPanel) ctx.showPanel('intelligence');
        else {
          const panelManager = getPanelManager();
          panelManager.open('intelligence');
          panelManager.show();
          ctx.renderRequest();
        }
        return;
      }

      const intelligence = CodeIntelligence.getInstance();
      const state = ctx.runtimeStore?.getState().intelligence;
      if (!state) {
        ctx.print('Intelligence Review\n  runtime store unavailable');
        return;
      }

      if (sub === 'symbols' || sub === 'outline') {
        const targetPath = ensureExistingFile(args[1], ctx);
        if (!targetPath) return;
        const content = readFileSync(targetPath, 'utf-8');
        if (sub === 'symbols') {
          const symbols = await intelligence.getDocumentSymbols(targetPath, content);
          const entries = symbols.slice(0, 12).map((symbol) => ('selectionRange' in symbol ? formatDocumentSymbol(symbol) : formatTreeSitterSymbol(symbol)));
          ctx.print([
            `Intelligence Symbols: ${targetPath}`,
            `  source: ${state.symbolSearchStatus === 'ready' ? 'LSP/tree-sitter' : 'best-effort tree-sitter/LSP fallback'}`,
            `  status: ${state.symbolSearchStatus}`,
            `  results: ${symbols.length}`,
            ...(entries.length > 0 ? entries : ['  No symbols available for this file.']),
            '  next: /health intelligence',
          ].join('\n'));
          return;
        }

        const outline = await intelligence.getOutline(targetPath, content);
        ctx.print([
          `Intelligence Outline: ${targetPath}`,
          `  source: tree-sitter outline extraction`,
          `  language ready: ${intelligence.hasTreeSitter(targetPath) ? 'yes' : 'no'}`,
          `  results: ${outline.length}`,
          ...(outline.slice(0, 12).map((entry) => `  ${entry.signature || entry.name}  line ${entry.line}`)),
          ...(outline.length === 0 ? ['  No outline entries available for this file.'] : []),
          '  next: /intelligence symbols ' + targetPath,
        ].join('\n'));
        return;
      }

      if (sub === 'definition' || sub === 'references' || sub === 'hover') {
        const targetPath = ensureExistingFile(args[1], ctx);
        if (!targetPath) return;
        const position = parsePosition(args[2], args[3]);
        if (!position) {
          ctx.print(`Intelligence ${sub[0]!.toUpperCase()}${sub.slice(1)}\n  Usage: /intelligence ${sub} <file> <line> <column>`);
          return;
        }

        if (sub === 'definition') {
          const definition = await intelligence.getDefinition(targetPath, position.line, position.column);
          ctx.print([
            `Intelligence Definition: ${targetPath}:${position.line + 1}:${position.column + 1}`,
            `  status: ${state.hoverStatus === 'ready' || state.symbolSearchStatus === 'ready' ? 'available' : 'best-effort'}`,
            ...(definition
              ? [
                  `  target: ${definition.uri}`,
                  `  line: ${definition.range.start.line + 1}`,
                  `  column: ${definition.range.start.character + 1}`,
                  '  next: open the target file or use /intelligence references on the same symbol',
                ]
              : ['  No definition was returned for that position.', '  next: /health intelligence']),
          ].join('\n'));
          return;
        }

        if (sub === 'references') {
          const references = await intelligence.getReferences(targetPath, position.line, position.column);
          ctx.print([
            `Intelligence References: ${targetPath}:${position.line + 1}:${position.column + 1}`,
            `  status: ${state.symbolSearchStatus}`,
            `  results: ${references.length}`,
            ...(references.slice(0, 12).map((reference) => `  ${reference.uri}  ${reference.range.start.line + 1}:${reference.range.start.character + 1}`)),
            ...(references.length === 0 ? ['  No references were returned for that position.'] : []),
            '  next: /intelligence definition ' + `${targetPath} ${position.line + 1} ${position.column + 1}`,
          ].join('\n'));
          return;
        }

        const hover = await intelligence.getHover(targetPath, position.line, position.column);
        const hoverLines = typeof hover?.contents === 'string'
          ? hover.contents.split('\n')
          : Array.isArray(hover?.contents)
            ? hover.contents.flatMap((entry) => typeof entry === 'string' ? entry : entry.value.split('\n'))
            : hover?.contents && 'value' in hover.contents
              ? hover.contents.value.split('\n')
              : [];
        ctx.print([
          `Intelligence Hover: ${targetPath}:${position.line + 1}:${position.column + 1}`,
          `  status: ${state.hoverStatus}`,
          ...(hoverLines.length > 0 ? hoverLines.slice(0, 8).map((line) => `  ${line}`) : ['  No hover information was returned for that position.']),
          '  next: /health intelligence',
        ].join('\n'));
        return;
      }

      if (sub === 'diagnostics') {
        const file = args[1];
        const entries = [...state.diagnostics.entries()]
          .map(([filePath, diagnostics]) => ({
            filePath,
            diagnostics,
            errors: diagnostics.filter((entry) => entry.severity === 'error').length,
            warnings: diagnostics.filter((entry) => entry.severity === 'warning').length,
          }))
          .sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings) || a.filePath.localeCompare(b.filePath));
        const selected = file
          ? entries.find((entry) => entry.filePath === file)
          : entries[0];
        if (!selected) {
          ctx.print('Intelligence Diagnostics\n  No diagnostics are currently tracked.');
          return;
        }
        ctx.print([
          `Intelligence Diagnostics: ${selected.filePath}`,
          `  errors: ${selected.errors}`,
          `  warnings: ${selected.warnings}`,
          ...selected.diagnostics.slice(0, 8).map((diagnostic) => (
            `  [${diagnostic.severity}] ${diagnostic.line + 1}:${diagnostic.column + 1} ${diagnostic.message}`
          )),
          ...(entries.length > 1 ? [`  next: /intelligence diagnostics ${entries[1]!.filePath}`] : []),
        ].join('\n'));
        return;
      }

      if (sub === 'repair') {
        const lines = [
          'Intelligence Repair',
          '  verify: /health intelligence',
          ...(state.diagnosticsStatus !== 'ready' ? ['  /setup review', '  /health intelligence'] : []),
          ...(state.symbolSearchStatus !== 'ready' ? ['  /symbols', '  /intelligence symbols <file>', '  /health intelligence'] : []),
          ...(state.completionsStatus !== 'ready' || state.hoverStatus !== 'ready'
            ? ['  /intelligence review', '  /intelligence hover <file> <line> <column>', '  /setup onboarding']
            : []),
        ];
        ctx.print(lines.length > 1 ? lines.join('\n') : 'Intelligence Repair\n  No active repair actions suggested.');
        return;
      }

      const issues: string[] = [];
      if (state.diagnosticsStatus !== 'ready') issues.push(`diagnostics=${state.diagnosticsStatus}`);
      if (state.symbolSearchStatus !== 'ready') issues.push(`symbols=${state.symbolSearchStatus}`);
      if (state.completionsStatus !== 'ready') issues.push(`completions=${state.completionsStatus}`);
      if (state.hoverStatus !== 'ready') issues.push(`hover=${state.hoverStatus}`);

      ctx.print([
        'Intelligence Review',
        `  diagnostics: ${state.diagnosticsStatus}`,
        `  symbols: ${state.symbolSearchStatus}`,
        `  completions: ${state.completionsStatus}`,
        `  hover: ${state.hoverStatus}`,
        `  errors: ${state.errorCount}`,
        `  warnings: ${state.warningCount}`,
        `  requests: ${state.totalRequests}`,
        `  avg latency: ${Math.round(state.avgLatencyMs)}ms`,
        ...(issues.length > 0 ? [`  issues: ${issues.join(', ')}`] : ['  issues: none']),
        `  diagnostic files: ${state.diagnostics.size}`,
        ...(state.diagnostics.size > 0 ? ['  next: /intelligence diagnostics'] : []),
        '  next: /intelligence symbols <file>',
        '  next: /intelligence outline <file>',
        '  next: /intelligence references <file> <line> <column>',
        '  next: /intelligence definition <file> <line> <column>',
        '  next: /intelligence hover <file> <line> <column>',
        '  next: /intelligence repair',
      ].join('\n'));
    },
  });
}
