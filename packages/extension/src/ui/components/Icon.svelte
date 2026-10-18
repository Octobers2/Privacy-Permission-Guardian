<script module lang="ts">
  export type IconName =
    | 'document' | 'shield' | 'tune' | 'check' | 'alert' | 'info' | 'lock' | 'refresh' | 'open' | 'close' | 'chevron' | 'upload' | 'person' | 'laptop' | 'cloud-off';
</script>

<script lang="ts">
  /**
   * A small set of icons drawn for this extension. Material Symbols is a webfont the extension's CSP and offline use rule
   * out, and a handful of simple shapes do not justify an icon package. 24 x 24, stroke-based, inheriting the text colour.
   */
  interface Props {
    name: IconName;
    size?: number;
    /** Decorative by default; give a label only when the icon alone carries the meaning. */
    label?: string;
  }
  let { name, size = 20, label }: Props = $props();

  const PATHS: Record<IconName, string> = {
    document: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5',
    shield: 'M12 3l7 3v5c0 4.6-2.9 8.4-7 10-4.1-1.6-7-5.4-7-10V6z',
    tune: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    alert: 'M12 4l9 16H3zM12 10v4.5M12 17.5v.5',
    info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v6M12 7.5v.5',
    lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3',
    refresh: 'M19 12a7 7 0 11-2.1-5M19 4v4h-4',
    open: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
    close: 'M6 6l12 12M18 6L6 18',
    chevron: 'M9 6l6 6-6 6',
    upload: 'M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14',
    person: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20c.6-3.6 3.5-5.5 7.5-5.5s6.9 1.9 7.5 5.5',
    laptop: 'M5 6h14v9H5zM3 19h18',
    'cloud-off': 'M5 17h11a4 4 0 00.5-8A6 6 0 005.6 8 4.5 4.5 0 005 17zM4 4l16 16',
  };
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : 'true'}>
  <path d={PATHS[name]} />
</svg>

<style>
  svg {
    flex: none;
    display: block;
  }
</style>
