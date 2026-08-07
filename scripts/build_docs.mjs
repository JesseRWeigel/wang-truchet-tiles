#!/usr/bin/env node
/* Build docs/index.html from web/template.html, web/style.css and the src modules.
 *
 * The page must be one self-contained file with no network requests, and the generator on
 * the page must be the same generator the command line uses. Those two requirements pull
 * against each other, because ES modules in a file:// page cannot import each other without
 * a server. So the modules are inlined here: the import graph is walked from web/app.mjs,
 * each module has its static relative imports and its `export` keywords removed, and the
 * results are concatenated in dependency order into one module script.
 *
 * Two guards make that safe rather than merely convenient. Concatenation puts every module
 * in one scope, so a name declared twice would silently shadow, and the build refuses
 * instead. And any import that is not a relative path to a file in this repository is
 * refused too, because a bare specifier would be a network request in disguise.
 *
 *   node scripts/build_docs.mjs            write docs/index.html
 *   node scripts/build_docs.mjs --check    rebuild and fail if the committed file differs
 *
 * The check mode is what keeps the published page from going stale. It reads the committed
 * file, rebuilds from source and compares, so a change to src/ that was never rebuilt is a
 * failure rather than a page that quietly shows last week's behaviour.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const ENTRY = resolve(root, 'web/app.mjs');
const TEMPLATE = resolve(root, 'web/template.html');
const STYLE = resolve(root, 'web/style.css');
const OUTPUT = resolve(root, 'docs/index.html');

const IMPORT_LINE = /^import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;
const SIDE_EFFECT_IMPORT = /^import\s+['"]([^'"]+)['"];?[ \t]*$/gm;

function collect(entry, seen = new Map(), order = []) {
  if (seen.has(entry)) return { seen, order };
  const source = readFileSync(entry, 'utf8');
  seen.set(entry, source);
  const specifiers = [];
  for (const match of source.matchAll(IMPORT_LINE)) specifiers.push(match[1]);
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) specifiers.push(match[1]);
  for (const specifier of specifiers) {
    if (!specifier.startsWith('.')) {
      throw new Error(`${relative(root, entry)} imports ${JSON.stringify(specifier)}, which is `
        + 'not a relative path. The page must be self contained, so every import has to '
        + 'resolve to a file in this repository.');
    }
    const target = resolve(dirname(entry), specifier);
    collect(target, seen, order);
  }
  order.push(entry);
  return { seen, order };
}

const DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

function declarations(source) {
  const names = [];
  for (const match of source.matchAll(DECLARATION)) names.push(match[1]);
  return names;
}

export function bundle() {
  const { seen, order } = collect(ENTRY);
  const owner = new Map();
  const pieces = [];
  for (const file of order) {
    const source = seen.get(file);
    for (const name of declarations(source)) {
      if (owner.has(name)) {
        throw new Error(`${relative(root, file)} and ${relative(root, owner.get(name))} both `
          + `declare ${name} at the top level. Inlining puts them in one scope, so one would `
          + 'silently shadow the other. Rename one of them.');
      }
      owner.set(name, file);
    }
    const stripped = source
      .replace(IMPORT_LINE, '')
      .replace(SIDE_EFFECT_IMPORT, '')
      .replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\s)/gm, '')
      .replace(/^export\s*\{[^}]*\};?[ \t]*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    pieces.push(`/* ---- ${relative(root, file)} ---- */\n${stripped}`);
  }
  const script = pieces.join('\n\n');
  const style = readFileSync(STYLE, 'utf8').trim();
  const template = readFileSync(TEMPLATE, 'utf8');
  if (!template.includes('/*STYLE*/') || !template.includes('/*APP*/')) {
    throw new Error('web/template.html has lost one of its /*STYLE*/ or /*APP*/ markers');
  }
  // A closing script tag inside the script would end the block early and leave the rest of
  // the program as text on the page. Nothing writes one today; this is here so that the day
  // something does, the build fails rather than the page.
  if (script.includes('</script')) {
    throw new Error('the bundled script contains a closing script tag, which would truncate it');
  }
  return template.replace('/*STYLE*/', style).replace('/*APP*/', script);
}

const html = bundle();
const check = process.argv.includes('--check');

if (check) {
  let existing;
  try {
    existing = readFileSync(OUTPUT, 'utf8');
  } catch {
    console.error(`docs/index.html does not exist. Build it with: node scripts/build_docs.mjs`);
    process.exit(1);
  }
  if (existing !== html) {
    console.error('docs/index.html is not what the sources build. It is stale, so the '
      + 'published page does not match src/ and web/. Rebuild it with:');
    console.error('    node scripts/build_docs.mjs');
    console.error(`    committed ${existing.length} bytes, rebuilt ${html.length} bytes`);
    process.exit(1);
  }
  console.log(`docs/index.html matches its sources, ${html.length} bytes`);
} else {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, html);
  console.log(`wrote docs/index.html, ${html.length} bytes`);
}
