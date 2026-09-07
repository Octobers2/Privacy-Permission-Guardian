<script lang="ts">
  import '@material/web/button/filled-button.js';
  import '@material/web/button/text-button.js';
  import '@material/web/progress/circular-progress.js';
  import { BAND_LABELS, riskBand } from '@ppg/shared/score';
  import type { SummaryState } from '../messages.ts';
  import PolicyPointCard from './components/PolicyPointCard.svelte';

  let state = $state<SummaryState | null>(null);
  let tabId = $state<number | null>(null);

  async function currentTab(): Promise<chrome.tabs.Tab | undefined> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function refresh(): Promise<void> {
    const tab = await currentTab();
    if (tab?.id === undefined) {
      state = { status: 'unavailable', domain: '', reason: '搵唔到目前嘅分頁。' };
      return;
    }
    tabId = tab.id;
    state = await chrome.runtime.sendMessage({ type: 'get-summary', tabId: tab.id });
  }

  async function analyse(): Promise<void> {
    if (tabId === null) return;
    state = { status: 'working', domain: state?.domain ?? '' };
    state = await chrome.runtime.sendMessage({ type: 'analyse-policy', tabId });
  }

  void refresh();
</script>

<main>
  <header>
    <h1 class="md-typescale-title-small">Privacy &amp; Permission Guardian</h1>
    {#if state?.domain}
      <p class="md-typescale-body-small domain">{state.domain}</p>
    {/if}
  </header>

  {#if !state}
    <div class="centre"><md-circular-progress indeterminate></md-circular-progress></div>
  {:else if state.status === 'idle'}
    <p class="md-typescale-body-medium lede">
      睇下呢個網站嘅私隱政策實際講咗啲咩。分析會將條款文字送去你設定嘅模型。
    </p>
    <md-filled-button onclick={analyse}>分析呢個網站</md-filled-button>
  {:else if state.status === 'working'}
    <div class="centre">
      <md-circular-progress indeterminate></md-circular-progress>
      <p class="md-typescale-body-small">搵緊條款，然後交畀模型…</p>
    </div>
  {:else if state.status === 'unavailable'}
    <p class="md-typescale-body-medium lede">{state.reason}</p>
    {#if state.links?.length}
      <ul class="links">
        {#each state.links as link (link)}
          <li>
            <a href={link} target="_blank" rel="noreferrer noopener" class="md-typescale-body-small">
              {link.replace(/^https?:\/\//, '')}
            </a>
          </li>
        {/each}
      </ul>
    {/if}
    <p class="md-typescale-body-small hint">
      搵唔到就係搵唔到 —— 我哋唔會拎第二版嘢當條款嚟摘要。
    </p>
  {:else if state.status === 'error'}
    <p class="md-typescale-body-medium lede">{state.message}</p>
    <md-filled-button onclick={analyse}>再試一次</md-filled-button>
    <md-text-button onclick={() => chrome.runtime.openOptionsPage()}>去設定</md-text-button>
  {:else}
    {@const summary = state.summary}
    <section class="score" data-band={riskBand(summary.riskScore)}>
      <span class="value">{summary.riskScore}</span>
      <span class="band md-typescale-body-medium">{BAND_LABELS[riskBand(summary.riskScore)]}</span>
    </section>

    {#if summary.truncated}
      <p class="md-typescale-body-small notice">
        呢份文件太長，只分析咗開頭一部分。
      </p>
    {/if}
    {#if summary.droppedPoints > 0}
      <p class="md-typescale-body-small notice">
        有 {summary.droppedPoints} 點因為引文對唔返原文而被丟棄。
      </p>
    {/if}

    <div class="points">
      {#each summary.points as point (point.title + point.quote)}
        <PolicyPointCard {point} policyUrl={summary.policyUrl} />
      {/each}
    </div>

    {#if summary.points.length === 0}
      <p class="md-typescale-body-medium lede">
        模型冇報告到任何可以喺原文核實嘅風險點。
      </p>
    {/if}

    <footer class="meta md-typescale-body-small">
      <span>{state.cached ? '來自快取' : '啱啱分析'}</span>
      <md-text-button onclick={analyse}>重新分析</md-text-button>
    </footer>
  {/if}

  <p class="md-typescale-body-small disclaimer">
    僅供參考，唔係法律意見。以原文為準。
  </p>
</main>

<style>
  main {
    width: 380px;
    box-sizing: border-box;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  header h1 {
    margin: 0;
  }
  .domain {
    margin: 2px 0 0;
    color: var(--md-sys-color-on-surface-variant);
  }
  .lede {
    margin: 0;
    color: var(--md-sys-color-on-surface-variant);
  }
  .hint,
  .notice {
    margin: 0;
    color: var(--md-sys-color-on-surface-variant);
  }
  .notice {
    background: var(--md-sys-color-surface-container-high);
    border-radius: 8px;
    padding: 8px 10px;
  }
  .centre {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 24px 0;
    color: var(--md-sys-color-on-surface-variant);
  }
  .score {
    display: flex;
    align-items: baseline;
    gap: 10px;
    border-radius: 12px;
    padding: 12px 14px;
  }
  .score[data-band='low'] {
    background: var(--md-sys-color-success-container);
    color: var(--md-sys-color-on-success-container);
  }
  .score[data-band='moderate'] {
    background: var(--md-sys-color-warning-container);
    color: var(--md-sys-color-on-warning-container);
  }
  .score[data-band='high'] {
    background: var(--md-sys-color-error-container);
    color: var(--md-sys-color-on-error-container);
  }
  .score .value {
    font-size: 34px;
    font-weight: 700;
    line-height: 1;
  }
  .links {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .links a {
    color: var(--md-sys-color-primary);
    word-break: break-all;
  }
  .points {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--md-sys-color-on-surface-variant);
  }
  .disclaimer {
    margin: 0;
    padding-top: 4px;
    border-top: 1px solid var(--md-sys-color-outline-variant);
    color: var(--md-sys-color-on-surface-variant);
  }
</style>
