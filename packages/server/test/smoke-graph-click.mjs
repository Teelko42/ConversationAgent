/**
 * Standalone smoke for public/graph.js node-CLICK handling (run: `node --jitless`).
 * smoke-graph.mjs stubs addEventListener to a no-op, so it never exercised the
 * pointer→click path. This loads graph.js in a vm against an event-capable SVG DOM
 * mock and simulates real pointer gestures to assert:
 *   A. a stationary click deep-dives (onNodeClick fires with the node ref),
 *   B. a click with sub-threshold jitter STILL deep-dives (the reported bug:
 *      any micro-movement used to be treated as a drag and the click was eaten),
 *   C. a genuine drag (past the dead-zone) does NOT deep-dive.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const GRAPH = fileURLToPath(new URL('../public/graph.js', import.meta.url));

function mockEl(tag) {
  const listeners = {};
  const classes = new Set();
  const el = {
    tagName: tag,
    childNodes: [],
    parentNode: null,
    _text: '',
    appendChild(c) {
      el.childNodes.push(c);
      c.parentNode = el;
      return c;
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn);
    },
    dispatch(type, ev) {
      (listeners[type] || []).slice().forEach((fn) => fn(Object.assign({ type }, ev)));
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    set textContent(v) {
      el._text = String(v);
      el.childNodes.length = 0;
    },
    get textContent() {
      return el._text;
    },
    set innerHTML(_v) {
      el.childNodes.length = 0;
    },
    get innerHTML() {
      return '';
    },
    classList: {
      toggle(x, force) {
        const want = force === undefined ? !classes.has(x) : !!force;
        if (want) classes.add(x);
        else classes.delete(x);
        return want;
      },
      add: (x) => classes.add(x),
      remove: (x) => classes.delete(x),
      contains: (x) => classes.has(x),
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 360 }),
    clientWidth: 600,
    clientHeight: 360,
  };
  return el;
}

const documentMock = {
  createElementNS: (_ns, tag) => mockEl(tag),
  createElement: (tag) => mockEl(tag),
};
const windowMock = {};
let ticks = 0;
const ctx = createContext({
  window: windowMock,
  document: documentMock,
  Math,
  setTimeout: (fn) => {
    if (ticks++ < 40) setTimeout(fn, 0);
    return 0;
  },
  console,
});

runInContext(readFileSync(GRAPH, 'utf8'), ctx);
assert(windowMock.AizenGraph && typeof windowMock.AizenGraph.render === 'function', 'AizenGraph.render is exposed');

const container = mockEl('div');
let clicked = null;
const nodes = [
  { id: 'n1', label: 'RAG', node_type: 'concept', salience: 0.8, first_seen_segment_id: 'seg_0' },
  { id: 'n2', label: 'Vector Database', node_type: 'entity', salience: 0.6, first_seen_segment_id: 'seg_1' },
];
const edges = [{ id: 'e1', src: 'n1', dst: 'n2', relation: 'depends_on' }];

windowMock.AizenGraph.render(container, nodes, edges, (n) => {
  clicked = n;
});

const svg = container.childNodes[0];
const nodeLayer = svg.childNodes[1];
const g0 = nodeLayer.childNodes[0]; // first node's <g>

// Simulate a pointer gesture on node g0. `move` (if given) is the cursor delta
// between pointerdown and pointerup. The svg owns pointermove/up; the node g owns
// pointerdown/click — exactly as a browser would route a captured pointer.
function gesture(move) {
  clicked = null;
  const x0 = 300;
  const y0 = 180;
  g0.dispatch('pointerdown', { pointerId: 1, clientX: x0, clientY: y0 });
  const x1 = x0 + (move ? move.dx : 0);
  const y1 = y0 + (move ? move.dy : 0);
  if (move) svg.dispatch('pointermove', { pointerId: 1, clientX: x1, clientY: y1 });
  svg.dispatch('pointerup', { pointerId: 1, clientX: x1, clientY: y1 });
  g0.dispatch('click', { clientX: x1, clientY: y1 });
  return clicked;
}

// A. A perfectly stationary click deep-dives.
assert.strictEqual(gesture(null), nodes[0], 'A: stationary click fires onNodeClick with the node ref');

// B. The reported bug: a click with a couple px of jitter must STILL fire.
assert.strictEqual(gesture({ dx: 2, dy: 1 }), nodes[0], 'B: sub-threshold jitter click still fires onNodeClick');

// C. A real drag (well past the dead-zone) must NOT deep-dive.
assert.strictEqual(gesture({ dx: 60, dy: 0 }), null, 'C: a genuine drag does not fire onNodeClick');

console.log('graph click smoke: PASS (stationary + jitter click deep-dive; drag does not)');
