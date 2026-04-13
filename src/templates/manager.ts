import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, basename } from 'path';

export interface TemplateEntry {
  name: string;
  path: string;
  preview: string;
  scope: 'project' | 'global';
}

export interface TemplateManagerRoots {
  projectRoot: string;
  homeDirectory: string;
}

/**
 * TemplateManager — Save, load, list, delete and expand prompt templates.
 *
 * Storage (searched in order — project takes priority):
 *   .goodvibes/tui/templates/<name>.md   (project-local)
 *   ~/.goodvibes/tui/templates/<name>.md  (global)
 *
 * Variable syntax:
 *   {{var_name}}       Named variable
 *   {{1}}, {{2}}       Positional argument (1-based)
 *   {{template:name}}  Inline template expansion (max depth 3)
 */
export class TemplateManager {
  private readonly globalDir: string;
  private readonly projectDir: string;

  constructor(roots: TemplateManagerRoots) {
    this.globalDir = join(roots.homeDirectory, '.goodvibes', 'tui', 'templates');
    this.projectDir = join(roots.projectRoot, '.goodvibes', 'tui', 'templates');
  }

  /**
   * Save a template to the project-local templates directory.
   * Overwrites if a template with the same name already exists.
   */
  save(name: string, content: string): void {
    const safeName = sanitizeName(name);
    mkdirSync(this.projectDir, { recursive: true });
    writeFileSync(join(this.projectDir, `${safeName}.md`), content, 'utf-8');
  }

  /**
   * Load a template by name. Searches project directory first, then global.
   * Returns null if not found.
   */
  load(name: string): string | null {
    const safeName = sanitizeName(name);
    const projectPath = join(this.projectDir, `${safeName}.md`);
    if (existsSync(projectPath)) {
      return readFileSync(projectPath, 'utf-8');
    }
    const globalPath = join(this.globalDir, `${safeName}.md`);
    if (existsSync(globalPath)) {
      return readFileSync(globalPath, 'utf-8');
    }
    return null;
  }

  /**
   * List all available templates (project + global, deduplicated by name).
   * Project templates take priority when names collide.
   */
  list(): TemplateEntry[] {
    const seen = new Set<string>();
    const entries: TemplateEntry[] = [];

    for (const [dir, scope] of [[this.projectDir, 'project'], [this.globalDir, 'global']] as const) {
      if (!existsSync(dir)) continue;
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const name = basename(file, '.md');
        if (seen.has(name)) continue;
        seen.add(name);
        const filePath = join(dir, file);
        let preview = '';
        try {
          const content = readFileSync(filePath, 'utf-8');
          preview = content.slice(0, 80).replace(/\n/g, ' ').trim();
        } catch {
          preview = '';
        }
        entries.push({ name, path: filePath, preview, scope });
      }
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Delete a template by name. Removes project-local copy first.
   * Returns true if a template was deleted, false if not found.
   */
  delete(name: string): boolean {
    const safeName = sanitizeName(name);
    const projectPath = join(this.projectDir, `${safeName}.md`);
    if (existsSync(projectPath)) {
      rmSync(projectPath);
      return true;
    }
    const globalPath = join(this.globalDir, `${safeName}.md`);
    if (existsSync(globalPath)) {
      rmSync(globalPath);
      return true;
    }
    return false;
  }

  /**
   * Expand variables in a template string.
   *
   * - Named args: { file: 'src/main.ts' } → replaces {{file}}
   * - Positional args: positional[0] → replaces {{1}}
   * - Template refs: {{template:name}} → recursively expands (max depth 3)
   * - Missing variables are left as-is: {{var_name}}
   */
  expand(
    template: string,
    args: Record<string, string>,
    _depth = 0
  ): string {
    if (_depth >= 3) return template;

    let result = template;

    // Expand {{template:name}} references first (recursive, depth-limited)
    result = result.replace(/\{\{template:([^}]+)\}\}/g, (_match, refName: string) => {
      const refContent = this.load(refName.trim());
      if (refContent === null) return `{{template:${refName}}}`;
      return this.expand(refContent, args, _depth + 1);
    });

    // Expand named variables {{var_name}} and positional {{1}}, {{2}}, ...
    result = result.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
      const trimmedKey = key.trim();
      if (trimmedKey in args) {
        return args[trimmedKey];
      }
      // Leave missing variables as-is
      return `{{${trimmedKey}}}`;
    });

    return result;
  }
}

/** Sanitize a template name: lowercase, alphanumeric, hyphens and underscores only. */
function sanitizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '')
    || 'template'
  );
}

/** Parse slash-command arguments into named/positional map. */
export function parseTemplateArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  let positionalIndex = 1;

  for (const arg of args) {
    const eqIdx = arg.indexOf('=');
    if (eqIdx > 0) {
      const key = arg.slice(0, eqIdx);
      const value = arg.slice(eqIdx + 1);
      result[key] = value;
    } else {
      result[String(positionalIndex)] = arg;
      positionalIndex++;
    }
  }

  return result;
}
