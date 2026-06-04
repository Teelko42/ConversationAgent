/*
 * Aizen — Obsidian vault connector seam (New_Feature.md F4).
 *
 * An Obsidian vault is just a folder of markdown notes, so F4 is a higher-volume
 * producer for the S0 library (window.AizenSources). This module is the BD-03 seam
 * — the same "always-callable, no branching at call sites" posture as
 * `WebSearchProvider`/`AuthSeam`:
 *
 *   interface ObsidianProvider {
 *     connect(): Promise<{ vaultName }>;
 *     listNotes(): Promise<Array<{ path }>>;
 *     readNote(path): Promise<string>;   // raw markdown (read-only — F4 §7)
 *     status(): 'connected' | 'disconnected' | 'unsupported';
 *   }
 *
 *   • FileSystemObsidianProvider — Phase 1 Chromium path (File System Access API).
 *   • UploadObsidianProvider     — Phase 1 fallback (<input webkitdirectory>).
 *   • RestApiObsidianProvider    — Phase 2 stub (Local REST API plugin), documented
 *                                  as an optional upgrade; NOT wired for "all users".
 *   • NullObsidianProvider       — unsupported browsers → the UI shows the fallback.
 *
 * No build step — plain ES2017, loaded after sources.js and before client.js,
 * exposing `window.AizenObsidian`. Read-only ALWAYS: nothing is ever written back
 * to the vault. Privacy (team-09): note text stays client-side; only S0-selected
 * chunks ride a request, never logged raw.
 */
(function () {
  'use strict';

  // Directories/files we never index (F4 §3/§7). `.obsidian/` is config, `.trash/`
  // is deleted notes, dotfiles are hidden. `.aizenignore` support is a documented
  // later add (F4 §7) — the constant is here so the rule has one home.
  var IGNORE_DIRS = { '.obsidian': 1, '.trash': 1, '.git': 1 };

  function isIgnoredName(name) {
    if (!name) return true;
    if (name.charAt(0) === '.') return true; // dotfile/dotdir
    if (IGNORE_DIRS[name]) return true;
    return false;
  }

  function isMarkdown(name) {
    return /\.md$/i.test(name);
  }

  /**
   * Parse a note's raw markdown into plain grounding text (F4 §3): strip a leading
   * YAML frontmatter block (`---\n…\n---`), keep headings and body as-is. Wikilinks
   * (`[[note]]`) are left as plain tokens for now (F4 §12 default) — resolution into
   * the linked note's text is a later add.
   */
  function parseMarkdown(raw) {
    var text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
    // YAML frontmatter only when it's the very first thing in the file.
    if (text.slice(0, 4) === '---\n') {
      var end = text.indexOf('\n---', 3);
      if (end !== -1) {
        var after = text.indexOf('\n', end + 1);
        text = after !== -1 ? text.slice(after + 1) : '';
      }
    }
    return text.trim();
  }

  // ---- FileSystemObsidianProvider (Phase 1, Chromium) ----------------------
  // Backed by a File System Access **directory handle**. The handle is injectable
  // (tests pass a mock; the client passes a real picked handle / a restored one),
  // so the provider has no hard dependency on the global picker — matching how
  // `TavilyWebSearchProvider` takes an injected `fetch`.
  function FileSystemObsidianProvider(opts) {
    opts = opts || {};
    this._handle = opts.handle || null;
    this._pick = opts.pickDirectory || null; // () => Promise<handle>
    this._requestPermission = opts.requestPermission || defaultRequestPermission;
    this._maxNotes = opts.maxNotes || 5000; // bound a pathological vault
    this._fileHandles = null; // path -> fileHandle (filled by listNotes)
    this._vaultName = '';
    this._state = 'disconnected';
  }
  FileSystemObsidianProvider.prototype.connect = function () {
    var self = this;
    return Promise.resolve()
      .then(function () {
        if (!self._handle) {
          if (!self._pick) throw new Error('no-directory-handle');
          return self._pick();
        }
        return self._handle;
      })
      .then(function (handle) {
        if (!handle) throw new Error('no-directory-handle');
        self._handle = handle;
        return self._requestPermission(handle);
      })
      .then(function (granted) {
        if (granted === false) throw new Error('permission-denied');
        self._vaultName = self._handle.name || 'vault';
        self._state = 'connected';
        return { vaultName: self._vaultName };
      });
  };
  FileSystemObsidianProvider.prototype.listNotes = function () {
    var self = this;
    if (!self._handle) return Promise.reject(new Error('not-connected'));
    self._fileHandles = Object.create(null);
    var notes = [];
    return walkDir(self._handle, '', notes, self._fileHandles, self._maxNotes).then(function () {
      notes.sort(function (a, b) {
        return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });
      return notes;
    });
  };
  FileSystemObsidianProvider.prototype.readNote = function (path) {
    var self = this;
    var fh = self._fileHandles && self._fileHandles[path];
    if (!fh) return Promise.reject(new Error('unknown-note'));
    return fh.getFile().then(function (file) {
      return file.text();
    });
  };
  FileSystemObsidianProvider.prototype.status = function () {
    return this._state;
  };
  FileSystemObsidianProvider.prototype.handle = function () {
    return this._handle; // for IndexedDB persistence by the client
  };

  // Recursively collect `*.md` under `dir`, skipping ignored dirs/dotfiles. Uses
  // the async-iterator handle API (`dir.entries()` → [name, handle]); each file
  // handle is cached by vault-relative path so readNote is a direct lookup.
  function walkDir(dir, prefix, notes, fileHandles, maxNotes) {
    return iterateEntries(dir, function (name, handle) {
      if (notes.length >= maxNotes) return;
      if (isIgnoredName(name)) return;
      var rel = prefix ? prefix + '/' + name : name;
      if (handle.kind === 'directory') {
        return walkDir(handle, rel, notes, fileHandles, maxNotes);
      }
      if (handle.kind === 'file' && isMarkdown(name)) {
        notes.push({ path: rel });
        fileHandles[rel] = handle;
      }
    });
  }

  // Drive `dir.entries()` (an async iterator of [name, handle]) sequentially,
  // awaiting the (possibly async) visitor for each entry.
  function iterateEntries(dir, visit) {
    var iter = dir.entries ? dir.entries() : null;
    if (!iter || typeof iter.next !== 'function') return Promise.resolve();
    function step() {
      return Promise.resolve(iter.next()).then(function (res) {
        if (res.done) return;
        var pair = res.value;
        return Promise.resolve(visit(pair[0], pair[1])).then(step);
      });
    }
    return step();
  }

  // Re-request read permission on a (possibly restored) handle. Returns true when
  // already/now granted. Guarded so a handle without the permission API still works.
  function defaultRequestPermission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') return Promise.resolve(true);
    var descriptor = { mode: 'read' };
    return Promise.resolve(handle.queryPermission(descriptor)).then(function (state) {
      if (state === 'granted') return true;
      if (typeof handle.requestPermission !== 'function') return false;
      return Promise.resolve(handle.requestPermission(descriptor)).then(function (s) {
        return s === 'granted';
      });
    });
  }

  // ---- UploadObsidianProvider (Phase 1 fallback) ---------------------------
  // Backed by a FileList from `<input type="file" webkitdirectory multiple>` (the
  // Firefox/Safari path). No handle → cannot persist across reloads (the user
  // re-picks); same parsing/chunking/ignore rules as the FS-Access path.
  function UploadObsidianProvider(fileList) {
    this._files = Object.create(null); // path -> File
    this._vaultName = '';
    this._state = 'disconnected';
    var arr = fileList ? Array.prototype.slice.call(fileList) : [];
    var root = '';
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      var rel = f.webkitRelativePath || f.relativePath || f.name;
      var segs = String(rel).split('/');
      if (!root && segs.length > 1) root = segs[0];
      // Skip ignored segments anywhere in the path, and non-markdown files.
      var skip = false;
      for (var s = 0; s < segs.length - 1; s++) {
        if (isIgnoredName(segs[s])) {
          skip = true;
          break;
        }
      }
      if (skip || isIgnoredName(segs[segs.length - 1]) || !isMarkdown(f.name)) continue;
      // Store under the vault-relative path (drop the vault-root segment).
      var relPath = segs.length > 1 ? segs.slice(1).join('/') : segs[0];
      this._files[relPath] = f;
    }
    this._vaultName = root || 'vault';
  }
  UploadObsidianProvider.prototype.connect = function () {
    this._state = 'connected';
    return Promise.resolve({ vaultName: this._vaultName });
  };
  UploadObsidianProvider.prototype.listNotes = function () {
    var paths = Object.keys(this._files).sort();
    return Promise.resolve(
      paths.map(function (p) {
        return { path: p };
      }),
    );
  };
  UploadObsidianProvider.prototype.readNote = function (path) {
    var f = this._files[path];
    if (!f) return Promise.reject(new Error('unknown-note'));
    return f.text();
  };
  UploadObsidianProvider.prototype.status = function () {
    return this._state;
  };

  // ---- RestApiObsidianProvider (Phase 2 — optional, stubbed) ---------------
  // Talks to the community **Local REST API** Obsidian plugin at
  // https://127.0.0.1:27124 with the user's API key. Gives cross-browser + live
  // updates without a folder re-pick — documented as a power-user upgrade, NOT part
  // of the "all users" path (F4 §3 Phase 2). Left as a thin, injectable stub now
  // (seam present, full wiring later — F4 §12 default).
  function RestApiObsidianProvider(opts) {
    opts = opts || {};
    this._base = opts.endpoint || 'https://127.0.0.1:27124';
    this._apiKey = opts.apiKey || '';
    this._fetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    this._state = 'disconnected';
  }
  RestApiObsidianProvider.prototype._headers = function () {
    return { authorization: 'Bearer ' + this._apiKey, accept: 'application/json' };
  };
  RestApiObsidianProvider.prototype.connect = function () {
    var self = this;
    if (!self._fetch || !self._apiKey) return Promise.reject(new Error('rest-not-configured'));
    return self._fetch(self._base + '/', { headers: self._headers() }).then(function (res) {
      if (!res || !res.ok) throw new Error('rest-unreachable');
      self._state = 'connected';
      return { vaultName: 'Obsidian (Local REST API)' };
    });
  };
  RestApiObsidianProvider.prototype.listNotes = function () {
    var self = this;
    // The plugin exposes /vault/ listings; full recursive enumeration is the
    // later wiring. Stubbed to an empty list so the seam is callable today.
    return Promise.resolve([]).then(function (n) {
      void self;
      return n;
    });
  };
  RestApiObsidianProvider.prototype.readNote = function (path) {
    var self = this;
    return self
      ._fetch(self._base + '/vault/' + encodeURI(path), { headers: self._headers() })
      .then(function (res) {
        if (!res || !res.ok) throw new Error('rest-read-failed');
        return res.text();
      });
  };
  RestApiObsidianProvider.prototype.status = function () {
    return this._state;
  };

  // ---- NullObsidianProvider ------------------------------------------------
  function NullObsidianProvider() {}
  NullObsidianProvider.prototype.connect = function () {
    return Promise.reject(new Error('unsupported'));
  };
  NullObsidianProvider.prototype.listNotes = function () {
    return Promise.resolve([]);
  };
  NullObsidianProvider.prototype.readNote = function () {
    return Promise.reject(new Error('unsupported'));
  };
  NullObsidianProvider.prototype.status = function () {
    return 'unsupported';
  };

  // Is the zero-install Chromium path available? (File System Access API.)
  function supportsDirectoryPicker() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  /**
   * Pick the right provider for the environment / inputs (BD-03). Explicit deps win
   * (tests inject a `handle`; the upload fallback injects `files`), else fall back to
   * the global directory picker, else Null. Always returns a callable provider.
   */
  function makeProvider(opts) {
    opts = opts || {};
    if (opts.files) return new UploadObsidianProvider(opts.files);
    if (opts.handle || opts.pickDirectory) {
      return new FileSystemObsidianProvider({
        handle: opts.handle,
        pickDirectory: opts.pickDirectory,
        requestPermission: opts.requestPermission,
        maxNotes: opts.maxNotes,
      });
    }
    if (supportsDirectoryPicker()) {
      return new FileSystemObsidianProvider({
        pickDirectory: function () {
          return window.showDirectoryPicker();
        },
        maxNotes: opts.maxNotes,
      });
    }
    return new NullObsidianProvider();
  }

  // ---- IndexedDB handle persistence (F4 §3 "reconnect across reloads") -----
  // Persist the FS-Access directory handle so a return visit can re-request
  // permission (one click) and re-index. All guarded — absent IndexedDB (the test
  // vm, private mode) is a silent no-op, and the upload fallback simply can't persist.
  var IDB_NAME = 'aizen-obsidian';
  var IDB_STORE = 'handles';
  var IDB_KEY = 'vault';

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') return reject(new Error('no-indexeddb'));
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error || new Error('idb-open-failed'));
      };
    });
  }
  function idbDo(mode, fn) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, mode);
        var store = tx.objectStore(IDB_STORE);
        var request = fn(store);
        tx.oncomplete = function () {
          resolve(request && request.result);
        };
        tx.onerror = function () {
          reject(tx.error || new Error('idb-tx-failed'));
        };
      });
    });
  }
  function saveHandle(handle) {
    return idbDo('readwrite', function (store) {
      return store.put(handle, IDB_KEY);
    }).catch(function () {
      /* persistence is best-effort — never block connecting */
    });
  }
  function loadHandle() {
    return idbDo('readonly', function (store) {
      return store.get(IDB_KEY);
    }).catch(function () {
      return null;
    });
  }
  function clearHandle() {
    return idbDo('readwrite', function (store) {
      return store.delete(IDB_KEY);
    }).catch(function () {
      /* ignore */
    });
  }

  var api = {
    FileSystemObsidianProvider: FileSystemObsidianProvider,
    UploadObsidianProvider: UploadObsidianProvider,
    RestApiObsidianProvider: RestApiObsidianProvider,
    NullObsidianProvider: NullObsidianProvider,
    makeProvider: makeProvider,
    supportsDirectoryPicker: supportsDirectoryPicker,
    parseMarkdown: parseMarkdown,
    isIgnoredName: isIgnoredName,
    isMarkdown: isMarkdown,
    persist: { saveHandle: saveHandle, loadHandle: loadHandle, clearHandle: clearHandle },
  };

  if (typeof window !== 'undefined') window.AizenObsidian = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
