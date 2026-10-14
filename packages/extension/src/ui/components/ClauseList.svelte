<script lang="ts">
  import { CATEGORY_HINTS, CATEGORY_LABELS, UNFAIR_CATEGORIES, type Passage } from '@ppg/shared';
  import { excerpt } from '../format.ts';

  interface Props {
    flagged: Passage[];
  }
  let { flagged }: Props = $props();

  const groups = $derived(
    UNFAIR_CATEGORIES.map((category) => ({ category, items: flagged.filter((p) => p.category === category) })).filter((g) => g.items.length > 0),
  );
</script>

<div class="groups">
  {#each groups as group (group.category)}
    <details>
      <summary>
        <span class="name">{CATEGORY_LABELS[group.category]}</span>
        <span class="count" aria-label="{group.items.length} clauses">{group.items.length}</span>
      </summary>
      <p class="hint">{CATEGORY_HINTS[group.category]}</p>
      <ul>
        {#each group.items as clause (clause.index)}
          <li>
            <!-- plain text only: clause wording comes from a web page and is never inserted as markup -->
            <span class="text" title={clause.text}>{excerpt(clause.text)}</span>
            <span class="confidence">{Math.round(Math.max(...clause.probs) * 100)}% sure</span>
          </li>
        {/each}
      </ul>
    </details>
  {/each}
</div>

<style>
  .groups {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  details {
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: 12px;
    background: var(--md-sys-color-surface);
    padding: 0 12px;
  }
  summary {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 0;
    cursor: pointer;
    font-weight: 600;
    list-style-position: inside;
  }
  .count {
    min-width: 24px;
    text-align: center;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
    font-size: 0.75rem;
  }
  .hint {
    margin: 0 0 8px;
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.8125rem;
  }
  ul {
    margin: 0 0 12px;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-left: 3px solid var(--md-sys-color-tertiary);
    padding-left: 10px;
    font-size: 0.8125rem;
    line-height: 1.4;
  }
  .confidence {
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.6875rem;
  }
</style>
