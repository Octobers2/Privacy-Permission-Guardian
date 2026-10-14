/**
 * The warning strip injected into the page.
 *
 * Three constraints shape everything here:
 *
 * 1. It runs on every site the user visits, so it pulls in no UI framework —
 *    shipping a Lit or Svelte runtime into every page would contradict the
 *    whole point of a lightweight privacy tool.
 * 2. It lives in a shadow root with an `all: initial` reset, so the host page
 *    cannot restyle it and it cannot restyle the host page.
 * 3. Nothing is ever assigned to `innerHTML`. Rule text is ours, but model
 *    output ends up in the same list, and model output is derived from
 *    attacker-controlled page text.
 */
import type { Verdict } from '@ppg/shared/schemas';
import tokens from './md3-tokens-host.css?inline';

const HOST_ID = 'ppg-banner-host';

export interface BannerContent {
  verdict: Exclude<Verdict, 'safe'>;
  title: string;
  reasons: string[];
  advice?: string;
}

export interface BannerHandlers {
  onDismiss(): void;
  onNeverOnThisSite(): void;
}

const STYLES = `
:host {
  all: initial;
  position: fixed;
  inset: 0 0 auto 0;
  z-index: 2147483647;
  display: block;
  font-family: Roboto, system-ui, -apple-system, 'Segoe UI', 'Noto Sans', 'Noto Sans HK', 'PingFang HK', sans-serif;
  color-scheme: light dark;
}

.bar {
  --accent: var(--md-sys-color-error);
  --on-accent: var(--md-sys-color-on-error);
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 14px 20px 14px 16px;
  box-sizing: border-box;
  border-left: 6px solid var(--accent);
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.22);
  font-size: 14px;
  line-height: 1.45;
  animation: drop 260ms cubic-bezier(0.2, 0, 0, 1) both;
}
.bar[data-verdict='danger'] {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
.bar[data-verdict='caution'] {
  --accent: var(--md-sys-color-warning);
  --on-accent: var(--md-sys-color-on-warning);
  background: var(--md-sys-color-warning-container);
  color: var(--md-sys-color-on-warning-container);
}

.badge {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
}
.icon { width: 20px; height: 20px; }
.body { flex: 1 1 auto; min-width: 0; }
.title { font-size: 15px; font-weight: 600; line-height: 1.3; }
.why { margin-top: 3px; }
.advice { margin-top: 6px; font-weight: 500; }

ul { margin: 10px 0 0; padding-left: 20px; }
li { margin: 3px 0; }
[hidden] { display: none; }

.more { margin-top: 10px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, currentColor 22%, transparent); }

.actions { flex: none; display: flex; gap: 6px; align-items: center; }

button {
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  border-radius: 20px;
  padding: 8px 16px;
  color: inherit;
  background: none;
}
button.primary { background: var(--accent); color: var(--on-accent); }
button.primary:hover { filter: brightness(1.08); }
button.quiet:hover, button.link:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
button.link { padding: 6px 10px; margin-left: -10px; font-weight: 500; text-decoration: underline; }
button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }

@keyframes drop { from { transform: translateY(-100%); } to { transform: none; } }
@media (prefers-reduced-motion: reduce) { .bar { animation: none; } }

@media (max-width: 640px) {
  .bar { flex-wrap: wrap; }
  .actions { width: 100%; justify-content: flex-end; }
}
`;

/** Simple stroked glyphs, inlined so no icon font is needed. */
const ICONS: Record<BannerContent['verdict'], string> = {
  danger: 'M12 4l9 16H3zM12 10v4.5M12 17.5v.5',
  caution: 'M12 3l7 3v5c0 4.6-2.9 8.4-7 10-4.1-1.6-7-5.4-7-10V6zM12 8.5v4M12 15.5v.5',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<'className' | 'textContent' | 'type', string>> = {},
  children: (Node | null)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.textContent !== undefined) node.textContent = props.textContent;
  if (props.type) node.setAttribute('type', props.type);
  for (const child of children) if (child) node.append(child);
  return node;
}

function icon(verdict: BannerContent['verdict']): HTMLElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[verdict]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.9');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  const badge = el('div', { className: 'badge' });
  badge.append(svg);
  return badge;
}

export function removeBanner(): void {
  document.getElementById(HOST_ID)?.remove();
}

/**
 * Renders (or re-renders) the banner. Returns the host element so callers can
 * update it in place when the model verdict arrives after the rule verdict.
 */
export function showBanner(content: BannerContent, handlers: BannerHandlers): HTMLElement {
  removeBanner();

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const sheet = new CSSStyleSheet();
  sheet.replaceSync(tokens + STYLES);
  shadow.adoptedStyleSheets = [sheet];

  // The first reason is the answer to "why?", so it is shown straight away; the rest, and the way to silence the site, are one click deeper.
  const [firstReason, ...otherReasons] = content.reasons;
  const more = el('div', { className: 'more' });
  more.hidden = true;
  if (otherReasons.length) {
    const list = el('ul');
    for (const reason of otherReasons) list.append(el('li', { textContent: reason }));
    more.append(list);
  }
  const never = el('button', { type: 'button', className: 'link', textContent: 'Do not warn me on this site' });
  never.addEventListener('click', () => {
    removeBanner();
    handlers.onNeverOnThisSite();
  });
  more.append(never);

  const body = el('div', { className: 'body' }, [
    el('div', { className: 'title', textContent: content.title }),
    firstReason ? el('div', { className: 'why', textContent: firstReason }) : null,
    content.advice ? el('div', { className: 'advice', textContent: content.advice }) : null,
    more,
  ]);

  const details = el('button', { type: 'button', className: 'primary', textContent: 'Why am I seeing this?' });
  details.setAttribute('aria-expanded', 'false');
  details.addEventListener('click', () => {
    more.hidden = !more.hidden;
    details.setAttribute('aria-expanded', String(!more.hidden));
    details.textContent = more.hidden ? 'Why am I seeing this?' : 'Hide details';
  });

  const dismiss = el('button', { type: 'button', className: 'quiet', textContent: 'Dismiss' });
  dismiss.addEventListener('click', () => {
    removeBanner();
    handlers.onDismiss();
  });

  const actions = el('div', { className: 'actions' }, [details, dismiss]);

  const bar = el('div', { className: 'bar' }, [icon(content.verdict), body, actions]);
  bar.setAttribute('data-verdict', content.verdict);
  bar.setAttribute('role', 'alert');

  shadow.append(bar);
  // documentElement rather than body: some pages replace body wholesale during
  // hydration, and a banner that vanishes on a framework mount is worse than none.
  document.documentElement.append(host);
  return host;
}
