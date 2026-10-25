/**
 * The invented public database the footage is recorded against: eight sites whose terms contain clauses worded like the ones in
 * the Pomme fixture, so "Find similar cases" has something to find, and the query site has something to show. Every site, company and
 * sentence is made up. The wording of each clause is a paraphrase of a Pomme clause on purpose.
 */
import { OTHER_INDEX, TOS_CATEGORIES, type ResultUpload, type UnfairCategory } from '@ppg/shared';

const probs = (category: UnfairCategory, mass: number) => TOS_CATEGORIES.map((c) => (c === category ? mass : c === 'other' ? 1 - mass - 0.02 : 0.02 / 7));

const BANK: Record<UnfairCategory, string[]> = {
  arbitration: [
    'Any dispute with {co} will be settled by final and binding individual arbitration, and you waive your right to go to court and to a jury trial.',
    'All disputes will be resolved by binding arbitration run by an arbitrator chosen by {co}, and you give up your right to a jury trial.',
  ],
  unilateral_termination: [
    '{co} may suspend or terminate your account or your access to any service at any time, for any reason or no reason, and without notice.',
    'We may close your account at any time, for any reason, and without notice to you, and we are not required to refund any payment.',
  ],
  limitation_of_liability: [
    'To the maximum extent permitted by law, {co} and its affiliates, suppliers and partners are not liable for any indirect, incidental, special, consequential or punitive damages, or for lost profits or lost data.',
  ],
  unilateral_change: [
    '{co} may change these terms, our fees and the features of any service at any time and at our sole discretion, with or without notice to you.',
  ],
  content_removal: ['We may remove or refuse to host any content at any time, for any reason, without telling you.'],
  jurisdiction: ['Any claim that is not subject to arbitration must be brought only in the courts located in the home city of {co}, and you agree to the exclusive jurisdiction of those courts.'],
  contract_by_using: ['By visiting the website or using any service, you accept these terms and every policy linked from them, whether or not you have read them.'],
  choice_of_law: ['These terms are governed by the laws of the place where {co} is based, and not by the laws of the place where you live.'],
};

const MONEY = {
  auto_renewal: 'Your subscription renews automatically at the end of each term, and your payment method will be charged again unless you cancel before the renewal date.',
  cancellation_fee: 'If you cancel during the first year, an early termination fee equal to half of the remaining term applies.',
  no_refund: 'All fees are non-refundable.',
} as const;

interface Site { domain: string; path: string; co: string; sentences: number; take: Partial<Record<UnfairCategory, number>>; money: (keyof typeof MONEY)[] }

const SITES: Site[] = [
  { domain: 'shopfront-demo.com', path: '/legal/terms', co: 'Shopfront', sentences: 240, take: { arbitration: 0, unilateral_termination: 0, limitation_of_liability: 0, unilateral_change: 0, jurisdiction: 0, content_removal: 0 }, money: ['no_refund'] },
  { domain: 'fastcloud-demo.net', path: '/tos', co: 'FastCloud', sentences: 180, take: { arbitration: 1, unilateral_termination: 1, limitation_of_liability: 0, unilateral_change: 0 }, money: ['auto_renewal', 'cancellation_fee'] },
  { domain: 'pixelpond-demo.org', path: '/terms-of-service', co: 'PixelPond', sentences: 150, take: { content_removal: 0, unilateral_termination: 0, contract_by_using: 0, arbitration: 0 }, money: [] },
  { domain: 'loopgames-demo.io', path: '/eula', co: 'Loop Games', sentences: 410, take: { arbitration: 1, limitation_of_liability: 0, unilateral_change: 0, jurisdiction: 0, choice_of_law: 0 }, money: ['auto_renewal', 'no_refund'] },
  { domain: 'streamly-demo.com', path: '/terms', co: 'Streamly', sentences: 120, take: { unilateral_change: 0, unilateral_termination: 1, contract_by_using: 0 }, money: ['auto_renewal', 'cancellation_fee', 'no_refund'] },
  { domain: 'bytebank-demo.com', path: '/terms-and-conditions', co: 'ByteBank', sentences: 300, take: { arbitration: 0, jurisdiction: 0, limitation_of_liability: 0, choice_of_law: 0 }, money: ['cancellation_fee'] },
  { domain: 'tinyfit-demo.app', path: '/terms', co: 'TinyFit', sentences: 90, take: { unilateral_change: 0, content_removal: 0 }, money: ['auto_renewal'] },
  { domain: 'quietmail-demo.com', path: '/terms', co: 'QuietMail', sentences: 80, take: {}, money: [] },
];

export function seedUploads(): ResultUpload[] {
  return SITES.map((site, k): ResultUpload => {
    const spacing = Math.floor(site.sentences / (Object.keys(site.take).length + site.money.length + 2));
    let at = spacing;
    const passages = Object.entries(site.take).map(([category, variant]) => {
      const text = BANK[category as UnfairCategory][variant ?? 0]!.replaceAll('{co}', site.co);
      const passage = { index: (at += spacing), text, category: category as UnfairCategory, probs: probs(category as UnfairCategory, 0.9 + ((k + at) % 9) / 100) };
      return passage;
    });
    const money = site.money.map((kind) => ({ index: (at += spacing), kind, text: MONEY[kind] }));
    return {
      url: `https://${site.domain}${site.path}`, domain: site.domain, textHash: (String(k + 1).repeat(64)).slice(0, 64),
      model: { id: 'ppg-fast-0.8b-q4f32', version: '2026-10-14' }, promptVersion: 'letters-v1', passageCount: site.sentences, passages, money,
    };
  });
}

export async function seed(serverUrl: string, token: string): Promise<number> {
  let n = 0;
  for (const upload of seedUploads()) {
    const response = await fetch(`${serverUrl}/api/results`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(upload) });
    if (!response.ok) throw new Error(`seeding ${upload.domain}: ${response.status} ${await response.text()}`);
    n += 1;
  }
  return n;
}
