/**
 * One-off data migration: copy the Phase-0 SQLite account store into Azure
 * PostgreSQL. It reads the four SQLite tables
 * directly (via `node:sqlite`) and writes every row through `PgAccountRepository`
 * — the same code path the live app uses — so the destination schema and types are
 * guaranteed identical. Rows are copied parents-first
 * (accounts → identities → saved_sessions → artifacts) to satisfy ownership, and
 * every write is an idempotent upsert, so re-running the script is safe.
 *
 * Usage (PowerShell / bash):
 *   DATABASE_URL="postgresql://aizen_admin:<pwd>@<fqdn>:5432/aizen?sslmode=require" \
 *     pnpm --filter @aizen/accounts run migrate:pg [path/to/accounts.db]
 *
 *   • DATABASE_URL  — required; the Azure Postgres connection string.
 *   • argument 1    — optional SQLite path (default: <repoRoot>/.data/accounts.db).
 *
 * Because Azure Flexible Server is private by default, run this from inside the
 * VNet (a Container Apps job) or with public access briefly enabled + a firewall
 * rule for your IP.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { PgAccountRepository } from '../src/repository-postgres.js';
import type { Account, Identity, SavedSession, StoredArtifact } from '@aizen/contracts';

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function num(v: unknown): number {
  return Number(v ?? 0);
}
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required (the Azure Postgres connection string).');
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '../../..');
  const sqlitePath = resolve(process.argv[2] ?? resolve(repoRoot, '.data', 'accounts.db'));
  if (!existsSync(sqlitePath)) {
    throw new Error(`SQLite file not found: ${sqlitePath} (nothing to migrate).`);
  }

  // Open the source SQLite DB (read-only use) via the Node built-in.
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string) => SqliteDb };
  const db = new DatabaseSync(sqlitePath);

  // Open the destination Postgres (creates the schema if absent).
  const ssl = /[?&]sslmode=(require|verify-ca|verify-full)/i.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined;
  const pg = await PgAccountRepository.open({ connectionString, ...(ssl ? { ssl } : {}) });

  // eslint-disable-next-line no-console
  const log = (...a: unknown[]) => console.log('[migrate]', ...a);
  log(`source : ${sqlitePath}`);
  log(`target : ${connectionString.replace(/:[^:@/]+@/, ':****@')}`);

  try {
    // 1) accounts
    const accounts = db.prepare('SELECT * FROM accounts').all();
    for (const r of accounts) {
      const account: Account = {
        id: String(r.id),
        tier: String(r.tier) as Account['tier'],
        workspace_id: String(r.workspace_id),
        display_name: strOrNull(r.display_name),
        created_at_us: num(r.created_at_us),
        updated_at_us: num(r.updated_at_us),
      };
      await pg.createAccount(account);
    }
    log(`accounts: ${accounts.length}`);

    // 2) identities
    const identities = db.prepare('SELECT * FROM identities').all();
    for (const r of identities) {
      const identity: Identity = {
        id: String(r.id),
        account_id: String(r.account_id),
        provider: String(r.provider) as Identity['provider'],
        provider_subject: String(r.provider_subject),
        email: strOrNull(r.email),
        display_name: strOrNull(r.display_name),
        created_at_us: num(r.created_at_us),
      };
      await pg.upsertIdentity(identity);
    }
    log(`identities: ${identities.length}`);

    // 3) saved_sessions
    const sessions = db.prepare('SELECT * FROM saved_sessions').all();
    for (const r of sessions) {
      const session: SavedSession = {
        id: String(r.id),
        account_id: String(r.account_id),
        title: String(r.title),
        artifact_count: num(r.artifact_count),
        consent_class: String(r.consent_class) as SavedSession['consent_class'],
        pii_present: num(r.pii_present) !== 0, // SQLite 0/1 → boolean
        created_at_us: num(r.created_at_us),
        updated_at_us: num(r.updated_at_us),
        expires_at_us: numOrNull(r.expires_at_us),
      };
      await pg.createSavedSession(session);
    }
    log(`saved_sessions: ${sessions.length}`);

    // 4) artifacts (payload is a JSON string in SQLite → parse to a value)
    const artifactRows = db.prepare('SELECT * FROM artifacts').all();
    const artifacts: StoredArtifact[] = artifactRows.map((r) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(String(r.payload ?? 'null'));
      } catch {
        payload = null;
      }
      return {
        id: String(r.id),
        account_id: String(r.account_id),
        session_id: String(r.session_id),
        kind: String(r.kind) as StoredArtifact['kind'],
        payload,
        created_at_us: num(r.created_at_us),
      };
    });
    await pg.addArtifacts(artifacts);
    log(`artifacts: ${artifacts.length}`);

    log('done. Verify counts with: psql "<url>" -c "select count(*) from accounts;"');
  } finally {
    db.close();
    await pg.close();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[migrate] FAILED:', err);
  process.exitCode = 1;
});
