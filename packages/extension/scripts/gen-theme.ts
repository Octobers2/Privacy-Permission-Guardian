/**
 * Generates the Material Design 3 colour tokens used by the popup, the options
 * page and the injected banner.
 *
 * This runs at development time only: the output CSS is committed, and
 * `@material/material-color-utilities` stays a devDependency so none of it ends
 * up in the shipped bundle.
 *
 *   bun run scripts/gen-theme.ts --seed '#2E6FF2'
 */
import {
  Hct,
  SchemeNeutral,
  SchemeTonalSpot,
  MaterialDynamicColors,
  DynamicColor,
  DynamicScheme,
  customColor,
  argbFromHex,
  hexFromArgb,
} from '@material/material-color-utilities';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** MD3 ships one semantic colour (`error`). Risk levels need three. */
const CUSTOM_COLOURS = [
  { name: 'success', hex: '#2E7D32' },
  { name: 'warning', hex: '#F9A825' },
  // The four kinds of clause, as marker colours: what a clause does to you, not how bad it is.
  { name: 'rights', hex: '#D8432B' }, // vermilion: arbitration, jurisdiction, choice of law
  { name: 'liability', hex: '#C98A0A' }, // ochre: limits on what they answer for
  { name: 'control', hex: '#7352C1' }, // violet: changing terms, ending accounts, removing content
  { name: 'consent', hex: '#0F8B8D' }, // teal: agreeing by using
] as const;

const OUT_ROOT = resolve(import.meta.dir, '../src/ui/theme/md3-tokens.css');
/**
 * The injected banner lives in a shadow root, where `:root` does not reach and
 * would leak into the host page anyway, so it gets its own `:host` copy.
 */
const OUT_HOST = resolve(import.meta.dir, '../src/content/md3-tokens-host.css');

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

/** `onPrimaryContainer` -> `on-primary-container` */
function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Every MaterialDynamicColors static that is an actual colour role. */
function dynamicColourRoles(): [string, DynamicColor][] {
  const MDC = MaterialDynamicColors as unknown as Record<string, unknown>;
  return Object.getOwnPropertyNames(MDC)
    .filter((name) => MDC[name] instanceof DynamicColor)
    // Palette key colours are an implementation detail of the scheme, not a
    // role anything is allowed to reference.
    .filter((name) => !name.endsWith('PaletteKeyColor'))
    .map((name) => [name, MDC[name] as DynamicColor]);
}

function schemeVars(scheme: DynamicScheme, sourceArgb: number, dark: boolean): string[] {
  const lines = dynamicColourRoles().map(
    ([name, role]) => `  --md-sys-color-${kebab(name)}: ${hexFromArgb(role.getArgb(scheme))};`,
  );

  for (const { name, hex } of CUSTOM_COLOURS) {
    const group = customColor(sourceArgb, { name, value: argbFromHex(hex), blend: true });
    const g = dark ? group.dark : group.light;
    lines.push(
      `  --md-sys-color-${name}: ${hexFromArgb(g.color)};`,
      `  --md-sys-color-on-${name}: ${hexFromArgb(g.onColor)};`,
      `  --md-sys-color-${name}-container: ${hexFromArgb(g.colorContainer)};`,
      `  --md-sys-color-on-${name}-container: ${hexFromArgb(g.onColorContainer)};`,
    );
  }

  return lines;
}

const seed = arg('--seed', '#2A4A5F');
const sourceArgb = argbFromHex(seed);
const source = Hct.fromInt(sourceArgb);

// `neutral` keeps the interface itself almost colourless, so the marker colours are the only chroma on the page.
const Scheme = arg('--scheme', 'neutral') === 'tonal' ? SchemeTonalSpot : SchemeNeutral;
const light = schemeVars(new Scheme(source, false, 0), sourceArgb, false);
const dark = schemeVars(new Scheme(source, true, 0), sourceArgb, true);

const header = `/*
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: bun run scripts/gen-theme.ts --seed '${seed}' --scheme ${arg('--scheme', 'neutral')}
 *
 * Seed colour: ${seed}
 * Custom semantic colours: ${CUSTOM_COLOURS.map((c) => `${c.name} ${c.hex}`).join(', ')}
 */
`;

function sheet(selector: string): string {
  return `${header}
${selector} {
${light.join('\n')}
}

@media (prefers-color-scheme: dark) {
  ${selector} {
${dark.map((l) => '  ' + l).join('\n')}
  }
}
`;
}

writeFileSync(OUT_ROOT, sheet(':root'));
writeFileSync(OUT_HOST, sheet(':host'));
console.log(`wrote ${OUT_ROOT}`);
console.log(`wrote ${OUT_HOST}`);
console.log(`  ${light.length} light tokens, ${dark.length} dark tokens, seed ${seed}`);
