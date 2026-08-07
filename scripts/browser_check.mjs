#!/usr/bin/env node
/* Load docs/index.html in a real browser and measure what it actually does.
 *
 * Unit tests import the modules and never load the page, so they pass in full while the
 * page's script fails to parse and the file renders as static HTML with an empty canvas.
 * That has happened in this workspace more than once. Everything here is measured inside the
 * page with JavaScript rather than judged from a screenshot, because a screenshot can be
 * captured at a different width than it was rendered at.
 *
 * Chrome is driven directly over the DevTools protocol with a WebSocket, so the check has no
 * dependencies beyond the browser and cannot resolve a stale copy of a driver from a sibling
 * project, which is a failure this fleet has had twice.
 *
 * Exit 2 means the check could not run, which is not the same as passing.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildModel } from '../src/model.mjs';
import { buildPrimitives } from '../src/geometry.mjs';
import { getPalette, colourFor } from '../src/palette.mjs';
import { toSvg } from '../src/svg.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(root, 'docs', 'index.html');
const TITLE = 'Wang and Truchet tiles';

let pass = 0;
let fail = 0;
const ok = (message) => { console.log(`  ok    ${message}`); pass += 1; };
const bad = (message) => { console.log(`  FAIL  ${message}`); fail += 1; };

function chromeBinary() {
  const named = process.env.CHROME ?? process.env.CHROME_PATH;
  const candidates = [named, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

// ------------------------------------------------------------------- a small CDP client

class Devtools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else done(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((done, reject) => {
      socket.addEventListener('open', done, { once: true });
      socket.addEventListener('error', () => reject(new Error(`cannot open ${url}`)), { once: true });
    });
    return new Devtools(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((done, reject) => {
      this.pending.set(id, { resolve: done, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after 30s`));
        }
      }, 30000);
    });
  }

  once(method, sessionId, timeout = 20000) {
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== listener);
        reject(new Error(`waited ${timeout}ms for ${method}`));
      }, timeout);
      const listener = (message) => {
        if (message.method !== method) return;
        if (sessionId && message.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.listeners = this.listeners.filter((l) => l !== listener);
        done(message.params);
      };
      this.listeners.push(listener);
    });
  }

  on(method, handler) {
    this.listeners.push((message) => { if (message.method === method) handler(message.params); });
  }
}

async function main() {
  if (!existsSync(PAGE)) {
    console.error(`docs/index.html is missing. Build it: node scripts/build_docs.mjs`);
    return 2;
  }
  const binary = chromeBinary();
  if (!binary) {
    console.error('no Chrome or Chromium found. Set CHROME to the binary, or install one:');
    console.error('    sudo apt install chromium');
    console.error('Without a browser nothing checks that the page script runs at all, that '
      + 'the canvas is drawn, or that the layout holds at 390 pixels.');
    return 2;
  }

  // Serve the built page rather than opening it from disk. Binding to port 0 asks the
  // kernel for a free one, because a fixed port that another agent already holds returns a
  // cheerful 200 from somebody else's project.
  const html = readFileSync(PAGE);
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/`;

  const profile = mkdtempSync(join(tmpdir(), 'wt-chrome-'));
  // --disable-crashpad-for-testing and --disable-features=Crashpad are deliberately absent:
  // on this machine they put Chrome into an endless crash and restart loop.
  const chrome = spawn(binary, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeStderr = '';
  chrome.stderr.on('data', (chunk) => { chromeStderr += chunk.toString().slice(0, 400); });

  const portFile = join(profile, 'DevToolsActivePort');
  let debugPort = null;
  for (let attempt = 0; attempt < 100 && debugPort === null; attempt++) {
    await new Promise((done) => setTimeout(done, 100));
    if (!existsSync(portFile)) continue;
    const text = readFileSync(portFile, 'utf8').split('\n');
    if (text[0]) debugPort = Number(text[0]);
  }

  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
    server.close();
    rmSync(profile, { recursive: true, force: true });
  };

  if (!debugPort) {
    console.error('Chrome never reported a debugging port.');
    if (chromeStderr) console.error(chromeStderr);
    cleanup();
    return 2;
  }

  let devtools;
  let session;
  try {
    const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    devtools = await Devtools.connect(version.webSocketDebuggerUrl);
    const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId: session } = await devtools.send('Target.attachToTarget',
      { targetId, flatten: true }));
  } catch (error) {
    console.error(`could not attach to Chrome: ${error.message}`);
    cleanup();
    return 2;
  }

  const consoleErrors = [];
  devtools.on('Runtime.exceptionThrown', (params) => {
    consoleErrors.push(params.exceptionDetails?.exception?.description
      ?? params.exceptionDetails?.text ?? 'unknown exception');
  });
  devtools.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') {
      consoleErrors.push(params.args.map((a) => a.value ?? a.description ?? '?').join(' '));
    }
  });

  await devtools.send('Page.enable', {}, session);
  await devtools.send('Runtime.enable', {}, session);

  const evaluate = async (expression) => {
    const result = await devtools.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    }, session);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };

  /* Navigate and measure is one step, not two. The browser is shared with other agents in
   * this workspace, and a page can be navigated out from under a measurement, so every
   * evaluation begins by asserting the page identity. */
  let nonce = 0;
  const load = async (rawUrl, { width = 1280, height = 900, scheme = 'light' } = {}) => {
    // Two URLs that differ only in their fragment do not reload, they fire a hashchange, so
    // Page.loadEventFired never arrives and the check hangs until its timeout. Every load
    // gets a distinct query so a fresh document is guaranteed, which is also what makes the
    // determinism check a real second load rather than the same page reread.
    const url = new URL(rawUrl);
    url.searchParams.set('n', String(nonce++));
    await devtools.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false }, session);
    await devtools.send('Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: scheme }] }, session);
    const loaded = devtools.once('Page.loadEventFired', session);
    await devtools.send('Page.navigate', { url: url.href }, session);
    await loaded;
    await new Promise((done) => setTimeout(done, 350));
    const title = await evaluate('return document.title;');
    if (title !== TITLE) {
      throw new Error(`the page under test is ${JSON.stringify(title)}, not ${JSON.stringify(TITLE)}`);
    }
  };

  try {
    // ------------------------------------------------------------ 1. the script runs
    await load(pageUrl);
    const ready = await evaluate(`
      return {
        ready: document.body.dataset.ready ?? null,
        api: typeof window.wangTruchet,
        shapes: window.wangTruchet ? window.wangTruchet.sceneShapes : 0,
        families: document.getElementById('family').options.length,
        sets: document.getElementById('set').options.length,
        palettes: document.getElementById('palette').options.length,
        tiles: document.getElementById('tiles').children.length,
      };
    `);
    if (ready.ready === 'yes' && ready.api === 'object' && ready.shapes > 0) {
      ok(`the page script ran and built ${ready.shapes} shapes`);
    } else {
      bad(`the page script did not complete: ${JSON.stringify(ready)}`);
    }
    if (ready.families === 5 && ready.sets === 6 && ready.palettes === 6) {
      ok(`${ready.families} families, ${ready.sets} tile sets, ${ready.palettes} palettes offered`);
    } else {
      bad(`the controls are not fully populated: ${JSON.stringify(ready)}`);
    }
    if (ready.tiles === 8) ok('the tile inspector drew all 8 tiles of the default set');
    else bad(`the tile inspector drew ${ready.tiles} tiles, expected 8`);

    // ------------------------------------------------- 2. the canvas is actually painted
    const painted = await evaluate(`
      const canvas = document.getElementById('canvas');
      const context = canvas.getContext('2d');
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = new Set();
      let opaque = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 0) opaque += 1;
        seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        if (seen.size > 400) break;
      }
      return { width: canvas.width, height: canvas.height, colours: seen.size, opaque };
    `);
    if (painted.width > 100 && painted.colours > 3) {
      ok(`the canvas is ${painted.width}x${painted.height} with ${painted.colours}+ distinct colours`);
    } else {
      bad(`the canvas looks blank: ${JSON.stringify(painted)}`);
    }

    // -------------------------------------- 3. the invariant is computed, and can fail
    const verdicts = await evaluate(`
      const out = {};
      const family = document.getElementById('family');
      for (const name of ['wang', 'arcs', 'arcs-free', 'diagonals', 'diagonals-free']) {
        family.value = name;
        family.dispatchEvent(new Event('input', { bubbles: true }));
        out[name] = {
          violations: window.wangTruchet.check.violations.length,
          expectClean: window.wangTruchet.check.expectClean,
          text: document.getElementById('invariant-verdict').textContent.trim().split(' ')[0],
        };
      }
      family.value = 'wang';
      family.dispatchEvent(new Event('input', { bubbles: true }));
      return out;
    `);
    const wrongVerdict = Object.entries(verdicts).filter(([, v]) => v.text !== 'PASS');
    const inertCheckers = Object.entries(verdicts)
      .filter(([, v]) => !v.expectClean && v.violations === 0);
    if (wrongVerdict.length === 0 && inertCheckers.length === 0) {
      const counterexamples = Object.entries(verdicts).filter(([, v]) => !v.expectClean);
      ok(`all five families report the verdict they should, including `
        + `${counterexamples.map(([n, v]) => `${n} with ${v.violations} violations`).join(' and ')}`);
    } else {
      bad(`wrong verdicts: ${JSON.stringify(wrongVerdict)}; `
        + `inert checkers: ${JSON.stringify(inertCheckers)}`);
    }

    // ------------------------------------ 4. the page and the CLI agree byte for byte
    const options = {
      family: 'wang', set: 'stochastic-3', style: 'triangles', width: 7, height: 5,
      seed: 'browser-parity', palette: 'terracotta', bands: 1, weight: 0.16, torus: false,
    };
    const pageSvg = await evaluate(`
      const api = window.wangTruchet;
      Object.assign(api.state, ${JSON.stringify(options)});
      const set = (id, value) => {
        const element = document.getElementById(id);
        if (element.type === 'checkbox') element.checked = value; else element.value = value;
      };
      set('family', '${options.family}');
      set('set', '${options.set}');
      set('style', '${options.style}');
      set('palette', '${options.palette}');
      set('seed', '${options.seed}');
      set('width', ${options.width});
      set('height', ${options.height});
      set('bands', ${options.bands});
      set('weight', ${Math.round(options.weight * 100)});
      set('torus', false);
      document.getElementById('seed').dispatchEvent(new Event('input', { bubbles: true }));
      return api.buildSvgText();
    `);
    const model = buildModel(options);
    const scene = buildPrimitives(model, {
      palette: getPalette(options.palette), colourFor, cell: 100,
      weight: model.weight, bands: model.bands,
    });
    const nodeSvg = toSvg(scene, {
      printWidthMm: model.width * 12,
      title: `${model.family} ${model.width}x${model.height} seed ${model.seed}`,
      metadata: {
        family: model.family, set: model.set, style: model.style, seed: model.seed,
        grid: `${model.width}x${model.height}`, seamless: 'false',
        placement: model.placement.method,
        invariant: 'edge-matching: 0 violation(s)',
      },
    });
    const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);
    if (pageSvg === nodeSvg) {
      ok(`the browser and node produce the same ${pageSvg.length} byte SVG, ${digest(pageSvg)}`);
    } else {
      bad(`the browser SVG (${pageSvg.length} bytes, ${digest(pageSvg ?? '')}) differs from `
        + `node's (${nodeSvg.length} bytes, ${digest(nodeSvg)})`);
    }

    // ----------------------------------------------- 5. a seed reproduces across reloads
    const seedUrl = `${pageUrl}#family=arcs&width=9&height=6&seed=repeatable&bands=3`;
    const canvasDigest = async () => {
      await load(seedUrl);
      return evaluate(`
        const canvas = document.getElementById('canvas');
        return canvas.getContext('2d')
          .getImageData(0, 0, canvas.width, canvas.height).data.join(',').length
          + ':' + Array.from(
            canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
          ).reduce((h, b) => ((h * 31) + b) >>> 0, 7);
      `);
    };
    const first = await canvasDigest();
    const second = await canvasDigest();
    if (first === second && first) {
      ok(`the seed in the URL reproduces the same pixels across two page loads, ${first}`);
    } else {
      bad(`two loads of the same seed drew different pixels: ${first} against ${second}`);
    }
    const differentSeed = await (async () => {
      await load(`${pageUrl}#family=arcs&width=9&height=6&seed=other&bands=3`);
      return evaluate(`
        const canvas = document.getElementById('canvas');
        return canvas.getContext('2d')
          .getImageData(0, 0, canvas.width, canvas.height).data.join(',').length
          + ':' + Array.from(
            canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
          ).reduce((h, b) => ((h * 31) + b) >>> 0, 7);
      `);
    })();
    if (differentSeed !== first) ok('a different seed draws a different tiling');
    else bad('two different seeds drew identical pixels, so the seed does nothing');

    // ------------------------------------------------------- 6. print resolution export
    const printWidth = await evaluate(`
      const api = window.wangTruchet;
      return api.printPixelWidth({ width: 16 });
    `);
    if (printWidth === 2268) ok('16 cells at 12 mm and 300 dpi exports 2268 pixels');
    else bad(`the print export would be ${printWidth} pixels, expected 2268`);

    // ------------------------------------------------------------------- 7. the themes
    const themeReport = {};
    for (const scheme of ['light', 'dark']) {
      await load(pageUrl, { scheme });
      themeReport[scheme] = await evaluate(`
        const read = () => getComputedStyle(document.body).backgroundColor;
        const luminance = (colour) => {
          const [r, g, b] = colour.match(/\\d+/g).map(Number);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const out = {};
        document.documentElement.dataset.theme = 'auto';
        out.auto = luminance(read());
        document.documentElement.dataset.theme = 'light';
        out.light = luminance(read());
        document.documentElement.dataset.theme = 'dark';
        out.dark = luminance(read());
        const toggle = document.getElementById('theme-toggle');
        document.documentElement.dataset.theme = 'auto';
        toggle.click();
        out.afterOneClick = document.documentElement.dataset.theme;
        toggle.click();
        out.afterTwoClicks = document.documentElement.dataset.theme;
        out.label = document.getElementById('theme-label').textContent;
        return out;
      `);
    }
    const problems = [];
    for (const scheme of ['light', 'dark']) {
      const r = themeReport[scheme];
      if (r.light < 128) problems.push(`data-theme=light is dark under ${scheme} (${r.light.toFixed(0)})`);
      if (r.dark > 128) problems.push(`data-theme=dark is light under ${scheme} (${r.dark.toFixed(0)})`);
      const expectedAuto = scheme === 'dark' ? r.dark : r.light;
      if (Math.abs(r.auto - expectedAuto) > 1) {
        problems.push(`auto does not follow ${scheme} (${r.auto.toFixed(0)} against ${expectedAuto.toFixed(0)})`);
      }
      if (r.afterOneClick !== 'light' || r.afterTwoClicks !== 'dark') {
        problems.push(`the toggle cycled to ${r.afterOneClick} then ${r.afterTwoClicks}`);
      }
    }
    if (problems.length === 0) {
      ok('an explicit theme overrides the system preference in both directions, and the '
        + 'toggle cycles auto to light to dark');
    } else {
      bad(`theme handling: ${problems.join('; ')}`);
    }

    // ----------------------------------------------------------- 8. layout at 390 pixels
    for (const width of [1280, 390]) {
      await load(pageUrl, { width, height: 900 });
      const layout = await evaluate(`
        const doc = document.documentElement;
        const limit = doc.clientWidth;
        const offenders = [];
        const scrollable = (element) => {
          for (let node = element.parentElement; node; node = node.parentElement) {
            const overflow = getComputedStyle(node).overflowX;
            if (overflow === 'auto' || overflow === 'scroll') return true;
          }
          return false;
        };
        for (const element of doc.querySelectorAll('*')) {
          const box = element.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) continue;
          if (box.right <= limit + 0.5 && box.left >= -0.5) continue;
          if (scrollable(element)) continue;
          offenders.push(element.tagName.toLowerCase()
            + (element.id ? '#' + element.id : '')
            + ' right=' + box.right.toFixed(1) + ' left=' + box.left.toFixed(1));
        }
        const canvas = document.getElementById('canvas');
        return {
          limit,
          scrollWidth: doc.scrollWidth,
          offenders: offenders.slice(0, 6),
          canvasCss: canvas.getBoundingClientRect().width,
          canvasBacking: canvas.width,
          controlsVisible: document.querySelector('.controls').getBoundingClientRect().width,
        };
      `);
      const overflows = layout.scrollWidth > layout.limit + 1;
      if (!overflows && layout.offenders.length === 0 && layout.canvasCss > 50) {
        ok(`at ${width}px nothing escapes the page, canvas is `
          + `${layout.canvasCss.toFixed(0)} css px backed by ${layout.canvasBacking}`);
      } else {
        bad(`at ${width}px scrollWidth ${layout.scrollWidth} against ${layout.limit}, `
          + `offenders ${JSON.stringify(layout.offenders)}`);
      }
    }

    // ------------------------------------------------------------ 9. nothing threw
    if (consoleErrors.length === 0) {
      ok('no uncaught exception and no console error in any of the runs above');
    } else {
      bad(`${consoleErrors.length} page error(s): ${consoleErrors.slice(0, 3).join(' | ')}`);
    }
  } catch (error) {
    bad(`the check itself broke: ${error.message}`);
  } finally {
    cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

process.exit(await main());
