/**
 * The parts of the site that need neither a browser nor the API: labels, counting, formatting, and reading what a person typed.
 * Kept apart so tests can load them directly.
 */

/* ---------------------------------------------------------------- labels (mirrors packages/shared/src/labels.ts, checked by a test) */

export const TOS_CATEGORIES = [
  'limitation_of_liability', 'contract_by_using', 'unilateral_change', 'arbitration', 'content_removal',
  'choice_of_law', 'other', 'unilateral_termination', 'jurisdiction',
];

export const CATEGORY_LABELS = {
  limitation_of_liability: 'Limitation of liability',
  contract_by_using: 'Contract by using',
  unilateral_change: 'Unilateral change',
  arbitration: 'Mandatory arbitration',
  content_removal: 'Content removal',
  choice_of_law: 'Choice of law',
  other: 'Other',
  unilateral_termination: 'Unilateral termination',
  jurisdiction: 'Jurisdiction',
};

export const CATEGORY_HINTS = {
  limitation_of_liability: 'The provider limits or excludes what it owes you if something goes wrong.',
  contract_by_using: 'Using the service counts as agreeing to the terms, even if you never saw them.',
  unilateral_change: 'The provider can change the terms or the service without your agreement.',
  arbitration: 'Disputes go to private arbitration instead of a court, often without class actions.',
  content_removal: 'The provider can remove or edit what you posted, at its own discretion.',
  choice_of_law: 'Disputes are decided under the law of a place chosen by the provider.',
  unilateral_termination: 'The provider can suspend or close your account at its own discretion.',
  jurisdiction: 'Disputes must be brought in a court chosen by the provider.',
};

export const FAMILIES = ['rights', 'liability', 'control', 'consent'];
export const FAMILY_OF = {
  arbitration: 'rights', jurisdiction: 'rights', choice_of_law: 'rights',
  limitation_of_liability: 'liability',
  unilateral_change: 'control', unilateral_termination: 'control', content_removal: 'control',
  contract_by_using: 'consent',
};
export const FAMILY_LABELS = { rights: 'Your rights', liability: 'Liability', control: 'Their control', consent: 'Consent' };
export const FAMILY_HINTS = {
  rights: 'Where and how you can take a dispute, and which law applies.',
  liability: 'What the provider will not answer for.',
  control: 'What the provider can change or end without your say.',
  consent: 'How you are taken to have agreed.',
};

/** { category: n } -> [{ family, n }] for the families that occur, in the fixed family order. */
export function familyCounts(categories) {
  const totals = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
  for (const [category, n] of Object.entries(categories ?? {})) if (FAMILY_OF[category]) totals[FAMILY_OF[category]] += n;
  return FAMILIES.map((family) => ({ family, n: totals[family] })).filter((x) => x.n > 0);
}

/* ---------------------------------------------------------------- formatting */

const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export const formatDate = (iso) => dateFormat.format(new Date(iso));

export function timeAgo(iso, now = Date.now()) {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return 'just now';
  const units = [[60, 'minute'], [3600, 'hour'], [86400, 'day']];
  let out = 'just now';
  for (const [size, name] of units) if (seconds >= size) {
    const n = Math.floor(seconds / size);
    out = `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return out;
}

export const plural = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const percent = (share) => (share >= 0.1 ? `${Math.round(share * 100)}%` : `${(share * 100).toFixed(1)}%`);

/** The path part of a policy URL, which is what tells two documents of the same site apart. */
export function policyLabel(url) {
  try {
    const { pathname } = new URL(url);
    return pathname === '/' ? '/' : pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}

/**
 * What a person types into the search box -> the host names worth trying, most specific first.
 * "https://www.Docs.Example.co.uk/terms?x=1" -> docs.example.co.uk, example.co.uk, the bare public suffix co.uk is not tried.
 */
export function domainCandidates(input) {
  let text = String(input ?? '').trim().toLowerCase();
  if (!text) return [];
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9.-]{1,253}$/.test(text) || !text.includes('.')) return [];
  const labels = text.split('.').filter(Boolean);
  const out = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    const tail = labels.slice(i);
    // "co.uk", "com.au": a two-label tail that looks like a public suffix is not a site, so it is not looked up.
    if (labels.length > 2 && tail.length === 2 && tail[0].length <= 3 && tail[1].length === 2) continue;
    out.push(tail.join('.'));
  }
  return out;
}

