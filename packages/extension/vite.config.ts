import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json' with { type: 'json' };

export default defineConfig({
  plugins: [svelte(), crx({ manifest })],
  build: {
    target: 'esnext',
    // Extension review (and our own threat model) is easier when the shipped
    // bundle is readable, and we are not optimising for download size here.
    minify: false,
  },
  server: { port: 5173, strictPort: true },
});
