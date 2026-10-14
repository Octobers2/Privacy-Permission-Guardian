<script lang="ts">
  import '@material/web/button/filled-button.js';
  import '@material/web/button/outlined-button.js';
  import '@material/web/button/text-button.js';
  import { onMount } from 'svelte';
  import { DEFAULT_PREFS, loadPrefs, onPrefsChanged, savePrefs, type Prefs } from '../prefs.ts';
  import { normaliseServer, signIn } from '../setup/api.ts';
  import Icon from './components/Icon.svelte';
  import Mark from './components/Mark.svelte';
  import Switch from './components/Switch.svelte';
  import TextField from './components/TextField.svelte';

  let prefs = $state<Prefs>(DEFAULT_PREFS);
  let loaded = $state(false);

  let serverUrl = $state('');
  let serverMessage = $state('');
  let byok = $state({ baseUrl: '', apiKey: '', model: '' });
  let byokSaved = $state(false);
  let username = $state('');
  let password = $state('');
  let accountMessage = $state('');
  let busy = $state(false);

  onMount(async () => {
    prefs = await loadPrefs();
    serverUrl = prefs.serverUrl;
    byok = { ...prefs.byok };
    loaded = true;
  });
  onPrefsChanged((next) => (prefs = next));

  const persist = async (patch: Partial<Prefs>) => (prefs = await savePrefs(patch));

  async function saveServer() {
    try {
      const normalised = normaliseServer(serverUrl);
      await persist({ serverUrl: normalised });
      serverUrl = normalised;
      serverMessage = 'Saved.';
    } catch (error) {
      serverMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function saveByok() {
    await persist({ byok });
    byokSaved = true;
    setTimeout(() => (byokSaved = false), 2_000);
  }

  async function doSignIn() {
    busy = true;
    accountMessage = '';
    try {
      await persist({ account: await signIn(prefs.serverUrl, username.trim(), password) });
      password = '';
    } catch (error) {
      accountMessage = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  const addAllowed = (domain: string) => persist({ allowlist: [...new Set([...prefs.allowlist, domain])] });
  const removeAllowed = (domain: string) => persist({ allowlist: prefs.allowlist.filter((d) => d !== domain) });
  const openSetup = () => chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') });
  const expired = $derived(prefs.account !== null && prefs.account.expiresAt <= Date.now());
</script>

<main>
  <header class="top">
    <Mark size={34} />
    <h1>Settings</h1>
  </header>

  {#if loaded}
    <section class="setting">
      <div class="what">
        <h2>On-device model</h2>
        <p>The model that reads terms of service on your computer.</p>
      </div>
      <div class="how">
        <p class="value">
          {#if prefs.setupDone && prefs.modelId}Installed: <strong>{prefs.modelId}</strong>{:else}Not set up yet.{/if}
        </p>
        <div class="row"><md-outlined-button onclick={openSetup}>{prefs.setupDone ? 'Change model or run setup again' : 'Run setup'}</md-outlined-button></div>
        <TextField label="Server address" bind:value={serverUrl} type="url" supportingText="Where models are downloaded from and results are looked up." />
        <div class="row">
          <md-filled-button onclick={saveServer}>Save address</md-filled-button>
          {#if serverMessage}<span class="note">{serverMessage}</span>{/if}
        </div>
      </div>
    </section>

    <section class="setting">
      <div class="what">
        <h2>Plain-language summaries</h2>
        <p>Optional, and off by default.</p>
      </div>
      <div class="how">
        <div class="radios" role="radiogroup" aria-label="Summary source">
          {#each [{ id: 'off', label: 'Off', hint: 'Only the flagged clauses are shown.' }, { id: 'server', label: 'From the server', hint: 'The flagged clauses of public pages are sent to the server, which asks an AI model to explain them.' }, { id: 'byok', label: 'From my own endpoint', hint: 'The flagged clauses go straight to an OpenAI-compatible endpoint you provide, and nowhere else.' }] as option}
            <label class="radio" class:chosen={prefs.summary === option.id}>
              <input type="radio" name="summary" value={option.id} checked={prefs.summary === option.id} onchange={() => persist({ summary: option.id as Prefs['summary'] })} />
              <span><strong>{option.label}</strong><span class="hint">{option.hint}</span></span>
            </label>
          {/each}
        </div>
        <p class="note"><Icon name="lock" size={16} /> Pages that look like they show personal information are never summarised, whatever you choose.</p>
        {#if prefs.summary === 'byok'}
          <TextField label="Endpoint" bind:value={byok.baseUrl} type="url" supportingText="Base URL, e.g. https://api.openai.com/v1" />
          <TextField label="API key" bind:value={byok.apiKey} type="password" supportingText="Stored in this browser only." />
          <TextField label="Model" bind:value={byok.model} />
          <div class="row">
            <md-filled-button onclick={saveByok}>Save</md-filled-button>
            {#if byokSaved}<span class="note">Saved.</span>{/if}
          </div>
        {/if}
      </div>
    </section>

    <section class="setting">
      <div class="what">
        <h2>Contributor account</h2>
        <p>Optional. Share what the model finds so other people can look it up.</p>
      </div>
      <div class="how">
        {#if prefs.account && !expired}
          <p class="value">Signed in as <strong>{prefs.account.username}</strong>. Flagged clauses from public terms pages are shared automatically. Pages that look personal never are.</p>
          <div class="row"><md-outlined-button onclick={() => persist({ account: null })}>Sign out</md-outlined-button></div>
        {:else}
          {#if expired}<p class="note">Your sign-in has expired. Sign in again to keep sharing.</p>{/if}
          <TextField label="Username" bind:value={username} />
          <TextField label="Password" bind:value={password} type="password" />
          {#if accountMessage}<p class="error" role="alert">{accountMessage}</p>{/if}
          <div class="row"><md-filled-button onclick={doSignIn} disabled={busy || !username || !password}>Sign in</md-filled-button></div>
        {/if}
      </div>
    </section>

    <section class="setting">
      <div class="what">
        <h2>Form warnings</h2>
        <p>The warning shown on forms that look like phishing. It works offline and never uses the model.</p>
      </div>
      <div class="how">
        <Switch checked={prefs.paused} label="Pause warnings" description="No banners on any site until you turn this off." onchange={(paused) => persist({ paused })} />
        <div>
          <h3>Sites where warnings stay quiet</h3>
          {#if prefs.allowlist.length === 0}
            <p class="note">None. Use “Do not warn me on this site” on a warning to add one.</p>
          {:else}
            <ul class="allow">
              {#each prefs.allowlist as domain (domain)}
                <li><span>{domain}</span><md-text-button onclick={() => removeAllowed(domain)}>Remove</md-text-button></li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
    </section>

    <section class="privacy" aria-labelledby="privacy-h">
      <h2 id="privacy-h">What leaves your computer</h2>
      <div class="columns">
        <div class="col stays">
          <h3><Icon name="laptop" size={18} /> Never leaves it</h3>
          <ul>
            <li>All reading and classifying</li>
            <li>What you type into forms</li>
            <li>Your browsing history</li>
            <li>Any page that shows personal information</li>
          </ul>
        </div>
        <div class="col looked">
          <h3><Icon name="info" size={18} /> Looked up</h3>
          <ul>
            <li>The address of a site’s terms page</li>
            <li>A fingerprint of its text, to find a saved result</li>
          </ul>
          <p class="to">Goes to the server above.</p>
        </div>
        <div class="col shared">
          <h3><Icon name="upload" size={18} /> Only if you opt in</h3>
          <ul>
            <li>Flagged clauses of public terms pages, with the page address, if you are signed in</li>
            <li>The same clauses, for a summary, if you chose a summary source</li>
          </ul>
        </div>
      </div>
    </section>
  {/if}
</main>

<style>
  main {
    max-width: 860px;
    margin: 0 auto;
    padding: 36px 24px 80px;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 8px;
  }
  h1 {
    margin: 0;
    font-size: 1.75rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 0.875rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  p {
    margin: 0;
  }

  /* a setting: its name on the left, its controls on the right, a rule between them */
  .setting {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: 16px 48px;
    padding: 32px 0;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
  }
  .what p {
    margin-top: 6px;
    font-size: 0.875rem;
    line-height: 1.45;
    color: var(--md-sys-color-on-surface-variant);
  }
  .how {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 520px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .note {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.875rem;
  }
  .note :global(svg) {
    margin-top: 2px;
  }
  .value {
    font-size: 0.9375rem;
  }
  .error {
    color: var(--md-sys-color-error);
    font-size: 0.875rem;
  }
  .radios {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .radio {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    padding: 14px 16px;
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: var(--ppg-radius-control);
    cursor: pointer;
  }
  .radio.chosen {
    border-color: var(--md-sys-color-primary);
    background: var(--md-sys-color-surface-container-low);
  }
  .radio input {
    margin-top: 3px;
    accent-color: var(--md-sys-color-primary);
  }
  .radio .hint {
    display: block;
    margin-top: 2px;
    font-size: 0.8125rem;
    color: var(--md-sys-color-on-surface-variant);
  }
  .allow {
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
  }
  .allow li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 0;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
  }

  /* what leaves the computer: three columns, because the difference between them is the point */
  .privacy {
    padding-top: 36px;
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-top: 16px;
  }
  .col {
    padding: 16px 18px 18px;
    border-radius: var(--ppg-radius-surface);
    background: var(--md-sys-color-surface-container-low);
    border-top: 3px solid var(--rule);
    font-size: 0.875rem;
    line-height: 1.45;
  }
  .col h3 :global(svg) {
    color: var(--rule);
  }
  .col ul {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* the colour carries the meaning (kept / looked up / shared) and nothing else on the card is coloured */
  .stays {
    --rule: var(--md-sys-color-success);
  }
  .looked {
    --rule: var(--md-sys-color-outline);
  }
  .shared {
    --rule: var(--md-sys-color-warning);
  }
  .to {
    margin-top: 10px;
    font-size: 0.8125rem;
    color: var(--md-sys-color-on-surface-variant);
  }
  @media (max-width: 720px) {
    .setting {
      grid-template-columns: 1fr;
    }
    .columns {
      grid-template-columns: 1fr;
    }
  }
</style>
