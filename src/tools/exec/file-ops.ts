import { copyFileSync, renameSync, unlinkSync, rmSync, cpSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, isAbsolute, join, relative, dirname } from 'node:path';
import { logger } from '../../utils/logger.ts';
import { resolveAndValidatePath } from '../../utils/path-safety.ts';
import type { ExecFileOp } from './schema.ts';
import { summarizeError } from '../../utils/error-display.ts';

export interface FileOpResult {
  op: string;
  source: string;
  destination?: string;
  dry_run?: boolean;
  would_delete?: string[];
  updated_imports?: string[];
}

function resolveFileOpPath(p: string, op: 'copy' | 'move' | 'delete', projectRoot: string): string {
  if (op === 'delete' || !isAbsolute(p)) {
    return resolveAndValidatePath(p, projectRoot);
  }
  return resolve(p);
}

function collectPaths(p: string, acc: string[] = []): string[] {
  try {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) {
        collectPaths(join(p, entry), acc);
      }
    } else {
      acc.push(p);
    }
  } catch {
    acc.push(p);
  }
  return acc;
}

function computeRelativeImportPath(fromFile: string, toFile: string): string {
  const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  const toDir = dirname(toFile);
  let rel = relative(dirname(fromFile), toDir);
  if (rel === '' || !rel.startsWith('.')) rel = './' + (rel || '');
  const ext = toFile.slice(toFile.lastIndexOf('.'));
  const base = toFile.slice(toDir.length + 1, TS_EXTS.has(ext) ? toFile.lastIndexOf('.') : undefined);
  return rel.endsWith('/') ? rel + base : rel + '/' + base;
}

async function updateImportsAfterMove(oldSrc: string, newDst: string, projectRoot: string): Promise<string[]> {
  const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.nuxt', '.cache', '__pycache__']);
  const allFiles: string[] = [];

  function walkDir(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) { walkDir(full); continue; }
        const ext = full.slice(full.lastIndexOf('.'));
        if (TS_EXTS.has(ext)) allFiles.push(full);
      } catch {
        // skip
      }
    }
  }
  walkDir(projectRoot);

  const updated: string[] = [];
  for (const file of allFiles) {
    if (file === newDst) continue;
    let content: string;
    try { content = readFileSync(file, 'utf-8'); } catch { continue; }

    const oldSpecifier = computeRelativeImportPath(file, oldSrc);
    const newSpecifier = computeRelativeImportPath(file, newDst);
    if (oldSpecifier === newSpecifier) continue;

    const escaped = oldSpecifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const importRe = new RegExp(`(from\\s+['"])${escaped}(['"])`, 'g');
    const requireRe = new RegExp(`(require\\(['"])${escaped}(['"]\\))`, 'g');

    const newContent = content
      .replace(importRe, `$1${newSpecifier}$2`)
      .replace(requireRe, `$1${newSpecifier}$2`);

    if (newContent !== content) {
      try {
        writeFileSync(file, newContent, 'utf-8');
        updated.push(file);
      } catch (err) {
        logger.debug('exec file_ops update_imports: write failed (non-fatal)', {
          file,
          error: summarizeError(err),
        });
      }
    }
  }

  return updated;
}

export function executeFileOp(op: ExecFileOp, projectRoot: string): FileOpResult {
  const src = resolveFileOpPath(op.source, op.op, projectRoot);
  const result: FileOpResult = { op: op.op, source: src };

  if (op.op === 'delete') {
    if (op.dry_run) {
      result.dry_run = true;
      result.would_delete = collectPaths(src);
      return result;
    }
    if (op.recursive) {
      rmSync(src, { recursive: true, force: true });
    } else {
      unlinkSync(src);
    }
    return result;
  }

  if (!op.destination) {
    throw new Error(`file_ops ${op.op} requires destination`);
  }
  const dst = resolveFileOpPath(op.destination, op.op, projectRoot);
  result.destination = dst;

  if (!op.overwrite && existsSync(dst)) {
    throw new Error(`file_ops ${op.op}: destination already exists: '${op.destination}'. Set overwrite: true to replace it.`);
  }

  if (op.op === 'copy') {
    if (op.recursive) {
      cpSync(src, dst, { recursive: true });
    } else {
      copyFileSync(src, dst);
    }
    return result;
  }

  if (op.op === 'move') {
    try {
      renameSync(src, dst);
    } catch {
      if (op.recursive) {
        cpSync(src, dst, { recursive: true });
        rmSync(src, { recursive: true, force: true });
      } else {
        copyFileSync(src, dst);
        unlinkSync(src);
      }
    }
  }

  return result;
}

export async function executeFileOperations(
  fileOps: ExecFileOp[] | undefined,
  projectRoot: string,
): Promise<{ fileOpResults: FileOpResult[]; fileOpError?: string }> {
  const fileOpResults: FileOpResult[] = [];
  const pendingImportUpdates: Array<{ src: string; dst: string }> = [];

  if (!fileOps || fileOps.length === 0) {
    return { fileOpResults };
  }

  for (const op of fileOps) {
    try {
      const opResult = executeFileOp(op, projectRoot);
      fileOpResults.push(opResult);
      if (op.op === 'move' && op.update_imports && opResult.destination) {
        pendingImportUpdates.push({ src: opResult.source, dst: opResult.destination });
      }
    } catch (err) {
      const msg = summarizeError(err);
      return { fileOpResults, fileOpError: `file_ops failed: ${msg}` };
    }
  }

  for (const { src, dst } of pendingImportUpdates) {
    try {
      const updated = await updateImportsAfterMove(src, dst, projectRoot);
      const matchingResult = fileOpResults.find((r) => r.source === src && r.destination === dst);
      if (matchingResult) matchingResult.updated_imports = updated;
    } catch (err) {
      logger.debug('exec file_ops: update_imports failed (non-fatal)', {
        src,
        dst,
        error: summarizeError(err),
      });
    }
  }

  return { fileOpResults };
}
