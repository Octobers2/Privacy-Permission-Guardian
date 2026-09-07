/**
 * Turns a DOM into the plain descriptors the rule engine works on.
 *
 * This lives in `shared` rather than in the content script for one reason: the
 * evaluation harness feeds it fixture HTML through linkedom, so the numbers in
 * the report come from the same code that runs in the browser. A second,
 * "close enough" extractor written for the harness would make every measurement
 * meaningless.
 *
 * Nothing here reads a field's value.
 */
import type { FormDescriptor, FormField, FormObservation, PageContext } from './schemas.ts';

/** Controls that carry user data, as opposed to buttons. */
const DATA_FIELD_SELECTOR = 'input, select, textarea';
const NON_DATA_INPUT_TYPES = new Set(['submit', 'button', 'reset', 'image']);

/** Drops the query string and fragment — they routinely carry tokens and ids. */
export function stripQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

function textOf(node: { textContent?: string | null } | null | undefined): string {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Finds the text a sighted user would read as this field's label.
 *
 * Tries the accessible-name sources in the order a screen reader would, then
 * falls back to the text immediately before the control, which is how a
 * surprising number of real forms are marked up.
 */
export function labelFor(el: Element, doc: Document): string {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => textOf(doc.getElementById(id)))
      .filter(Boolean);
    if (parts.length) return parts.join(' ');
  }

  const id = el.getAttribute('id');
  if (id) {
    // CSS.escape is not available in every DOM implementation we run under.
    for (const label of doc.querySelectorAll('label[for]')) {
      if (label.getAttribute('for') === id) {
        const text = textOf(label);
        if (text) return text;
      }
    }
  }

  const wrapping = el.closest('label');
  if (wrapping) {
    const text = textOf(wrapping);
    if (text) return text;
  }

  const previous = el.previousElementSibling;
  if (previous && !previous.matches(DATA_FIELD_SELECTOR)) {
    const text = textOf(previous);
    if (text && text.length <= 80) return text;
  }

  return '';
}

function describeField(el: Element, doc: Document): FormField {
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : tag;
  return {
    type,
    name: el.getAttribute('name') ?? '',
    id: el.getAttribute('id') ?? '',
    autocomplete: (el.getAttribute('autocomplete') ?? '').toLowerCase(),
    placeholder: el.getAttribute('placeholder') ?? '',
    label: labelFor(el, doc),
    required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
  };
}

function dataFields(root: Element, doc: Document): FormField[] {
  return [...root.querySelectorAll(DATA_FIELD_SELECTOR)]
    .filter((el) => {
      if (el.tagName.toLowerCase() !== 'input') return true;
      return !NON_DATA_INPUT_TYPES.has((el.getAttribute('type') ?? 'text').toLowerCase());
    })
    .map((el) => describeField(el, doc));
}

function submitTextOf(root: Element): string {
  const candidates = [
    ...root.querySelectorAll('button, input[type=submit], input[type=button], [role=button]'),
  ];
  for (const el of candidates) {
    const text = textOf(el) || el.getAttribute('value') || '';
    if (text.trim()) return text.trim().slice(0, 80);
  }
  return '';
}

/**
 * The origin a form posts to, or null when it posts back to the page's own
 * origin. Callers treat a non-null value as "this form sends data elsewhere".
 */
export function resolveActionOrigin(action: string | null, pageUrl: string): string | null {
  if (!action) return null;
  try {
    const target = new URL(action, pageUrl);
    if (!/^https?:$/.test(target.protocol)) return null;
    return target.origin === new URL(pageUrl).origin ? null : target.origin;
  } catch {
    return null;
  }
}

export function describePage(url: string, title: string): PageContext {
  let hostname = '';
  let isHttps = false;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
    isHttps = parsed.protocol === 'https:';
  } catch {
    /* leave the defaults; the rule engine treats an unparseable page as not https */
  }
  return { url: stripQuery(url), hostname, isHttps, title: title.trim().slice(0, 200) };
}

export function describeForm(form: Element, doc: Document, pageUrl: string): FormDescriptor {
  return {
    fields: dataFields(form, doc),
    actionOrigin: resolveActionOrigin(form.getAttribute('action'), pageUrl),
    method: (form.getAttribute('method') ?? 'get').toLowerCase(),
    submitText: submitTextOf(form),
  };
}

/**
 * Every form on the page, plus one synthetic descriptor for sensitive controls
 * that sit outside any `<form>` element.
 *
 * That last part is not an edge case: phishing kits routinely collect
 * credentials from loose inputs wired to a JavaScript handler, precisely
 * because naive scanners only look inside `<form>`.
 */
export function extractForms(doc: Document, pageUrl: string, title = ''): FormObservation[] {
  const page = describePage(pageUrl, title || doc.title || '');
  const observations: FormObservation[] = [];

  const forms = [...doc.querySelectorAll('form')];
  for (const form of forms) {
    const descriptor = describeForm(form, doc, pageUrl);
    if (descriptor.fields.length > 0) observations.push({ page, form: descriptor });
  }

  const loose = [...doc.querySelectorAll(DATA_FIELD_SELECTOR)]
    .filter((el) => !el.closest('form'))
    .filter((el) => {
      if (el.tagName.toLowerCase() !== 'input') return true;
      return !NON_DATA_INPUT_TYPES.has((el.getAttribute('type') ?? 'text').toLowerCase());
    });

  const hasPassword = loose.some((el) => el.getAttribute('type')?.toLowerCase() === 'password');
  if (loose.length >= 3 || (hasPassword && loose.length >= 2)) {
    observations.push({
      page,
      form: {
        fields: loose.map((el) => describeField(el, doc)),
        actionOrigin: null,
        method: '',
        submitText: submitTextOf(doc.body ?? doc.documentElement),
      },
    });
  }

  return observations;
}
