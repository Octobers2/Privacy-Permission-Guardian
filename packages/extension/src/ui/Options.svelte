<script lang="ts">
  import '@material/web/switch/switch.js';
  import '@material/web/textfield/outlined-text-field.js';

  // W0 smoke test only; the real settings form lands in W1.
  let paused = $state(false);
</script>

<main>
  <h1 class="md-typescale-headline-small">設定</h1>

  <label class="row">
    <span class="md-typescale-body-large">全域暫停</span>
    <md-switch
      selected={paused}
      onchange={(e: Event) => (paused = (e.target as unknown as { selected: boolean }).selected)}
    ></md-switch>
  </label>

  <md-outlined-text-field label="Base URL" value="https://api.openai.com/v1"
  ></md-outlined-text-field>
</main>

<style>
  main {
    max-width: 640px;
    margin: 0 auto;
    padding: 24px 16px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  h1 {
    margin: 0;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
</style>
