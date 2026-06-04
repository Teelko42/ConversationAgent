import { describe, it, expect } from 'vitest';
import { makeAccount, makeIdentity, makeSavedSession, type StoredArtifact } from '@aizen/contracts';
import { InMemoryAccountRepository, type AccountRepository } from './repository.js';
import { SqliteAccountRepository } from './repository-sqlite.js';
import { PgAccountRepository } from './repository-postgres.js';

/**
 * One suite, run against EVERY backend, is the proof that the repository is a real
 * swappable seam (New_Feature.md §4): the in-memory store, the node:sqlite store,
 * and PostgreSQL must be observationally identical. The SQLite case uses an
 * in-memory ':memory:' DB so it is fast + leaves no file.
 *
 * PostgreSQL is **opt-in**: set `TEST_DATABASE_URL` (e.g. a local docker
 * `postgres`) and the same suite runs against it too, each case starting from
 * truncated tables. With the var unset (CI default) the Postgres rows are skipped.
 */
const PG_URL = process.env.TEST_DATABASE_URL;

const BACKENDS: Array<{ name: string; make: () => Promise<AccountRepository> }> = [
  { name: 'InMemoryAccountRepository', make: async () => new InMemoryAccountRepository() },
  { name: 'SqliteAccountRepository(:memory:)', make: async () => new SqliteAccountRepository(':memory:') },
];

if (PG_URL) {
  BACKENDS.push({
    name: 'PgAccountRepository',
    make: async () => {
      const repo = await PgAccountRepository.open({
        connectionString: PG_URL,
        ...(/[?&]sslmode=require/i.test(PG_URL) ? { ssl: { rejectUnauthorized: false } } : {}),
      });
      await repo.truncateAll();
      return repo;
    },
  });
}

const ACC_A = '33333333-3333-4333-8333-33333333000a';
const ACC_B = '33333333-3333-4333-8333-33333333000b';
const SESS_1 = '22222222-2222-4222-8222-222222220001';
const SESS_2 = '22222222-2222-4222-8222-222222220002';

for (const backend of BACKENDS) {
  describe(`AccountRepository — ${backend.name}`, () => {
    /** Run a case against a fresh repo and release it (closes the PG pool). */
    const withRepo = (fn: (repo: AccountRepository) => Promise<void>) => async () => {
      const repo = await backend.make();
      try {
        await fn(repo);
      } finally {
        await repo.close?.();
      }
    };

    it(
      'round-trips an account and updates its tier',
      withRepo(async (repo) => {
        await repo.createAccount(makeAccount({ id: ACC_A, tier: 'free' }));
        expect((await repo.getAccount(ACC_A))?.tier).toBe('free');
        await repo.updateAccountTier(ACC_A, 'pro', 1748706944000000);
        expect((await repo.getAccount(ACC_A))?.tier).toBe('pro');
        expect(await repo.getAccount('nope')).toBeNull();
      }),
    );

    it(
      'looks up an identity by (provider, subject) and lists by account',
      withRepo(async (repo) => {
        await repo.createAccount(makeAccount({ id: ACC_A }));
        await repo.upsertIdentity(
          makeIdentity({ id: 'id-1', account_id: ACC_A, provider: 'google', provider_subject: 'g-1' }),
        );
        const got = await repo.getIdentityByProviderSubject('google', 'g-1');
        expect(got?.account_id).toBe(ACC_A);
        expect(await repo.getIdentityByProviderSubject('google', 'absent')).toBeNull();
        expect(await repo.listIdentitiesForAccount(ACC_A)).toHaveLength(1);
      }),
    );

    it(
      're-linking the same (provider, subject) updates, does not duplicate',
      withRepo(async (repo) => {
        await repo.createAccount(makeAccount({ id: ACC_A }));
        await repo.upsertIdentity(
          makeIdentity({ id: 'id-1', account_id: ACC_A, provider: 'google', provider_subject: 'g-1', email: 'a@x' }),
        );
        await repo.upsertIdentity(
          makeIdentity({ id: 'id-1', account_id: ACC_A, provider: 'google', provider_subject: 'g-1', email: 'b@x' }),
        );
        expect(await repo.listIdentitiesForAccount(ACC_A)).toHaveLength(1);
        expect((await repo.getIdentityByProviderSubject('google', 'g-1'))?.email).toBe('b@x');
      }),
    );

    it(
      'counts + lists saved sessions per account',
      withRepo(async (repo) => {
        await repo.createAccount(makeAccount({ id: ACC_A }));
        expect(await repo.countSavedSessions(ACC_A)).toBe(0);
        await repo.createSavedSession(makeSavedSession({ id: SESS_1, account_id: ACC_A, title: 'one' }));
        await repo.createSavedSession(makeSavedSession({ id: SESS_2, account_id: ACC_A, title: 'two' }));
        expect(await repo.countSavedSessions(ACC_A)).toBe(2);
        expect((await repo.listSavedSessions(ACC_A)).map((s) => s.title).sort()).toEqual(['one', 'two']);
      }),
    );

    it(
      'scopes reads to the owning account (team-09 T6 — no cross-account access)',
      withRepo(async (repo) => {
        await repo.createAccount(makeAccount({ id: ACC_A }));
        await repo.createAccount(makeAccount({ id: ACC_B }));
        await repo.createSavedSession(makeSavedSession({ id: SESS_1, account_id: ACC_A }));

        // A's resource is visible to A...
        expect((await repo.getSavedSession(ACC_A, SESS_1))?.id).toBe(SESS_1);
        // ...and structurally invisible to B (different account id on the same row).
        expect(await repo.getSavedSession(ACC_B, SESS_1)).toBeNull();
        expect(await repo.listSavedSessions(ACC_B)).toHaveLength(0);
        expect(await repo.countSavedSessions(ACC_B)).toBe(0);
        // B cannot delete A's resource.
        expect(await repo.deleteSavedSession(ACC_B, SESS_1)).toBe(false);
        expect(await repo.getSavedSession(ACC_A, SESS_1)).not.toBeNull();
      }),
    );

    it(
      'stores + scopes artifacts and cascades on delete',
      withRepo(async (repo) => {
        await repo.createAccount(makeAccount({ id: ACC_A }));
        await repo.createAccount(makeAccount({ id: ACC_B }));
        await repo.createSavedSession(makeSavedSession({ id: SESS_1, account_id: ACC_A }));
        const arts: StoredArtifact[] = [
          { id: 'a1', account_id: ACC_A, session_id: SESS_1, kind: 'transcript_segment', payload: { text: 'hi' }, created_at_us: 1 },
          { id: 'a2', account_id: ACC_A, session_id: SESS_1, kind: 'concept_card', payload: { name: 'ARR' }, created_at_us: 2 },
        ];
        await repo.addArtifacts(arts);
        expect(await repo.listArtifacts(ACC_A, SESS_1)).toHaveLength(2);
        // payload survives the round-trip (JSON column on SQLite, JSONB on Postgres).
        const round = (await repo.listArtifacts(ACC_A, SESS_1)).find((a) => a.id === 'a1');
        expect((round?.payload as { text: string }).text).toBe('hi');
        // B sees none of A's artifacts.
        expect(await repo.listArtifacts(ACC_B, SESS_1)).toHaveLength(0);

        // deleting the session cascades its artifacts.
        expect(await repo.deleteSavedSession(ACC_A, SESS_1)).toBe(true);
        expect(await repo.listArtifacts(ACC_A, SESS_1)).toHaveLength(0);
        expect(await repo.countSavedSessions(ACC_A)).toBe(0);
      }),
    );
  });
}
