/**
 * A tiny mocked-DOM + window harness for running `public/client.js` (a plain-ES
 * IIFE, no build step) inside `node:vm`. It implements just enough of the DOM that
 * the client touches — getElementById/createElement, a class-aware
 * querySelector(All)/closest, innerHTML parsing for the small templates the client
 * uses, appendChild/insertBefore that re-parent like the real DOM, classList, and
 * event listeners with a `dispatch()` to fire them — plus stubs for WebSocket,
 * window, location and the Document Picture-in-Picture API.
 *
 * It is deliberately minimal and lives next to the client tests so the F1 (type a
 * follow-up) and F2 (pop-out) UI behaviours can be asserted headlessly; Document
 * PiP and getDisplayMedia themselves still need a real browser, so the manual
 * check remains the final word for those.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const CLIENT_PATH = fileURLToPath(new URL('../public/client.js', import.meta.url));

// Every id the client looks up via getElementById.
const ID_LIST = [
  'status', 'mic', 'sys', 'both', 'transcript', 'explanation', 'hint',
  'stat-lines', 'stat-questions', 'stat-sources', 'stat-words',
  'transcript-search', 'conn-chip', 'sidebar', 'nav-toggle', 'nav-backdrop',
  'followup', 'followup-input', 'followup-send', 'followup-thread',
  'popout', 'card-transcript', 'card-explanation', 'theme-toggle',
];

/* eslint-disable @typescript-eslint/no-explicit-any */
type El = any;

function makeText(t: unknown): El {
  return {
    nodeType: 3,
    _text: String(t),
    parentNode: null,
    get textContent() {
      return this._text;
    },
    set textContent(v: unknown) {
      this._text = String(v);
    },
  };
}

function detach(child: El): void {
  const p = child.parentNode;
  if (!p) return;
  p.childNodes = (p.childNodes || []).filter((n: El) => n !== child);
  if (p.children) p.children = p.children.filter((n: El) => n !== child);
  child.parentNode = null;
}

function matchSel(node: El, sel: string): boolean {
  if (!node || node.nodeType !== 1) return false;
  const s = sel.trim();
  const attrM = s.match(/^([a-zA-Z0-9]*)\[([a-zA-Z-]+)="([^"]*)"\]$/);
  if (attrM) {
    const [, tag, attr, val] = attrM;
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    return node.getAttribute(attr) === val;
  }
  const m = s.match(/^([a-zA-Z0-9]*)((?:\.[a-zA-Z0-9_-]+)*)$/);
  if (m) {
    const tag = m[1];
    const classes = m[2] ? m[2].split('.').filter(Boolean) : [];
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    for (const c of classes) if (!node.classList.contains(c)) return false;
    return true;
  }
  return false;
}

function queryAll(root: El, selector: string): El[] {
  const out: El[] = [];
  const sels = selector.split(',').map((x) => x.trim()).filter(Boolean);
  const walk = (node: El): void => {
    for (const child of node.children || []) {
      if (sels.some((sel) => matchSel(child, sel))) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function makeEl(tag: string, doc: El): El {
  const classes = new Set<string>();
  const el: El = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    id: '',
    childNodes: [] as El[],
    children: [] as El[],
    parentNode: null,
    dataset: {},
    style: {},
    attributes: {} as Record<string, string>,
    _listeners: {} as Record<string, Array<(ev: unknown) => void>>,
    _text: '',
    _innerHTML: '',
    disabled: false,
    hidden: false,
    title: '',
    value: '',
    href: '',
    rel: '',
    target: '',
    placeholder: '',
    classList: {
      add: (...c: string[]) => c.forEach((x) => classes.add(x)),
      remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
      toggle: (x: string, force?: boolean) => {
        const want = force === undefined ? !classes.has(x) : !!force;
        if (want) classes.add(x);
        else classes.delete(x);
        return want;
      },
      contains: (x: string) => classes.has(x),
    },
    get className() {
      return Array.from(classes).join(' ');
    },
    set className(v: string) {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    get textContent() {
      if (el.childNodes.length === 0) return el._text;
      return el.childNodes.map((n: El) => (n.nodeType === 3 ? n._text : n.textContent)).join('');
    },
    set textContent(v: unknown) {
      el._text = String(v);
      el.childNodes = [];
      el.children = [];
    },
    get innerHTML() {
      return el._innerHTML;
    },
    set innerHTML(html: string) {
      el.childNodes = [];
      el.children = [];
      el._innerHTML = html || '';
      el._text = '';
      if (!html) return;
      const stack: El[] = [el];
      const re = /<(\/?)([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const [, closing, tagName, attrs, selfClose, text] = m;
        const parent = stack[stack.length - 1];
        if (text != null) {
          parent.appendChild(doc.createTextNode(text));
          continue;
        }
        if (closing) {
          if (stack.length > 1) stack.pop();
          continue;
        }
        const child = doc.createElement(tagName!);
        const cm = /class="([^"]*)"/.exec(attrs || '');
        if (cm) child.className = cm[1]!;
        parent.appendChild(child);
        if (!selfClose) stack.push(child);
      }
    },
    appendChild(child: El) {
      detach(child);
      child.parentNode = el;
      el.childNodes.push(child);
      if (child.nodeType === 1) el.children.push(child);
      return child;
    },
    insertBefore(child: El, ref: El | null) {
      detach(child);
      child.parentNode = el;
      const idx = ref ? el.childNodes.indexOf(ref) : -1;
      if (idx < 0) {
        el.childNodes.push(child);
        if (child.nodeType === 1) el.children.push(child);
        return child;
      }
      el.childNodes.splice(idx, 0, child);
      if (child.nodeType === 1) {
        const ci = el.children.indexOf(ref);
        if (ci >= 0) el.children.splice(ci, 0, child);
        else el.children.push(child);
      }
      return child;
    },
    removeChild(child: El) {
      detach(child);
      return child;
    },
    get nextSibling() {
      const p = el.parentNode;
      if (!p) return null;
      const i = p.childNodes.indexOf(el);
      return i >= 0 && i + 1 < p.childNodes.length ? p.childNodes[i + 1] : null;
    },
    setAttribute(k: string, v: unknown) {
      el.attributes[k] = String(v);
      if (k === 'class') el.className = String(v);
      if (k === 'rel') el.rel = String(v);
      if (k === 'href') el.href = String(v);
    },
    getAttribute(k: string) {
      return k in el.attributes ? el.attributes[k] : null;
    },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      (el._listeners[type] = el._listeners[type] || []).push(fn);
    },
    removeEventListener(type: string, fn: (ev: unknown) => void) {
      if (el._listeners[type]) el._listeners[type] = el._listeners[type].filter((f) => f !== fn);
    },
    dispatch(type: string, ev?: unknown) {
      (el._listeners[type] || []).slice().forEach((fn) => fn(ev ?? { type }));
      return el._listeners[type] ? el._listeners[type].length : 0;
    },
    querySelector(sel: string) {
      return queryAll(el, sel)[0] || null;
    },
    querySelectorAll(sel: string) {
      return queryAll(el, sel);
    },
    closest(sel: string) {
      let n: El = el;
      while (n) {
        if (matchSel(n, sel)) return n;
        n = n.parentNode;
      }
      return null;
    },
    cloneNode() {
      return makeEl(tag, doc);
    },
    focus() {},
  };
  return el;
}

export interface PipWindowMock {
  document: El;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  close(): void;
}

export interface FakeSocket {
  url: string;
  readyState: number;
  binaryType: string;
  sent: string[];
  onopen: (() => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  send(data: unknown): void;
  close(): void;
  addEventListener(): void;
}

export interface Harness {
  document: El;
  window: El;
  byId: (id: string) => El;
  grid: El;
  sockets: FakeSocket[];
  opened: unknown[][];
  storage: Record<string, string>;
  makePipWindow(): PipWindowMock;
}

/**
 * Build a fresh DOM/window, run client.js in a vm against it, and return handles
 * for driving + asserting. `withDocumentPiP` controls whether the Document PiP API
 * is present on the mocked window (to exercise the supported vs. fallback paths).
 */
export function loadClient(
  opts: { withDocumentPiP?: boolean; initialTheme?: 'light' | 'dark' } = {},
): Harness {
  const byIdMap: Record<string, El> = {};
  const documentListeners: Record<string, Array<(ev: unknown) => void>> = {};

  const doc: El = {
    nodeType: 9,
    createElement: (t: string) => makeEl(t, doc),
    createTextNode: (t: unknown) => makeText(t),
    getElementById: (id: string) => byIdMap[id] || null,
    addEventListener: (t: string, fn: (ev: unknown) => void) => {
      (documentListeners[t] = documentListeners[t] || []).push(fn);
    },
    removeEventListener: () => {},
    querySelector: (s: string) => queryAll(doc, s)[0] || null,
    querySelectorAll: (s: string) => queryAll(doc, s),
    children: [] as El[],
  };
  doc.head = makeEl('head', doc);
  doc.body = makeEl('body', doc);
  doc.documentElement = makeEl('html', doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.children = [doc.documentElement];

  // Simulate the inline <head> script having applied a saved theme before paint.
  const storage: Record<string, string> = {};
  if (opts.initialTheme) {
    doc.documentElement.setAttribute('data-theme', opts.initialTheme);
    storage['aizen-theme'] = opts.initialTheme;
  }

  for (const id of ID_LIST) {
    const el = makeEl('div', doc);
    el.id = id;
    byIdMap[id] = el;
  }

  // The two pop-out panels live inside a content grid in the body so restore has a
  // real parent to return them to.
  const grid = makeEl('section', doc);
  grid.appendChild(byIdMap['card-transcript']);
  grid.appendChild(byIdMap['card-explanation']);
  doc.body.appendChild(grid);

  // Pop-out button carries a .btn-txt span (label toggles between Pop out/Return).
  const btnTxt = makeEl('span', doc);
  btnTxt.className = 'btn-txt';
  btnTxt.textContent = 'Pop out';
  byIdMap['popout'].appendChild(btnTxt);

  // Seed the opener head with a stylesheet link + a <style> so copyStyles has
  // something to clone into the PiP document.
  const link = makeEl('link', doc);
  link.setAttribute('rel', 'stylesheet');
  link.setAttribute('href', '/styles.css');
  const style = makeEl('style', doc);
  doc.head.appendChild(link);
  doc.head.appendChild(style);

  const sockets: FakeSocket[] = [];
  class FakeWebSocket implements FakeSocket {
    static OPEN = 1;
    url: string;
    readyState = 0;
    binaryType = '';
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }
    send(data: unknown) {
      this.sent.push(typeof data === 'string' ? data : '[binary]');
    }
    close() {
      this.readyState = 3;
      if (this.onclose) this.onclose({});
    }
    addEventListener() {}
  }

  const opened: unknown[][] = [];
  const windowObj: El = {
    WebSocket: FakeWebSocket,
    AudioContext: function () {},
    isSecureContext: true,
    addEventListener: () => {},
    open: (...args: unknown[]) => {
      opened.push(args);
      return {};
    },
  };
  if (opts.withDocumentPiP) {
    windowObj.documentPictureInPicture = {
      requestWindow: async () => makePipWindow(),
    };
  }

  function makePipWindow(): PipWindowMock {
    const pdoc: El = {
      nodeType: 9,
      createElement: (t: string) => makeEl(t, pdoc),
      createTextNode: (t: unknown) => makeText(t),
      children: [] as El[],
    };
    pdoc.head = makeEl('head', pdoc);
    pdoc.body = makeEl('body', pdoc);
    pdoc.documentElement = makeEl('html', pdoc);
    pdoc.documentElement.appendChild(pdoc.head);
    pdoc.documentElement.appendChild(pdoc.body);
    pdoc.children = [pdoc.documentElement];
    const listeners: Record<string, Array<(ev: unknown) => void>> = {};
    return {
      document: pdoc,
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      close: () => {
        (listeners['pagehide'] || []).slice().forEach((fn) => fn({}));
      },
    };
  }

  const location = {
    protocol: 'http:',
    host: 'localhost:5173',
    href: 'http://localhost:5173/',
    port: '5173',
  };
  const noopConsole = { log: () => {}, warn: () => {}, error: () => {} };

  const localStorage = {
    getItem: (k: string) => (k in storage ? storage[k] : null),
    setItem: (k: string, v: unknown) => {
      storage[k] = String(v);
    },
    removeItem: (k: string) => {
      delete storage[k];
    },
    clear: () => {
      for (const k of Object.keys(storage)) delete storage[k];
    },
  };

  const ctx = createContext({
    document: doc,
    window: windowObj,
    WebSocket: FakeWebSocket,
    navigator: { mediaDevices: {} },
    location,
    localStorage,
    console: noopConsole,
    setTimeout,
    clearTimeout,
  });

  runInContext(readFileSync(CLIENT_PATH, 'utf8'), ctx);

  return {
    document: doc,
    window: windowObj,
    byId: (id: string) => byIdMap[id],
    grid,
    sockets,
    opened,
    storage,
    makePipWindow,
  };
}
