import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * S0 unit tests (New_Feature.md): the client-side source library + top-k retrieval
 * (`public/sources.js`, `window.AizenSources`) and the F4 Obsidian provider seam
 * (`public/obsidian.js`, `window.AizenObsidian`). Both are plain-ES IIFEs that
 * assign to `window`, so — like the client UI tests — we run them in a `node:vm`
 * against a minimal `window` and assert the exposed API.
 */
const SOURCES_PATH = fileURLToPath(new URL('../public/sources.js', import.meta.url));
const OBSIDIAN_PATH = fileURLToPath(new URL('../public/obsidian.js', import.meta.url));

/** Fresh library + obsidian seam in an isolated vm (state is per-load). */
function load(): { S: any; O: any } {
  const win: any = {};
  const ctx = createContext({ window: win, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout });
  runInContext(readFileSync(SOURCES_PATH, 'utf8'), ctx);
  runInContext(readFileSync(OBSIDIAN_PATH, 'utf8'), ctx);
  return { S: win.AizenSources, O: win.AizenObsidian };
}

describe('S0 — source library + chunking', () => {
  it('chunks markdown on heading/paragraph boundaries, keeping a heading with its section', () => {
    const { S } = load();
    const chunks = S._internals.chunkText('# H1\npara one\n\n## H2\npara two');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text.startsWith('# H1')).toBe(true);
    expect(chunks[0].text).toContain('para one');
    expect(chunks[1].text.startsWith('## H2')).toBe(true);
  });

  it('splits a long single section into multiple bounded chunks', () => {
    const { S } = load();
    const para = Array.from({ length: 40 }, (_, i) => `sentence number ${i} with some filler words`).join(' ');
    const doc = S.addDoc({ origin: 'file', title: 'big.txt', text: para });
    expect(doc.chunks).toBeGreaterThan(1);
    // every chunk stays under the hard ceiling
    const full = S.getDoc(doc.id);
    expect(full.chunks).toBe(doc.chunks);
  });

  it('counts UTF-8 bytes (multi-byte safe)', () => {
    const { S } = load();
    expect(S._internals.utf8Len('abc')).toBe(3);
    expect(S._internals.utf8Len('héllo')).toBe(6); // é = 2 bytes
    expect(S._internals.utf8Len('😀')).toBe(4); // astral = 4 bytes
  });
});

describe('S0 — BM25-lite retrieval', () => {
  it('ranks the relevant chunk first for a query', () => {
    const { S } = load();
    S.addDoc({
      origin: 'file',
      title: 'notes.md',
      text:
        '# Pricing\nOur enterprise pricing starts at 50000 dollars per year.\n\n' +
        '# Roadmap\nThe mobile app ships in the autumn with offline support.\n\n' +
        '# Security\nWe use SOC2 controls and encryption at rest.',
    });
    const top = S.selectFor('what is the enterprise pricing?', { maxChunks: 3 });
    expect(top.length).toBeGreaterThan(0);
    expect(/pricing/i.test(top[0].text)).toBe(true);
  });

  it('returns the chunks shaped as UserSources (us_<docId>_<idx>, origin, title)', () => {
    const { S } = load();
    const doc = S.addDoc({ origin: 'obsidian', title: 'sub/note.md', path: 'sub/note.md', text: 'The budget is 1000 dollars.' });
    const sel = S.selectFor('budget');
    expect(sel[0].id).toBe('us_' + doc.id + '_0');
    expect(sel[0].origin).toBe('obsidian');
    expect(sel[0].title).toBe('sub/note.md');
    expect(sel[0].text).toContain('budget');
  });
});

describe('S0 — fallback + budget (today-compatible)', () => {
  it('returns [] for an empty library (regression: zero-doc == today)', () => {
    const { S } = load();
    expect(S.selectFor('anything')).toEqual([]);
    expect(S.selectFor('')).toEqual([]);
  });

  it('falls back to most-recent-first when the query matches nothing', () => {
    const { S } = load();
    S.addDoc({ origin: 'paste', text: 'Our product launches in Q4.' });
    // No token overlap with "launch" (only "launches" appears) → score 0 → recency.
    const sel = S.selectFor('when do we launch?');
    expect(sel).toHaveLength(1);
    expect(sel[0].text).toBe('Our product launches in Q4.');
    expect(sel[0].origin).toBe('paste');
  });

  it('enforces the global chunk-count budget (≤12) regardless of maxChunks', () => {
    const { S } = load();
    for (let i = 0; i < 40; i++) S.addDoc({ origin: 'paste', text: `note ${i} about widgets and gadgets` });
    const sel = S.selectFor('widgets', { maxChunks: 100 });
    expect(sel.length).toBeLessThanOrEqual(S.LIMITS.GLOBAL_MAX_CHUNKS);
  });

  it('removes docs and clears by origin', () => {
    const { S } = load();
    const a = S.addDoc({ origin: 'paste', text: 'alpha note' });
    S.addDoc({ origin: 'obsidian', title: 'n1', path: 'n1', text: 'beta note' });
    S.addDoc({ origin: 'obsidian', title: 'n2', path: 'n2', text: 'gamma note' });
    expect(S.listDocs().length).toBe(3);
    expect(S.removeDoc(a.id)).toBe(true);
    expect(S.removeByOrigin('obsidian')).toBe(2);
    expect(S.listDocs().length).toBe(0);
  });

  it('dedupes a re-synced note by (origin, path) instead of duplicating', () => {
    const { S } = load();
    S.addDoc({ origin: 'obsidian', title: 'n.md', path: 'n.md', text: 'version one' });
    S.addDoc({ origin: 'obsidian', title: 'n.md', path: 'n.md', text: 'version two' });
    const docs = S.listDocs('obsidian');
    expect(docs).toHaveLength(1);
    expect(docs[0].text).toBe('version two');
  });
});

// ---- F4 Obsidian provider seam -------------------------------------------

/** A mock File System Access directory handle (async-iterator `entries()`). */
function fileHandle(name: string, content: string): any {
  return { kind: 'file', name, getFile: async () => ({ text: async () => content }) };
}
function dirHandle(name: string, children: any[]): any {
  return {
    kind: 'directory',
    name,
    entries() {
      let i = 0;
      return {
        next: async () =>
          i < children.length ? { value: [children[i].name, children[i++]], done: false } : { value: undefined, done: true },
      };
    },
  };
}

describe('F4 — Obsidian provider seam', () => {
  it('parseMarkdown strips leading YAML frontmatter, keeps headings/body', () => {
    const { O } = load();
    expect(O.parseMarkdown('---\ntags: [a]\ntitle: X\n---\n# H\nbody')).toBe('# H\nbody');
    expect(O.parseMarkdown('# No frontmatter\ntext')).toBe('# No frontmatter\ntext');
  });

  it('FileSystemObsidianProvider lists *.md skipping ignored dirs, reads a note', async () => {
    const { O } = load();
    const vault = dirHandle('MyVault', [
      fileHandle('note1.md', '# Note1\nalpha'),
      fileHandle('readme.txt', 'not markdown'), // skipped (not .md)
      dirHandle('.obsidian', [fileHandle('app.json', '{}')]), // skipped (ignored dir)
      dirHandle('sub', [fileHandle('note2.md', '# Note2\nbeta')]),
    ]);
    const provider = O.makeProvider({ handle: vault });
    const info = await provider.connect();
    expect(info.vaultName).toBe('MyVault');
    expect(provider.status()).toBe('connected');
    const notes = await provider.listNotes();
    expect(notes.map((n: any) => n.path).sort()).toEqual(['note1.md', 'sub/note2.md']);
    expect(await provider.readNote('sub/note2.md')).toContain('beta');
  });

  it('UploadObsidianProvider (webkitdirectory fallback) parses a FileList, skips ignored', async () => {
    const { O } = load();
    const f = (path: string, content: string) => ({ name: path.split('/').pop(), webkitRelativePath: path, text: async () => content });
    const provider = O.makeProvider({
      files: [
        f('MyVault/a.md', '# A'),
        f('MyVault/.trash/old.md', 'deleted'), // skipped (ignored dir)
        f('MyVault/.obsidian/app.json', '{}'), // skipped
        f('MyVault/docs/b.md', '# B'),
      ],
    });
    const info = await provider.connect();
    expect(info.vaultName).toBe('MyVault');
    const notes = await provider.listNotes();
    expect(notes.map((n: any) => n.path).sort()).toEqual(['a.md', 'docs/b.md']);
    expect(await provider.readNote('docs/b.md')).toBe('# B');
  });

  it('NullObsidianProvider reports unsupported and rejects connect', async () => {
    const { O } = load();
    const provider = new O.NullObsidianProvider();
    expect(provider.status()).toBe('unsupported');
    await expect(provider.connect()).rejects.toThrow();
  });
});
