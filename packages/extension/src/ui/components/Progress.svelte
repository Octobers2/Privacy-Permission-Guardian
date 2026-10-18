<script lang="ts">
  import '@material/web/progress/linear-progress.js';

  interface Props {
    /** 0..1, or null for an indeterminate bar. */
    value: number | null;
    label: string;
  }
  let { value, label }: Props = $props();

  let element = $state<HTMLElement & { value: number; indeterminate: boolean }>();

  // Material's progress bar is a custom element: value and indeterminate are properties, not attributes.
  $effect(() => {
    if (!element) return;
    element.indeterminate = value === null;
    if (value !== null) element.value = Math.min(1, Math.max(0, value));
  });
</script>

<md-linear-progress bind:this={element} aria-label={label}></md-linear-progress>

<style>
  md-linear-progress {
    width: 100%;
  }
</style>
