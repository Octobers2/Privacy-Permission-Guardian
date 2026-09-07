<script lang="ts">
  import '@material/web/textfield/outlined-text-field.js';

  interface Props {
    label: string;
    value: string;
    type?: 'text' | 'password' | 'number' | 'url';
    supportingText?: string;
    placeholder?: string;
  }

  let { label, value = $bindable(), type = 'text', supportingText = '', placeholder = '' }: Props =
    $props();

  let element = $state<HTMLElement & { value: string }>();

  // Material's fields are custom elements, so the value is a property rather
  // than an attribute. Setting it through an effect keeps the binding
  // deterministic instead of relying on how Svelte guesses for unknown tags.
  $effect(() => {
    if (element && element.value !== value) element.value = value;
  });
</script>

<md-outlined-text-field
  bind:this={element}
  {label}
  {type}
  {placeholder}
  supporting-text={supportingText}
  oninput={(event: Event) => (value = (event.target as HTMLInputElement).value)}
></md-outlined-text-field>

<style>
  md-outlined-text-field {
    width: 100%;
  }
</style>
