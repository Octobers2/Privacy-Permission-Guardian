/**
 * Shared by every page: the API client, labels, and the few DOM helpers.
 *
 * Everything shown comes from a public API whose passages were written by other people's websites, so nothing here ever
 * builds HTML from data. Text goes in through `textContent` (see `h`), and attributes are set one at a time.
 */
import { CATEGORY_LABELS, FAMILY_HINTS, FAMILY_LABELS, FAMILY_OF, familyCounts, plural, policyLabel, timeAgo } from './pure.js';

export * from './pure.js';

/* ---------------------------------------------------------------- DOM */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Creates an element. Children may be strings (inserted as text), nodes, arrays, or null. Attributes are plain strings. */
export function h(tag, attrs = {}, ...children) {
  const svg = tag === 'svg' || attrs.__svg;
  const el = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === '__svg' || value === null || value === undefined || value === false) continue;
    // The page's CSP forbids inline style attributes; setting properties through the CSSOM is allowed.
    if (name === 'style' && typeof value === 'object') for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
    else if (name.startsWith('on') && typeof value === 'function') el.addEventListener(name.slice(2), value);
    else el.setAttribute(name, value === true ? '' : String(value));
  }
  const add = (child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach(add);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  children.forEach(add);
  return el;
}
export const s = (tag, attrs = {}, ...children) => h(tag, { ...attrs, __svg: true }, ...children);

export function mount(target, ...nodes) {
  target.replaceChildren(...nodes.flat().filter(Boolean));
}

/* ---------------------------------------------------------------- API */

/** The API is served by the same server as this site, so it lives at the page's own origin. */
export const API_BASE = location.origin;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path) {
  let response;
  try {
    response = await fetch(API_BASE + path, { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'The results server could not be reached. Try again in a moment.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body?.message ?? `The results server answered with an error (${response.status}).`);
  return body;
}

/* ---------------------------------------------------------------- the document strip */

/**
 * A picture of one document: a tick per sentence (binned when there are many), the flagged ones tall and coloured by family.
 * The same figure as in the extension's popup, so a result looks the same wherever it is read.
 */
export function documentStrip({ total, flagged, money = [], height = 44, onpick, reveal = false }) {
  const MAX_TICKS = 240;
  const bins = Math.min(Math.max(total, 1), MAX_TICKS);
  const binOf = (index) => Math.min(bins - 1, Math.floor((index / Math.max(total, 1)) * bins));
  const marks = new Map();
  for (const f of flagged) if (!marks.has(binOf(f.index))) marks.set(binOf(f.index), f);
  // fee-rule sentences take a tick only where the classifier flagged nothing
  const moneyMarks = new Map();
  for (const m of money) if (!marks.has(binOf(m.index)) && !moneyMarks.has(binOf(m.index))) moneyMarks.set(binOf(m.index), m);

  const svg = s('svg', {
    class: 'strip', viewBox: `0 0 ${bins} 44`, preserveAspectRatio: 'none', role: 'img', height,
    'aria-label': flagged.length + money.length === 0 ? `${plural(total, 'sentence')} read, none flagged` : `${plural(total, 'sentence')}, ${flagged.length} flagged${money.length ? ` and ${money.length} about money` : ''} at these positions in the document`,
  });
  // A flagged tick stays about 3 px wide however many sentences share the strip.
  const widthPx = () => svg.getBoundingClientRect().width || 600;
  const draw = () => {
    const markWidth = Math.max(0.8, (3 * bins) / widthPx());
    const kids = [];
    let order = 0;
    for (let i = 0; i < bins; i++) {
      const mark = marks.get(i);
      if (mark) {
        const family = FAMILY_OF[mark.category];
        const tick = s('rect', {
          class: `tick flagged fam-${family}`, x: i + 0.5 - markWidth / 2, y: 3, width: markWidth, height: 38, rx: Math.min(0.4, markWidth / 2),
          'data-family': family,
        }, s('title', {}, `${CATEGORY_LABELS[mark.category]} · sentence ${mark.index + 1}`));
        if (reveal) tick.style.setProperty('--delay', `${300 + order++ * 110}ms`);
        kids.push(tick);
      } else if (moneyMarks.has(i)) {
        kids.push(s('rect', {
          class: 'tick flagged fam-money', x: i + 0.5 - markWidth / 2, y: 3, width: markWidth, height: 38, rx: Math.min(0.4, markWidth / 2), 'data-family': 'money',
        }, s('title', {}, `Money · sentence ${moneyMarks.get(i).index + 1}`)));
      } else kids.push(s('rect', { class: 'tick plain', x: i + 0.25, y: 17, width: 0.5, height: 10, rx: 0.2 }));
    }
    svg.replaceChildren(...kids);
  };
  if (reveal) {
    svg.classList.add('reveal');
    setTimeout(() => svg.classList.remove('reveal'), 3_000);
  }
  draw();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(draw).observe(svg);
  if (onpick && flagged.length + money.length) {
    svg.classList.add('clickable');
    svg.addEventListener('click', (event) => {
      const box = svg.getBoundingClientRect();
      const target = ((event.clientX - box.left) / box.width) * total;
      onpick([...flagged, ...money].reduce((best, f) => (Math.abs(f.index - target) < Math.abs(best.index - target) ? f : best)).index);
    });
  }
  return svg;
}

/** Coloured dots for the families present, with counts: the short form of a result's findings. */
export function familyDots(categories) {
  const counts = familyCounts(categories);
  if (counts.length === 0) return h('span', { class: 'none' }, 'Nothing flagged');
  return h('ul', { class: 'dots', 'aria-label': 'Flagged clauses by family' }, counts.map(({ family, n }) =>
    h('li', { class: `fam-${family}`, title: FAMILY_HINTS[family] }, h('span', { class: 'swatch', 'aria-hidden': 'true' }), `${FAMILY_LABELS[family]} `, h('b', {}, String(n)))));
}

export function errorNote(error, retry) {
  return h('div', { class: 'note error', role: 'alert' }, h('p', {}, error instanceof Error ? error.message : String(error)), retry ? h('button', { type: 'button', class: 'button tonal', onclick: retry }, 'Try again') : null);
}

/** Shared header: wordmark, navigation, and the current page marked. */
export function header(current) {
  const link = (href, label, key) => h('a', { href, 'aria-current': current === key ? 'page' : null }, label);
  return h('header', { class: 'top' },
    h('a', { class: 'brand', href: '/' }, brandMark(), h('span', {}, 'Terms check')),
    h('nav', { 'aria-label': 'Main' }, link('/', 'Search', 'search'), link('/docs', 'API', 'docs')));
}

export function footer() {
  return h('footer', { class: 'foot' },
    h('p', {}, 'Results are produced by a small model reading each terms page on a contributor’s own computer, and are kept for 30 days. They point at clauses worth reading. They are not legal advice.'));
}

function brandMark() {
  return s('svg', { class: 'mark', viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': 'true' },
    s('path', { d: 'M6 2.75h8.2L19 7.55V20a1.25 1.25 0 0 1-1.25 1.25H6A1.25 1.25 0 0 1 4.75 20V4A1.25 1.25 0 0 1 6 2.75Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }),
    s('rect', { x: 8, y: 9.5, width: 8, height: 2.2, rx: 0.6, class: 'fam-rights', fill: 'var(--fam)' }),
    s('rect', { x: 8, y: 13.2, width: 8, height: 1.2, rx: 0.6, fill: 'currentColor', opacity: 0.45 }),
    s('rect', { x: 8, y: 16, width: 5.5, height: 1.2, rx: 0.6, fill: 'currentColor', opacity: 0.45 }));
}
