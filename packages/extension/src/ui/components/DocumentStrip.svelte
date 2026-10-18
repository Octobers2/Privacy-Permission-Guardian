<script lang="ts">
  import { CATEGORY_LABELS, FAMILY_OF, type Family, type Passage } from '@ppg/shared';

  interface Props {
    /** Sentences in the document (the ones that were, or will be, classified). */
    total: number;
    /** How many have been read so far; `total` once finished. Drives the read head while the model works. */
    read?: number;
    flagged: Pick<Passage, 'index' | 'category'>[];
    /** When set, ticks of other families fade back. */
    family?: Family | null;
    /** Play the flagged ticks in one after another, once. For the welcome screen. */
    reveal?: boolean;
    /** Show the unread part as faint placeholders and a moving read head. */
    working?: boolean;
    /** Nothing has been read: every tick is a faint placeholder. */
    ghost?: boolean;
    height?: number;
    onpick?: (index: number) => void;
  }
  let { total, read = total, flagged, family = null, reveal = false, working = false, ghost = false, height = 44, onpick }: Props = $props();

  // A flagged tick should stay at least ~3 px wide however many sentences share the strip, so it is always seen.
  let pixels = $state(348);

  const MAX_TICKS = 240;
  const bins = $derived(Math.min(Math.max(total, 1), MAX_TICKS));
  const markWidth = $derived(Math.max(0.8, (3 * bins) / Math.max(pixels, 1)));
  const binOf = (index: number) => Math.min(bins - 1, Math.floor((index / Math.max(total, 1)) * bins));

  // One entry per tick: the first flagged sentence that falls in it, if any (a bin is wider than a sentence only in long documents).
  const marks = $derived.by(() => {
    const m = new Map<number, Pick<Passage, 'index' | 'category'>>();
    for (const f of flagged) if (!m.has(binOf(f.index))) m.set(binOf(f.index), f);
    return m;
  });
  const readBins = $derived(Math.min(bins, Math.round((read / Math.max(total, 1)) * bins)));
  const summary = $derived(
    flagged.length === 0 ? `${total} sentences read, none flagged` : `${total} sentences, ${flagged.length} flagged at these positions in the document`,
  );

  function pick(event: MouseEvent) {
    if (!onpick || flagged.length === 0) return;
    const box = (event.currentTarget as SVGElement).getBoundingClientRect();
    const target = ((event.clientX - box.left) / box.width) * total;
    onpick(flagged.reduce((best, f) => (Math.abs(f.index - target) < Math.abs(best.index - target) ? f : best)).index);
  }
</script>

<!--
  The strip is a picture of the document. Clicking it is a pointer shortcut to the nearest flagged clause; the keyboard route to the same
  clauses is the list that always sits directly below it, so nothing here is reachable only by mouse.
-->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<svg class="strip" class:working class:clickable={!!onpick} viewBox="0 0 {bins} 44" preserveAspectRatio="none" role="img" aria-label={summary} {height} bind:clientWidth={pixels} onclick={pick}>
  {#each { length: bins } as _, i}
    {@const mark = marks.get(i)}
    {@const done = !ghost && (i < readBins || !working)}
    {#if mark}
      <rect
        class="tick flagged fam-{FAMILY_OF[mark.category]}"
        class:dim={family !== null && FAMILY_OF[mark.category] !== family}
        class:reveal
        style={reveal ? `animation-delay:${400 + [...marks.keys()].indexOf(i) * 110}ms` : ''}
        x={i + 0.5 - markWidth / 2}
        y="3"
        width={markWidth}
        height="38"
        rx={Math.min(0.4, markWidth / 2)}
      >
        <title>{CATEGORY_LABELS[mark.category]} · sentence {mark.index + 1}</title>
      </rect>
    {:else}
      <rect class="tick plain" class:unread={!done} x={i + 0.25} y="17" width="0.5" height="10" rx="0.2" />
    {/if}
  {/each}
  {#if working && readBins < bins}
    <rect class="head" x={readBins} y="0" width="0.9" height="44" />
  {/if}
</svg>

<style>
  .strip {
    display: block;
    width: 100%;
    overflow: visible;
  }
  .clickable {
    cursor: pointer;
  }
  .tick.plain {
    fill: var(--md-sys-color-outline);
    opacity: 0.45;
  }
  .tick.plain.unread {
    opacity: 0.14;
  }
  .tick.flagged {
    fill: var(--fam);
    transition: opacity 160ms var(--ppg-ease);
  }
  .tick.flagged.dim {
    opacity: 0.22;
  }
  .head {
    fill: var(--md-sys-color-primary);
    opacity: 0.9;
  }
  .reveal {
    transform-box: fill-box;
    transform-origin: center bottom;
    animation: rise 520ms var(--ppg-ease) both;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: scaleY(0.15);
    }
    to {
      opacity: 1;
      transform: scaleY(1);
    }
  }
</style>
