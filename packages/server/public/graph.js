/**
 * window.AizenGraph — a tiny, dependency-free force-directed graph for the live
 * knowledge graph (Phase 3). Loaded before client.js (like sources.js / obsidian.js);
 * client.js's renderGraph() delegates to it whenever there are nodes.
 *
 *   AizenGraph.render(container, nodes, edges, onNodeClick)
 *     nodes: [{ id, label, node_type, salience?, first_seen_segment_id? }, …]
 *     edges: [{ id, src, dst, relation, … }, …]
 *     onNodeClick(node, ui): called on a node click with the ORIGINAL node object and
 *       a small UI handle `{ host, close }` — `host` is an (initially empty) absolutely
 *       positioned <div> we keep anchored over the clicked node, for the caller to fill
 *       with whatever the node refers to; `close()` dismisses it. Filling `host` is
 *       optional (a caller that ignores `ui` keeps the old click-only behaviour).
 *   AizenGraph.closePopover(container) → boolean: dismiss an open node popover (e.g. on
 *       Escape); returns true iff one was open.
 *
 * It keeps a persistent simulation per container (on container.__aizenGraph), so
 * incoming kg_delta updates grow the graph in place instead of reshuffling it: known
 * nodes keep their position, new ones spawn near the centre, and the layout re-settles
 * with a short cooling animation. Nodes are draggable; hovering highlights neighbours;
 * a click opens a popover anchored over the node (it follows the node as the layout
 * settles or the node is dragged). Pure SVG + requestAnimationFrame — no build step,
 * no libs.
 */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var W_FALLBACK = 600;
  var H_FALLBACK = 360;

  // Force-sim constants (tuned for the few-dozen-node graphs a session produces).
  var REPULSION = 2600; // node-node Coulomb repulsion
  var SPRING_K = 0.035; // edge spring stiffness
  var SPRING_LEN = 84; // edge rest length
  var CENTER_K = 0.02; // pull toward the centre (keeps it framed)
  var DAMPING = 0.82; // velocity damping per tick
  var COOL = 0.985; // alpha decay per tick
  var MIN_ALPHA = 0.02; // stop the loop below this
  var MARGIN = 26; // keep nodes off the edge
  var DRAG_THRESH2 = 16; // px² dead-zone: a press that moves < 4px is a click, not a drag

  function rand(n) {
    // Browser-only module → Math.random is fine here (not a workflow script).
    return (Math.random() - 0.5) * n;
  }

  function measure(container, sim) {
    var w = 0;
    var h = 0;
    if (container.getBoundingClientRect) {
      var r = container.getBoundingClientRect();
      w = r.width;
      h = r.height;
    }
    sim.w = w || container.clientWidth || W_FALLBACK;
    sim.h = h || container.clientHeight || H_FALLBACK;
    sim.svg.setAttribute('viewBox', '0 0 ' + sim.w + ' ' + sim.h);
    sim.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }

  function makeSim(container, onNodeClick) {
    var svg = document.createElementNS(SVGNS, 'svg');
    var edgeLayer = document.createElementNS(SVGNS, 'g');
    var nodeLayer = document.createElementNS(SVGNS, 'g');
    svg.appendChild(edgeLayer);
    svg.appendChild(nodeLayer);
    container.innerHTML = '';
    container.appendChild(svg);

    var sim = {
      container: container,
      svg: svg,
      edgeLayer: edgeLayer,
      nodeLayer: nodeLayer,
      byId: {},
      nodes: [],
      edges: [],
      nodeEls: [],
      edgeEls: [],
      neighbors: {},
      onNodeClick: onNodeClick,
      alpha: 0,
      running: false,
      drag: null,
      dragMoved: false,
      dragStart: null,
      popover: null, // the anchored <div> host (created lazily on first node click)
      popoverNode: null, // the node it is anchored to (null ⇒ closed)
      w: 0,
      h: 0,
    };

    // Pointer drag: move a node and pin it under the cursor while held. A press only
    // becomes a drag once it travels past DRAG_THRESH2; below that it stays a click,
    // so the normal sub-pixel jitter between pointerdown and pointerup never eats the
    // tap (which is how a node deep-dives).
    svg.addEventListener('pointermove', function (ev) {
      if (!sim.drag) return;
      var p = toLocal(sim, ev);
      if (!sim.dragMoved) {
        var s = sim.dragStart || p;
        var ddx = p.x - s.x;
        var ddy = p.y - s.y;
        if (ddx * ddx + ddy * ddy < DRAG_THRESH2) return; // still within the click dead-zone
        sim.dragMoved = true;
      }
      sim.drag.x = p.x;
      sim.drag.y = p.y;
      sim.drag.vx = 0;
      sim.drag.vy = 0;
      sim.alpha = Math.max(sim.alpha, 0.6);
      ensureLoop(sim);
      paint(sim);
    });
    var endDrag = function () {
      sim.drag = null;
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointerleave', endDrag);

    // A click on empty canvas (not on a node — those bubble up with a node descendant
    // as target) dismisses an open popover. The popover host is an HTML sibling of the
    // <svg>, so its own clicks never reach here.
    svg.addEventListener('click', function (ev) {
      if (ev.target === svg) closeNodePopover(sim);
    });

    return sim;
  }

  function toLocal(sim, ev) {
    var rect = sim.svg.getBoundingClientRect ? sim.svg.getBoundingClientRect() : { left: 0, top: 0, width: sim.w, height: sim.h };
    var sx = rect.width ? sim.w / rect.width : 1;
    var sy = rect.height ? sim.h / rect.height : 1;
    return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
  }

  function update(sim, nodes, edges) {
    var cx = sim.w / 2;
    var cy = sim.h / 2;
    var next = {};
    var list = [];
    nodes.forEach(function (n) {
      var prev = sim.byId[n.id];
      var node = prev || { id: n.id, x: cx + rand(140), y: cy + rand(140), vx: 0, vy: 0 };
      node.label = n.label || n.id;
      node.kind = n.node_type || 'concept';
      node.salience = typeof n.salience === 'number' ? n.salience : 0.5;
      node.ref = n;
      next[n.id] = node;
      list.push(node);
    });
    sim.byId = next;
    sim.nodes = list;
    sim.edges = (edges || [])
      .filter(function (e) {
        return e && next[e.src] && next[e.dst] && e.src !== e.dst;
      })
      .map(function (e) {
        return { src: next[e.src], dst: next[e.dst], rel: e.relation };
      });

    // Adjacency for hover-highlight.
    sim.neighbors = {};
    sim.nodes.forEach(function (n) {
      sim.neighbors[n.id] = {};
    });
    sim.edges.forEach(function (e) {
      sim.neighbors[e.src.id][e.dst.id] = true;
      sim.neighbors[e.dst.id][e.src.id] = true;
    });

    // Reconcile an open popover with the new graph: drop it if its node is gone, else
    // re-fill it so freshly-arrived mentions of that concept show up live.
    if (sim.popoverNode) {
      var kept = next[sim.popoverNode.id];
      if (!kept) {
        closeNodePopover(sim);
      } else {
        sim.popoverNode = kept;
        sim.popover.textContent = '';
        if (typeof sim.onNodeClick === 'function') sim.onNodeClick(kept.ref, popoverHandle(sim));
      }
    }

    buildEls(sim);
    sim.alpha = 1;
    ensureLoop(sim);
  }

  function buildEls(sim) {
    sim.edgeLayer.textContent = '';
    sim.nodeLayer.textContent = '';

    sim.edgeEls = sim.edges.map(function (e) {
      var line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('class', 'graph-edge');
      sim.edgeLayer.appendChild(line);
      return { line: line, e: e };
    });

    sim.nodeEls = sim.nodes.map(function (node) {
      var g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'graph-node gn-' + nodeClass(node.kind));
      var c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('r', String(6 + node.salience * 5));
      var t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', String(10 + node.salience * 5));
      t.setAttribute('y', '4');
      t.textContent = node.label;
      g.appendChild(c);
      g.appendChild(t);
      attachNodeEvents(sim, g, node);
      sim.nodeLayer.appendChild(g);
      return { g: g, node: node };
    });
  }

  function nodeClass(kind) {
    if (kind === 'entity') return 'entity';
    if (kind === 'topic') return 'topic';
    if (kind === 'event') return 'event';
    if (kind === 'insight') return 'insight';
    return 'concept';
  }

  function attachNodeEvents(sim, g, node) {
    g.addEventListener('pointerdown', function (ev) {
      sim.drag = node;
      sim.dragMoved = false;
      sim.dragStart = toLocal(sim, ev);
      if (g.setPointerCapture && ev.pointerId != null) {
        try {
          g.setPointerCapture(ev.pointerId);
        } catch (e) {
          /* not all environments support capture */
        }
      }
    });
    g.addEventListener('click', function () {
      // Suppress the click that ends a drag (only a tap opens the popover).
      if (sim.dragMoved) {
        sim.dragMoved = false;
        return;
      }
      openNodePopover(sim, node);
    });
    g.addEventListener('pointerenter', function () {
      highlight(sim, node);
    });
    g.addEventListener('pointerleave', function () {
      highlight(sim, null);
    });
  }

  function highlight(sim, node) {
    sim.nodeEls.forEach(function (ne) {
      var on = !node || ne.node === node || (sim.neighbors[node.id] && sim.neighbors[node.id][ne.node.id]);
      toggle(ne.g, 'dim', node ? !on : false);
    });
    sim.edgeEls.forEach(function (ee) {
      var on = !node || ee.e.src === node || ee.e.dst === node;
      toggle(ee.line, 'dim', node ? !on : false);
    });
  }

  function toggle(el, cls, on) {
    if (el.classList) el.classList.toggle(cls, on);
  }

  // --- node popover ----------------------------------------------------------
  // A small handle handed to onNodeClick so the caller can fill the host and close it
  // without reaching into the sim. `node.ref` is the ORIGINAL node object (the data the
  // caller passed to render), not our internal sim node.
  function popoverHandle(sim) {
    return {
      host: sim.popover,
      node: sim.popoverNode ? sim.popoverNode.ref : null,
      close: function () {
        closeNodePopover(sim);
      },
    };
  }

  // Open the popover anchored over `node` (clicking another node moves this single
  // host to it; clicking the same node again just refreshes it in place). The host is
  // created lazily so a graph that is never clicked stays a lone <svg> child of the
  // container. We clear it and hand it to the caller to fill. Closing is via the host's
  // own affordance, Escape, a background click, or the node leaving the graph.
  function openNodePopover(sim, node) {
    if (!sim.popover) {
      var host = document.createElement('div');
      host.setAttribute('class', 'graph-popover');
      // A click inside the popover must not bubble out to the svg's background-close.
      host.addEventListener('click', function (ev) {
        if (ev.stopPropagation) ev.stopPropagation();
      });
      sim.container.appendChild(host);
      sim.popover = host;
    }
    sim.popoverNode = node;
    sim.popover.textContent = '';
    if (typeof sim.onNodeClick === 'function') sim.onNodeClick(node.ref, popoverHandle(sim));
    positionPopover(sim);
  }

  function closeNodePopover(sim) {
    if (!sim.popoverNode && !sim.popover) return false;
    if (sim.popover && sim.popover.parentNode && sim.popover.parentNode.removeChild) {
      sim.popover.parentNode.removeChild(sim.popover);
    }
    sim.popover = null;
    sim.popoverNode = null;
    return true;
  }

  // Keep the host pinned over its node: above it when there's room, else below, and
  // clamped fully inside the (overflow-hidden) canvas. node.x/node.y are in the same
  // pixel space as the container because the viewBox is sized to the container rect.
  function positionPopover(sim) {
    var host = sim.popover;
    var node = sim.popoverNode;
    if (!host || !node || !host.style) return;
    var pad = 10;
    var w = host.offsetWidth || 240;
    var h = host.offsetHeight || 150;
    var x = node.x + 14;
    var y = node.y - h - 12;
    if (y < pad) y = node.y + 16; // not enough headroom → drop below the node
    x = Math.max(pad, Math.min(Math.max(pad, sim.w - w - pad), x));
    y = Math.max(pad, Math.min(Math.max(pad, sim.h - h - pad), y));
    host.style.left = x + 'px';
    host.style.top = y + 'px';
  }

  function tick(sim) {
    var nodes = sim.nodes;
    var i;
    var j;
    // Repulsion (O(n²) — fine for a few dozen nodes).
    for (i = 0; i < nodes.length; i++) {
      var a = nodes[i];
      for (j = i + 1; j < nodes.length; j++) {
        var b = nodes[j];
        var dx = a.x - b.x;
        var dy = a.y - b.y;
        var d2 = dx * dx + dy * dy + 0.01;
        var d = Math.sqrt(d2);
        var f = REPULSION / d2;
        var fx = (dx / d) * f;
        var fy = (dy / d) * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }
    // Springs along edges.
    sim.edges.forEach(function (e) {
      var dx = e.dst.x - e.src.x;
      var dy = e.dst.y - e.src.y;
      var d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      var f = SPRING_K * (d - SPRING_LEN);
      var fx = (dx / d) * f;
      var fy = (dy / d) * f;
      e.src.vx += fx;
      e.src.vy += fy;
      e.dst.vx -= fx;
      e.dst.vy -= fy;
    });
    // Centering + integrate (skip the dragged node — it's pinned to the cursor).
    var cx = sim.w / 2;
    var cy = sim.h / 2;
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n === sim.drag) continue;
      n.vx += (cx - n.x) * CENTER_K;
      n.vy += (cy - n.y) * CENTER_K;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx * sim.alpha;
      n.y += n.vy * sim.alpha;
      n.x = Math.max(MARGIN, Math.min(sim.w - MARGIN, n.x));
      n.y = Math.max(MARGIN, Math.min(sim.h - MARGIN, n.y));
    }
    sim.alpha *= COOL;
  }

  function paint(sim) {
    sim.edgeEls.forEach(function (ee) {
      ee.line.setAttribute('x1', String(ee.e.src.x));
      ee.line.setAttribute('y1', String(ee.e.src.y));
      ee.line.setAttribute('x2', String(ee.e.dst.x));
      ee.line.setAttribute('y2', String(ee.e.dst.y));
    });
    sim.nodeEls.forEach(function (ne) {
      ne.g.setAttribute('transform', 'translate(' + ne.node.x + ',' + ne.node.y + ')');
    });
    if (sim.popoverNode) positionPopover(sim); // keep an open popover pinned to its node
  }

  function ensureLoop(sim) {
    if (sim.running) return;
    sim.running = true;
    var step = function () {
      tick(sim);
      paint(sim);
      if (sim.alpha > MIN_ALPHA || sim.drag) {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
        else setTimeout(step, 16);
      } else {
        sim.running = false;
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
    else setTimeout(step, 16);
  }

  function render(container, nodes, edges, onNodeClick) {
    if (!container) return;
    var sim = container.__aizenGraph;
    if (!sim) {
      sim = makeSim(container, onNodeClick);
      container.__aizenGraph = sim;
    } else {
      sim.onNodeClick = onNodeClick;
    }
    measure(container, sim);
    update(sim, nodes || [], edges || []);
    paint(sim);
  }

  // Dismiss an open node popover for a container (e.g. from an Escape handler). Returns
  // true iff one was actually open, so a caller can fall through to other Escape work.
  function closePopover(container) {
    var sim = container && container.__aizenGraph;
    return sim ? closeNodePopover(sim) : false;
  }

  if (typeof window !== 'undefined') {
    window.AizenGraph = { render: render, closePopover: closePopover };
  }
})();
