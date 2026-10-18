import { API_BASE, TOS_CATEGORIES, footer, h, header } from './common.js';

document.getElementById('top').replaceChildren(header('docs'));
document.getElementById('bottom').replaceChildren(footer());
document.querySelector('#base code').textContent = API_BASE;

const ENDPOINTS = [
  { path: '/api/v1/sites/{domain}', example: '/api/v1/sites/github.com', what: 'The current result for every policy address of a site, with the flagged passages.', params: 'domain: the registrable domain, such as github.com.' },
  { path: '/api/v1/lookup?url={policy URL}', example: '/api/v1/lookup?url=https://github.com/site-policy/github-terms/github-terms-of-service', what: 'The current result for one policy address. Add &hash={sha256} to learn whether the text is unchanged (sameText).', params: 'url: the policy address, without query string. hash: optional.' },
  { path: '/api/v1/results/{id}', example: '/api/v1/results/1', what: 'One result by its id, including older versions that have not expired.', params: 'id: a number from any other response.' },
  { path: '/api/v1/history?url={policy URL}', example: '/api/v1/history?url=https://github.com/site-policy/github-terms/github-terms-of-service', what: 'Every unexpired version of one policy address, newest first.', params: 'url: the policy address.' },
  { path: '/api/v1/recent?limit={n}', example: '/api/v1/recent?limit=5', what: 'The most recently read policies, without passage text.', params: 'limit: 1 to 100, default 20.' },
  { path: '/api/v1/rankings?by={count|share}&limit={n}', example: '/api/v1/rankings?by=share&limit=5', what: 'Sites ranked by the number of flagged clauses (count) or the share of sentences flagged (share).', params: 'by: count or share. limit: 1 to 100, default 20.' },
  { path: '/api/v1/stats', example: '/api/v1/stats', what: 'How many results, policy addresses, sites and summaries are currently held.', params: 'none.' },
];

function endpoint(e) {
  const output = h('pre', { class: 'code out', hidden: true, 'aria-live': 'polite' }, h('code', {}));
  const run = h('button', { type: 'button', class: 'button tonal small' }, 'Try it');
  run.addEventListener('click', async () => {
    run.disabled = true;
    output.hidden = false;
    output.firstChild.textContent = 'Loading…';
    try {
      const response = await fetch(API_BASE + e.example, { headers: { accept: 'application/json' } });
      const text = JSON.stringify(await response.json(), null, 2);
      output.firstChild.textContent = `${response.status} ${response.statusText}\n${text.length > 3000 ? text.slice(0, 3000) + '\n…' : text}`;
    } catch {
      output.firstChild.textContent = 'The results server could not be reached.';
    }
    run.disabled = false;
  });
  return h('article', { class: 'endpoint' },
    h('h3', {}, h('span', { class: 'verb' }, 'GET'), h('code', {}, e.path)),
    h('p', {}, e.what),
    h('p', { class: 'sub' }, e.params),
    h('pre', { class: 'code' }, h('code', {}, `curl '${API_BASE}${e.example}'`)),
    h('div', { class: 'actions' }, run),
    output);
}
document.getElementById('endpoints').replaceChildren(...ENDPOINTS.map(endpoint));

const FIELDS = [
  ['domain, url', 'The site and the exact policy address that was read.'],
  ['createdAt, expiresAt', 'When it was read, and when it is removed (30 days later).'],
  ['passageCount', 'How many sentences the document was split into.'],
  ['unfairCount, fairCount', 'How many sentences were flagged, and how many were not.'],
  ['categories', 'Flagged sentences per clause type, such as {"arbitration": 2}.'],
  ['passages[]', 'The flagged sentences only: index, text, category, and probs, the probability of each of the nine classes in this order: ' + TOS_CATEGORIES.join(', ') + '.'],
  ['model, promptVersion', 'Which model read the document, so results from different versions can be told apart.'],
  ['current', 'False for an older version of the same address.'],
];
document.getElementById('fields').replaceChildren(...FIELDS.flatMap(([k, v]) => [h('dt', {}, h('code', {}, k)), h('dd', {}, v)]));
