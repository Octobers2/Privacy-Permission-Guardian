<script lang="ts">
  import { CATEGORY_LABELS, FAMILY_OF, type Passage } from '@ppg/shared';

  interface Props {
    clause: Passage;
    /** Position of the sentence in the document, for the margin note. */
    total: number;
    highlighted?: boolean;
  }
  let { clause, total, highlighted = false }: Props = $props();

  const family = $derived(FAMILY_OF[clause.category]);
  const confidence = $derived(Math.round(Math.max(...clause.probs) * 100));
  let open = $state(false);
  const LONG = 220;
  const long = $derived(clause.text.length > LONG);
</script>

<!--
  Two voices: the margin note is the extension speaking (sans); the quoted wording is the document speaking (serif, on a marker wash).
  Clause text comes from a web page and is only ever inserted as text, never as markup.
-->
<article class="clause fam-{family}" class:highlighted id="clause-{clause.index}">
  <header>
    <span class="kind">{CATEGORY_LABELS[clause.category]}</span>
    <span class="where">sentence {clause.index + 1} of {total} · {confidence}% sure</span>
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
    /* a marker wash behind the words, re-drawn on every line: the clause reads as highlighted, not boxed */
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
