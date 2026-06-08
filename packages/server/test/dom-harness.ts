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
// S0 source library + the F4 Obsidian seam load (in index.html) BEFORE client.js,
// exposing window.AizenSources / window.AizenObsidian. The harness mirrors that load
// order so client.js's rewired BYO-sources path (S0) runs exactly as in the browser.
const SOURCES_PATH = fileURLToPath(new URL('../public/sources.js', import.meta.url));
const OBSIDIAN_PATH = fileURLToPath(new URL('../public/obsidian.js', import.meta.url));
// graph.js (window.AizenGraph) also loads before client.js in index.html; mirror it so
// the knowledge-graph node popover (a click → the messages a node refers to) is testable.
const GRAPH_PATH = fileURLToPath(new URL('../public/graph.js', import.meta.url));

// Every id the client looks up via getElementById.
const ID_LIST = [
  'status', 'mic', 'sys', 'both', 'transcript', 'explanation', 'hint',
  'stat-lines', 'stat-questions', 'stat-sources', 'stat-words',
  'transcript-search', 'conn-chip', 'sidebar', 'nav-toggle', 'nav-backdrop',
  'followup', 'followup-input', 'followup-send', 'followup-thread',
  'popout', 'card-stats', 'card-transcript', 'card-explanation', 'theme-toggle',
  // live intelligence panels (concepts / insights / recap / knowledge graph)
  'card-concepts', 'concepts', 'concepts-count', 'card-insights', 'insights', 'insights-count',
  'card-summary', 'summary', 'summary-stamp', 'card-graph', 'graph', 'graph-expand',
  // account widget
  'account', 'acct-signin', 'signin-btn', 'acct-menu', 'acct-user', 'acct-chip',
  'acct-avatar', 'acct-name', 'acct-tier', 'acct-panel', 'acct-fullname',
  'acct-email', 'quota', 'quota-text', 'quota-fill', 'quota-over',
  'save-session-btn', 'acct-msg', 'signout-btn',
  // popup/modal (Providers + Settings tabs)
  'modal-overlay', 'modal-title', 'modal-body', 'modal-close',
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
    // Fire the element's own click listeners (e.g. a styled button that proxies to a
    // hidden <input>). A real <input type=file>.click() opens a native dialog that
    // can't be driven headlessly, so file tests still set `.files` + dispatch 'change'
    // on the input directly; this just lets a test click the proxy button safely.
    click() {
      (el._listeners['click'] || []).slice().forEach((fn) => fn({ type: 'click' }));
    },
    // Scroll APIs the client uses to keep the explanation tab in view. No layout
    // engine here, so they just record the last call for assertions.
    scrollTop: 0,
    scrollHeight: 0,
    scrollTo(opts: unknown) {
      el._scrolledTo = opts;
    },
    scrollIntoView(opts: unknown) {
      el._scrolledIntoView = opts;
    },
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

export interface FetchCall {
  url: string;
  init?: unknown;
}
export type FetchHandler = (url: string, init?: unknown) => unknown;

export interface Harness {
  document: El;
  window: El;
  byId: (id: string) => El;
  grid: El;
  sockets: FakeSocket[];
  opened: unknown[][];
  storage: Record<string, string>;
  location: Record<string, string>;
  fetchCalls: FetchCall[];
  setFetch(fn: FetchHandler): void;
  /** Resolve after pending micro/macro tasks (lets bootAccount/fetch settle). */
  tick(): Promise<void>;
  /** The sidebar nav items (Providers/Settings info popups, the Transcript/
   *  Explanation/Activity/Sources focus popups, and the "Live Session" item). */
  nav: {
    providers: El;
    settings: El;
    live: El;
    transcript: El;
    explanation: El;
    activity: El;
    sources: El;
    history: El;
  };
  /** Fire a document-level event (e.g. a 'keydown' for Escape). */
  fireDoc(type: string, ev?: unknown): void;
  makePipWindow(): PipWindowMock;
}

/**
 * Build a fresh DOM/window, run client.js in a vm against it, and return handles
 * for driving + asserting. `withDocumentPiP` controls whether the Document PiP API
 * is present on the mocked window (to exercise the supported vs. fallback paths).
 */
export function loadClient(
  opts: { withDocumentPiP?: boolean; initialTheme?: 'light' | 'dark'; fetch?: FetchHandler } = {},
): Harness {
  const byIdMap: Record<string, El> = {};
  const documentListeners: Record<string, Array<(ev: unknown) => void>> = {};

  const doc: El = {
    nodeType: 9,
    createElement: (t: string) => makeEl(t, doc),
    // graph.js builds its SVG with createElementNS; the harness ignores the namespace.
    createElementNS: (_ns: string, t: string) => makeEl(t, doc),
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

  // The stat row ("Activity" focus popup relocates this) lives above the grid.
  const statRow = byIdMap['card-stats'];
  statRow.className = 'stat-row';
  doc.body.appendChild(statRow);

  // The two pop-out panels live inside a content grid in the body so restore has a
  // real parent to return them to.
  const grid = makeEl('section', doc);
  grid.appendChild(byIdMap['card-transcript']);
  grid.appendChild(byIdMap['card-explanation']);
  doc.body.appendChild(grid);

  // Live intelligence cards — nest each render target + its count/stamp inside its
  // card container (mirroring index.html), so focus-relocate has real parents.
  const intel = makeEl('section', doc);
  for (const [card, inner, badge] of [
    ['card-concepts', 'concepts', 'concepts-count'],
    ['card-insights', 'insights', 'insights-count'],
    ['card-summary', 'summary', 'summary-stamp'],
    ['card-graph', 'graph', 'graph-expand'],
  ]) {
    byIdMap[card!].appendChild(byIdMap[inner!]);
    byIdMap[card!].appendChild(byIdMap[badge!]);
    intel.appendChild(byIdMap[card!]);
  }
  doc.body.appendChild(intel);

  // Pop-out button carries a .btn-txt span (label toggles between Pop out/Return).
  const btnTxt = makeEl('span', doc);
  btnTxt.className = 'btn-txt';
  btnTxt.textContent = 'Pop out';
  byIdMap['popout'].appendChild(btnTxt);

  // Sidebar nav items the client wires at load (querySelectorAll('.nav-item')).
  // Items carrying data-modal open a popup on click; the "Live Session" item
  // (data-view) shows the full dashboard. Placed in the body so the client's
  // nav-item query finds them.
  const nav = makeEl('nav', doc);
  const makeNavItem = (attrs: Record<string, string>, label: string): El => {
    const a = makeEl('a', doc);
    a.className = 'nav-item';
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
    const lbl = makeEl('span', doc);
    lbl.className = 'nav-label';
    lbl.textContent = label;
    a.appendChild(lbl);
    nav.appendChild(a);
    return a;
  };
  const navLive = makeNavItem({ 'data-view': 'live', 'data-target': 'card-stats' }, 'Live Session');
  const navTranscript = makeNavItem({ 'data-modal': 'transcript', 'data-target': 'card-transcript' }, 'Transcript');
  const navExplanation = makeNavItem({ 'data-modal': 'explanation', 'data-target': 'card-explanation' }, 'Explanation');
  const navActivity = makeNavItem({ 'data-modal': 'activity', 'data-target': 'card-stats' }, 'Activity');
  const navSources = makeNavItem({ 'data-modal': 'sources', 'data-target': 'card-explanation' }, 'Sources');
  const navHistory = makeNavItem({ 'data-modal': 'history', 'data-target': 'card-stats' }, 'Saved sessions');
  const navProviders = makeNavItem({ 'data-modal': 'providers', 'data-target': 'status' }, 'Providers');
  const navSettings = makeNavItem({ 'data-modal': 'settings', 'data-target': 'card-stats' }, 'Settings');
  // Live-intelligence nav items (focus popups for the concept/insight/recap/graph cards).
  makeNavItem({ 'data-modal': 'concepts', 'data-target': 'card-concepts' }, 'Concepts');
  makeNavItem({ 'data-modal': 'insights', 'data-target': 'card-insights' }, 'Insights');
  makeNavItem({ 'data-modal': 'summary', 'data-target': 'card-summary' }, 'Recap');
  makeNavItem({ 'data-modal': 'graph', 'data-target': 'card-graph' }, 'Knowledge graph');
  doc.body.appendChild(nav);
  // Modal overlay starts hidden (the real markup sets the `hidden` attribute).
  byIdMap['modal-overlay'].hidden = true;

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

  // A configurable fetch mock for the account widget. Default = anonymous session
  // (so existing tests that don't care about accounts boot unchanged).
  const fetchCalls: FetchCall[] = [];
  const defaultFetch: FetchHandler = (url) => {
    if (String(url).startsWith('/api/session')) {
      return { ok: true, status: 200, json: async () => ({ authenticated: false, providers: ['stub'], authMode: 'stub' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  let fetchImpl: FetchHandler = opts.fetch ?? defaultFetch;
  const fetchMock = (url: unknown, init?: unknown): Promise<unknown> => {
    fetchCalls.push({ url: String(url), init });
    return Promise.resolve(fetchImpl(String(url), init));
  };

  const ctx = createContext({
    document: doc,
    window: windowObj,
    WebSocket: FakeWebSocket,
    navigator: { mediaDevices: {} },
    location,
    localStorage,
    console: noopConsole,
    fetch: fetchMock,
    setTimeout,
    clearTimeout,
  });

  // Load the S0 library + Obsidian seam + graph (they assign to window), then client.js.
  runInContext(readFileSync(SOURCES_PATH, 'utf8'), ctx);
  runInContext(readFileSync(OBSIDIAN_PATH, 'utf8'), ctx);
  runInContext(readFileSync(GRAPH_PATH, 'utf8'), ctx);
  runInContext(readFileSync(CLIENT_PATH, 'utf8'), ctx);

  return {
    document: doc,
    window: windowObj,
    byId: (id: string) => byIdMap[id],
    grid,
    sockets,
    opened,
    storage,
    location,
    fetchCalls,
    setFetch: (fn: FetchHandler) => {
      fetchImpl = fn;
    },
    tick: () => new Promise<void>((r) => setTimeout(r, 0)),
    nav: {
      providers: navProviders,
      settings: navSettings,
      live: navLive,
      transcript: navTranscript,
      explanation: navExplanation,
      activity: navActivity,
      sources: navSources,
      history: navHistory,
    },
    fireDoc: (type: string, ev?: unknown) => {
      (documentListeners[type] || []).slice().forEach((fn) => fn(ev ?? { type }));
    },
    makePipWindow,
  };
}
