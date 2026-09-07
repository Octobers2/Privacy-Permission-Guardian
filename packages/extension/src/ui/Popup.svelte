<script lang="ts">
  import '@material/web/button/filled-button.js';

  // W0 smoke test: proves Lit renders inside an MV3 extension page without
  // tripping the extension_pages CSP. Replaced by the real panel in W2.
  let clicks = $state(0);
</script>

<main>
  <h1 class="md-typescale-title-medium">Privacy &amp; Permission Guardian</h1>
  <p class="md-typescale-body-medium">
    W0 smoke test — Lit renders under the MV3 CSP.
  </p>
  <md-filled-button onclick={() => clicks++}>
    分析呢個網站 ({clicks})
  </md-filled-button>
</main>

<style>
  main {
    width: 360px;
    box-sizing: border-box;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }
  h1 {
    margin: 0;
  }
  p {
    margin: 0;
    color: var(--md-sys-color-on-surface-variant);
  }
</style>
