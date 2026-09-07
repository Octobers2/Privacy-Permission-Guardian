import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Svelte's accessibility checks do not know what a `<md-*>` element is, so it
 * treats every Material button as a non-interactive div with a click handler.
 * Those elements render a real `<button>` inside their shadow root and handle
 * Enter and Space themselves.
 *
 * The filter is scoped to exactly those two warnings on exactly those tags —
 * silencing the rules outright would also hide the real thing on our own
 * markup, and a build that always prints warnings is a build nobody reads.
 */
const MATERIAL_FALSE_POSITIVES = new Set([
  'a11y_click_events_have_key_events',
  'a11y_no_static_element_interactions',
]);

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    warningFilter: (warning) =>
      !(MATERIAL_FALSE_POSITIVES.has(warning.code) && /<md-[a-z-]+>/.test(warning.message)),
  },
};
