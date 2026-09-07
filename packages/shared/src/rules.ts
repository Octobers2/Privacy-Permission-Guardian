/**
 * The offline half of the form check.
 *
 * Everything here is a pure function over plain data: no DOM, no network, no
 * model. That is what lets the extension warn about a phishing form with the
 * API key unset and the machine offline, and it is what makes the numbers in
 * the evaluation reproducible.
 */
import { detectLookalike, type LookalikeMatch } from './lookalike.ts';
import { parse as parseDomain } from 'tldts';
import type { FormField, FormObservation, RuleHit, RuleResult, Verdict } from './schemas.ts';
import { BRANDS } from './lookalike.ts';

/* ------------------------------------------------------ field classification */

export const FIELD_CATEGORIES = [
  'password',
  'credit_card',
  'card_cvv',
  'card_expiry',
  'national_id',
  'bank_account',
  'dob',
  'full_name',
  'address',
  'phone',
  'email',
  'other',
] as const;
export type FieldCategory = (typeof FIELD_CATEGORIES)[number];

/** Categories that represent personal data, for the "how much is this form asking?" count. */
const PERSONAL_CATEGORIES = new Set<FieldCategory>([
  'credit_card', 'card_cvv', 'card_expiry', 'national_id', 'bank_account',
  'dob', 'full_name', 'address', 'phone', 'email',
]);

/**
 * Ordered most specific first: a field labelled "card security code" has to
 * land in `card_cvv`, not `credit_card`.
 *
 * Patterns cover English and Traditional Chinese because the sites this is
 * aimed at are bilingual.
 */
const FIELD_PATTERNS: [FieldCategory, RegExp][] = [
  ['card_cvv', /\bcvv\b|\bcvc\b|\bcsc\b|security.?code|card.?code|安全碼|信用卡驗證/],
  ['card_expiry', /cc-exp|exp.?(date|month|year|iry)|valid.?thru|有效期|到期日/],
  ['credit_card', /cc-number|card.?(number|num|no)\b|creditcard|信用卡|卡號|卡片號碼/],
  [
    'national_id',
    /hkid|身份證|身分證|identity.?card|\bid.?(card|number|no)\b|national.?id|\bssn\b|social.?security|passport|護照|\bnric\b|aadhaar/,
  ],
  [
    'bank_account',
    /\biban\b|\bswift\b|routing.?(number|no)|sort.?code|bank.?acc|account.?(number|no)\b|銀行帳|銀行戶口|戶口號碼|帳戶號碼/,
  ],
  ['dob', /\bbday\b|birth.?date|date.?of.?birth|\bdob\b|出生日期|生日/],
  ['address', /street.?address|address.?line|postal.?code|\bzip\b|\baddress\b|地址|郵遞區號|郵編/],
  ['full_name', /given.?name|family.?name|full.?name|first.?name|last.?name|\bsurname\b|姓名|名字|\bname\b/],
  ['phone', /\btel\b|phone|mobile|電話|手機|流動電話/],
  ['email', /e-?mail|電郵|郵箱|電子郵件/],
];

/**
 * Buckets a field by what it is asking for.
 *
 * Reads `type`, `name`, `id`, `autocomplete`, `placeholder` and the visible
 * label — never the value.
 */
export function classifyField(field: FormField): FieldCategory {
  if (field.type === 'password') return 'password';

  const haystack = [
    field.type, field.name, field.id, field.autocomplete, field.placeholder, field.label,
  ]
    .join(' ')
    .toLowerCase();

  for (const [category, pattern] of FIELD_PATTERNS) {
    if (pattern.test(haystack)) return category;
  }

  if (field.type === 'tel') return 'phone';
  if (field.type === 'email') return 'email';
  return 'other';
}

/* ------------------------------------------------------------------ rules */

/** Registries with effectively no vetting, heavily over-represented in phishing. */
const SUSPICIOUS_TLDS = new Set([
  'top', 'xyz', 'tk', 'cf', 'gq', 'ml', 'ga', 'buzz', 'click', 'link', 'work',
  'rest', 'cyou', 'icu', 'sbs', 'lol', 'quest', 'monster', 'shop', 'live',
]);

const BRAND_DOMAINS = new Set(BRANDS.map((b) => b.domain));

export interface ScoreOptions {
  /** Registrable domains the user has silenced. */
  allowlist?: string[];
  /** Score at or above which a form is escalated to the model. */
  llmThreshold?: number;
}

function lookalikeDetail(match: LookalikeMatch): string {
  switch (match.kind) {
    case 'homoglyph':
      return `網域「${match.matched}」睇落似 ${match.brand.name}（${match.brand.domain}），但唔係同一個網站`;
    case 'typo':
      return `網域「${match.matched}」同 ${match.brand.name}（${match.brand.domain}）只差 ${match.distance} 個字母`;
    case 'impersonation':
      return `網域用咗 ${match.brand.name} 個名，但實際註冊域唔屬於 ${match.brand.domain}`;
  }
}

/**
 * Scores one form.
 *
 * The weights are the tuning surface for the evaluation: they are deliberately
 * coarse round numbers so that a change in the confusion matrix can be traced
 * back to a specific rule rather than to a fitted constant.
 */
export function scoreForm(observation: FormObservation, options: ScoreOptions = {}): RuleResult {
  const { page, form } = observation;
  const hits: RuleHit[] = [];

  const registrable = parseDomain(page.hostname).domain ?? page.hostname;
  if (options.allowlist?.includes(registrable)) {
    return { score: 0, hits: [], verdict: 'safe' };
  }

  const categories = form.fields.map(classifyField);
  const has = (category: FieldCategory) => categories.includes(category);
  const personalCount = categories.filter((c) => PERSONAL_CATEGORIES.has(c)).length;

  const lookalike = detectLookalike(page.hostname);
  if (lookalike) {
    hits.push({ id: 'lookalike_domain', points: 35, detail: lookalikeDetail(lookalike) });
  }

  if (has('password') && !page.isHttps) {
    hits.push({
      id: 'password_over_http',
      points: 30,
      detail: '呢一頁要你打密碼，但連線冇加密（http），密碼會以明文傳送',
    });
  }

  if (has('credit_card') || has('card_cvv')) {
    hits.push({ id: 'credit_card_fields', points: 25, detail: '表單要求信用卡資料' });
  }

  if (has('national_id')) {
    hits.push({ id: 'national_id_field', points: 25, detail: '表單要求身份證明文件號碼' });
  }

  if (has('bank_account')) {
    hits.push({ id: 'bank_account_field', points: 25, detail: '表單要求銀行帳戶資料' });
  }

  if (form.actionOrigin) {
    hits.push({
      id: 'cross_origin_action',
      points: 20,
      detail: `表單會將資料送去另一個網域：${form.actionOrigin}`,
    });
  }

  if (has('full_name') && has('dob') && has('address')) {
    hits.push({
      id: 'identity_triplet',
      points: 15,
      detail: '姓名、出生日期同地址一齊收集，已經足夠冒充你嘅身份',
    });
  }

  if (personalCount > 8) {
    hits.push({
      id: 'many_personal_fields',
      points: 10,
      detail: `表單一次過要 ${personalCount} 項個人資料`,
    });
  }

  const tld = parseDomain(page.hostname).publicSuffix ?? '';
  if (SUSPICIOUS_TLDS.has(tld) && has('password')) {
    hits.push({
      id: 'suspicious_tld_login',
      points: 10,
      detail: `.${tld} 網域註冊幾乎冇審查，而呢一頁要你登入`,
    });
  }

  const score = Math.min(100, hits.reduce((total, hit) => total + hit.points, 0));

  // A legitimate bank or government form genuinely asks for an ID number, an
  // address and a date of birth, and would otherwise score straight into the
  // red. Being on its own registrable domain is strong evidence it is the real
  // thing, so cap the verdict at caution rather than suppressing the reasons —
  // the user still sees what is being collected.
  const isKnownBrandDomain = BRAND_DOMAINS.has(registrable);
  if (isKnownBrandDomain && score >= 60) {
    hits.push({
      id: 'known_brand_domain',
      points: 0,
      detail: '呢個係該機構嘅正式網域，所以只作提示，唔當可疑',
    });
  }

  let verdict: Verdict = score >= 60 ? 'danger' : score >= 30 ? 'caution' : 'safe';
  if (isKnownBrandDomain && verdict === 'danger') verdict = 'caution';

  return { score, hits, verdict };
}

/** Whether this form is worth spending a model call on. */
export function shouldEscalate(result: RuleResult, threshold: number): boolean {
  return result.score >= threshold;
}
