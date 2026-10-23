const root = import.meta.dir
const ggufDir = process.env.GGUF_DIR!
Bun.serve({
  port: 5198,
  async fetch(req) {
    const u = new URL(req.url)
    const h = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' }
    let f: ReturnType<typeof Bun.file>
    if (u.pathname === '/') f = Bun.file(`${root}/index.html`)
    else if (u.pathname === '/page.js') f = Bun.file(`${root}/dist/page.js`)
    else if (u.pathname === '/wllama.wasm') f = Bun.file(`${root}/node_modules/@wllama/wllama/esm/wasm/wllama.wasm`)
    else if (u.pathname.startsWith('/gguf/')) f = Bun.file(`${ggufDir}/${u.pathname.slice(6)}`)
    else if (u.pathname.startsWith('/dist/')) f = Bun.file(`${root}${u.pathname}`)
    else return new Response('nf', { status: 404, headers: h })
    return new Response(f, { headers: h })
  },
})
console.log('http://localhost:5198')
