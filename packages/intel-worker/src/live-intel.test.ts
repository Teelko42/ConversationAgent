import { describe, it, expect } from 'vitest';
import {
  ConceptCardSchema,
  InsightItemSchema,
  KgDeltaSchema,
  SessionSummarySchema,
} from '@aizen/contracts';
import { LlmGateway, CostMeter, type LlmProvider, type CompletionRequest } from '@aizen/llm-gateway';
import { InMemorySessionBus, type Envelope } from '@aizen/edge-gateway';
import { runLiveIntel } from './live-intel.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';

const EXTRACT_JSON =
  '{"concepts":[' +
  '{"surface_form":"RAG","canonical_name":"Retrieval-Augmented Generation","kind":"acronym","definition_short":"Retrieval plus generation.","salience":0.8,"segment_id":0},' +
  '{"surface_form":"vector database","canonical_name":"Vector Database","kind":"concept","definition_short":"Stores embeddings.","salience":0.7,"segment_id":1}],' +
  '"insights":[{"type":"action_item","text":"Evaluate pgvector","owner":"Alice","evidence_segment_ids":[1]}],' +
  '"edges":[{"from":"Retrieval-Augmented Generation","to":"Vector Database","relation":"depends_on"}]}';
const SUMMARY_JSON = '{"paragraph":"They discussed RAG and vector databases.","bullets":["RAG basics","pgvector"]}';

/** Returns the extract JSON for the extract prompt, the summary JSON for the recap prompt. */
class ScriptedProvider implements LlmProvider {
  async complete(req: CompletionRequest) {
    const text = req.prompt.includes('Summarize this live conversation') ? SUMMARY_JSON : EXTRACT_JSON;
    return { text, usage: { inputTokens: 50, outputTokens: 50 } };
  }
}

const gateway = () =>
  new LlmGateway(new ScriptedProvider(), new CostMeter({ tenantCeilingUsd: 10, opusCallCap: 0 }));

function collect(bus: InMemorySessionBus) {
  const got: Record<string, any[]> = { concept_card: [], insight_item: [], kg_delta: [], session_summary: [] };
  bus.subscribe(SESSION, 0, (env: Envelope) => {
    const e = env as { message_type?: string };
    if (e.message_type && got[e.message_type]) got[e.message_type]!.push(env);
  });
  return got;
}

let f01 = 0;
function feed(bus: InMemorySessionBus, text: string, who: string) {
  const seq = bus.nextSeq(SESSION, 'f01');
  bus.publish(SESSION, {
    schema_version: '1.0.0',
    tenant_id: TENANT,
    session_id: SESSION,
    seq,
    producer_id: 'test',
    emitted_at: 0,
    segment_id: `seg_${seq}`,
    text,
    is_final: true,
    speaker: { display_name: who },
  } as unknown as Envelope);
}

const settle = (worker: { drain(): Promise<void> }) =>
  worker.drain().then(() => new Promise((r) => setTimeout(r, 10))).then(() => worker.drain());

describe('runLiveIntel (live intelligence worker)', () => {
  it('emits schema-valid concept cards, insights, a kg_delta, and a recap', async () => {
    f01 = 0;
    const bus = new InMemorySessionBus();
    const worker = runLiveIntel(SESSION, bus, gateway(), {
      tenantId: TENANT,
      consent: { consent_class: 'standard', pii_present: false },
      minNewFinals: 2,
      minIntervalMs: 0,
      idleMs: 30,
      summaryEveryN: 2,
      summaryIntervalMs: 1000,
    });
    const got = collect(bus);

    feed(bus, 'Let us talk about RAG and grounding answers.', 'Alice');
    feed(bus, 'We will need a vector database for embeddings.', 'Bob');
    await settle(worker);

    expect(got.concept_card.length).toBeGreaterThanOrEqual(2);
    expect(got.insight_item.length).toBeGreaterThanOrEqual(1);
    expect(got.kg_delta.length).toBeGreaterThanOrEqual(1);
    expect(got.session_summary.length).toBeGreaterThanOrEqual(1);

    // Every emitted artifact validates against its canonical contract.
    for (const e of got.concept_card) expect(() => ConceptCardSchema.parse(e.card)).not.toThrow();
    for (const e of got.insight_item) expect(() => InsightItemSchema.parse(e.insight)).not.toThrow();
    for (const e of got.kg_delta) expect(() => KgDeltaSchema.parse(e.delta)).not.toThrow();
    for (const e of got.session_summary) expect(() => SessionSummarySchema.parse(e.summary)).not.toThrow();

    const delta = got.kg_delta[0].delta;
    expect(delta.upsert_nodes).toHaveLength(2);
    expect(delta.upsert_edges).toHaveLength(1);
    expect(got.insight_item[0].insight.insight_type).toBe('action_item');

    worker.stop();
    await worker.drain();
  });

  it('de-dupes a repeated concept: same id, bumped revision, no duplicate node', async () => {
    f01 = 0;
    const bus = new InMemorySessionBus();
    const worker = runLiveIntel(SESSION, bus, gateway(), {
      tenantId: TENANT,
      consent: { consent_class: 'standard', pii_present: false },
      minNewFinals: 2,
      minIntervalMs: 0,
      idleMs: 30,
      summaryEveryN: 99,
      summaryIntervalMs: 99999,
    });
    const got = collect(bus);

    feed(bus, 'RAG is retrieval augmented generation.', 'Alice');
    feed(bus, 'And a vector database holds the embeddings.', 'Bob');
    await settle(worker);
    const deltasAfterFirst = got.kg_delta.length;

    feed(bus, 'Back to RAG and its retrieval step.', 'Alice');
    feed(bus, 'The vector database choice affects recall.', 'Bob');
    await settle(worker);

    const ragRevs = got.concept_card
      .filter((e) => e.card.canonical_name === 'Retrieval-Augmented Generation')
      .map((e) => e.card.revision);
    const ragIds = new Set(
      got.concept_card
        .filter((e) => e.card.canonical_name === 'Retrieval-Augmented Generation')
        .map((e) => e.card.id),
    );
    expect(ragRevs).toContain(1);
    expect(ragRevs).toContain(2);
    expect(ragIds.size).toBe(1); // same stable id across revisions
    // The second round only re-surfaced known concepts → no new nodes/edges → no new delta.
    expect(got.kg_delta.length).toBe(deltasAfterFirst);

    worker.stop();
    await worker.drain();
  });
});
