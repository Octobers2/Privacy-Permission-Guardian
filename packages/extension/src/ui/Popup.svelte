<script lang="ts">
  import '@material/web/button/filled-button.js';
  import '@material/web/button/filled-tonal-button.js';
  import '@material/web/button/text-button.js';
  import { onMount, tick } from 'svelte';
  import { FAMILIES, FAMILY_HINTS, FAMILY_LABELS, FAMILY_OF, type Family } from '@ppg/shared';
  import { STAGE_LABELS, type AnalysisResult, type AnalysisState } from '../analysis/state.ts';
  import { STATE_KEY_PREFIX } from '../messages.ts';
  import { loadPrefs } from '../prefs.ts';
  import ClauseCard from './components/ClauseCard.svelte';
  import DocumentStrip from './components/DocumentStrip.svelte';
  import Icon from './components/Icon.svelte';
  import Mark from './components/Mark.svelte';
  import Progress from './components/Progress.svelte';
  import { sharingLine, timeAgo } from './format.ts';

  let tabId = $state<number | null>(null);
  let view = $state<AnalysisState | null>(null);
  let family = $state<Family | null>(null);
  let picked = $state<number | null>(null);
  /** Shared-only mode: nothing is read on this device; the popup looks up what others have shared. */
  let shared = $state(false);

  /** Set when the background worker gave no usable answer, which is how a worker left over from an older version looks. */
  let unresponsive = $state(false);

  async function ask<T>(message: object): Promise<T | null> {
    try {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000));
      return ((await Promise.race([chrome.runtime.sendMessage(message), timeout])) as T | undefined) ?? null;
    } catch {
      return null;
    }
  }

  const NO_ANSWER: AnalysisState = {
    status: 'error',
    domain: '',
    message: 'The extension did not answer. After an update, the browser can keep running the previous version until the extension is reloaded.',
  };

  async function refresh() {
    if (tabId === null) return;
    const answer = await ask<AnalysisState>({ type: 'get-state', tabId });
    unresponsive = !answer;
    view = answer ?? NO_ANSWER;
  }

  async function analyse() {
    if (tabId === null) return;
    family = null;
    view = { status: 'working', domain: '', stage: 'reading', done: 0, total: 0, flagged: [] };
    const answer = await ask<AnalysisState>({ type: 'analyse', tabId });
    unresponsive = !answer;
    view = answer ?? NO_ANSWER;
  }

  onMount(() => {
    void loadPrefs().then((prefs) => (shared = prefs.mode === 'shared'));
    // `?tab=<id>` points the popup at a specific tab, which is how the end-to-end test drives it as an ordinary page.
    const forced = Number(new URLSearchParams(location.search).get('tab'));
    void (forced ? Promise.resolve(forced) : chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab?.id ?? null)).then(async (id) => {
      tabId = id;
      await refresh();
    });
    // The worker writes progress here as the offscreen document reports it; the popup just follows.
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && tabId !== null && changes[STATE_KEY_PREFIX + tabId]) void refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  });

  const openSetup = () => chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
  const openOptions = () => chrome.runtime.openOptionsPage();
  const reloadExtension = () => chrome.runtime.reload();

  async function jumpTo(index: number) {
    family = null;
    picked = index;
    await tick();
    document.getElementById(`clause-${index}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => (picked = null), 1_800);
  }

  const domain = $derived(view && 'domain' in view && view.domain ? view.domain : '');
  const percent = (s: Extract<AnalysisState, { status: 'working' }>) => (s.total > 0 ? s.done / s.total : null);
  const familyCounts = (r: Pick<AnalysisResult, 'flagged'>) => FAMILIES.map((f) => ({ f, n: r.flagged.filter((p) => FAMILY_OF[p.category] === f).length })).filter((x) => x.n > 0);
  const headline = (n: number) => (n === 0 ? 'No clauses that look unfair' : n === 1 ? '1 clause that may work against you' : `${n} clauses that may work against you`);
</script>

<div class="app">
  <header class="bar">
    <Mark />
    <div class="title">
      <h1>{domain || 'Terms of service'}</h1>
      {#if domain}<p>Terms of service</p>{/if}
    </div>
    <button type="button" class="icon-button" aria-label="Settings" onclick={openOptions}><Icon name="tune" /></button>
  </header>

  <!-- while the model reads, the list below is not interactive, so the scrollable area itself must be reachable by keyboard -->
  <main tabindex={view?.status === 'working' ? 0 : undefined} aria-label={view?.status === 'working' ? 'Analysis in progress' : undefined}>
    {#if !view}
      <Progress value={null} label="Loading" />
    {:else if view.status === 'needs-setup'}
      <section class="empty">
        <DocumentStrip total={64} flagged={[]} ghost height={36} />
        <h2>Set up once, then read anything</h2>
        <p>The extension reads terms of service with a small model that runs on your computer. Setup downloads it and takes a minute.</p>
      </section>
    {:else if view.status === 'idle'}
      <section class="empty">
        <DocumentStrip total={64} flagged={[]} ghost height={36} />
        {#if shared}
          <h2>Look up these terms</h2>
          <p>Shows the clauses that tend to work against you, as found by other people’s computers. Nothing is read on this one. Only the name of this website is sent to the results server.</p>
        {:else}
          <h2>Read these terms for you</h2>
          <p>Finds the clauses that tend to work against you, such as forced arbitration or closing your account without notice. It runs on your computer, and nothing you read leaves it.</p>
        {/if}
      </section>
    {:else if view.status === 'working'}
      {@const w = view}
      <section class="working" aria-live="polite">
        <h2>{STAGE_LABELS[w.stage]}</h2>
        {#if w.stage === 'classifying' || (w.total > 0 && w.flagged.length > 0)}
          <DocumentStrip total={w.total} read={w.done} flagged={w.flagged} working height={44} />
          <p class="meta">{w.done} of {w.total} sentences · {w.flagged.length} flagged so far</p>
        {:else}
          <Progress value={w.stage === 'loading-model' && w.total > 0 ? percent(w) : null} label={STAGE_LABELS[w.stage]} />
          {#if w.detail}<p class="meta">{w.detail}</p>{/if}
        {/if}
        {#if !shared}<p class="reassure"><Icon name="laptop" size={16} /> Running on your computer</p>{/if}
        {#if w.flagged.length}
          <div class="list">
            {#each w.flagged.slice(-3) as clause (clause.index)}<ClauseCard {clause} total={w.total} />{/each}
          </div>
        {/if}
      </section>
    {:else if view.status === 'ready'}
      {@const r = view.result}
      {@const share = sharingLine(r.sharing)}
      {@const shown = family ? r.flagged.filter((p) => FAMILY_OF[p.category] === family) : r.flagged}
      <section class="ready">
        <div class="hero">
          <h2>{headline(r.flagged.length)}</h2>
          <p class="meta">
            among {r.passageCount} sentences · {r.source === 'community' ? 'from the public cache' : 'read on this device'} · {timeAgo(r.analyzedAt)}
          </p>
        </div>

        <DocumentStrip total={r.passageCount} flagged={r.flagged} {family} height={44} onpick={jumpTo} />

        {#if r.flagged.length}
          <div class="chips" role="group" aria-label="Filter clauses by what they do">
            {#each familyCounts(r) as { f, n } (f)}
              <button type="button" class="chip fam-{f}" aria-pressed={family === f} title={FAMILY_HINTS[f]} onclick={() => (family = family === f ? null : f)}>
                <span class="swatch" aria-hidden="true"></span>{FAMILY_LABELS[f]}<span class="n">{n}</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if r.truncated}
          <p class="note info"><Icon name="info" size={16} /> Only the first part of a long document was read.</p>
        {/if}

        {#if r.summary}
          <div class="summary">
            <h3>In plain language</h3>
            <ul>
              {#each r.summary.points as point}
                <li class="sev-{point.severity}">
                  <span class="sev">{point.severity === 'high' ? 'Serious' : point.severity === 'medium' ? 'Worth knowing' : 'Minor'}</span>
                  <strong>{point.title}</strong>
                  <span class="detail">{point.detail}</span>
                </li>
              {/each}
            </ul>
          </div>
        {:else if r.summaryError}
          <p class="note"><Icon name="info" size={16} /> Summary unavailable: {r.summaryError}</p>
        {/if}

        {#if r.flagged.length}
          <div class="list">
            <h3>{family ? FAMILY_LABELS[family] : 'The clauses'} <span class="count">{shown.length}</span></h3>
            {#each shown as clause (clause.index)}<ClauseCard {clause} total={r.passageCount} highlighted={picked === clause.index} />{/each}
          </div>
        {:else}
          <p class="note good"><Icon name="check" size={16} /> Nothing in these terms matched the clause types this model looks for. That is not a guarantee, so skim the document if it matters.</p>
        {/if}

        {#if r.site && r.site.documents > 1}
          <p class="note info"><Icon name="info" size={16} /> This is one of {r.site.documents} documents for this site. <a class="link" href={r.site.url} target="_blank" rel="noreferrer">See all of them</a></p>
        {/if}

        <p class="note {share.tone}">
          <Icon name={share.tone === 'good' ? 'upload' : share.tone === 'warn' ? 'lock' : 'info'} size={16} />
          <span>{share.text}</span>
        </p>
      </section>
    {:else if view.status === 'unavailable'}
      <section class="state">
        <Icon name="document" size={28} />
        <h2>{shared ? 'No shared result yet' : 'No terms to read here'}</h2>
        <p>{view.reason}</p>
        {#each view.links ?? [] as link}<a class="link" href={link} target="_blank" rel="noreferrer">{link}</a>{/each}
      </section>
    {:else}
      <section class="state">
        <Icon name="alert" size={28} />
        <h2>That did not work</h2>
        <p>{view.message}</p>
        {#if view.detail}<details class="tech"><summary>Technical details</summary><pre>{view.detail}</pre></details>{/if}
      </section>
    {/if}
  </main>

  <footer class="actions">
    {#if view?.status === 'needs-setup'}
      <md-filled-button onclick={openSetup}>Finish setup</md-filled-button>
    {:else if view?.status === 'idle'}
      <md-filled-button onclick={analyse}>{shared ? 'Look up results' : 'Read the terms'}</md-filled-button>
    {:else if view?.status === 'ready'}
      <md-text-button href={view.result.policyUrl} target="_blank">Open the terms</md-text-button>
      <md-filled-tonal-button onclick={analyse}>{shared ? 'Look up again' : 'Read again'}</md-filled-tonal-button>
    {:else if unresponsive}
      <md-filled-button onclick={reloadExtension}>Reload extension</md-filled-button>
    {:else if view?.status === 'unavailable' || view?.status === 'error'}
      {#if view.domain}<md-filled-tonal-button onclick={analyse}>Try again</md-filled-tonal-button>{/if}
    {/if}
  </footer>
</div>

<style>
  .app {
    width: 380px;
    max-height: 580px;
    display: flex;
    flex-direction: column;
    background: var(--md-sys-color-surface);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 8px 12px 16px;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
  }
  .title {
    flex: 1;
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title p {
    margin: 0;
    font-size: 0.75rem;
    color: var(--md-sys-color-on-surface-variant);
  }
  .icon-button {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--md-sys-color-on-surface-variant);
    cursor: pointer;
  }
  .icon-button:hover {
    background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
  }
  main {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    min-height: 120px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.005em;
    text-wrap: balance;
  }
  h3 {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
  }
  p {
    margin: 0;
  }
  .meta {
    font-size: 0.75rem;
    color: var(--md-sys-color-on-surface-variant);
  }
  .empty p,
  .state p {
    color: var(--md-sys-color-on-surface-variant);
    max-width: 34ch;
  }
  .state {
    align-items: flex-start;
    padding-top: 8px;
  }
  .state .link {
    color: var(--md-sys-color-primary);
    font-size: 0.8125rem;
    word-break: break-all;
  }
  .reassure {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.75rem;
    color: var(--md-sys-color-on-surface-variant);
  }
  .hero {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding: 0 12px 0 10px;
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: 8px;
    background: none;
    color: var(--md-sys-color-on-surface);
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .chip .swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: var(--fam);
  }
  .chip .n {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .chip[aria-pressed='true'] {
    background: var(--fam-container);
    border-color: var(--fam);
    color: var(--on-fam-container);
  }
  .summary {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--md-sys-color-surface-container-low);
    border-radius: var(--ppg-radius-surface);
    padding: 14px 16px;
  }
  .summary ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .summary li {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sev {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--md-sys-color-on-surface-variant);
  }
  .sev-high .sev {
    color: var(--md-sys-color-error);
  }
  .detail {
    font-size: 0.8125rem;
    color: var(--md-sys-color-on-surface-variant);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .count {
    margin-left: 4px;
    font-weight: 400;
    color: var(--md-sys-color-on-surface-variant);
  }
  .note {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 10px 12px;
    border-radius: var(--ppg-radius-control);
    background: var(--md-sys-color-surface-container);
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.75rem;
    line-height: 1.4;
  }
  .note :global(svg) {
    margin-top: 1px;
  }
  .note.good {
    background: color-mix(in srgb, var(--md-sys-color-success-container) 45%, var(--md-sys-color-surface));
    color: var(--md-sys-color-on-surface);
  }
  .note.good :global(svg) {
    color: var(--md-sys-color-success);
  }
  .note.warn {
    background: color-mix(in srgb, var(--md-sys-color-warning-container) 45%, var(--md-sys-color-surface));
    color: var(--md-sys-color-on-surface);
  }
  .note.warn :global(svg) {
    color: var(--md-sys-color-warning);
  }
  .tech pre {
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 0.6875rem;
    max-height: 140px;
    overflow: auto;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--md-sys-color-outline-variant);
    background: var(--md-sys-color-surface);
  }
  .actions:empty {
    display: none;
  }
</style>
