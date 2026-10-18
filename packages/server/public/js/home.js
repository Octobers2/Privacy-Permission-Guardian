import { ApiError, api, domainCandidates, errorNote, familyDots, footer, formatDate, h, header, mount, percent, plural, policyLabel, timeAgo, documentStrip, s } from './common.js';

document.getElementById('top').replaceChildren(header('search'));
document.getElementById('bottom').replaceChildren(footer());

/* ---- the search box */

const form = document.getElementById('search');
const input = document.getElementById('q');
const status = document.getElementById('search-status');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const candidates = domainCandidates(input.value);
  if (candidates.length === 0) {
    status.textContent = 'That does not look like a website. Try something like example.com.';
    status.className = 'status warn';
    return;
  }
  status.className = 'status';
  status.textContent = 'Looking…';
  for (const domain of candidates) {
    try {
      await api(`/api/v1/sites/${encodeURIComponent(domain)}`);
      location.assign(`/site/${encodeURIComponent(domain)}`);
      return;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) continue;
      status.textContent = error.message;
      status.className = 'status warn';
      return;
    }
  }
  status.className = 'status warn';
  status.textContent = `Nobody has read the terms of ${candidates[candidates.length - 1]} yet. Results appear here once a contributor reads them with the extension.`;
});

/* ---- the picture under the search box: a document with a few clauses lit, drawn once, decorative */

const sample = [[14, 'liability'], [31, 'rights'], [33, 'rights'], [58, 'control'], [71, 'consent'], [90, 'control'], [104, 'rights'], [131, 'liability'], [150, 'control']];
const demo = documentStrip({ total: 168, flagged: sample.map(([index, family]) => ({ index, category: { rights: 'arbitration', liability: 'limitation_of_liability', control: 'unilateral_termination', consent: 'contract_by_using' }[family] })), height: 52, reveal: true });
document.getElementById('hero-strip').replaceChildren(demo);

/* ---- rankings */

const rankingsBox = document.getElementById('rankings');
const buttons = [...document.querySelectorAll('[data-by]')];

function rankingTable(rows, by) {
  if (rows.length === 0) return h('p', { class: 'empty' }, 'No results yet. They appear as soon as a contributor reads a site’s terms.');
  const top = Math.max(...rows.map((r) => r.share), 0.01);
  return h('table', { class: 'table' },
    h('caption', { class: 'visually-hidden' }, by === 'share' ? 'Sites ranked by the share of their terms that was flagged' : 'Sites ranked by the number of flagged clauses'),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col', class: 'rank' }, 'Rank'), h('th', { scope: 'col' }, 'Site'), h('th', { scope: 'col', class: 'num' }, 'Flagged'), h('th', { scope: 'col', class: 'bar-col' }, 'Share of the text'))),
    h('tbody', {}, rows.map((row, i) => h('tr', {},
      h('td', { class: 'rank' }, String(i + 1)),
      h('th', { scope: 'row' }, h('a', { href: `/site/${encodeURIComponent(row.domain)}` }, row.domain), h('span', { class: 'sub' }, plural(row.documents, 'document'))),
      h('td', { class: 'num' }, row.unfair.toLocaleString(), h('span', { class: 'sub' }, ` of ${row.passages.toLocaleString()} sentences`)),
      h('td', { class: 'bar-col' }, h('span', { class: 'bar', role: 'img', 'aria-label': `${percent(row.share)} of sentences flagged` }, h('span', { class: 'fill', style: { width: `${Math.max(2, (row.share / top) * 100)}%` } })), h('span', { class: 'pct' }, percent(row.share)))))));
}

async function loadRankings(by) {
  buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.by === by)));
  try {
    const { rows } = await api(`/api/v1/rankings?by=${by}&limit=15`);
    mount(rankingsBox, rankingTable(rows, by));
  } catch (error) {
    mount(rankingsBox, errorNote(error, () => loadRankings(by)));
  }
}
buttons.forEach((b) => b.addEventListener('click', () => loadRankings(b.dataset.by)));

/* ---- recent */

async function loadRecent() {
  try {
    const { results } = await api('/api/v1/recent?limit=12');
    if (results.length === 0) return mount(document.getElementById('recent'), h('p', { class: 'empty' }, 'Nothing has been read yet.'));
    mount(document.getElementById('recent'), h('ul', { class: 'recent' }, results.map((r) => h('li', {},
      h('div', { class: 'who' }, h('a', { href: `/site/${encodeURIComponent(r.domain)}` }, r.domain), h('span', { class: 'sub' }, policyLabel(r.url))),
      familyDots(r.categories),
      h('time', { datetime: r.createdAt, title: formatDate(r.createdAt) }, timeAgo(r.createdAt))))));
  } catch (error) {
    mount(document.getElementById('recent'), errorNote(error, loadRecent));
  }
}

void loadRankings('count');
void loadRecent();
