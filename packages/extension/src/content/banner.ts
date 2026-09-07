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
import type { RuleHit, Verdict } from '@ppg/shared';
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
  font-family: system-ui, -apple-system, 'Noto Sans HK', 'PingFang HK', sans-serif;
  color-scheme: light dark;
}

.bar {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  box-sizing: border-box;
  border-bottom: 1px solid rgb(0 0 0 / 0.12);
  box-shadow: 0 2px 8px rgb(0 0 0 / 0.15);
  font-size: 14px;
  line-height: 1.45;
}
.bar[data-verdict='danger'] {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
.bar[data-verdict='caution'] {
  background: var(--md-sys-color-warning-container);
  color: var(--md-sys-color-on-warning-container);
}

.icon { flex: none; width: 22px; height: 22px; margin-top: 1px; }
.body { flex: 1 1 auto; min-width: 0; }
.title { font-weight: 600; }
.advice { margin-top: 4px; opacity: 0.9; }

ul { margin: 8px 0 0; padding-left: 20px; }
li { margin: 2px 0; }
[hidden] { display: none; }

.actions { flex: none; display: flex; gap: 8px; align-items: center; }

button {
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  border: none;
  border-radius: 20px;
  padding: 7px 14px;
  color: inherit;
  background: rgb(0 0 0 / 0.08);
}
button:hover { background: rgb(0 0 0 / 0.16); }
button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }

@media (prefers-color-scheme: dark) {
  button { background: rgb(255 255 255 / 0.12); }
  button:hover { background: rgb(255 255 255 / 0.2); }
}

@media (max-width: 640px) {
  .bar { flex-wrap: wrap; }
  .actions { width: 100%; justify-content: flex-end; }
}
`;

/** Material Symbols "warning" and "gpp_maybe", inlined so no icon font is needed. */
const ICONS: Record<BannerContent['verdict'], string> = {
  danger:
    'M12 2 1 21h22L12 2Zm0 6 7.53 13H4.47L12 8Zm-1 4v4h2v-4h-2Zm0 5v2h2v-2h-2Z',
  caution:
    'M12 2 4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3Zm-1 5h2v6h-2V7Zm0 8h2v2h-2v-2Z',
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

function icon(verdict: BannerContent['verdict']): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[verdict]);
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
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

  const reasons = el('ul');
  reasons.hidden = true;
  for (const reason of content.reasons) reasons.append(el('li', { textContent: reason }));

  const body = el('div', { className: 'body' }, [
    el('div', { className: 'title', textContent: content.title }),
    content.advice ? el('div', { className: 'advice', textContent: content.advice }) : null,
    content.reasons.length ? reasons : null,
  ]);

  const details = el('button', { type: 'button', textContent: '詳情' });
  details.setAttribute('aria-expanded', 'false');
  details.addEventListener('click', () => {
    reasons.hidden = !reasons.hidden;
    details.setAttribute('aria-expanded', String(!reasons.hidden));
    details.textContent = reasons.hidden ? '詳情' : '收起';
  });

  const dismiss = el('button', { type: 'button', textContent: '暫時關閉' });
  dismiss.addEventListener('click', () => {
    removeBanner();
    handlers.onDismiss();
  });

  const never = el('button', { type: 'button', textContent: '呢個網站唔再提示' });
  never.addEventListener('click', () => {
    removeBanner();
    handlers.onNeverOnThisSite();
  });

  const actions = el('div', { className: 'actions' }, [
    content.reasons.length ? details : null,
    dismiss,
    never,
  ]);

  const bar = el('div', { className: 'bar' }, [icon(content.verdict), body, actions]);
  bar.setAttribute('data-verdict', content.verdict);
  bar.setAttribute('role', 'alert');

  shadow.append(bar);
  // documentElement rather than body: some pages replace body wholesale during
  // hydration, and a banner that vanishes on a framework mount is worse than none.
  document.documentElement.append(host);
  return host;
}
