/**
 * Standalone smoke for the audio/transcription-pipeline meta filter on live-intel
 * insights (run: `tsx --jitless` from the repo root). The extractor keeps raising
 * "risks" about the audio/recording itself instead of the conversation; this asserts:
 *   1. isAudioMetaInsight() flags those pipeline-meta phrasings and spares genuine
 *      insights (including ones that merely mention "audio"),
 *   2. end-to-end, an audio "risk" the model returns is NOT published while a real
 *      action item in the SAME reply IS.
 * Exits non-zero on the first failed assertion.
 */
import { InMemorySessionBus } from '@aizen/edge-gateway';
// Relative import: a package is not a dependency of itself (tsx maps .js→.ts).
import { runLiveIntel, isAudioMetaInsight } from '../src/live-intel.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';

let failures = 0;
function check(label: string, cond: boolean): void {
  // eslint-disable-next-line no-console
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
}

// --- Part 1: the predicate in isolation -----------------------------------
const META = [
  'Audio quality is poor, risking miscommunication',
  'Background noise may affect transcription accuracy',
  'Risk of mistranscription due to unclear audio',
  'The speaker is hard to hear',
  'Possible mishearing of the figures cited',
  'Microphone levels are low',
  'Transcription accuracy may be impacted',
  'Audio is cutting out intermittently',
  'Parts of the call were inaudible',
  'Speech recognition may be unreliable here',
];
const LEGIT = [
  'Evaluate pgvector for the store',
  'Decide on the Q3 launch date',
  'Who owns the migration plan?',
  'Risk: the vendor contract lapses next month',
  'Audio latency in the product spikes under load', // mentions "audio" but is real content
  'Improve onboarding conversion by 10%',
];
for (const t of META) check(`flags meta: "${t}"`, isAudioMetaInsight(t) === true);
for (const t of LEGIT) check(`spares legit: "${t}"`, isAudioMetaInsight(t) === false);

// --- Part 2: end-to-end through runLiveIntel ------------------------------
const AUDIO_RISK = 'Background noise may be causing mistranscription of the figures';
const REAL_ITEM = 'Evaluate pgvector for the store';
const EXTRACT_JSON = JSON.stringify({
  concepts: [
    { surface_form: 'RAG', canonical_name: 'Retrieval-Augmented Generation', kind: 'acronym', definition_short: 'Retrieval plus generation.', salience: 0.8, segment_id: 0 },
  ],
  insights: [
    { type: 'risk', text: AUDIO_RISK, owner: null, evidence_segment_ids: [0] },
    { type: 'action_item', text: REAL_ITEM, owner: 'Alice', evidence_segment_ids: [1] },
  ],
  edges: [],
});
const SUMMARY_JSON = JSON.stringify({ paragraph: 'Recap.', bullets: ['a'] });

const fakeGateway = {
  invoke: async (task: { kind: string }) => ({
    ok: true as const,
    tier: 'haiku' as const,
    text: task.kind === 'summarize' ? SUMMARY_JSON : EXTRACT_JSON,
    usage: { inputTokens: 100, outputTokens: 50 },
    costUsd: 0,
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const bus = new InMemorySessionBus();
const insights: any[] = [];
const worker = runLiveIntel(SESSION, bus, fakeGateway, {
  tenantId: TENANT,
  consent: { consent_class: 'standard', pii_present: false },
  minNewFinals: 2,
  minIntervalMs: 0,
  idleMs: 50,
  summaryEveryN: 99,
  summaryIntervalMs: 999999,
});
bus.subscribe(SESSION, 0, (env: any) => {
  if (env && env.message_type === 'insight_item') insights.push(env.insight);
});

function feed(text: string, who: string): void {
  const seq = bus.nextSeq(SESSION, 'f01');
  bus.publish(SESSION, {
    schema_version: '1.0.0',
    tenant_id: TENANT,
    session_id: SESSION,
    seq,
    producer_id: 'smoke',
    emitted_at: 0,
    segment_id: `seg_${seq}`,
    text,
    is_final: true,
    speaker: { display_name: who },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  feed('Let us talk about RAG and grounding answers.', 'Alice');
  feed('We will need a vector database for embeddings.', 'Bob');
  await worker.drain();
  await sleep(10);
  await worker.drain();

  const texts = insights.map((i) => i.text);
  check('a real insight WAS published', texts.includes(REAL_ITEM));
  check('the audio-meta "risk" was NOT published', !texts.includes(AUDIO_RISK));
  check('no published insight is audio-meta', insights.every((i) => !isAudioMetaInsight(i.text)));

  worker.stop();
  await worker.drain();

  // eslint-disable-next-line no-console
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
