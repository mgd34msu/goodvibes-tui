import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type SourcePatch = {
  file: string;
  from: string;
  to: string;
};

export function patchBunCompileCompatibility(root: string): void {
  const jsdomDefaultStyleSheet = join(root, 'node_modules', 'jsdom', 'lib', 'jsdom', 'browser', 'default-stylesheet.css');
  const sqlWasmJs = join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.js');
  const sqlWasmBinary = join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const patches: SourcePatch[] = [
    {
      file: join(root, 'node_modules', 'css-tree', 'lib', 'data-patch.js'),
      from: `import { createRequire } from 'module';\n\nconst require = createRequire(import.meta.url);\nconst patch = require('../data/patch.json');\n\nexport default patch;\n`,
      to: `import patch from '../data/patch.json';\n\nexport default patch;\n`,
    },
    {
      file: join(root, 'node_modules', 'css-tree', 'lib', 'data.js'),
      from: `import { createRequire } from 'module';\nimport patch from './data-patch.js';\n\nconst require = createRequire(import.meta.url);\nconst mdnAtrules = require('mdn-data/css/at-rules.json');\nconst mdnProperties = require('mdn-data/css/properties.json');\nconst mdnSyntaxes = require('mdn-data/css/syntaxes.json');\n`,
      to: `import mdnAtrules from 'mdn-data/css/at-rules.json';\nimport mdnProperties from 'mdn-data/css/properties.json';\nimport mdnSyntaxes from 'mdn-data/css/syntaxes.json';\nimport patch from './data-patch.js';\n`,
    },
    {
      file: join(root, 'node_modules', 'css-tree', 'lib', 'version.js'),
      from: `import { createRequire } from 'module';\n\nconst require = createRequire(import.meta.url);\n\nexport const { version } = require('../package.json');\n`,
      to: `import packageInfo from '../package.json';\n\nexport const { version } = packageInfo;\n`,
    },
    {
      file: join(root, 'node_modules', 'jsdom', 'lib', 'jsdom', 'living', 'xhr', 'XMLHttpRequest-impl.js'),
      from: `const syncWorkerFile = require.resolve("./xhr-sync-worker.js");\n`,
      to: `const syncWorkerFile = null;\n`,
    },
    {
      file: join(root, 'node_modules', 'jsdom', 'lib', 'jsdom', 'living', 'xhr', 'XMLHttpRequest-impl.js'),
      from: `  if (!syncWorker) {\n    syncWorker = new Worker(syncWorkerFile);\n`,
      to: `  if (!syncWorker) {\n    if (!syncWorkerFile) {\n      throw new Error("Synchronous XMLHttpRequest is not supported in Bun-compiled GoodVibes binaries.");\n    }\n    syncWorker = new Worker(syncWorkerFile);\n`,
    },
  ];

  if (existsSync(jsdomDefaultStyleSheet)) {
    const defaultStyleSheet = JSON.stringify(readFileSync(jsdomDefaultStyleSheet, 'utf8'));
    patches.push({
      file: join(root, 'node_modules', 'jsdom', 'lib', 'jsdom', 'living', 'css', 'helpers', 'computed-style.js'),
      from: `const defaultStyleSheet = fs.readFileSync(\n  path.resolve(__dirname, "../../../browser/default-stylesheet.css"),\n  { encoding: "utf-8" }\n);\n`,
      to: `const defaultStyleSheet = ${defaultStyleSheet};\n`,
    });
  }

  if (existsSync(sqlWasmBinary)) {
    const sqlWasmBase64 = readFileSync(sqlWasmBinary).toString('base64');
    patches.push({
      file: sqlWasmJs,
      from: `k.noExitRuntime&&(Ya=k.noExitRuntime);k.print&&(Da=k.print);k.printErr&&(B=k.printErr);k.wasmBinary&&(Ea=k.wasmBinary);k.thisProgram&&(wa=k.thisProgram);\n`,
      to: `k.noExitRuntime&&(Ya=k.noExitRuntime);k.print&&(Da=k.print);k.printErr&&(B=k.printErr);k.wasmBinary&&(Ea=k.wasmBinary);if(!Ea&&typeof Buffer!=="undefined"){Ea=new Uint8Array(Buffer.from("${sqlWasmBase64}","base64"));}k.thisProgram&&(wa=k.thisProgram);\n`,
    });
  }

  for (const patch of patches) {
    if (!existsSync(patch.file)) {
      continue;
    }

    const source = readFileSync(patch.file, 'utf8');
    if (source.includes(patch.to)) {
      continue;
    }

    if (!source.includes(patch.from)) {
      console.warn(`prebuild: skipped Bun compile compatibility patch for unexpected file shape: ${patch.file}`);
      continue;
    }

    writeFileSync(patch.file, source.replace(patch.from, patch.to));
    console.log(`prebuild: patched Bun compile compatibility → ${patch.file.replace(`${root}/`, '')}`);
  }
}
