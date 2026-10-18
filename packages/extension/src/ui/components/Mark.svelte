<script lang="ts">
  interface Props {
    size?: number;
  }
  let { size = 28 }: Props = $props();
</script>

<!-- A page of fine print with one line picked out in marker: the whole product in one shape. -->
<svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
  <path d="M8 3h11l6 6v20H8z" fill="var(--md-sys-color-surface-container-highest)" stroke="var(--md-sys-color-on-surface)" stroke-width="1.6" stroke-linejoin="round" />
  <path d="M19 3v6h6" fill="none" stroke="var(--md-sys-color-on-surface)" stroke-width="1.6" stroke-linejoin="round" />
  <rect x="11" y="13" width="11" height="3.4" rx="0.6" fill="var(--md-sys-color-rights)" opacity="0.85" />
  <path d="M11 20h10M11 24h7" stroke="var(--md-sys-color-outline)" stroke-width="1.6" stroke-linecap="round" />
</svg>
