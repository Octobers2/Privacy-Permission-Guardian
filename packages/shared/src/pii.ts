/**
 * Personal-data detection: decides whether a page (or a single passage) shows personal data about an
 * individual, so the extension knows when NOT to upload results or ask a remote service for a summary.
 *
 * Two levels, because the questions differ:
 *  - `passageHasPii`  strict. Every passage that leaves the device goes through it (and the server runs it again).
 *  - `assessPage`     context-aware. Terms-of-service pages legitimately print company contact details
 *                     (support@, an office address, a hotline), so those must not make a policy page "personal".
 *
 * Findings carry counts only. The detected values are never stored, returned or logged.
 */

export type PiiKind =
  | 'email' // a mailbox at a consumer provider (gmail, outlook, qq …): a person's own address
  | 'contact_email' // any other address; on policy pages these are company role mailboxes
  | 'payment_card'
  | 'national_id'
  | 'iban'
  | 'dob'
  | 'phone'
  | 'address'
  | 'account_marker';

export interface PiiFinding {
  kind: PiiKind;
  count: number;
}

export interface PiiAssessment {
  personal: boolean;
  score: number;
  findings: PiiFinding[];
  /** Human-readable, value-free reasons ("2 personal email addresses"). */
  reasons: string[];
}

/** Strong signals identify a person on their own. */
const STRONG: ReadonlySet<PiiKind> = new Set(['email', 'payment_card', 'national_id', 'iban', 'dob']);
/** Contact details: a person's on a profile page, the company's on a policy page. Meaningful only with other cues. */
const CONTACT: ReadonlySet<PiiKind> = new Set(['contact_email', 'phone', 'address']);

// ---------------------------------------------------------------- checksums

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Hong Kong ID: one or two letters, six digits, a check digit (0-9 or A) in optional parentheses. */
export function hkidValid(raw: string): boolean {
  const m = /^([A-Z]{1,2})(\d{6})\(?([0-9A])\)?$/.exec(raw.toUpperCase());
  if (!m) return false;
  const [, letters, digits, check] = m;
  const code = (c: string) => c.charCodeAt(0) - 55; // A=10 … Z=35
  const first = letters!.length === 2 ? code(letters![0]!) : 36; // a single letter is preceded by a blank (36)
  const second = code(letters![letters!.length - 1]!);
  let sum = first * 9 + second * 8;
  for (let i = 0; i < 6; i++) sum += Number(digits![i]) * (7 - i);
  const expected = (11 - (sum % 11)) % 11;
  return (expected === 10 ? 'A' : String(expected)) === check;
}

/** Mainland China resident ID (18 characters, weighted mod-11 check). */
export function cnIdValid(raw: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(raw)) return false;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(raw[i]) * w[i]!;
  return '10X98765432'[sum % 11] === raw[17]!.toUpperCase();
}

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

// ---------------------------------------------------------------- detectors

const PLACEHOLDER_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;
/** Consumer mailbox providers. Labels that are also ordinary words (mail, web, free, orange, me) are left out on purpose. */
const CONSUMER_MAIL = new Set([
  'gmail', 'googlemail', 'yahoo', 'ymail', 'rocketmail', 'hotmail', 'outlook', 'live', 'msn', 'icloud', 'aol', 'proton',
  'protonmail', 'gmx', 'yandex', 'qq', '163', '126', 'sina', 'sohu', 'foxmail', 'naver', 'daum', 'zoho', 'fastmail',
  'tutanota', 'comcast', 'verizon', 'sbcglobal', 'btinternet', 't-online', 'libero', 'mail',
]);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** [mailbox at a consumer provider, any other non-placeholder address] */
function emails(text: string): [number, number] {
  let personal = 0;
  let contact = 0;
  for (const m of text.matchAll(EMAIL)) {
    const domain = m[0].toLowerCase().split('@')[1]!;
    if (PLACEHOLDER_DOMAIN.test(domain)) continue;
    const labels = domain.split('.');
    // the provider is the registrable label (gmail.com, yahoo.co.uk, mail.qq.com), never a lone "mail." subdomain of a company
    const label = labels.length > 2 && ['co', 'com', 'org', 'ne', 'or', 'ac'].includes(labels[labels.length - 2]!) ? labels[labels.length - 3]! : labels[labels.length - 2]!;
    if (CONSUMER_MAIL.has(label) && label !== 'mail') personal++;
    else if (label === 'mail' && labels.length === 2) personal++; // mail.com itself
    else contact++;
  }
  return [personal, contact];
}

function cards(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g)) {
    if (luhnValid(m[0].replace(/[ -]/g, ''))) n++;
  }
  return n;
}

function nationalIds(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/\b[A-Z]{1,2}\d{6}\(?[0-9A]\)?(?![\w])/g)) if (hkidValid(m[0])) n++;
  for (const m of text.matchAll(/\b\d{17}[\dXx]\b/g)) if (cnIdValid(m[0])) n++;
  for (const m of text.matchAll(/\b(\d{3})-(\d{2})-(\d{4})\b/g)) {
    const area = Number(m[1]);
    if (area !== 0 && area !== 666 && area < 900 && m[2] !== '00' && m[3] !== '0000') n++; // US SSN
  }
  return n;
}

function ibans(text: string): number {
  let n = 0;
  // Candidates are grouped runs of capitals/digits; trailing groups that belong to the next word are trimmed until the checksum holds.
  for (const m of text.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{1,4}){3,9}\b/g)) {
    const groups = m[0].split(' ');
    for (let k = groups.length; k >= 1; k--) {
      if (ibanValid(groups.slice(0, k).join(''))) {
        n++;
        break;
      }
    }
  }
  return n;
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const DOB = new RegExp(
  String.raw`\b(?:date of birth|d\.?o\.?b\.?|birth ?date|born(?: on)?)\b[\s:–-]*(?:\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}|${MONTH}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+${MONTH}\s+\d{4})`,
  'gi',
);

function phones(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/(?<![\w@./])\+?\d[\d\s().-]{6,17}\d(?![\w@])/g)) {
    const raw = m[0];
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue; // ISO date
    if (luhnValid(digits) && digits.length >= 13) continue; // a card, counted elsewhere
    // Bare digit runs are far more often ids/prices; require a + prefix or visible grouping.
    if (!raw.startsWith('+') && !/[\s().-]/.test(raw)) continue;
    n++;
  }
  return n;
}

const STREET =
  /\b\d{1,5}\s+(?:[A-Z][\w.'-]*\s+){1,4}(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\b\.?/g;
const FLAT = /\b(?:Flat|Room|Rm|Unit|Suite)\s+\w+[,\s].{0,80}?(?:Road|Street|Rd|St|Building|Tower|Court|Avenue|Lane)\b/gi;

function addresses(text: string): number {
  return (text.match(STREET)?.length ?? 0) + (text.match(FLAT)?.length ?? 0);
}

/**
 * Only phrases that belong to a signed-in person's own page. "your account" or "your order" are deliberately absent:
 * they appear in nearly every terms-of-service text.
 */
const MARKERS: RegExp[] = [
  /\b(?:signed|logged)[ -]in as\b/gi,
  /\b(?:[Ww]elcome back|[Hh]ello|[Hh]i),?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g,
  /\b(?:my (?:account|profile|orders?|wallet|payment methods?)|order history|saved addresses|billing details)\b/gi,
  /\b(?:account|customer|member(?:ship)?|policy|order|reference) (?:number|no\.?|id|#)\s*[:#]?\s*[A-Z0-9-]{4,}/gi,
];

function markers(text: string): number {
  return MARKERS.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
}

/** Paths that belong to a signed-in person's own area. */
const ACCOUNT_PATH = /(^|\/)(account|accounts|profile|settings|orders?|order-history|billing|payments?|wallet|inbox|messages|dashboard|portal|statements?|my|me|member|checkout)(\/|$|[-_.])/i;
const POLICY_PATH = /(terms|tos|privacy|legal|policy|policies|conditions|cookie|eula|agreement|user-agreement)/i;

export function urlSignals(url: string): { account: boolean; policy: boolean } {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    // not a URL: no signal
  }
  return { account: ACCOUNT_PATH.test(path), policy: POLICY_PATH.test(path) };
}

// ---------------------------------------------------------------- public API

export function detectPii(text: string): PiiFinding[] {
  const [personalMail, contactMail] = emails(text);
  const counts: Record<PiiKind, number> = {
    email: personalMail,
    contact_email: contactMail,
    payment_card: cards(text),
    national_id: nationalIds(text),
    iban: ibans(text),
    dob: text.match(DOB)?.length ?? 0,
    phone: phones(text),
    address: addresses(text),
    account_marker: markers(text),
  };
  return (Object.keys(counts) as PiiKind[]).filter((k) => counts[k] > 0).map((kind) => ({ kind, count: counts[kind] }));
}

/**
 * Strict check for text that is about to leave the device. Policy text legitimately names company mailboxes,
 * hotlines and offices, so those pass. A personal mailbox, card, national id, IBAN or date of birth blocks the passage.
 */
export function passageHasPii(text: string): boolean {
  return detectPii(text).some((f) => STRONG.has(f.kind));
}

const LABEL: Record<PiiKind, string> = {
  email: 'personal email address',
  contact_email: 'email address',
  payment_card: 'payment card number',
  national_id: 'national ID number',
  iban: 'bank account (IBAN)',
  dob: 'date of birth',
  phone: 'phone number',
  address: 'street address',
  account_marker: 'signed-in account marker',
};

export interface PageInput {
  url: string;
  /** Visible text of the main content, not of the navigation chrome. */
  text: string;
}

/**
 * Is this page about a person (their account, orders, profile …) rather than a public document?
 *  - Strong evidence (personal mailbox, card, national id, IBAN, date of birth) is enough on its own.
 *  - Contact details (company email, phone, address) and personal-page cues ("signed in as", "my account",
 *    an /account URL) are each one hint, and two hints make the page personal.
 *  - Policy pages print contact blocks as a matter of course, so on a policy-like URL the contact details are ignored.
 */
export function assessPage({ url, text }: PageInput): PiiAssessment {
  const findings = detectPii(text);
  const signals = urlSignals(url);
  const reasons = findings.map((f) => `${f.count} ${LABEL[f.kind]}${f.count > 1 ? 's' : ''}`);
  const strong = findings.filter((f) => STRONG.has(f.kind)).length;
  const contact = findings.some((f) => CONTACT.has(f.kind));
  const cues = (findings.some((f) => f.kind === 'account_marker') ? 1 : 0) + (signals.account ? 1 : 0);
  if (signals.account) reasons.push('account-like page address');
  const hints = cues + (contact && !(signals.policy && !signals.account) ? 1 : 0);
  return { personal: strong >= 1 || hints >= 2, score: strong * 2 + hints, findings, reasons };
}
