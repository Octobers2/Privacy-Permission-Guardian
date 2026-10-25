import { ApiError, MONEY_HINTS, MONEY_LABELS, CATEGORY_HINTS, CATEGORY_LABELS, FAMILIES, FAMILY_HINTS, FAMILY_LABELS, FAMILY_OF, TOS_CATEGORIES, api, documentStrip, errorNote, familyCounts, footer, formatDate, h, header, mount, plural, policyLabel, timeAgo } from './common.js';

document.getElementById('top').replaceChildren(header('search'));
document.getElementById('bottom').replaceChildren(footer());
const main = document.getElementById('main');

/** `/site/github.com` or, as a fallback, `/site?d=github.com`. */
function domainFromLocation() {
  const fromPath = decodeURIComponent(location.pathname.split('/')[2] ?? '');
  return (fromPath || new URLSearchParams(location.search).get('d') || '').trim().toLowerCase();
}

const headline = (n) => (n === 0 ? 'No clauses that look unfair' : n === 1 ? '1 clause that may work against you' : `${n} clauses that may work against you`);
const confidence = (passage) => Math.round(passage.probs[TOS_CATEGORIES.indexOf(passage.category)] * 100);

/* ------------------------------------------------------------------ one document */

function clauseCard(result, passage) {
  const family = FAMILY_OF[passage.category];
  return h('article', { class: `clause fam-${family}`, id: `clause-${result.id}-${passage.index}`, 'data-family': family },
    h('header', {},
      h('h4', {}, h('span', { class: 'swatch', 'aria-hidden': 'true' }), CATEGORY_LABELS[passage.category]),
      h('p', { class: 'where' }, `Sentence ${passage.index + 1} of ${result.passageCount.toLocaleString()} · ${confidence(passage)}% sure`)),
    h('blockquote', {}, passage.text),
    h('p', { class: 'hint' }, CATEGORY_HINTS[passage.category]));
}

function moneyCard(result, clause) {
  return h('article', { class: 'clause fam-money', id: `money-${result.id}-${clause.index}`, 'data-family': 'money' },
    h('header', {},
      h('h4', {}, h('span', { class: 'swatch', 'aria-hidden': 'true' }), MONEY_LABELS[clause.kind]),
      h('p', { class: 'where' }, `Sentence ${clause.index + 1} of ${result.passageCount.toLocaleString()} · found by a fixed pattern, not the model`)),
    h('blockquote', {}, clause.text),
    h('p', { class: 'hint' }, MONEY_HINTS[clause.kind]));
}

function renderDocument(result, options = {}) {
  const money = result.money ?? [];
  const box = h('article', { class: 'doc', 'aria-labelledby': `doc-${result.id}` });
  let family = null;
  const list = h('div', { class: 'clauses' });
  const more = h('button', { type: 'button', class: 'button tonal more', onclick: () => { expanded = true; paint(); } }, 'Show all');
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter clauses by what they do' });
  const heading = h('h3', { class: 'list-title' });

  let expanded = false;
  const FOLD = 6;
  const paint = () => {
    // classifier clauses and fee clauses in reading order, narrowed by the chosen family
    const shown = [
      ...(family === 'money' ? [] : result.passages.filter((p) => !family || FAMILY_OF[p.category] === family).map((p) => ({ index: p.index, card: () => clauseCard(result, p) }))),
      ...(family === null || family === 'money' ? money.map((m) => ({ index: m.index, card: () => moneyCard(result, m) })) : []),
    ].sort((a, b) => a.index - b.index);
    const visible = expanded ? shown : shown.slice(0, FOLD);
    heading.replaceChildren(family ? FAMILY_LABELS[family] : 'The clauses', ' ', h('span', { class: 'count' }, String(shown.length)));
    list.replaceChildren(...visible.map((r) => r.card()));
    more.hidden = expanded || shown.length <= FOLD;
    more.textContent = `Show all ${shown.length} clauses`;
    strip.querySelectorAll('.flagged').forEach((tick) => tick.classList.toggle('dim', family !== null && tick.dataset.family !== family));
    [...chips.children].forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.family === family)));
  };

  const jump = (index) => {
    family = null;
    expanded = true;
    paint();
    const target = document.getElementById(`clause-${result.id}-${index}`) ?? document.getElementById(`money-${result.id}-${index}`);
    target?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    target?.classList.add('picked');
    setTimeout(() => target?.classList.remove('picked'), 1800);
  };
  const strip = documentStrip({ total: result.passageCount, flagged: result.passages, money, height: 48, onpick: jump });

  for (const { family: f, n } of familyCounts(result.categories)) {
    chips.append(h('button', { type: 'button', class: `chip fam-${f}`, 'data-family': f, 'aria-pressed': 'false', title: FAMILY_HINTS[f], onclick: () => { family = family === f ? null : f; paint(); } },
      h('span', { class: 'swatch', 'aria-hidden': 'true' }), FAMILY_LABELS[f], h('span', { class: 'n' }, String(n))));
  }

  if (money.length) {
    chips.append(h('button', { type: 'button', class: 'chip fam-money', 'data-family': 'money', 'aria-pressed': 'false', title: FAMILY_HINTS.money, onclick: () => { family = family === 'money' ? null : 'money'; paint(); } },
      h('span', { class: 'swatch', 'aria-hidden': 'true' }), FAMILY_LABELS.money, h('span', { class: 'n' }, String(money.length))));
  }

  box.append(
    h('header', { class: 'doc-head' },
      h('div', {},
        h('p', { class: 'kicker' }, h('a', { href: /^https?:\/\//i.test(result.url) ? result.url : null, rel: 'noreferrer noopener', target: '_blank' }, policyLabel(result.url)), options.old ? h('span', { class: 'tag' }, 'Older version') : null),
        h('h2', { id: `doc-${result.id}` }, headline(result.unfairCount))),
      h('p', { class: 'meta' }, `among ${plural(result.passageCount, 'sentence')} · read ${timeAgo(result.createdAt)} · kept until ${formatDate(result.expiresAt)}`)),
    strip,
    result.passages.length || money.length ? chips : null,
    result.passages.length || money.length ? heading : h('p', { class: 'note good' }, 'Nothing in these terms matched the clause types this model looks for. That is not a guarantee, so skim the document if it matters.'),
    list,
    more,
    h('p', { class: 'fine' }, `Read by ${result.model.id} (${result.model.version}).`));
  paint();
  return box;
}

/* ------------------------------------------------------------------ history of one policy URL */

function historyBlock(result, onShow) {
  const details = h('details', { class: 'history' }, h('summary', {}, 'Earlier versions of this document'));
  let loaded = false;
  details.addEventListener('toggle', async () => {
    if (!details.open || loaded) return;
    loaded = true;
    const body = h('div', {}, h('p', { class: 'loading' }, 'Loading…'));
    details.append(body);
    try {
      const { versions } = await api(`/api/v1/history?url=${encodeURIComponent(result.url)}`);
      if (versions.length < 2) return mount(body, h('p', { class: 'empty' }, 'Only one version has been read in the last 30 days.'));
      mount(body, h('ol', { class: 'versions' }, versions.map((v) => h('li', {},
        h('span', {}, formatDate(v.createdAt), v.current ? h('span', { class: 'tag' }, 'Current') : null),
        h('span', { class: 'sub' }, `${plural(v.unfairCount, 'clause')} flagged`),
        h('button', { type: 'button', class: 'link', 'aria-label': `Show the version of ${formatDate(v.createdAt)}`, onclick: () => onShow(v) }, 'Show')))));
    } catch (error) {
      loaded = false;
      mount(body, errorNote(error));
    }
  });
  return details;
}

function documentSection(result) {
  const wrap = h('section', { class: 'doc-wrap' });
  const show = (r) => {
    mount(wrap, renderDocument(r, { old: !r.current }), historyBlock(r, show));
  };
  show(result);
  return wrap;
}

/* ------------------------------------------------------------------ the page */

async function load() {
  const domain = domainFromLocation();
  if (!domain) return mount(main, h('section', { class: 'hero small' }, h('h1', {}, 'Which website?'), h('p', { class: 'lede' }, h('a', { href: '/' }, 'Search for one'), '.')));
  document.title = `${domain} · Terms check`;
  mount(main, h('p', { class: 'loading' }, 'Loading…'));
  try {
    const { documents } = await api(`/api/v1/sites/${encodeURIComponent(domain)}`);
    const totals = familyCounts(documents.reduce((acc, d) => { for (const [k, n] of Object.entries(d.categories)) acc[k] = (acc[k] ?? 0) + n; return acc; }, {}));
    const latest = documents.map((d) => d.createdAt).sort().at(-1);
    mount(main,
      h('section', { class: 'site-head' },
        h('h1', {}, domain),
        h('p', { class: 'lede' }, `${plural(documents.length, 'document')} read, the latest ${timeAgo(latest)}.`,
          totals.length ? ` Across them: ${totals.map((t) => `${FAMILY_LABELS[t.family].toLowerCase()} ${t.n}`).join(', ')}.` : ' Nothing was flagged.')),
      ...documents.map(documentSection));
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'center' });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      // nobody has read it; has anyone said it has no terms at all?
      const missing = await api(`/api/v1/missing-terms/${encodeURIComponent(domain)}`).catch(() => null);
      if (missing) {
        return mount(main, h('section', { class: 'hero small' },
          h('h1', {}, domain),
          h('p', { class: 'tag warn-tag' }, 'No terms found'),
          h('p', { class: 'lede' }, `${plural(missing.reports, 'person', 'people')} reported that this site has no terms of service we can find. The latest report was ${timeAgo(missing.lastReportedAt)}; it stays here until ${formatDate(new Date(Date.parse(missing.lastReportedAt) + 30 * 86_400_000).toISOString())} unless someone reports it again.`),
          h('p', { class: 'fine' }, 'A report is a person’s observation, not a verdict. Check the site yourself before you decide.'),
          h('p', {}, h('a', { class: 'button tonal', href: '/' }, 'Search another site'))));
      }
      return mount(main, h('section', { class: 'hero small' },
        h('h1', {}, domain),
        h('p', { class: 'lede' }, 'Nobody has read this site’s terms in the last 30 days. Results appear here once a contributor reads them with the extension.'),
        h('p', {}, h('a', { class: 'button tonal', href: '/' }, 'Search another site'))));
    }
    mount(main, h('h1', {}, domain), errorNote(error, load));
  }
}

void load();
