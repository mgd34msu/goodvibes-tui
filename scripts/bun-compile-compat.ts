import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type SourcePatch = {
  file: string;
  from: string;
  to: string;
};

export function patchBunCompileCompatibility(root: string): void {
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
  ];

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
    console.log(`prebuild: patched Bun compile JSON loader → ${patch.file.replace(`${root}/`, '')}`);
  }
}
