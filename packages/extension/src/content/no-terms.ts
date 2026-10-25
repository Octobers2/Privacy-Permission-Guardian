/**
 * Pages that ask for your details but publish no terms of service or privacy policy.
 *
 * Cheap on purpose (this runs on pages with a form, on every site): a form with a password or a payment/ID field, and not one link
 * on the page that reads like terms, a legal notice or a privacy policy. The page being a terms or privacy page itself, a host with
 * no dot (an intranet, localhost) and an address that is only digits are not worth a warning.
 */
import type { FormObservation } from '@ppg/shared/schemas';
import { hasPolicyLink, looksLikePolicyPage, PRIVACY_PATTERN } from './policy-scout.ts';

const SENSITIVE_FIELD = /cc-|card.?num|cvv|cvc|iban|ssn|passport|national.?id|身份證|信用卡|銀行/i;

export function asksForDetails(observations: FormObservation[]): boolean {
  return observations.some((o) =>
    o.form.fields.some((f) => f.type === 'password' || SENSITIVE_FIELD.test(`${f.name} ${f.id} ${f.autocomplete} ${f.placeholder} ${f.label}`)),
  );
}

export function publishesNoTerms(observations: FormObservation[], doc: Document = document, pageUrl: string = location.href): boolean {
  if (!asksForDetails(observations)) return false;
  let host = '';
  let path = '';
  try {
    const url = new URL(pageUrl);
    if (!/^https?:$/.test(url.protocol)) return false;
    host = url.hostname;
    path = url.pathname;
  } catch {
    return false;
  }
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) return false;
  if (looksLikePolicyPage(doc, pageUrl) || PRIVACY_PATTERN.test(path) || PRIVACY_PATTERN.test(doc.title ?? '')) return false;
  return !hasPolicyLink(doc, pageUrl);
}
