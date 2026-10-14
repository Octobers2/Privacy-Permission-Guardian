<script lang="ts">
  import '@material/web/button/filled-button.js';
  import '@material/web/button/outlined-button.js';
  import '@material/web/button/text-button.js';
  import { onMount } from 'svelte';
  import { DEFAULT_PREFS, loadPrefs, onPrefsChanged, savePrefs, type Prefs } from '../prefs.ts';
  import { normaliseServer, signIn } from '../setup/api.ts';
  import Section from './components/Section.svelte';
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
  <h1 class="md-typescale-headline-medium">Settings</h1>

  {#if loaded}
    <Section title="On-device model" description="The model that reads terms of service on your computer.">
      <p class="value">
        {#if prefs.setupDone && prefs.modelId}Installed: <strong>{prefs.modelId}</strong>{:else}Not set up yet.{/if}
      </p>
      <div class="row"><md-outlined-button onclick={openSetup}>{prefs.setupDone ? 'Change model or run setup again' : 'Run setup'}</md-outlined-button></div>
      <TextField label="Server address" bind:value={serverUrl} type="url" supportingText="Where models are downloaded from and results are looked up." />
      <div class="row">
        <md-filled-button onclick={saveServer}>Save address</md-filled-button>
        {#if serverMessage}<span class="note">{serverMessage}</span>{/if}
      </div>
    </Section>

    <Section title="Plain-language summaries" description="Optional. Off by default.">
      <div class="radios" role="radiogroup" aria-label="Summary source">
        {#each [{ id: 'off', label: 'Off', hint: 'Only the flagged clauses are shown.' }, { id: 'server', label: 'From the server', hint: 'The flagged clauses of public pages are sent to the server, which asks an AI model to explain them.' }, { id: 'byok', label: 'From my own endpoint', hint: 'The flagged clauses go straight to an OpenAI-compatible endpoint you provide, and nowhere else.' }] as option}
          <label>
            <input type="radio" name="summary" value={option.id} checked={prefs.summary === option.id} onchange={() => persist({ summary: option.id as Prefs['summary'] })} />
            <span><strong>{option.label}</strong><br /><span class="note">{option.hint}</span></span>
          </label>
        {/each}
      </div>
      <p class="note">Pages that look like they show personal information are never summarised, whatever you choose.</p>
      {#if prefs.summary === 'byok'}
        <TextField label="Endpoint" bind:value={byok.baseUrl} type="url" supportingText="Base URL, e.g. https://api.openai.com/v1" />
        <TextField label="API key" bind:value={byok.apiKey} type="password" supportingText="Stored in this browser only." />
        <TextField label="Model" bind:value={byok.model} />
        <div class="row">
          <md-filled-button onclick={saveByok}>Save</md-filled-button>
          {#if byokSaved}<span class="note">Saved.</span>{/if}
        </div>
      {/if}
    </Section>

    <Section title="Contributor account" description="Optional. Lets you share what the model finds so other people can look it up.">
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
    </Section>

    <Section title="Form warnings" description="The warning shown on forms that look like phishing. This works offline and never uses the model.">
      <Switch checked={prefs.paused} label="Pause warnings" description="No banners on any site until you turn this off." onchange={(paused) => persist({ paused })} />
      <div>
        <h3 class="md-typescale-title-small">Sites where warnings stay quiet</h3>
        {#if prefs.allowlist.length === 0}
          <p class="note">None. Use “Do not warn me on this site” on a warning banner to add one.</p>
        {:else}
          <ul class="allow">
            {#each prefs.allowlist as domain (domain)}
              <li>{domain} <md-text-button onclick={() => removeAllowed(domain)}>Remove</md-text-button></li>
            {/each}
          </ul>
        {/if}
      </div>
    </Section>

    <Section title="What this extension sends, and what it does not">
      <ul class="privacy">
        <li><strong>Never sent:</strong> what you type into forms, your browsing history, or any page that shows personal information.</li>
        <li><strong>Looked up:</strong> the address of a site’s terms page and a fingerprint of its text, to find a saved public result. This goes to the server above.</li>
        <li><strong>Shared, only if you signed in:</strong> the flagged clauses of a public terms page, with the page address. Never the rest of the page.</li>
        <li><strong>Sent for summaries, only if you chose a source above:</strong> the flagged clauses, and nothing else.</li>
        <li><strong>On your computer:</strong> all reading and classifying. The model is downloaded once and kept in this browser.</li>
      </ul>
    </Section>
  {/if}
</main>

<style>
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 24px 16px 64px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  h1,
  h3,
  p {
    margin: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .note {
    color: var(--md-sys-color-on-surface-variant);
    font-size: 0.875rem;
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
    gap: 12px;
  }
  .radios label {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    cursor: pointer;
  }
  .radios input {
    margin-top: 4px;
    accent-color: var(--md-sys-color-primary);
  }
  .allow {
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }
  .allow li {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .privacy {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.875rem;
  }
</style>
