const built = await Bun.build({ entrypoints: ['page.ts'], target: 'browser', outdir: 'dist' })
if (!built.success) { console.error(built.logs); process.exit(1) }
Bun.serve({ port: 5199, fetch(r) {
  const u = new URL(r.url).pathname
  if (u.startsWith('/models/')) {
    // our-backend layout: /models/<id>/resolve/main/<file>  (WebLLM appends resolve/main/)
    const rel = u.slice('/models/'.length).replace('/resolve/main/', '/')
    const f = Bun.file('/tmp/claude-1000/models/' + rel)
    return new Response(f, { headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=31536000, immutable' } })
  }
  if (u === '/page.js') return new Response(Bun.file('dist/page.js'))
  return new Response(Bun.file('index.html'))
} })
console.log('serving :5199')
