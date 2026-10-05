/**
 * The offline half of the form check.
 *
 * Everything here is a pure function over plain data: no DOM, no network, no
 * model. That is what lets the extension warn about a phishing form with the
 * API key unset and the machine offline, and it is what makes the numbers in
 * the evaluation reproducible.
 */
import { BRANDS, detectLookalike, type LookalikeMatch } from './lookalike.ts';
import { publicSuffixOf, registrableDomain } from './domain.ts';
import { COMMON_THIRD_PARTIES } from './third-party.ts';
import type { FaviconMatch } from './favicon.ts';
import type { PageSignals } from './page-signals.ts';
import type { FormField, FormObservation, PageContext, RuleHit, RuleResult, Verdict } from './schemas.ts';

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
  /**
   * Page-level findings from `scorePageSignals`, folded into this form's score.
   *
   * A form is scored by what it asks for; a page is scored by where it ships
   * data and what it is pretending to be. Merging them here rather than keeping
   * a second score means the existing thresholds, the allowlist and the
   * known-brand damper all keep applying to one number.
   */
  pageHits?: RuleHit[];
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
  const hits: RuleHit[] = [...(options.pageHits ?? [])];

  const registrable = registrableDomain(page.hostname);
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

  const tld = publicSuffixOf(page.hostname);
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

/* ------------------------------------------------------- page-level rules */

/**
 * Techniques that only exist to keep somebody out of DevTools.
 *
 * Blocking the context menu is not on this list. Photo galleries, news sites
 * and a good deal of the Chinese-language web do it, and a rule that fires on
 * all of them buys a phishing signal at the price of the extension's
 * credibility on every other page.
 */
const STRONG_DEVTOOLS_BLOCKS = new Set([
  'debugger_loop',
  'devtools_key_block',
  'devtools_detect_lib',
  'devtools_size_probe',
  'console_suppression',
]);

const DEVTOOLS_BLOCK_LABELS: Record<string, string> = {
  debugger_loop: '不斷觸發 debugger 令你開唔到開發者工具',
  devtools_key_block: '攔截 F12 / Ctrl+Shift+I / Ctrl+U',
  devtools_detect_lib: '載咗一個專門偵測開發者工具嘅程式庫',
  devtools_size_probe: '用視窗大小偵測你有冇打開開發者工具',
  console_suppression: '不斷清空 console',
};

const EXFIL_SINK_LABELS: Record<string, string> = {
  telegram_bot_api: 'Telegram bot API',
  telegram_bot_token: 'Telegram bot token',
  discord_webhook: 'Discord webhook',
  slack_webhook: 'Slack webhook',
  form_relay: '表單轉寄服務',
  request_bin: '一個用嚟收請求嘅測試 endpoint',
  paste_sink: '一個貼文服務',
};

const BRAND_NAMES = new Map(BRANDS.map((brand) => [brand.domain, brand.name]));

/**
 * The findings that mean "phishing" with nothing else to go on.
 *
 * Everything else on the page-level list needs a form to be about something:
 * a page that blocks DevTools is suspicious, but suspicious about what? These
 * three name a destination or an impersonation, which stands by itself.
 */
const STANDALONE_RULE_IDS = new Set(['telegram_bot_token', 'favicon_brand_mismatch', 'exfil_sink_endpoint']);

export interface PageScoreOptions {
  /** Registrable domains the user has silenced. */
  allowlist?: string[];
  /** Which brand the page's icon turned out to be, when the worker looked it up. */
  faviconMatch?: FaviconMatch | null;
  /** Whether any form on the page asks for a password, card details or an ID number. */
  hasSensitiveFields?: boolean;
}

/** Hosts the page reaches that are neither its own nor ordinary web infrastructure. */
function unrelatedHosts(signals: PageSignals, registrable: string): string[] {
  const seen = new Set([...signals.sendingHosts, ...signals.referencedHosts]);
  return [...seen].filter((host) => {
    const domain = registrableDomain(host);
    return domain !== registrable && !COMMON_THIRD_PARTIES.has(domain);
  });
}

/**
 * Scores what the page itself is doing, independently of any form on it.
 *
 * Returns hits rather than a verdict: they are folded into a form's score by
 * `scoreForm`, or stand on their own through `scoreStandalonePage` when the
 * page has no form the extractor can see — which is the case a kit collecting
 * credentials from loose `contenteditable` divs deliberately creates.
 */
export function scorePageSignals(
  signals: PageSignals,
  page: PageContext,
  options: PageScoreOptions = {},
): RuleHit[] {
  const hits: RuleHit[] = [];
  const registrable = registrableDomain(page.hostname);
  if (options.allowlist?.includes(registrable)) return [];

  /* ------------------------------------------------------ where data goes */

  const sinks = new Set(signals.exfilSinks);

  if (sinks.has('telegram_bot_token')) {
    hits.push({
      id: 'telegram_bot_token',
      points: 40,
      detail: '頁面入面有一個 Telegram bot token —— 即係話你打嘅嘢會直接送去某人個 Telegram',
    });
    // The token and the endpoint it is used against are one finding, not two.
    sinks.delete('telegram_bot_token');
    sinks.delete('telegram_bot_api');
  }

  if (sinks.size > 0) {
    const named = [...sinks].map((id) => EXFIL_SINK_LABELS[id] ?? id);
    hits.push({
      id: 'exfil_sink_endpoint',
      points: 35,
      detail: `呢一頁會將資料送去 ${named.join('、')}，唔係送返去網站自己`,
    });
  }

  if (options.hasSensitiveFields) {
    const unrelated = unrelatedHosts(signals, registrable);
    if (unrelated.length > 0) {
      const shown = unrelated.slice(0, 2).join('、');
      const rest = unrelated.length > 2 ? `等 ${unrelated.length} 個網域` : '';
      hits.push({
        id: 'sensitive_post_third_party',
        points: 20,
        detail: `呢一頁一邊要你嘅敏感資料，一邊同 ${shown}${rest} 通訊，而嗰啲唔係呢個網站自己`,
      });
    }
  }

  /* --------------------------------------------------- what the icon says */

  const match = options.faviconMatch;
  if (match && match.domain !== registrable) {
    const name = BRAND_NAMES.get(match.domain) ?? match.domain;
    hits.push({
      id: 'favicon_brand_mismatch',
      points: 35,
      detail: `網站圖示同 ${name}（${match.domain}）嘅一模一樣，但呢個網域唔係佢哋嘅`,
    });
  }

  const hotlinked = signals.iconUrls
    .map((url) => {
      try {
        return new URL(url).hostname;
      } catch {
        return '';
      }
    })
    .find((host) => host && registrableDomain(host) !== registrable);

  if (hotlinked) {
    hits.push({
      id: 'favicon_hotlinked',
      points: 15,
      detail: `網站個圖示係由 ${hotlinked} 攞嘅，唔係由呢個網站自己提供`,
    });
  }

  /* ------------------------------------------------------ fighting the reader */

  const strong = signals.devtoolsBlocks.filter((id) => STRONG_DEVTOOLS_BLOCKS.has(id));
  if (strong.length > 0) {
    const named = strong.map((id) => DEVTOOLS_BLOCK_LABELS[id] ?? id);
    hits.push({
      id: 'devtools_blocked',
      points: 25,
      detail: `呢一頁刻意阻止你檢查佢：${named.join('、')}。正經網站冇理由咁做`,
    });
  } else if (signals.devtoolsBlocks.includes('contextmenu_block')) {
    hits.push({
      id: 'right_click_blocked',
      points: 5,
      detail: '呢一頁封鎖咗右鍵或者選字',
    });
  }

  return hits;
}

/**
 * A verdict for a page with no form worth scoring.
 *
 * Kept separate from `scoreForm` because the bar is different: without a form,
 * the 60-point threshold would be reached by adding up findings that only mean
 * something together with one. Only `STANDALONE_RULE_IDS` can open this door,
 * and a single one of them is a `caution` unless it is the bot token, which
 * has no innocent reading at all.
 */
export function scoreStandalonePage(
  pageHits: RuleHit[],
  page: PageContext,
  options: Pick<PageScoreOptions, 'allowlist'> = {},
): RuleResult {
  if (options.allowlist?.includes(registrableDomain(page.hostname))) {
    return { score: 0, hits: [], verdict: 'safe' };
  }

  const eligible = pageHits.filter((hit) => STANDALONE_RULE_IDS.has(hit.id));
  if (eligible.length === 0) return { score: 0, hits: [], verdict: 'safe' };

  const score = Math.min(100, pageHits.reduce((total, hit) => total + hit.points, 0));
  const certain = eligible.some((hit) => hit.id === 'telegram_bot_token') || eligible.length >= 2;

  return { score, hits: pageHits, verdict: certain ? 'danger' : 'caution' };
}

/** Whether this form is worth spending a model call on. */
export function shouldEscalate(result: RuleResult, threshold: number): boolean {
  return result.score >= threshold;
}
