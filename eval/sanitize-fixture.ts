/**
 * Defuses a saved page before it goes into the repository.
 *
 *   bun run eval/sanitize-fixture.ts saved.html --host login.example.top --label phishing
 *   bun run eval/sanitize-fixture.ts --check eval/fixtures/phishing/*.html
 *
 * Raw phishing HTML in git is a working phishing page that everybody who clones
 * the repository now has a copy of, and that anybody can open by accident. It
 * also often carries whatever the person who saved it had autofilled.
 *
 * Defusing does not affect what the evaluation measures: the rule engine reads
 * field names, types, labels and the domain, and never executes anything.
 */
import { parseHTML } from 'linkedom';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface DefuseReport {
  scriptsRemoved: number;
  handlersRemoved: number;
  externalRefsNeutralised: number;
  formActionsRewritten: number;
  valuesStripped: number;
}

/** Input types whose `value` is a button caption rather than user data. */
const VALUE_IS_A_LABEL = new Set(['submit', 'button', 'reset', 'image']);

/**
 * A form target that can never resolve.
 *
 * `.invalid` is reserved by RFC 2606, so a submission goes nowhere. Rewriting a
 * cross-origin action to `#` instead — the obvious thing — would delete the
 * `cross_origin_action` signal from every collected phishing fixture and quietly
 * bias the evaluation against the detector.
 */
const SINK_ORIGIN = 'https://sink.invalid';

export interface DefuseOptions {
  /** The page's own host, so same-origin actions can be told from cross-origin ones. */
  host?: string;
}

export function defuse(html: string, options: DefuseOptions = {}): { html: string; report: DefuseReport } {
  const { document } = parseHTML(html);
  const report: DefuseReport = {
    scriptsRemoved: 0,
    handlersRemoved: 0,
    externalRefsNeutralised: 0,
    formActionsRewritten: 0,
    valuesStripped: 0,
  };

  for (const element of [...document.querySelectorAll('script, noscript, iframe, object, embed')]) {
    element.remove();
    report.scriptsRemoved++;
  }

  for (const element of [...document.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();

      // Inline handlers are the other half of "this page still works".
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name);
        report.handlersRemoved++;
        continue;
      }

      // Anything that would reach the network when the file is opened: the
      // attacker's infrastructure should not get a hit from our test runs.
      // The form action is handled below, where the cross-origin distinction
      // can be preserved.
      if (['src', 'srcset', 'href', 'poster', 'data', 'formaction'].includes(name)) {
        if (/^\s*(https?:)?\/\//i.test(attribute.value) && !isInert(attribute.value)) {
          element.setAttribute(attribute.name, '#');
          report.externalRefsNeutralised++;
        }
      }
    }

    if (element.tagName === 'FORM') {
      const action = element.getAttribute('action') ?? '';
      if (/^\s*(https?:)?\/\//i.test(action)) {
        let target: URL | null = null;
        try {
          target = new URL(action.startsWith('//') ? `https:${action}` : action);
        } catch {
          target = null;
        }
        const sameOrigin = target && options.host && target.hostname === options.host;
        // Same-origin becomes a relative path, cross-origin keeps its
        // cross-origin nature but points at a host that cannot resolve.
        element.setAttribute('action', sameOrigin ? target!.pathname : `${SINK_ORIGIN}/${target?.hostname ?? 'unknown'}`);
        report.formActionsRewritten++;
      }
    }

    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      const type = (element.getAttribute('type') ?? 'text').toLowerCase();
      if (!VALUE_IS_A_LABEL.has(type) && element.hasAttribute('value')) {
        element.removeAttribute('value');
        report.valuesStripped++;
      }
    }
  }

  return { html: `<!doctype html>\n${document.documentElement.outerHTML}\n`, report };
}

/** Hosts that cannot resolve, so a reference to them reaches nobody. */
const INERT_HOST = /^(?:https?:)?\/\/[^/]*\.(?:invalid|test|example|localhost)(?::\d+)?(?:\/|$)/i;

export function isInert(url: string): boolean {
  return INERT_HOST.test(url.trim());
}

/** Whether a file still contains anything a defused fixture must not. */
export function residualRisks(html: string): string[] {
  const problems: string[] = [];
  if (/<script[\s>]/i.test(html)) problems.push('contains a <script> element');
  if (/\son[a-z]+\s*=/i.test(html)) problems.push('contains an inline event handler');

  for (const [, url] of html.matchAll(/<form[^>]+action\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi)) {
    if (!isInert(url)) problems.push('a form still posts to a resolvable remote origin');
  }
  for (const [, url] of html.matchAll(/(?:src|href)\s*=\s*["']((?:https?:)?\/\/[^"']+)["']/gi)) {
    if (!isInert(url)) {
      problems.push('loads a resolvable remote resource');
      break;
    }
  }
  return [...new Set(problems)];
}

/* ------------------------------------------------------------------- cli */

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const checkMode = process.argv.includes('--check');
  const files = process.argv.slice(2).filter((argument) => argument.endsWith('.html'));

  if (files.length === 0) {
    console.error('usage: bun run eval/sanitize-fixture.ts <saved.html> --host <hostname> --label <legit|phishing>');
    console.error('       bun run eval/sanitize-fixture.ts --check <file.html>...');
    process.exit(2);
  }

  if (checkMode) {
    let failed = 0;
    for (const file of files) {
      const problems = residualRisks(readFileSync(file, 'utf8'));
      console.log(`  ${problems.length === 0 ? 'ok  ' : 'FAIL'} ${file}`);
      for (const problem of problems) console.log(`       ${problem}`);
      if (problems.length) failed++;
    }
    process.exit(failed === 0 ? 0 : 1);
  }

  const host = flag('host');
  const label = flag('label');
  if (!host || (label !== 'legit' && label !== 'phishing')) {
    console.error('--host and --label (legit|phishing) are required');
    process.exit(2);
  }

  const source = files[0]!;
  const { html, report } = defuse(readFileSync(source, 'utf8'), { host });

  const target = resolve(import.meta.dir, 'fixtures', label, `${host}.html`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);

  const relative = `${label}/${host}.html`;
  const url = `${flag('scheme') ?? 'https'}://${host}${flag('path') ?? '/'}`;
  const notes = (flag('notes') ?? '').replaceAll('"', "'");
  const row = `${relative},${url},${label},"${notes}",collected\n`;

  const labelsPath = resolve(import.meta.dir, 'labels.csv');
  if (existsSync(labelsPath) && !readFileSync(labelsPath, 'utf8').includes(relative)) {
    appendFileSync(labelsPath, row);
  }

  console.log(`wrote ${target}`);
  console.log(`  scripts removed        ${report.scriptsRemoved}`);
  console.log(`  event handlers removed ${report.handlersRemoved}`);
  console.log(`  remote refs cut        ${report.externalRefsNeutralised}`);
  console.log(`  form actions rewritten ${report.formActionsRewritten}`);
  console.log(`  values stripped        ${report.valuesStripped}`);
  console.log(`\nappended to labels.csv as a "collected" fixture. Check the notes column reads usefully.`);
}
