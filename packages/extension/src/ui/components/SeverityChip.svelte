<script lang="ts">
  import type { Severity } from '@ppg/shared/schemas';

  interface Props {
    severity: Severity;
  }

  let { severity }: Props = $props();

  const LABELS: Record<Severity, string> = { low: '輕微', medium: '留意', high: '嚴重' };
</script>

<!--
  Mapped onto the MD3 semantic colour roles: `error` ships with the design
  system, `warning` and `success` are generated alongside it by gen-theme.ts,
  so all three behave identically in light and dark.
-->
<span class="chip md-typescale-label-small" data-severity={severity}>{LABELS[severity]}</span>

<style>
  .chip {
    flex: none;
    border-radius: 999px;
    padding: 2px 9px;
    font-weight: 600;
    white-space: nowrap;
  }
  .chip[data-severity='low'] {
    background: var(--md-sys-color-success-container);
    color: var(--md-sys-color-on-success-container);
  }
  .chip[data-severity='medium'] {
    background: var(--md-sys-color-warning-container);
    color: var(--md-sys-color-on-warning-container);
  }
  .chip[data-severity='high'] {
    background: var(--md-sys-color-error-container);
    color: var(--md-sys-color-on-error-container);
  }
</style>
