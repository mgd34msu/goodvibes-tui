import type {
  ComponentInfo,
  LayoutInfo,
  A11yIssue,
  ComponentStateInfo,
  StateVar,
  RenderTriggersInfo,
  RenderTrigger,
  HooksInfo,
  HookDep,
  OverflowInfo,
  OverflowIssue,
  SizingInfo,
  SizingItem,
  StackingInfo,
  ZIndexItem,
  ResponsiveInfo,
  BreakpointUsage,
  EventsInfo,
  EventHandler,
  TailwindInfo,
  TailwindConflict,
  ClientBoundaryInfo,
  ErrorBoundaryInfo,
} from './schema.ts';

export function inspectComponents(content: string): ComponentInfo[] {
  const components: ComponentInfo[] = [];
  const lines = content.split('\n');

  const FN_COMP_RE = /^(?:export\s+(?:default\s+)?)?function\s+(\w+)\s*\(/;
  const ARROW_COMP_RE = /^(?:export\s+(?:const|default)\s+)(\w+)\s*(?::\s*React\.FC[^=]*)?=\s*(?:(?:\([^)]*\)|\w+)\s*=>|React\.memo)/;
  const CLASS_COMP_RE = /^(?:export\s+(?:default\s+)?)?class\s+(\w+)\s+extends\s+(?:React\.)?(?:Component|PureComponent)/;
  const HOOK_RE = /\b(use[A-Z]\w*)\s*\(/g;
  const CHILD_COMP_RE = /<([A-Z]\w*)(?:\s|>|\/)/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let name: string | null = null;
    let kind: ComponentInfo['kind'] = 'function';

    let fnMatch = FN_COMP_RE.exec(line);
    if (fnMatch) {
      name = fnMatch[1];
      kind = 'function';
    }

    if (!name) {
      const arrowMatch = ARROW_COMP_RE.exec(line);
      if (arrowMatch) {
        name = arrowMatch[1];
        kind = 'arrow';
      }
    }

    if (!name) {
      const classMatch = CLASS_COMP_RE.exec(line);
      if (classMatch) {
        name = classMatch[1];
        kind = 'class';
      }
    }

    if (!name || !/^[A-Z]/.test(name)) continue;

    let body = '';
    const end = Math.min(i + 50, lines.length);
    for (let j = i; j < end; j++) body += lines[j] + '\n';

    const hooks: string[] = [];
    const hooksSeen = new Set<string>();
    let hm: RegExpExecArray | null;
    const hookRe = new RegExp(HOOK_RE.source, 'g');
    while ((hm = hookRe.exec(body)) !== null) {
      if (!hooksSeen.has(hm[1])) {
        hooksSeen.add(hm[1]);
        hooks.push(hm[1]);
      }
    }

    const children: string[] = [];
    const childSeen = new Set<string>();
    let cm: RegExpExecArray | null;
    const childRe = new RegExp(CHILD_COMP_RE.source, 'g');
    while ((cm = childRe.exec(body)) !== null) {
      if (!childSeen.has(cm[1]) && cm[1] !== name) {
        childSeen.add(cm[1]);
        children.push(cm[1]);
      }
    }

    const props: string[] = [];
    const propLine = lines.slice(i, Math.min(i + 5, lines.length)).join(' ');
    const PROPS_DESTRUCTURE_RE = /\{\s*([^}]+)\s*\}/;
    const pm = PROPS_DESTRUCTURE_RE.exec(propLine);
    if (pm) {
      props.push(
        ...pm[1]
          .split(',')
          .map((p) => p.trim().replace(/[=:][^,]*/g, '').trim())
          .filter((p) => /^\w+$/.test(p)),
      );
    }

    components.push({ name, kind, line: i + 1, props, hooks, children });
  }

  return components;
}

export function inspectLayout(content: string, file: string): LayoutInfo {
  const displays: string[] = [];
  const flex: string[] = [];
  const grid: string[] = [];
  const sizing: string[] = [];
  const overflow: string[] = [];

  const DISPLAY_RE = /\b(flex|grid|block|inline|inline-flex|inline-grid|inline-block|hidden|contents|flow-root)\b/g;
  const FLEX_RE = /\b(flex-(?:row|col|wrap|nowrap|1|auto|none|grow|shrink)|justify-(?:start|end|center|between|around|evenly)|items-(?:start|end|center|stretch|baseline)|gap-\w+|space-[xy]-\w+|self-\w+)\b/g;
  const GRID_RE = /\b(grid-cols-\w+|grid-rows-\w+|col-span-\w+|row-span-\w+|place-\w+-\w+)\b/g;
  const SIZING_RE = /\b(w-\w+|h-\w+|min-w-\w+|min-h-\w+|max-w-\w+|max-h-\w+|size-\w+)\b/g;
  const OVERFLOW_RE = /\b(overflow-(?:hidden|auto|scroll|visible|x-\w+|y-\w+)|truncate|text-ellipsis|whitespace-\w+)\b/g;

  const extract = (re: RegExp, target: string[]): void => {
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, 'g');
    while ((m = r.exec(content)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        target.push(m[1]);
      }
    }
  };

  extract(DISPLAY_RE, displays);
  extract(FLEX_RE, flex);
  extract(GRID_RE, grid);
  extract(SIZING_RE, sizing);
  extract(OVERFLOW_RE, overflow);

  return { file, displays, flex, grid, sizing, overflow };
}

export function inspectAccessibility(content: string): A11yIssue[] {
  const issues: A11yIssue[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (/<img\b(?![^>]*\balt=)/i.test(line)) {
      issues.push({
        line: lineNo,
        code: 'img-alt',
        message: 'img element is missing an alt attribute',
        wcag: 'WCAG 1.1.1 (Level A)',
      });
    }

    if (/<button\b(?![^>]*(?:aria-label|aria-labelledby|title))/i.test(line)) {
      const hasContent = />[^<]+<\/button>/i.test(line) || />[^<]+/.test(line);
      if (!hasContent) {
        issues.push({
          line: lineNo,
          code: 'button-name',
          message: 'button element may be missing an accessible name',
          wcag: 'WCAG 4.1.2 (Level A)',
        });
      }
    }

    if (/onClick/.test(line)) {
      if (/<(?:div|span)\b(?![^>]*\brole=)[^>]*onClick/i.test(line)) {
        issues.push({
          line: lineNo,
          code: 'click-events-have-key-events',
          message: 'Non-interactive element has onClick without a role attribute',
          wcag: 'WCAG 4.1.2 (Level A)',
        });
      }
    }

    if (/<input\b/i.test(line) && !/type=['"]hidden['"]/.test(line)) {
      if (!/<label/i.test(line) && !/aria-label/.test(line) && !/aria-labelledby/.test(line)) {
        const context = lines.slice(Math.max(0, i - 3), i + 1).join(' ');
        if (!/<label/i.test(context) && !/aria-label/.test(context)) {
          issues.push({
            line: lineNo,
            code: 'label',
            message: 'input element may be missing an associated label',
            wcag: 'WCAG 1.3.1 (Level A)',
          });
        }
      }
    }
  }

  return issues;
}

export function inspectComponentState(content: string, file: string): ComponentStateInfo {
  const lines = content.split('\n');
  const stateVars: StateVar[] = [];
  const useStateRe = /const\s*\[\s*(\w+)\s*,/;
  const useContextRe = /(?:const|let|var)\s+(\w+)\s*=\s*useContext\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (/\buseState\s*\(/.test(line)) {
      const m = useStateRe.exec(line);
      stateVars.push({ name: m ? m[1] : '(unknown)', kind: 'useState', line: ln });
    } else if (/\buseReducer\s*\(/.test(line)) {
      const m = useStateRe.exec(line);
      stateVars.push({ name: m ? m[1] : '(unknown)', kind: 'useReducer', line: ln });
    } else if (/\buseContext\s*\(/.test(line)) {
      const m = useContextRe.exec(line);
      stateVars.push({ name: m ? m[1] : '(unknown)', kind: 'useContext', line: ln });
    }
  }
  return { file, stateVars, count: stateVars.length };
}

export function inspectRenderTriggers(content: string, file: string): RenderTriggersInfo {
  const lines = content.split('\n');
  const triggers: RenderTrigger[] = [];
  const setterRe = /const\s*\[\s*\w+\s*,\s*(set\w+)\s*\]/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (setterRe.test(line)) {
      const m = setterRe.exec(line);
      if (m) triggers.push({ kind: 'state_setter', name: m[1], line: ln });
    }
    if (/\buseEffect\s*\(/.test(line)) triggers.push({ kind: 'effect_dep', name: 'useEffect', line: ln });
    if (/\buseMemo\s*\(/.test(line)) triggers.push({ kind: 'memo_dep', name: 'useMemo', line: ln });
    if (/\buseCallback\s*\(/.test(line)) triggers.push({ kind: 'callback_dep', name: 'useCallback', line: ln });
    if (/(?:React\.memo|\bmemo)\s*\(/.test(line)) triggers.push({ kind: 'memo_boundary', name: 'memo', line: ln });
  }
  return { file, triggers, count: triggers.length };
}

export function inspectHooks(content: string, file: string): HooksInfo {
  const lines = content.split('\n');
  const hooks: HookDep[] = [];
  let missingDepsCount = 0;
  const hookRe = /\b(useEffect|useMemo|useCallback)\s*\(/;
  const inlineDepsRe = /[},]\s*\[([^\]]*)\]\s*\)/;
  const skipKeywords = new Set(['useEffect', 'useMemo', 'useCallback', 'return', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'true', 'false', 'null', 'undefined', 'async', 'await', 'function', 'new', 'this', 'of', 'in', 'console', 'Math', 'JSON', 'Array', 'Object', 'Promise', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'window', 'document', 'fetch', 'NaN', 'Infinity', 'Error', 'RegExp', 'Date', 'Map', 'Set', 'parseInt', 'parseFloat']);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hm = hookRe.exec(line);
    if (!hm) continue;
    const hookKind = hm[1] as 'useEffect' | 'useMemo' | 'useCallback';
    const ln = i + 1;
    const body = lines.slice(i, Math.min(i + 30, lines.length)).join('\n');
    const dm = inlineDepsRe.exec(body);
    const deps = dm ? dm[1].split(',').map((d) => d.trim()).filter(Boolean) : [];
    const callbackBody = body.slice(0, body.lastIndexOf(']'));
    const usedVarsRe = /\b([a-zA-Z_$][\w$]*)\b/g;
    const usedVars = new Set<string>();
    let vm: RegExpExecArray | null;
    while ((vm = usedVarsRe.exec(callbackBody)) !== null) {
      if (!skipKeywords.has(vm[1]) && vm[1].length > 1) usedVars.add(vm[1]);
    }
    const missing = [...usedVars].filter((v) => !deps.includes(v) && /^[a-z]/.test(v)).slice(0, 5);
    if (missing.length) missingDepsCount++;
    hooks.push({ hookKind, line: ln, deps, missing });
  }
  return { file, hooks, missingDepsCount };
}

export function inspectOverflow(content: string, file: string): OverflowInfo {
  const lines = content.split('\n');
  const issues: OverflowIssue[] = [];
  const hasHeightRe = /\b(?:h-|max-h-|height)\b/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    if (/\boverflow-hidden\b/.test(line) || /overflow\s*:\s*hidden/.test(line)) {
      if (!hasHeightRe.test(line)) {
        issues.push({ line: ln, kind: 'hidden_clip', snippet: line.trim().slice(0, 80) });
      }
    } else if (/\b(?:overflow-(?:scroll|auto|y-scroll|y-auto|x-scroll|x-auto))\b/.test(line) || /overflow(?:-y|-x)?\s*:\s*(?:scroll|auto)/.test(line)) {
      if (!hasHeightRe.test(line)) {
        issues.push({ line: ln, kind: 'scroll_no_height', snippet: line.trim().slice(0, 80) });
      }
    }
  }
  return { file, issues, count: issues.length };
}

export function inspectSizing(content: string, file: string): SizingInfo {
  const lines = content.split('\n');
  const items: SizingItem[] = [];
  let hardcodedCount = 0;
  const tailwindFixedRe = /\b(?:w|h|min-w|max-w|min-h|max-h)-(\d+)\b/g;
  const tailwindPctRe = /\b(?:w|h)-(\d+\/\d+|full|screen)\b/g;
  const tailwindFlexRe = /\bflex-(?:1|auto|none|initial|grow|shrink)\b/g;
  const tailwindGridRe = /\bgrid-cols-\d+\b/g;
  const tailwindVpRe = /\b(?:w|h)-(?:screen|lvh|svh|dvh)\b/g;
  const cssPxRe = /(?:width|height|min-width|max-width|min-height|max-height)\s*:\s*(\d+)px/g;
  const cssPctRe = /(?:width|height)\s*:\s*(\d+%)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    let m: RegExpExecArray | null;
    tailwindFixedRe.lastIndex = 0;
    while ((m = tailwindFixedRe.exec(line)) !== null) {
      const val = parseInt(m[1]);
      const flagged = val > 96;
      if (flagged) hardcodedCount++;
      items.push({ line: ln, kind: 'fixed_px', value: m[0], flagged });
    }
    tailwindPctRe.lastIndex = 0;
    while ((m = tailwindPctRe.exec(line)) !== null) {
      items.push({ line: ln, kind: 'percentage', value: m[0], flagged: false });
    }
    tailwindFlexRe.lastIndex = 0;
    while ((m = tailwindFlexRe.exec(line)) !== null) {
      items.push({ line: ln, kind: 'flex', value: m[0], flagged: false });
    }
    tailwindGridRe.lastIndex = 0;
    while ((m = tailwindGridRe.exec(line)) !== null) {
      items.push({ line: ln, kind: 'grid', value: m[0], flagged: false });
    }
    tailwindVpRe.lastIndex = 0;
    while ((m = tailwindVpRe.exec(line)) !== null) {
      items.push({ line: ln, kind: 'viewport', value: m[0], flagged: false });
    }
    cssPxRe.lastIndex = 0;
    while ((m = cssPxRe.exec(line)) !== null) {
      const flagged = parseInt(m[1]) > 200;
      if (flagged) hardcodedCount++;
      items.push({ line: ln, kind: 'fixed_px', value: m[0], flagged });
    }
    cssPctRe.lastIndex = 0;
    while ((m = cssPctRe.exec(line)) !== null) {
      items.push({ line: ln, kind: 'percentage', value: m[0], flagged: false });
    }
  }
  return { file, items, hardcodedCount };
}

export function inspectStacking(content: string, file: string): StackingInfo {
  const lines = content.split('\n');
  const zIndexItems: ZIndexItem[] = [];
  const tailwindZRe = /-?z-(\d+|auto)\b/g;
  const cssZRe = /z-index\s*:\s*(-?\d+)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    let m: RegExpExecArray | null;
    tailwindZRe.lastIndex = 0;
    while ((m = tailwindZRe.exec(line)) !== null) {
      zIndexItems.push({ line: ln, value: m[0], context: line.trim().slice(0, 60) });
    }
    cssZRe.lastIndex = 0;
    while ((m = cssZRe.exec(line)) !== null) {
      zIndexItems.push({ line: ln, value: m[0], context: line.trim().slice(0, 60) });
    }
  }
  const byValue = new Map<string, number[]>();
  for (const item of zIndexItems) {
    const existing = byValue.get(item.value) ?? [];
    existing.push(item.line);
    byValue.set(item.value, existing);
  }
  const potentialConflicts: Array<{ values: string[]; lines: number[] }> = [];
  for (const [val, lineNums] of byValue) {
    if (lineNums.length > 1) potentialConflicts.push({ values: [val], lines: lineNums });
  }
  return { file, zIndexItems, potentialConflicts };
}

export function inspectResponsive(content: string, file: string): ResponsiveInfo {
  const lines = content.split('\n');
  const prefixes = ['sm', 'md', 'lg', 'xl', '2xl'] as const;
  const breakpointMap = new Map<string, string[]>();
  for (const p of prefixes) breakpointMap.set(p, []);
  const re = /\b(sm|md|lg|xl|2xl):([-\w/[\]]+)/g;
  for (const line of lines) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const arr = breakpointMap.get(m[1])!;
      arr.push(m[0]);
    }
  }
  const breakpoints: BreakpointUsage[] = [];
  for (const p of prefixes) {
    const classes = breakpointMap.get(p)!;
    if (classes.length) breakpoints.push({ prefix: p, count: classes.length, classes: [...new Set(classes)].slice(0, 20) });
  }
  return { file, breakpoints, hasMobileFirst: (breakpointMap.get('sm')?.length ?? 0) > 0 };
}

export function inspectEvents(content: string, file: string): EventsInfo {
  const lines = content.split('\n');
  const handlers: EventHandler[] = [];
  const eventRe = /\bon(Click|Change|Submit|KeyDown|KeyUp|KeyPress|Focus|Blur|MouseEnter|MouseLeave|Input|Scroll|Resize)\s*[={]/gi;
  const preventDefaultRe = /\.preventDefault\s*\(/;
  const stopPropagationRe = /\.stopPropagation\s*\(/;
  const delegationRe = /(?:document|window)\s*\.\s*addEventListener\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    eventRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = eventRe.exec(line)) !== null) {
      const ln = i + 1;
      const ctx = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 4)).join('\n');
      handlers.push({
        line: ln,
        event: m[0].slice(0, -1).trim(),
        hasPreventDefault: preventDefaultRe.test(ctx),
        hasStopPropagation: stopPropagationRe.test(ctx),
        isDelegated: delegationRe.test(line),
      });
    }
  }
  return { file, handlers, count: handlers.length };
}

export function inspectTailwind(content: string, file: string): TailwindInfo {
  const lines = content.split('\n');
  const conflicts: TailwindConflict[] = [];
  const conflictGroups: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /\bp-(\d+|px|py|\w+)\b/g, name: 'padding' },
    { pattern: /\bm-(\d+|px|py|auto|\w+)\b/g, name: 'margin' },
    { pattern: /\btext-(red|blue|green|yellow|purple|pink|gray|black|white|slate|zinc|neutral|stone|orange|amber|lime|emerald|teal|cyan|sky|violet|fuchsia|rose)-(\d+)\b/g, name: 'text-color' },
    { pattern: /\bbg-(red|blue|green|yellow|purple|pink|gray|black|white|slate|zinc|neutral|stone|orange|amber|lime|emerald|teal|cyan|sky|violet|fuchsia|rose)-(\d+)?\b/g, name: 'background' },
    { pattern: /\b(?:block|inline-block|inline|flex|inline-flex|grid|inline-grid|hidden|contents|flow-root|list-item)\b/g, name: 'display' },
    { pattern: /\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/g, name: 'font-size' },
    { pattern: /\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/g, name: 'font-weight' },
    { pattern: /\bjustify-(start|end|center|between|around|evenly|stretch)\b/g, name: 'justify-content' },
    { pattern: /\bitems-(start|end|center|baseline|stretch)\b/g, name: 'align-items' },
    { pattern: /\bw-(\d+|\/\w+|full|screen|auto|min|max|fit)\b/g, name: 'width' },
    { pattern: /\bh-(\d+|\/\w+|full|screen|auto|min|max|fit)\b/g, name: 'height' },
  ];
  const classNameRe = /className\s*=\s*["']([^"']+)["']/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let cm: RegExpExecArray | null;
    classNameRe.lastIndex = 0;
    while ((cm = classNameRe.exec(line)) !== null) {
      const classStr = cm[1];
      for (const { pattern, name } of conflictGroups) {
        const found: string[] = [];
        pattern.lastIndex = 0;
        let mm: RegExpExecArray | null;
        while ((mm = pattern.exec(classStr)) !== null) found.push(mm[0]);
        if (found.length > 1) {
          conflicts.push({ line: i + 1, classes: found, reason: `Multiple ${name} classes: ${found.join(', ')}` });
        }
      }
    }
  }
  return { file, conflicts, count: conflicts.length };
}

export function inspectClientBoundary(content: string, file: string): ClientBoundaryInfo {
  const lines = content.split('\n');
  let directive: 'use client' | 'use server' | null = null;
  const serverOnlyModules = ['server-only', 'next/headers', 'next-auth/server'];
  const serverOnlyImports: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "'use client';" || trimmed === '"use client";' || trimmed === "'use client'" || trimmed === '"use client"') { directive = 'use client'; break; }
    if (trimmed === "'use server';" || trimmed === '"use server";' || trimmed === "'use server'" || trimmed === '"use server"') { directive = 'use server'; break; }
    break;
  }
  const importRe = /import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(content)) !== null) {
    if (serverOnlyModules.some((mod) => im![1] === mod || im![1].startsWith(mod + '/'))) serverOnlyImports.push(im[1]);
  }
  return { file, directive, importsServerOnly: serverOnlyImports.length > 0, serverOnlyImports };
}

export function inspectErrorBoundary(content: string, file: string): ErrorBoundaryInfo {
  const boundaryComponents: string[] = [];
  const coveredRoutes: string[] = [];
  const errorBoundaryRe = /(?:class\s+(\w*ErrorBoundary\w*)\s+extends|<(\w*ErrorBoundary\w*)|import\s+.*?(\w*ErrorBoundary\w*).*?from)/g;
  let m: RegExpExecArray | null;
  while ((m = errorBoundaryRe.exec(content)) !== null) {
    const name = m[1] || m[2] || m[3];
    if (name && !boundaryComponents.includes(name)) boundaryComponents.push(name);
  }
  if (/(?:^|[\/\\])error\.[jt]sx?$/.test(file)) boundaryComponents.push('error.tsx (Next.js App Router)');
  const wrappedRouteRe = /<(?:\w*ErrorBoundary\w*)[^>]*>[\s\S]*?<\/(?:\w*ErrorBoundary\w*)>/g;
  let wr: RegExpExecArray | null;
  while ((wr = wrappedRouteRe.exec(content)) !== null) {
    const routeMatch = /<(\w+)/.exec(wr[0].slice(wr[0].indexOf('>') + 1));
    if (routeMatch && !coveredRoutes.includes(routeMatch[1])) coveredRoutes.push(routeMatch[1]);
  }
  return { file, hasErrorBoundary: boundaryComponents.length > 0, boundaryComponents, coveredRoutes };
}

