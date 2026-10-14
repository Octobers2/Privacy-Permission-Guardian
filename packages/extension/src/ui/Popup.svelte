<script lang="ts">
  import '@material/web/button/filled-button.js';
  import '@material/web/button/outlined-button.js';
  import '@material/web/button/text-button.js';
  import { onMount } from 'svelte';
  import { STAGE_LABELS, type AnalysisState } from '../analysis/state.ts';
  import { STATE_KEY_PREFIX } from '../messages.ts';
  import ClauseList from './components/ClauseList.svelte';
  import Progress from './components/Progress.svelte';
  import { flaggedHeadline, sharingLine, timeAgo } from './format.ts';

  let tabId = $state<number | null>(null);
  let view = $state<AnalysisState | null>(null);

  async function ask<T>(message: object): Promise<T | null> {
    try {
      return (await chrome.runtime.sendMessage(message)) as T;
    } catch {
      return null;
    }
  }

  async function refresh() {
    if (tabId !== null) view = await ask<AnalysisState>({ type: 'get-state', tabId });
  }

  async function analyse() {
    if (tabId === null) return;
    view = { status: 'working', domain: '', stage: 'reading', done: 0, total: 0, flagged: [] };
    view = (await ask<AnalysisState>({ type: 'analyse', tabId })) ?? { status: 'error', domain: '', message: 'The extension did not answer. Reload it and try again.' };
  }

  onMount(() => {
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
  const percent = (s: Extract<AnalysisState, { status: 'working' }>) => (s.total > 0 ? s.done / s.total : null);
</script>

<main>
  <header>
    <h1 class="md-typescale-title-medium">Terms of service check</h1>
    {#if view && 'domain' in view && view.domain}<p class="domain">{view.domain}</p>{/if}
  </header>

  {#if !view}
    <Progress value={null} label="Loading" />
  {:else if view.status === 'needs-setup'}
    <section>
      <p>Finish the one-time setup to download the model that reads terms of service on your computer.</p>
      <md-filled-button onclick={openSetup}>Finish setup</md-filled-button>
    </section>
  {:else if view.status === 'idle'}
    <section>
      <p>Read this site’s terms of service and flag clauses that tend to work against you. This happens on your computer.</p>
      <md-filled-button onclick={analyse}>Analyse the terms</md-filled-button>
    </section>
  {:else if view.status === 'working'}
    <section aria-live="polite">
      <Progress value={percent(view)} label="Analysis progress" />
      <p class="stage">{STAGE_LABELS[view.stage]}{view.detail ? ` ${view.detail}` : ''}</p>
      {#if view.total > 0 && view.stage === 'classifying'}
        <p class="note">{view.done} of {view.total} sentences · {view.flagged.length} flagged so far</p>
      {/if}
      {#if view.flagged.length}<ClauseList flagged={view.flagged} />{/if}
    </section>
  {:else if view.status === 'ready'}
    {@const r = view.result}
    {@const share = sharingLine(r.sharing)}
    <section>
      <p class="headline md-typescale-title-large" class:clean={r.flagged.length === 0}>{flaggedHeadline(r.flagged.length, r.passageCount)}</p>
      <p class="note">
        {r.source === 'community' ? 'From the public cache' : 'Analysed on this device'} · {timeAgo(r.analyzedAt)}
        {#if r.truncated}· <strong>only part of a long document was read</strong>{/if}
      </p>

      {#if r.summary}
        <div class="summary">
          <h2 class="md-typescale-title-small">In plain language</h2>
          <ul>
            {#each r.summary.points as point}
              <li class={point.severity}>
                <strong>{point.title}</strong>
                <span>{point.detail}</span>
              </li>
            {/each}
          </ul>
        </div>
      {:else if r.summaryError}
        <p class="note">Summary unavailable: {r.summaryError}</p>
      {/if}

      {#if r.flagged.length}<ClauseList flagged={r.flagged} />{/if}

      <p class="sharing {share.tone}">{share.text}</p>

      <div class="actions">
        <md-text-button onclick={analyse}>Analyse again</md-text-button>
        <md-text-button href={r.policyUrl} target="_blank">Open the terms</md-text-button>
      </div>
    </section>
  {:else if view.status === 'unavailable'}
    <section>
      <p>{view.reason}</p>
      {#each view.links ?? [] as link}
        <p class="note"><a href={link} target="_blank" rel="noreferrer">{link}</a></p>
      {/each}
      {#if view.domain}<md-outlined-button onclick={analyse}>Try again</md-outlined-button>{/if}
    </section>
  {:else}
    <section>
      <p class="error" role="alert">{view.message}</p>
      {#if view.detail}<details class="tech"><summary>Technical details</summary><pre>{view.detail}</pre></details>{/if}
      <md-outlined-button onclick={analyse}>Try again</md-outlined-button>
    </section>
  {/if}

  <footer>
    <md-text-button onclick={openOptions}>Settings</md-text-button>
  </footer>
</main>

<style>
  main {
    width: 380px;
    max-height: 560px;
    overflow-y: auto;
    padding: 16px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h1,
  h2,
  p {
    margin: 0;
  }
  .domain {
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.8125rem;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .headline {
    color: var(--md-sys-color-error);
  }
  .headline.clean {
    color: var(--md-sys-color-primary);
  }
  .note,
  .stage {
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.8125rem;
  }
  .error {
    color: var(--md-sys-color-error);
    background: var(--md-sys-color-error-container);
    padding: 12px;
    border-radius: 12px;
  }
  .summary {
    background: var(--md-sys-color-surface-container);
    border-radius: 12px;
    padding: 12px;
  }
  .summary ul {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .summary li {
    display: flex;
    flex-direction: column;
    font-size: 0.8125rem;
    border-left: 3px solid var(--md-sys-color-outline);
    padding-left: 10px;
  }
  .summary li.high {
    border-left-color: var(--md-sys-color-error);
  }
  .summary li.medium {
    border-left-color: var(--md-sys-color-tertiary);
  }
  .sharing {
    font-size: 0.75rem;
    padding: 8px 12px;
    border-radius: 8px;
    background: var(--md-sys-color-surface-container-low);
    color: var(--md-sys-color-on-surface-variant);
  }
  .sharing.good {
    background: var(--md-sys-color-primary-container);
    color: var(--md-sys-color-on-primary-container);
  }
  .sharing.warn {
    background: var(--md-sys-color-tertiary-container);
    color: var(--md-sys-color-on-tertiary-container);
  }
  .actions,
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
  }
  .tech pre {
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 0.6875rem;
    max-height: 160px;
    overflow: auto;
  }
  a {
    color: var(--md-sys-color-primary);
    word-break: break-all;
  }
</style>
