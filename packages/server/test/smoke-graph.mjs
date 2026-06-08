/**
 * Standalone smoke for public/graph.js (run: `node --jitless`). graph.js is
 * browser-only (SVG + rAF), so this loads it in a vm against a minimal SVG-capable
 * DOM mock, calls AizenGraph.render with a 2-node / 1-edge graph, and asserts the
 * SVG is built and the force loop runs a few ticks without throwing.
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const GRAPH = fileURLToPath(new URL('../public/graph.js', import.meta.url));

function mockEl(tag) {
  const children = [];
  const el = {
    tagName: tag,
    childNodes: children,
    parentNode: null,
    _text: '',
    appendChild(c) {
      children.push(c);
      c.parentNode = el;
      return c;
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    set textContent(v) {
      el._text = String(v);
      children.length = 0;
    },
    get textContent() {
      return el._text;
    },
    set innerHTML(_v) {
      children.length = 0;
    },
    get innerHTML() {
      return '';
    },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
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
  // No requestAnimationFrame → graph.js uses the setTimeout fallback; cap the loop.
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

assert.strictEqual(container.childNodes.length, 1, 'an <svg> is appended to the container');
const svg = container.childNodes[0];
assert.strictEqual(svg.childNodes.length, 2, 'svg has an edge layer and a node layer');
assert.strictEqual(svg.childNodes[0].childNodes.length, 1, 'one edge <line> built');
assert.strictEqual(svg.childNodes[1].childNodes.length, 2, 'two node groups built');

// Re-render with an added node (incremental kg_delta) — must not throw and keeps n1.
windowMock.AizenGraph.render(
  container,
  nodes.concat([{ id: 'n3', label: 'pgvector', node_type: 'entity', salience: 0.5 }]),
  edges.concat([{ id: 'e2', src: 'n2', dst: 'n3', relation: 'part_of' }]),
  () => {},
);
const svg2 = container.childNodes[0];
assert.strictEqual(svg2.childNodes[1].childNodes.length, 3, 'three node groups after incremental add');

await new Promise((r) => setTimeout(r, 60)); // let the capped force loop run

console.log('graph smoke: PASS (render + incremental update + sim ran without throwing)');
