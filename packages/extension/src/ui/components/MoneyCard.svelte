<script lang="ts">
  import { MONEY_HINTS, MONEY_LABELS, type MoneyClause } from '@ppg/shared';

  interface Props {
    clause: MoneyClause;
    total: number;
    highlighted?: boolean;
  }
  let { clause, total, highlighted = false }: Props = $props();

  let open = $state(false);
  const long = $derived(clause.text.length > 220);
</script>

<!-- Same two voices as ClauseCard: the label is the extension speaking, the quote is the document. The text is only ever inserted as text. -->
<article class="clause fam-money" class:highlighted id="money-{clause.index}">
  <header>
    <span class="kind">{MONEY_LABELS[clause.kind]}</span>
    <span class="where" title={MONEY_HINTS[clause.kind]}>sentence {clause.index + 1} of {total}</span>
  </header>
  <blockquote class:clamped={long && !open}>{clause.text}</blockquote>
  {#if long}
    <button type="button" class="more" aria-expanded={open} onclick={() => (open = !open)}>{open ? 'Show less' : 'Show all'}</button>
  {/if}
</article>

<style>
  .clause {
    border-left: 3px solid var(--fam);
    padding: 2px 0 2px 12px;
    scroll-margin-top: 56px;
    border-radius: 0 var(--ppg-radius-quote) var(--ppg-radius-quote) 0;
    transition: background-color 400ms var(--ppg-ease);
  }
  .clause.highlighted {
    background: color-mix(in srgb, var(--fam-container) 55%, transparent);
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 10px;
    margin-bottom: 4px;
  }
  .kind {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--fam);
  }
  .where {
    font-size: 0.6875rem;
    color: var(--md-sys-color-on-surface-variant);
  }
  blockquote {
    margin: 0;
    font-family: var(--ppg-serif);
    font-size: 0.9375rem;
    line-height: 1.5;
    color: var(--md-sys-color-on-surface);
    background: linear-gradient(transparent 58%, color-mix(in srgb, var(--fam-container) 85%, transparent) 58%);
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
    display: inline;
  }
  blockquote.clamped {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .more {
    display: block;
    margin-top: 2px;
    padding: 4px 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--md-sys-color-primary);
    cursor: pointer;
  }
</style>
