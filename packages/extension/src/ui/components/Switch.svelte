<script lang="ts">
  import '@material/web/switch/switch.js';

  interface Props {
    checked: boolean;
    label: string;
    description?: string;
    /** Called with the new state. Persisting is the caller's job. */
    onchange: (checked: boolean) => void;
  }

  let { checked, label, description = '', onchange }: Props = $props();

  let element = $state<HTMLElement & { selected: boolean }>();

  // Material's switch is a custom element, so `selected` is a property rather
  // than an attribute. Setting it through an effect keeps the binding
  // deterministic instead of relying on how Svelte guesses for unknown tags.
  $effect(() => {
    if (element && element.selected !== checked) element.selected = checked;
  });
</script>

<!--
  svelte-ignore a11y_label_has_associated_control
  md-switch is a form-associated custom element, so wrapping it in a label does
  associate at runtime; Svelte only recognises native controls. run-e2e.ts
  clicks the label text rather than the switch, so this claim is tested.
-->
<label class="row">
  <span class="text">
    <span class="md-typescale-body-large">{label}</span>
    {#if description}
      <span class="md-typescale-body-small desc">{description}</span>
    {/if}
  </span>
  <md-switch
    bind:this={element}
    onchange={(event: Event) =>
      onchange((event.target as unknown as { selected: boolean }).selected)}
  ></md-switch>
</label>

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    cursor: pointer;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .desc {
    color: var(--md-sys-color-on-surface-variant);
  }
</style>
