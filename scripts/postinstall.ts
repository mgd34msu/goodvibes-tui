#!/usr/bin/env bun
/**
 * postinstall — copies bundled skills and agents to ~/.goodvibes/tui/
 * 
 * Runs after `bun run build` or can be called manually.
 * Only copies if the destination doesn't exist. Never overwrites.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const projectRoot = join(import.meta.dir, '..');
const home = homedir();

interface CopyTarget {
  src: string;
  dest: string;
}

const targets: CopyTarget[] = [
  { src: join(projectRoot, '.goodvibes', 'skills'), dest: join(home, '.goodvibes', 'tui', 'skills') },
  { src: join(projectRoot, '.goodvibes', 'agents'), dest: join(home, '.goodvibes', 'tui', 'agents') },
];

let installed = 0;
let skipped = 0;

for (const { src, dest } of targets) {
  if (!existsSync(src)) continue;

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (existsSync(destPath)) {
      skipped++;
      continue;
    }

    mkdirSync(dest, { recursive: true });

    if (entry.isDirectory()) {
      cpSync(srcPath, destPath, { recursive: true });
      console.log(`  installed: ${entry.name}/`);
      installed++;
    } else if (entry.name.endsWith('.md')) {
      cpSync(srcPath, destPath);
      console.log(`  installed: ${entry.name}`);
      installed++;
    }
  }
}

if (installed > 0 || skipped > 0) {
  console.log(`postinstall: ${installed} installed, ${skipped} already exist (skipped)`);
} else {
  console.log('postinstall: nothing to deploy');
}
