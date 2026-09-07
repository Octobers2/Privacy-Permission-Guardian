<script lang="ts">
  import type { PolicyCategory, PolicyPoint } from '@ppg/shared/schemas';
  import SeverityChip from './SeverityChip.svelte';

  interface Props {
    point: PolicyPoint;
    policyUrl: string;
  }

  let { point, policyUrl }: Props = $props();
  let expanded = $state(false);

  const CATEGORY_LABELS: Record<PolicyCategory, string> = {
    data_collection: '收集資料',
    third_party_sharing: '分享畀第三方',
    tracking_ads: '追蹤同廣告',
    location: '位置',
    retention: '保留期',
    user_rights: '你嘅權利',
    account_deletion: '刪除帳戶',
    jurisdiction: '司法管轄',
    children: '兒童',
    manipulation_attempt: '文件企圖操控分析',
  };
</script>

<article>
  <header>
    <!--
      Everything below comes from the model, which read attacker-controlled page
      text, so it is interpolated as text and never as markup. The guard in
      test/no-html-injection.test.ts enforces that across the whole codebase —
      which is why this comment does not spell out the directive it forbids.
    -->
    <h3 class="md-typescale-body-large">{point.title}</h3>
    <SeverityChip severity={point.severity} />
  </header>

  <p class="md-typescale-body-medium detail">{point.detail}</p>

  <footer>
    <span class="md-typescale-label-small category">{CATEGORY_LABELS[point.category]}</span>
    <button
      type="button"
      class="md-typescale-label-large"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      {expanded ? '收起原文' : '睇原文'}
    </button>
  </footer>

  {#if expanded}
    <blockquote class="md-typescale-body-small">
      {point.quote}
      <a href={policyUrl} target="_blank" rel="noreferrer noopener">開原文</a>
    </blockquote>
  {/if}
</article>

<style>
  article {
    background: var(--md-sys-color-surface-container-low);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: 12px;
    padding: 12px 14px;
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }
  h3 {
    margin: 0;
    font-weight: 600;
  }
  .detail {
    margin: 6px 0 0;
    color: var(--md-sys-color-on-surface-variant);
  }
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 8px;
  }
  .category {
    color: var(--md-sys-color-on-surface-variant);
  }
  button {
    font: inherit;
    background: none;
    border: none;
    padding: 2px 0;
    cursor: pointer;
    color: var(--md-sys-color-primary);
  }
  button:focus-visible {
    outline: 2px solid var(--md-sys-color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }
  blockquote {
    margin: 10px 0 0;
    padding: 8px 10px;
    border-left: 3px solid var(--md-sys-color-outline);
    background: var(--md-sys-color-surface-container);
    border-radius: 0 8px 8px 0;
    color: var(--md-sys-color-on-surface-variant);
  }
  blockquote a {
    display: inline-block;
    margin-top: 6px;
    color: var(--md-sys-color-primary);
  }
</style>
