import { describe, it, expect } from 'vitest';
import { AccountService } from './service.js';
import { InMemoryAccountRepository } from './repository.js';
import { QuotaExceededError } from './quota.js';
import type { ExternalIdentity } from './auth-provider.js';

/** A deterministic service: fixed clock + a counter-based id generator. */
function makeService(opts: { defaultTier?: 'free' | 'pro' | 'team' | 'enterprise' } = {}) {
  let n = 0;
  const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  return new AccountService({
    repo: new InMemoryAccountRepository(),
    genId: ids,
    nowMs: () => 1_700_000_000_000,
    ...(opts.defaultTier ? { defaultTier: opts.defaultTier } : {}),
  });
}

const ext = (over: Partial<ExternalIdentity> = {}): ExternalIdentity => ({
  provider: 'google',
  subject: 'g-sub-1',
  email: 'user@example.com',
  displayName: 'Real User',
  ...over,
});

describe('AccountService.upsertIdentity', () => {
  it('creates a Free account + identity on first sign-in', async () => {
    const svc = makeService();
    const { account, identity } = await svc.upsertIdentity(ext());
    expect(account.tier).toBe('free');
    expect(account.workspace_id).toBe(account.id); // Phase-0: own workspace
    expect(identity.account_id).toBe(account.id);
    expect(identity.provider).toBe('google');
  });

  it('reuses the same account on repeat sign-in and refreshes name/email', async () => {
    const svc = makeService();
    const first = await svc.upsertIdentity(ext());
    const again = await svc.upsertIdentity(ext({ displayName: 'Renamed', email: 'new@example.com' }));
    expect(again.account.id).toBe(first.account.id);
    expect(again.identity.display_name).toBe('Renamed');
    expect(again.identity.email).toBe('new@example.com');
    expect(await svc.getIdentitiesForAccount(first.account.id)).toHaveLength(1);
  });

  it('links a second provider as a distinct identity (same person, new IdP)', async () => {
    const svc = makeService();
    const g = await svc.upsertIdentity(ext({ provider: 'google', subject: 'g-1' }));
    const m = await svc.upsertIdentity(ext({ provider: 'microsoft', subject: 'm-1' }));
    // distinct subjects → distinct accounts in Phase 0 (account-linking UI is out of scope).
    expect(m.account.id).not.toBe(g.account.id);
  });
});

describe('AccountService quota enforcement (New_Feature.md §5)', () => {
  it('allows saves under the cap and reports usage', async () => {
    const svc = makeService();
    const { account } = await svc.upsertIdentity(ext());
    for (let i = 0; i < 5; i++) {
      await svc.saveResource(account.id, {
        sessionId: `5f5f5f5f-0000-4000-8000-00000000000${i}`,
        title: `session ${i}`,
        consentClass: 'standard',
        piiPresent: false,
      });
    }
    const status = await svc.quotaStatus(account.id);
    expect(status).toMatchObject({ tier: 'free', used: 5, limit: 5, exceeded: true });
  });

  it('rejects the 6th save on Free with a typed QuotaExceededError (hard reject)', async () => {
    const svc = makeService();
    const { account } = await svc.upsertIdentity(ext());
    for (let i = 0; i < 5; i++) {
      await svc.saveResource(account.id, {
        sessionId: `5f5f5f5f-0000-4000-8000-00000000000${i}`,
        title: `s${i}`,
        consentClass: 'standard',
        piiPresent: false,
      });
    }
    let thrown: unknown;
    try {
      await svc.saveResource(account.id, {
        sessionId: '5f5f5f5f-0000-4000-8000-000000000099',
        title: 'over',
        consentClass: 'standard',
        piiPresent: false,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(QuotaExceededError);
    expect((thrown as QuotaExceededError).body).toMatchObject({ error: 'quota_exceeded', tier: 'free', used: 5, limit: 5 });
    // The rejected resource was NOT persisted (count stays at the cap).
    expect((await svc.quotaStatus(account.id)).used).toBe(5);
  });

  it('re-saving an already-saved session updates it without consuming quota', async () => {
    const svc = makeService();
    const { account } = await svc.upsertIdentity(ext());
    const sid = '5f5f5f5f-0000-4000-8000-0000000000aa';
    await svc.saveResource(account.id, { sessionId: sid, title: 'v1', consentClass: 'standard', piiPresent: false });
    await svc.saveResource(account.id, { sessionId: sid, title: 'v2', consentClass: 'standard', piiPresent: false });
    expect((await svc.quotaStatus(account.id)).used).toBe(1);
    expect((await svc.getResource(account.id, sid))?.title).toBe('v2');
  });

  it('deleting a resource frees a slot under the cap', async () => {
    const svc = makeService();
    const { account } = await svc.upsertIdentity(ext());
    const sid = '5f5f5f5f-0000-4000-8000-0000000000bb';
    await svc.saveResource(account.id, { sessionId: sid, title: 'x', consentClass: 'standard', piiPresent: false });
    expect(await svc.deleteResource(account.id, sid)).toBe(true);
    expect((await svc.quotaStatus(account.id)).used).toBe(0);
  });

  it('Pro accounts carry the 200 cap + a retention deadline on saves', async () => {
    const svc = makeService({ defaultTier: 'pro' });
    const { account } = await svc.upsertIdentity(ext());
    const saved = await svc.saveResource(account.id, {
      sessionId: '5f5f5f5f-0000-4000-8000-0000000000cc',
      title: 'pro session',
      consentClass: 'standard',
      piiPresent: false,
    });
    expect(await svc.quotaStatus(account.id)).toMatchObject({ tier: 'pro', limit: 200, exceeded: false });
    expect(saved.expires_at_us).not.toBeNull(); // retention window applied
  });

  it('carries consent forward onto the saved resource (account never bypasses team-09)', async () => {
    const svc = makeService();
    const { account } = await svc.upsertIdentity(ext());
    const saved = await svc.saveResource(account.id, {
      sessionId: '5f5f5f5f-0000-4000-8000-0000000000dd',
      title: 'sensitive',
      consentClass: 'sensitive',
      piiPresent: true,
      artifacts: [{ kind: 'transcript_segment', payload: { text: 'phi' } }],
    });
    expect(saved.consent_class).toBe('sensitive');
    expect(saved.pii_present).toBe(true);
    expect(saved.artifact_count).toBe(1);
    expect(await svc.listArtifacts(account.id, saved.id)).toHaveLength(1);
  });
});

describe('AccountService cross-account isolation (team-09 T6)', () => {
  it('one account cannot read, list, or delete another account’s resource', async () => {
    const svc = makeService();
    const a = (await svc.upsertIdentity(ext({ provider: 'google', subject: 'a' }))).account;
    const b = (await svc.upsertIdentity(ext({ provider: 'google', subject: 'b' }))).account;
    const sid = '5f5f5f5f-0000-4000-8000-0000000000ee';
    await svc.saveResource(a.id, { sessionId: sid, title: 'A only', consentClass: 'standard', piiPresent: false });

    expect(await svc.getResource(b.id, sid)).toBeNull();
    expect(await svc.listResources(b.id)).toHaveLength(0);
    expect(await svc.deleteResource(b.id, sid)).toBe(false);
    // A still owns it.
    expect((await svc.getResource(a.id, sid))?.title).toBe('A only');
  });
});
