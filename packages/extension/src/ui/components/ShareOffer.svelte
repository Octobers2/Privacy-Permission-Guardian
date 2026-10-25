<script lang="ts">
  import '@material/web/button/filled-button.js';
  import '@material/web/button/text-button.js';
  import { passageHasPii } from '@ppg/shared';
  import type { AnalysisResult } from '../../analysis/state.ts';

  interface Props {
    result: AnalysisResult;
    busy?: boolean;
    onanswer: (decision: 'share' | 'decline') => void;
  }
  let { result, busy = false, onanswer }: Props = $props();

  // The same filter `uploadBody` applies, so the card promises exactly what would be sent.
  const clauses = $derived(result.flagged.filter((p) => !passageHasPii(p.text)).length);
  const money = $derived((result.money ?? []).filter((m) => !passageHasPii(m.text)).length);
  const fair = $derived(Math.max(0, result.passageCount - result.flagged.length));
  const address = $derived(result.policyUrl);
</script>

<div class="offer" role="group" aria-labelledby="offer-title">
  <h3 id="offer-title">Share this result?</h3>
  <p>Reading the terms did not send anything. Sharing is a separate choice, and it is public: anyone can then look this site up without running a model.</p>
  <dl>
    <dt>Would be sent</dt>
    <dd>
      <ul>
        <li>The address of the terms, without anything after “?” or “#”: <span class="mono">{address}</span></li>
        <li>{clauses} flagged {clauses === 1 ? 'clause' : 'clauses'}{money ? `, ${money} about money` : ''}, with the model’s confidence</li>
        <li>A fingerprint of the text, the model’s name, and the number of sentences read</li>
      </ul>
    </dd>
    <dt>Stays here</dt>
    <dd>The other {fair} {fair === 1 ? 'sentence' : 'sentences'}, and anything else on the page.</dd>
  </dl>
  <div class="buttons">
    <md-text-button disabled={busy} onclick={() => onanswer('decline')}>Not now</md-text-button>
    <md-filled-button disabled={busy} onclick={() => onanswer('share')}>{busy ? 'Sharing…' : 'Share'}</md-filled-button>
  </div>
</div>

<style>
  .offer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 16px;
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--ppg-radius-surface);
    background: var(--md-sys-color-surface);
  }
  h3 {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
  }
  p {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--md-sys-color-on-surface-variant);
  }
  dl {
    margin: 0;
    display: grid;
    gap: 2px 0;
    font-size: 0.75rem;
  }
  dt {
    margin-top: 6px;
    font-weight: 600;
  }
  dd {
    margin: 0;
    color: var(--md-sys-color-on-surface-variant);
  }
  ul {
    margin: 0;
    padding-left: 18px;
  }
  .mono {
    font-family: ui-monospace, monospace;
    word-break: break-all;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
</style>
