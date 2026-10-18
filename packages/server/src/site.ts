/**
 * The public query site, served by the results server itself: static files from `public/` and clean URLs for its three pages.
 *
 * The pages are plain HTML, CSS and JavaScript with no build step, and read results from this same server's public API, so
 * one process answers both the site and the API.
 *
 * `/api/*` and `/models/*` belong to the API and are never answered here.
 */
import { resolve, sep } from 'node:path';

const DEFAULT_PUBLIC = resolve(import.meta.dir, '../public');

/** Clean URLs: `/docs` is docs.html, `/site/github.com` is site.html (which reads the domain from the path). */
function pageFor(pathname: string): string | null {
  if (pathname === '/') return 'index.html';
  if (pathname === '/docs') return 'docs.html';
  if (/^\/site\/[^/]+\/?$/.test(pathname)) return 'site.html';
  return null;
}

/** Scripts, styles and fonts only from this origin, and the page may call nothing but this origin's API. */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export interface Site {
  /** The response for a site address, or null when the path is not the site's to answer (the API's prefixes). */
  respond(req: Request): Promise<Response | null>;
}

export function createSite(options: { publicDir?: string } = {}): Site {
  const publicDir = resolve(options.publicDir ?? DEFAULT_PUBLIC);

  const secure = (response: Response, cache: string): Response => {
    response.headers.set('content-security-policy', CSP);
    response.headers.set('x-content-type-options', 'nosniff');
    response.headers.set('referrer-policy', 'no-referrer');
    response.headers.set('cache-control', cache);
    return response;
  };

  const notFound = async (): Promise<Response> => {
    const page = Bun.file(resolve(publicDir, '404.html'));
    const body = (await page.exists()) ? page : 'Not found';
    return secure(new Response(body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }), 'no-cache');
  };

  return {
    async respond(req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return null;

      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(req.url).pathname);
      } catch {
        return notFound();
      }
      if (/^\/(api|models)(\/|$)/.test(pathname) || pathname === '/health') return null;

      const page = pageFor(pathname);
      const relative = page ?? pathname.slice(1);
      const full = resolve(publicDir, relative);
      // Whatever the path decoded to, it must stay inside the public folder.
      if (relative === '' || relative.includes('\0') || !(full + sep).startsWith(publicDir + sep)) return notFound();

      const file = Bun.file(full);
      if (!(await file.exists()) || (await file.stat().then((s) => s.isDirectory()).catch(() => true))) return notFound();

      // Pages change with the site; fonts never change under the same name; the rest is short-lived.
      const cache = page ? 'no-cache' : relative.startsWith('fonts/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
      return secure(new Response(req.method === 'HEAD' ? null : file), cache);
    },
  };
}
