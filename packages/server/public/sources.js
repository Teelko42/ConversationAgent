/*
 * Aizen client-side **source library + top-k retrieval** (New_Feature.md S0).
 *
 * The shared building block under F3 (local files) and F4 (Obsidian vault): both
 * turn "a lot of user text" into grounding, and the transcript-grounding budget is
 * small (one `enrich` hop). So rather than shipping every source into every prompt
 * (today's `userSourcesForSend()` dumped up to 20 whole notes), we keep a library
 * of source *docs*, split each into chunks, and select only the few chunks relevant
 * to the CURRENT sentence/question per request.
 *
 * No build step — plain ES2017 the browser runs directly. Loaded by index.html
 * BEFORE client.js, exposing `window.AizenSources`. F3/F4 are thin producers that
 * pour docs into it (`addDoc`); client.js's `userSourcesForSend()` is rewired to
 * `selectFor(currentQueryText)`.
 *
 * Privacy (team-09, F3 §9 / F4 §7): doc text is conversation data. It lives ONLY
 * in the browser, in memory, for the session; only the top-k selected chunks ride
 * each request, and nothing is logged raw. Everything is bounded (count, per-doc
 * bytes, aggregate) so neither a 40-page PDF nor a 2,000-note vault can blow memory
 * or the prompt.
 *
 *   Section refs below cite S0; F3/F4 code cites these too (e.g. `// S0 retrieval`).
 */
(function () {
  'use strict';

  // ---- bounds (S0 "Budget") ------------------------------------------------
  // Per-chunk target/ceiling: ~700–1,000 chars on paragraph/heading boundaries.
  var CHUNK_TARGET = 900; // aim for this; flush a chunk once a paragraph pushes past it
  var CHUNK_MAX = 1100; // never let a single chunk exceed this
  var CHUNK_OVERLAP = 160; // carry this many trailing chars into the next chunk (lexical overlap)
  var MAX_CHUNKS_PER_DOC = 400; // cap chunks/doc so one giant file can't explode the library
  // Global retrieval budget: one frame can't carry an unbounded prompt regardless
  // of library size (S0 — "≤ 12 chunks and ≤ 24 KB total").
  var GLOBAL_MAX_CHUNKS = 12;
  var GLOBAL_MAX_BYTES = 24 * 1024;
  // Library-wide ingest ceiling so memory stays bounded even for a huge vault.
  var LIBRARY_MAX_BYTES = 32 * 1024 * 1024; // 32 MB of extracted text across all docs

  // ---- the library ---------------------------------------------------------
  // An ordered list of source docs (insertion order == recency). Each:
  //   { id, origin:'paste'|'file'|'obsidian', title?, url?, path?, text,
  //     chunks:[{text, idx}], bytes, addedAt }
  var library = [];
  var docSeq = 0; // monotonic → unique doc id + a deterministic recency key

  // ---- tokenization (S0 retrieval — reuse explain.ts STOPWORDS idea) -------
  // Lowercased alphanumeric tokens, stopword-filtered, length-bounded. Kept
  // dependency-free and intentionally close to the server's `pickKeyWords` notion
  // so client-side selection and server-side citation rendering agree on "notable".
  var STOPWORDS = {
    the: 1, a: 1, an: 1, and: 1, or: 1, but: 1, if: 1, then: 1, else: 1, of: 1,
    to: 1, in: 1, on: 1, at: 1, by: 1, for: 1, with: 1, as: 1, is: 1, are: 1,
    was: 1, were: 1, be: 1, been: 1, being: 1, am: 1, do: 1, does: 1, did: 1,
    have: 1, has: 1, had: 1, this: 1, that: 1, these: 1, those: 1, it: 1, its: 1,
    he: 1, she: 1, they: 1, them: 1, his: 1, her: 1, their: 1, we: 1, you: 1,
    your: 1, our: 1, us: 1, me: 1, my: 1, i: 1, from: 1, into: 1, about: 1,
    over: 1, under: 1, again: 1, there: 1, here: 1, when: 1, where: 1, which: 1,
    who: 1, whom: 1, what: 1, why: 1, how: 1, all: 1, any: 1, can: 1, will: 1,
    would: 1, could: 1, should: 1, may: 1, might: 1, must: 1, not: 1, no: 1,
    so: 1, than: 1, too: 1, very: 1, just: 1, also: 1,
  };

  function tokenize(text) {
    var out = [];
    if (!text) return out;
    var matches = String(text).toLowerCase().match(/[a-z0-9][a-z0-9'+-]*/g);
    if (!matches) return out;
    for (var i = 0; i < matches.length; i++) {
      var t = matches[i].replace(/^['+-]+|['+-]+$/g, '');
      if (t.length < 2 || t.length > 32) continue;
      if (STOPWORDS[t]) continue;
      out.push(t);
    }
    return out;
  }

  // UTF-8 byte length WITHOUT TextEncoder (absent in the headless test vm).
  function utf8Len(str) {
    var s = String(str == null ? '' : str);
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) {
        n += 4;
        i++;
      } // surrogate pair → one 4-byte code point
      else n += 3;
    }
    return n;
  }

  // ---- chunking (S0 — markdown-aware, overlapping) -------------------------
  // Split text into ~700–1,000-char chunks on paragraph/heading boundaries. A
  // markdown heading (`#`..`######`) starts a new section and is kept at the HEAD
  // of its chunk (and re-seeded into the section's continuation chunks so context
  // isn't lost). When a section is split for length, a short trailing slice of the
  // previous chunk is carried forward as overlap so a phrase spanning the boundary
  // still matches a query.
  function isHeading(line) {
    return /^\s{0,3}#{1,6}\s+\S/.test(line);
  }

  function splitParagraphs(text) {
    var norm = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var lines = norm.split('\n');
    var paras = [];
    var buf = [];
    var flush = function () {
      if (!buf.length) return;
      var joined = buf.join('\n').trim();
      if (joined) paras.push({ text: joined, heading: false });
      buf = [];
    };
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (isHeading(line)) {
        flush();
        paras.push({ text: line.trim(), heading: true });
      } else if (line.trim() === '') {
        flush();
      } else {
        buf.push(line);
      }
    }
    flush();
    return paras;
  }

  // The trailing `CHUNK_OVERLAP` chars of `s`, trimmed to a word boundary.
  function overlapTail(s) {
    if (s.length <= CHUNK_OVERLAP) return '';
    var tail = s.slice(s.length - CHUNK_OVERLAP);
    var sp = tail.indexOf(' ');
    return sp > 0 ? tail.slice(sp + 1) : tail;
  }

  function chunkText(text) {
    var paras = splitParagraphs(text);
    if (!paras.length) {
      var t = String(text == null ? '' : text).trim();
      return t ? [{ text: t.slice(0, CHUNK_MAX), idx: 0 }] : [];
    }
    var chunks = [];
    var cur = '';
    var heading = '';
    var pushCur = function () {
      var c = cur.trim();
      if (c) chunks.push(c);
      cur = '';
    };
    for (var i = 0; i < paras.length && chunks.length < MAX_CHUNKS_PER_DOC; i++) {
      var p = paras[i];
      if (p.heading) {
        // New section: flush whatever we had and start a chunk led by the heading.
        pushCur();
        heading = p.text;
        cur = p.text;
        continue;
      }
      var sep = cur ? '\n\n' : '';
      // A single paragraph longer than CHUNK_MAX is hard-split below; otherwise
      // flush-and-reseed when adding it would overflow.
      if (cur && cur.length + sep.length + p.text.length > CHUNK_MAX) {
        var tail = overlapTail(cur);
        pushCur();
        // Re-seed the continuation with the section heading + a short overlap tail
        // so retrieval keeps the section's context and boundary phrases.
        var seedParts = [];
        if (heading) seedParts.push(heading);
        if (tail) seedParts.push(tail);
        cur = seedParts.join('\n\n');
        sep = cur ? '\n\n' : '';
      }
      // Hard-split an oversized single paragraph into CHUNK_TARGET slices.
      if (p.text.length > CHUNK_MAX) {
        if (cur) {
          pushCur();
          cur = '';
          sep = '';
        }
        for (var off = 0; off < p.text.length && chunks.length < MAX_CHUNKS_PER_DOC; off += CHUNK_TARGET) {
          var piece = (heading ? heading + '\n\n' : '') + p.text.slice(off, off + CHUNK_TARGET);
          chunks.push(piece.trim());
        }
        continue;
      }
      cur += sep + p.text;
    }
    pushCur();
    return chunks.slice(0, MAX_CHUNKS_PER_DOC).map(function (text, idx) {
      return { text: text, idx: idx };
    });
  }

  // ---- BM25-lite scoring (S0 retrieval) ------------------------------------
  // Classic BM25 over the chunk corpus: idf across chunks, term frequency within a
  // chunk, length-normalized. "lite" = no stemming, lexical only (team-05's
  // embedding+BM25 hybrid is the later server-side target, F3/F4 "Out of scope").
  var BM25_K1 = 1.5;
  var BM25_B = 0.75;

  function chunkTokenCounts(chunk) {
    if (chunk._tf) return chunk._tf; // memoize per chunk (cleared on re-chunk)
    var tf = Object.create(null);
    var toks = tokenize(chunk.text);
    for (var i = 0; i < toks.length; i++) tf[toks[i]] = (tf[toks[i]] || 0) + 1;
    chunk._tf = tf;
    chunk._len = toks.length;
    return tf;
  }

  // ---- public API ----------------------------------------------------------

  // Add a doc to the library; chunk it synchronously. Returns the stored doc, or
  // null when the text is empty / the library is at its byte ceiling. `dedupeKey`
  // (origin+path or origin+title) lets a re-sync replace a note rather than dupe it.
  function addDoc(input) {
    input = input || {};
    var text = input.text == null ? '' : String(input.text);
    var trimmed = text.trim();
    if (!trimmed) return null;

    var origin = input.origin === 'file' || input.origin === 'obsidian' ? input.origin : 'paste';
    var bytes = utf8Len(trimmed);

    // Replace an existing doc with the same dedupe key (re-sync / re-add a file).
    var key = dedupeKey(origin, input.path, input.title);
    if (key) {
      for (var i = 0; i < library.length; i++) {
        if (dedupeKey(library[i].origin, library[i].path, library[i].title) === key) {
          library.splice(i, 1);
          break;
        }
      }
    }

    // Library-wide byte ceiling (fail-closed: refuse rather than evict silently).
    if (totalBytes() + bytes > LIBRARY_MAX_BYTES) return null;

    docSeq += 1;
    var doc = {
      id: 'doc' + docSeq,
      seq: docSeq,
      origin: origin,
      text: trimmed,
      chunks: chunkText(trimmed),
      bytes: bytes,
      addedAt: docSeq, // logical clock (no wall-clock dependency for ordering)
    };
    if (input.title) doc.title = String(input.title);
    if (input.url) doc.url = String(input.url);
    if (input.path) doc.path = String(input.path);
    library.push(doc);
    return publicDoc(doc);
  }

  function dedupeKey(origin, path, title) {
    if (path) return origin + ' p ' + String(path);
    if (origin !== 'paste' && title) return origin + ' t ' + String(title);
    return null; // pastes are never deduped (two identical notes are allowed)
  }

  function removeDoc(id) {
    for (var i = 0; i < library.length; i++) {
      if (library[i].id === id) {
        library.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  function removeByOrigin(origin) {
    var before = library.length;
    library = library.filter(function (d) {
      return d.origin !== origin;
    });
    return before - library.length;
  }

  function getDoc(id) {
    for (var i = 0; i < library.length; i++) if (library[i].id === id) return publicDoc(library[i]);
    return null;
  }

  function listDocs(origin) {
    return library
      .filter(function (d) {
        return !origin || d.origin === origin;
      })
      .map(publicDoc);
  }

  function clear() {
    library = [];
  }

  function totalBytes() {
    var n = 0;
    for (var i = 0; i < library.length; i++) n += library[i].bytes;
    return n;
  }

  // Per-origin (or whole-library) counters for the F3/F4 UI ("N notes, M chunks").
  function stats(origin) {
    var docs = 0;
    var chunks = 0;
    var bytes = 0;
    for (var i = 0; i < library.length; i++) {
      var d = library[i];
      if (origin && d.origin !== origin) continue;
      docs += 1;
      chunks += d.chunks.length;
      bytes += d.bytes;
    }
    return { docs: docs, chunks: chunks, bytes: bytes };
  }

  // A safe, read-only view of a doc (no internal memo fields leak out).
  function publicDoc(d) {
    var out = { id: d.id, origin: d.origin, text: d.text, bytes: d.bytes, addedAt: d.addedAt, chunks: d.chunks.length };
    if (d.title) out.title = d.title;
    if (d.url) out.url = d.url;
    if (d.path) out.path = d.path;
    return out;
  }

  /**
   * Select the top-k chunks relevant to `queryText`, shaped as `UserSource`s the
   * server/engine already understand: `{ id:'us_<docId>_<chunkIdx>', title?, url?,
   * text, origin }`. Ranked by BM25-lite, tie-broken by recency — so with NO query
   * (or a query that matches nothing) it degrades to "most recent first", which is
   * byte-for-byte today's behaviour for a small library of pasted notes. Always
   * bounded by `maxChunks` (default 6) AND the global ceiling (≤12 chunks / ≤24 KB).
   */
  function selectFor(queryText, opts) {
    opts = opts || {};
    var maxChunks = Math.min(opts.maxChunks || 6, GLOBAL_MAX_CHUNKS);
    var maxCharsPerChunk = opts.maxCharsPerChunk || 600;
    if (!library.length) return [];

    // Flatten every chunk with a back-pointer to its doc.
    var items = [];
    var totalLen = 0;
    for (var i = 0; i < library.length; i++) {
      var d = library[i];
      for (var c = 0; c < d.chunks.length; c++) {
        var ch = d.chunks[c];
        chunkTokenCounts(ch); // populate ._tf / ._len
        totalLen += ch._len;
        items.push({ doc: d, ch: ch });
      }
    }
    if (!items.length) return [];
    var avgdl = totalLen / items.length || 1;

    var qTokens = uniq(tokenize(queryText));
    var scores = new Array(items.length);
    if (qTokens.length) {
      // df(t) across chunks → idf(t).
      var df = Object.create(null);
      for (var t = 0; t < qTokens.length; t++) {
        var tok = qTokens[t];
        var n = 0;
        for (var k = 0; k < items.length; k++) if (items[k].ch._tf[tok]) n++;
        df[tok] = n;
      }
      var N = items.length;
      for (var s = 0; s < items.length; s++) {
        var chk = items[s].ch;
        var score = 0;
        for (var qt = 0; qt < qTokens.length; qt++) {
          var q = qTokens[qt];
          var f = chk._tf[q] || 0;
          if (!f) continue;
          var idf = Math.log(1 + (N - df[q] + 0.5) / (df[q] + 0.5));
          var denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * chk._len) / avgdl);
          score += idf * ((f * (BM25_K1 + 1)) / denom);
        }
        scores[s] = score;
      }
    } else {
      for (var z = 0; z < items.length; z++) scores[z] = 0;
    }

    // Sort by score desc, then recency (doc seq desc), then chunk idx asc — so a
    // zero-score (no-overlap) tie falls back to newest-doc-first, preserving today's
    // "ship the pasted notes" behaviour while real matches float to the top.
    var order = items.map(function (_, idx) {
      return idx;
    });
    order.sort(function (a, b) {
      return (
        scores[b] - scores[a] ||
        items[b].doc.seq - items[a].doc.seq ||
        items[a].ch.idx - items[b].ch.idx
      );
    });

    var out = [];
    var bytes = 0;
    for (var o = 0; o < order.length && out.length < maxChunks; o++) {
      var it = items[order[o]];
      var text = it.ch.text.length > maxCharsPerChunk ? it.ch.text.slice(0, maxCharsPerChunk) : it.ch.text;
      var b = utf8Len(text);
      if (bytes + b > GLOBAL_MAX_BYTES) continue; // skip this one, keep filling with smaller chunks
      bytes += b;
      var us = { id: 'us_' + it.doc.id + '_' + it.ch.idx, text: text, origin: it.doc.origin };
      if (it.doc.title) us.title = it.doc.title;
      if (it.doc.url) us.url = it.doc.url;
      out.push(us);
    }
    return out;
  }

  function uniq(arr) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (!seen[arr[i]]) {
        seen[arr[i]] = 1;
        out.push(arr[i]);
      }
    }
    return out;
  }

  var api = {
    addDoc: addDoc,
    removeDoc: removeDoc,
    removeByOrigin: removeByOrigin,
    getDoc: getDoc,
    listDocs: listDocs,
    clear: clear,
    selectFor: selectFor,
    stats: stats,
    // Exposed for unit tests + advanced callers (not used by the UI directly).
    _internals: { tokenize: tokenize, chunkText: chunkText, utf8Len: utf8Len },
    LIMITS: {
      CHUNK_TARGET: CHUNK_TARGET,
      CHUNK_MAX: CHUNK_MAX,
      GLOBAL_MAX_CHUNKS: GLOBAL_MAX_CHUNKS,
      GLOBAL_MAX_BYTES: GLOBAL_MAX_BYTES,
      LIBRARY_MAX_BYTES: LIBRARY_MAX_BYTES,
    },
  };

  if (typeof window !== 'undefined') window.AizenSources = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // node test convenience
})();
