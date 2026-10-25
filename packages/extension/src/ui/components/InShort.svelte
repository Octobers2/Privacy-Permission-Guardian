<script lang="ts">
  import { LEVEL_LABELS, pointLabel, type LocalSummary } from '@ppg/shared';

  interface Props {
    summary: LocalSummary;
  }
  let { summary }: Props = $props();

  const SEVERITY: Record<string, string> = { high: 'Serious', medium: 'Worth knowing', low: 'Minor' };
</script>

<!--
  Built on the device from the findings (shared/local-summary.ts): fixed wording per type, and the document's own sentence underneath.
  Quotes come from a web page and are only ever inserted as text.
-->
<div class="short" aria-labelledby="in-short-title">
  <header>
    <h3 id="in-short-title">In short</h3>
    <span class="level level-{summary.level}">{LEVEL_LABELS[summary.level]}</span>
  </header>
  <ol>
    {#each summary.points as point (point.category)}
      <li class="sev-{point.severity}">
        <span class="sev">{SEVERITY[point.severity]} · {pointLabel(point.category)}{point.count > 1 ? ` · ${point.count} clauses` : ''}</span>
        <strong>{point.title}</strong>
        <span class="detail">{point.detail}</span>
        <q>{point.quote}</q>
      </li>
    {/each}
  </ol>
</div>

<style>
  .short {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--md-sys-color-surface-container-low);
    border-radius: var(--ppg-radius-surface);
    padding: 14px 16px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  h3 {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
  }
  .level {
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .level-low {
    background: var(--md-sys-color-success-container);
    color: var(--md-sys-color-on-success-container);
  }
  .level-medium {
    background: var(--md-sys-color-warning-container);
    color: var(--md-sys-color-on-warning-container);
  }
  .level-high {
    background: var(--md-sys-color-error-container);
    color: var(--md-sys-color-on-error-container);
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  li {
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
  q {
    quotes: none;
    margin-top: 2px;
    padding-left: 10px;
    border-left: 2px solid var(--md-sys-color-outline-variant);
    font-family: var(--ppg-serif);
    font-size: 0.8125rem;
    line-height: 1.45;
    color: var(--md-sys-color-on-surface);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
