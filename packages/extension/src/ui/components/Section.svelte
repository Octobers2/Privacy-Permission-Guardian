<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    description?: string;
    children: Snippet;
  }

  let { title, description = '', children }: Props = $props();
</script>

<!--
  Material Design 3 does not ship a card component in @material/web, so surfaces
  are assembled here from the surface and outline tokens.
-->
<section>
  <h2 class="md-typescale-title-medium">{title}</h2>
  {#if description}
    <p class="md-typescale-body-medium">{description}</p>
  {/if}
  <div class="content">{@render children()}</div>
</section>

<style>
  section {
    background: var(--md-sys-color-surface-container-low);
    border: 1px solid var(--md-sys-color-outline-variant);
    border-radius: 16px;
    padding: 20px;
  }
  h2 {
    margin: 0;
  }
  p {
    margin: 4px 0 0;
    color: var(--md-sys-color-on-surface-variant);
  }
  .content {
    margin-top: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
</style>
