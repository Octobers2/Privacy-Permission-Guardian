/**
 * Runs the results server (which also serves the query site) on a throwaway in-memory database filled with invented sites,
 * for looking at the pages without contributors or a model:
 *
 *   bun run demo
 *
 * The domains are made up (…-demo.com) so nothing here can be mistaken for a real finding about a real company.
 */
import { OTHER_INDEX, TOS_CATEGORIES, UNFAIR_CATEGORIES, type ResultUpload, type UnfairCategory } from '@ppg/shared';
import { AuthStore } from '../src/auth.ts';
import { createApp } from '../src/index.ts';
import { ResultStore } from '../src/store.ts';

const PORT = Number(Bun.env.PPG_DEMO_PORT ?? 8788);

const QUOTES: Record<UnfairCategory, string[]> = {
  limitation_of_liability: ['To the fullest extent permitted by law, the Company will not be liable for any indirect, incidental or consequential damages arising from your use of the Service.'],
  contract_by_using: ['By accessing or using the Service in any way, you agree to be bound by these Terms, whether or not you have read them.'],
  unilateral_change: ['We may modify these Terms at any time, and your continued use of the Service after a change means you accept the new Terms.'],
  arbitration: ['Any dispute will be resolved by binding arbitration on an individual basis, and you waive any right to a jury trial or to join a class action.'],
  content_removal: ['We may remove or edit any content you post, at any time and for any reason, without notice to you.'],
  choice_of_law: ['These Terms are governed by the laws of the State of Delaware, without regard to conflict of law principles.'],
  unilateral_termination: ['We may suspend or terminate your account at any time, with or without cause, and without liability to you.'],
  jurisdiction: ['You agree that any claim not subject to arbitration must be brought exclusively in the courts located in Wilmington, Delaware.'],
};

function probsFor(category: UnfairCategory, mass: number): number[] {
  const v = TOS_CATEGORIES.map(() => 0);
  v[TOS_CATEGORIES.indexOf(category)] = mass;
  v[OTHER_INDEX] = 1 - mass;
  return v;
}

/** Deterministic pseudo-random numbers, so the demo looks the same every run. */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function demoResult(domain: string, path: string, passageCount: number, flaggedCount: number, seed: number): ResultUpload {
  const rand = rng(seed);
  const indexes = new Set<number>();
  while (indexes.size < flaggedCount) indexes.add(Math.floor(rand() * passageCount));
  const passages = [...indexes].sort((a, b) => a - b).map((index) => {
    const category = UNFAIR_CATEGORIES[Math.floor(rand() * UNFAIR_CATEGORIES.length)]!;
    const options = QUOTES[category];
    return { index, text: options[Math.floor(rand() * options.length)]!.replace('the Company', domain.split('.')[0]!), category, probs: probsFor(category, 0.6 + rand() * 0.39) };
  });
  return {
    url: `https://${domain}${path}`, domain, textHash: Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join(''),
    model: { id: 'ppg-fast-0.8b-q4f32', version: '2026-10-14' }, promptVersion: 'letters-v1', passageCount, passages,
  };
}

const store = new ResultStore({ file: ':memory:' });
const SITES: [string, string, number, number][] = [
  ['acme-demo.com', '/terms', 168, 17], ['acme-demo.com', '/privacy', 210, 4], ['shopfront-demo.com', '/legal/terms', 340, 31], ['fastcloud-demo.net', '/tos', 96, 3],
  ['pixelpond-demo.org', '/terms-of-service', 120, 12], ['quietmail-demo.com', '/terms', 80, 0], ['loopgames-demo.io', '/eula', 412, 44],
];
SITES.forEach(([domain, path, total, flagged], i) => store.insert(demoResult(domain, path, total, flagged, i + 1), 'demo'));

const auth = new AuthStore({ users: new Map() });
const api = createApp({ config: { baseUrl: 'https://model.invalid/v1', apiKey: '', model: '', temperature: 0, maxTokens: 1, timeoutMs: 1000 }, store, auth, modelsDir: '/nonexistent' });
Bun.serve({ port: PORT, fetch: api.fetch });
console.log(`Demo: http://localhost:${PORT}  (site and API, ${SITES.length} invented documents)`);
