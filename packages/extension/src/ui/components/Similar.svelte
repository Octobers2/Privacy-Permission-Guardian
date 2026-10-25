<script lang="ts">
  import type { SimilarItem } from '@ppg/shared';

  interface Props {
    item: SimilarItem;
  }
  let { item }: Props = $props();
  let open = $state(false);
</script>

<!-- Stored sentences of other sites. They come from web pages and are only ever inserted as text. -->
<div class="similar">
  <button type="button" aria-expanded={open} onclick={() => (open = !open)}>
    Seen on {item.sites} other {item.sites === 1 ? 'site' : 'sites'}
  </button>
  {#if open}
    <ul>
      {#each item.examples as example (example.url)}
        <li><a href={example.url} target="_blank" rel="noreferrer">{example.domain}</a><q>{example.text}</q></li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .similar {
    margin-top: 2px;
  }
  button {
    padding: 4px 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--md-sys-color-primary);
    cursor: pointer;
  }
  ul {
    list-style: none;
    margin: 0 0 4px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: 10px;
    border-left: 2px solid var(--md-sys-color-outline-variant);
  }
  a {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--md-sys-color-on-surface-variant);
  }
  q {
    quotes: none;
    font-family: var(--ppg-serif);
    font-size: 0.8125rem;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
