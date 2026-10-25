/*
 * Scene runtime. A scene is a static page plus a builder that creates animations on a timeline measured in milliseconds.
 * The renderer (render.ts) never plays a scene: it calls `seek(t)` for every frame, so what is drawn at time t is a function of t alone.
 *
 *   scene((C, D) => { ... snap(el, C(2), 'left') ... })
 *
 * C(i) is the start (ms) of narration line i of this scene, D the scene's length. The renderer injects them as
 * `window.__cues` and `window.__duration` before the page loads; opened by hand, the scene uses made-up cues and plays in real time.
 */
const EASE_SNAP = 'cubic-bezier(.16,.9,.24,1)'; // fast, then a hard stop: a printing press, not a fade
const tickers = [];
/** Sound-effect events (ms into the scene), read by render.ts and mixed by sfx.ts. */
window.__sfx = [];
const sfx = (t, kind, gain = 1) => window.__sfx.push({ t: Math.round(t), kind, gain });

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function add(parent, html, style = {}, cls = '') {
  const node = el(html);
  Object.assign(node.style, style);
  if (cls) node.className += ' ' + cls;
  (typeof parent === 'string' ? document.querySelector(parent) : parent).append(node);
  return node;
}

/** Move into place from off its position, then lock. `dir`: left right up down; `pop`: scale from zero; `spin`: a 90 degree turn. */
function snap(node, at, dir = 'left', dur = 240, dist = 140) {
  sfx(at, dir === 'pop' ? 'pop' : 'snap', dir === 'spin' ? 1.2 : 1);
  const from = { left: `translateX(-${dist}%)`, right: `translateX(${dist}%)`, up: `translateY(-${dist}%)`, down: `translateY(${dist}%)`, pop: 'scale(0)', spin: 'rotate(-90deg) scale(0.4)' }[dir];
  // opacity jumps 0 -> 1 on the first frame (a cut, not a fade); `visibility` is left to panels, which must be able to hide their children
  const a = node.animate([{ transform: from, opacity: 0 }, { transform: from, opacity: 1, offset: 0.001 }, { transform: 'none', opacity: 1 }], {
    delay: at, duration: dur, easing: EASE_SNAP, fill: 'both',
  });
  return a;
}

/** Visible from `from` to `to` and hidden before and after: one animation, because two on the same property fight over the fill. */
function between(node, from, to) {
  return node.animate([{ visibility: 'hidden', offset: 0 }, { visibility: 'visible', offset: 0.0001 }, { visibility: 'visible', offset: 0.9999 }, { visibility: 'hidden', offset: 1 }], { delay: from, duration: Math.max(2, to - from), fill: 'both', easing: 'linear' });
}

/** A group of elements that exists between two times; its children animate on the same absolute clock. */
function panel(from, to, parent = '.stage', style = {}) {
  const p = add(parent, '<div class="abs"></div>', { inset: '0px', ...style });
  // one animation, not a show and a hide: with two, whichever was made last decides what the other's fill says before its start
  if (to === undefined || to === null) showAt(p, from);
  else between(p, from, to);
  return p;
}

/** A wipe: the element is revealed from one edge, hard-edged (clip-path), like a block of colour sliding across. */
function wipe(node, at, from = 'left', dur = 260) {
  sfx(at, 'swish');
  const hidden = { left: 'inset(0 100% 0 0)', right: 'inset(0 0 0 100%)', up: 'inset(0 0 100% 0)', down: 'inset(100% 0 0 0)' }[from];
  return node.animate([{ clipPath: hidden }, { clipPath: 'inset(0 0 0 0)' }], { delay: at, duration: dur, easing: EASE_SNAP, fill: 'both' });
}

/** Gone from a time on, instantly (a cut inside the scene). */
function hideAt(node, at) {
  return node.animate([{ visibility: 'visible' }, { visibility: 'hidden' }], { delay: at, duration: 1, fill: 'both', easing: 'steps(1, jump-end)' });
}

function showAt(node, at) {
  return node.animate([{ visibility: 'hidden' }, { visibility: 'visible' }], { delay: at, duration: 1, fill: 'both', easing: 'steps(1, jump-end)' });
}

/** A value that counts up between two times. `render(v)` writes it. Deterministic: called by seek with the time. */
function count(at, dur, from, to, render) {
  for (let k = 0; k < 14; k++) sfx(at + (k * dur) / 14, 'tick', 0.5);
  tickers.push((t) => render(Math.round(from + (to - from) * Math.min(1, Math.max(0, (t - at) / dur)))));
}

/** Calls fn(t) on every seek. For anything an animation cannot express. */
function onSeek(fn) { tickers.push(fn); }

/** Footage: a <video> or <img> inside `.screen`, or a slate that says what is missing. */
function footage(parent, src, opts = {}) {
  const screen = typeof parent === 'string' ? document.querySelector(parent) : parent;
  const isVideo = /\.(mp4|webm)$/i.test(src);
  const node = document.createElement(isVideo ? 'video' : 'img');
  if (isVideo) {
    node.muted = true; node.playsInline = true; node.preload = 'auto';
    node.dataset.start = String(opts.at ?? 0);
    node.dataset.from = String(opts.from ?? 0);
    node.dataset.speed = String(opts.speed ?? 1);
    if (opts.until !== undefined) node.dataset.until = String(opts.until);
  }
  node.src = src;
  node.addEventListener('error', () => {
    node.remove();
    const slate = document.createElement('div');
    slate.className = 'slate';
    slate.textContent = 'FOOTAGE MISSING: ' + src.split('/').slice(-2).join('/');
    screen.append(slate);
  });
  screen.append(node);
  return node;
}

async function seekVideos(t) {
  const videos = [...document.querySelectorAll('video[data-start]')];
  await Promise.all(videos.map((v) => new Promise((resolve) => {
    const start = Number(v.dataset.start), until = v.dataset.until === undefined ? Infinity : Number(v.dataset.until);
    v.style.visibility = t >= start && t < until ? 'visible' : 'hidden';
    const want = Number(v.dataset.from) + Math.max(0, t - start) / 1000 * Number(v.dataset.speed);
    const target = Number.isFinite(v.duration) ? Math.min(want, Math.max(0, v.duration - 0.04)) : want;
    if (Math.abs(v.currentTime - target) < 0.001 || v.readyState === 0) return resolve();
    const done = () => { v.removeEventListener('seeked', done); resolve(); };
    v.addEventListener('seeked', done);
    v.currentTime = target;
    setTimeout(done, 1500);
  })));
}

window.seek = async (t) => {
  for (const a of document.getAnimations()) { a.pause(); a.currentTime = t; }
  for (const f of tickers) f(t);
  await seekVideos(t);
};

window.scene = (build) => {
  const cues = window.__cues ?? Array.from({ length: 40 }, (_, i) => ({ start: 600 + i * 3200, end: 600 + i * 3200 + 2800 }));
  const duration = window.__duration ?? 30000;
  const C = (i) => (cues[i] ? cues[i].start : (cues.at(-1)?.start ?? 0));
  window.__lineEnd = (i) => (cues[i] ? cues[i].end : duration);
  const E = (i) => (cues[i] ? cues[i].end : duration);
  const start = async () => {
    await document.fonts.ready;
    if (new URLSearchParams(location.search).get('grid')) add('.stage', '<div class="gridlines"></div>');
    build(C, duration, E);
    // wait for footage to load its first frame, so frame 0 is not blank
    await Promise.all([...document.querySelectorAll('video')].map((v) => (v.readyState >= 2 ? 0 : new Promise((r) => { v.addEventListener('loadeddata', r, { once: true }); v.addEventListener('error', r, { once: true }); setTimeout(r, 4000); }))));
    await window.seek(0);
    window.__ready = true;
    // opened by hand: play in real time
    if (!window.__renderer) {
      const t0 = performance.now();
      const loop = () => { const t = (performance.now() - t0) % (duration + 1500); window.seek(Math.min(t, duration)); requestAnimationFrame(loop); };
      loop();
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
};

/* ------------------------------------------------------------------ footage placed against the narration */

/** Seconds into a clip at which a named moment happens (footage/marks.js, written by capture.ts). */
const M = (clip, name) => (window.MARKS?.[clip]?.[name] ?? 0);
const LEN = (clip) => (window.MARKS?.[clip]?._length ?? 10);

/**
 * Plays the part of a clip between two of its marks over a stretch of the scene, as fast as it takes to fit (never slower than real
 * time). The clip then simply carries on if the stretch is longer than the part. Returns the video and the speed used, so a scene can
 * label a sped-up passage as sped up.
 */
function segment(screen, clip, fromMark, toMark, start, end, { maxSpeed = 3 } = {}) {
  const from = typeof fromMark === 'number' ? fromMark : M(clip, fromMark);
  const to = typeof toMark === 'number' ? toMark : M(clip, toMark);
  const speed = Math.min(maxSpeed, Math.max(1, (to - from) / Math.max(0.5, (end - start) / 1000)));
  const video = footage(screen, `../footage/${clip}.mp4`, { at: start, from, speed, until: end });
  // what the footage does makes a sound too: a press, a warning appearing, a read finishing
  for (const [name, m] of Object.entries(window.MARKS?.[clip] ?? {})) {
    if (typeof m !== 'number' || m < from || m > to) continue;
    const t = start + ((m - from) / speed) * 1000;
    if (/clicked$/.test(name)) sfx(t, 'click', 1.1);
    else if (name === 'banner') sfx(t, clip === 'phish' ? 'alert' : 'caution');
    else if (name === 'ready' || name === 'reported' || name === 'shared' || name === 'similar-found') sfx(t, 'ding', 0.8);
  }
  return { video, speed };
}

/** A flat browser frame (white border, black bar with the address) holding a screen of the given content size. */
function browser(parent, { left, top, width, address = '', aspect = 1280 / 800 }) {
  const frame = add(parent, `<div class="frame"><div class="bar"><i></i><i></i><i></i><span>${address}</span></div><div class="screen"></div></div>`, { left: left + 'px', top: top + 'px', width: width + 'px' });
  const screen = frame.querySelector('.screen');
  screen.style.height = Math.round((width - 16) / aspect) + 'px';
  return { frame, screen };
}

/** The popup, framed without a browser bar. */
function popupFrame(parent, { left, top, height }) {
  const w = Math.round((height - 16) * (380 / 600)) + 16;
  const frame = add(parent, '<div class="frame" style="padding:8px"><div class="screen"></div></div>', { left: left + 'px', top: top + 'px', width: w + 'px' });
  frame.querySelector('.screen').style.height = height - 16 + 'px';
  return { frame, screen: frame.querySelector('.screen'), width: w };
}

/** A big caption in the left column. */
function caption(parent, text, at, until, { top = 300, size = 78, color = '#fff', tag } = {}) {
  const p = panel(at - 40, until, parent);
  if (tag) snap(add(p, `<div class="abs small txt-red">${tag}</div>`, { left: '80px', top: top - 56 + 'px' }), at, 'left', 180, 60);
  snap(add(p, `<div class="abs black" style="font-size:${size}px;line-height:.95;color:${color};width:560px">${text}</div>`, { left: '80px', top: top + 'px' }), at, 'left', 240, 90);
  return p;
}

/* ------------------------------------------------------------------ captions with different entrances, so neighbours never move alike */

/** A point `f` (0..1) of the way through narration line i. */
const F = (cues, i, f) => Math.round(cues(i) + f * (window.__lineEnd(i) - cues(i)));

/**
 * A caption that is on screen between two times, in one of five styles:
 *   slide  slides in from the left            stamp  drops in large, turned, and lands
 *   words  one word at a time, up and down    band   a red band sweeps behind the words
 *   type   typed out, letter by letter
 * Every style hard-stops; none fades.
 */
function say(parent, text, at, until, { style = 'slide', left = 80, top = 300, width = 560, size = 72, color = '#fff', tag } = {}) {
  const p = panel(at - 40, until, parent);
  if (tag) snap(add(p, `<div class="abs small txt-red">${tag}</div>`, { left: left + 'px', top: top - 52 + 'px' }), at, 'left', 180, 60);
  const base = { left: left + 'px', top: top + 'px', width: width + 'px', fontSize: size + 'px', lineHeight: '0.97', color };
  if (style === 'slide') {
    snap(add(p, `<div class="abs black">${text}</div>`, base), at, 'left', 240, 90);
  } else if (style === 'stamp') {
    sfx(at + 150, 'stamp');
    const n = add(p, `<div class="abs black">${text}</div>`, base);
    n.animate([{ transform: 'scale(1.7) rotate(-5deg)', opacity: 0 }, { transform: 'scale(1.7) rotate(-5deg)', opacity: 1, offset: 0.01 }, { transform: 'none', opacity: 1 }], { delay: at, duration: 200, easing: 'cubic-bezier(.2,.9,.2,1)', fill: 'both' });
    wipe(add(p, '<div class="block red"></div>', { left: left + 'px', top: Number(top) + n.offsetHeight + 14 + 'px', width: Math.min(width, 360) + 'px', height: '14px' }), at + 220, 'left', 220);
  } else if (style === 'words') {
    const words = text.split(' ');
    const n = add(p, '<div class="abs black"></div>', base);
    words.forEach((w, i) => {
      const span = add(n, `<span style="display:inline-block;margin-right:.28em">${w}</span>`);
      snap(span, at + i * 110, i % 2 ? 'down' : 'up', 180, 70);
    });
  } else if (style === 'band') {
    const n = add(p, `<div class="abs black">${text}</div>`, { ...base, color: '#fff' });
    // the band is as tall as the text actually came out (it wraps), measured, not guessed
    const bar = el('<div class="block red"></div>');
    Object.assign(bar.style, { left: left - 24 + 'px', top: Number(top) - 14 + 'px', width: width + 48 + 'px', height: n.offsetHeight + 30 + 'px' });
    p.insertBefore(bar, n);
    wipe(bar, at, 'left', 260);
    snap(n, at + 180, 'up', 200, 50);
  } else if (style === 'type') {
    for (let k = 0; k < Math.min(36, text.replace(/<br>/g, '').length); k++) sfx(at + k * 38, 'type', 0.7);
    const n = add(p, '<div class="abs black"></div>', base);
    const plain = text.replace(/<br>/g, '\n');
    onSeek((t) => { const k = Math.max(0, Math.min(plain.length, Math.floor((t - at) / 38))); n.innerHTML = plain.slice(0, k).replace(/\n/g, '<br>') + (k < plain.length && t >= at ? '<span style="color:#e1251b">█</span>' : ''); });
  }
  return p;
}

/** A hard colour sweep across the stage: a scene's way in, in a different direction each time. */
function sweep(at, from = 'left', color = '#e1251b', dur = 320) {
  sfx(at, 'whoosh');
  const b = add('.stage', '<div class="block"></div>', { left: '0px', top: '0px', width: '1920px', height: '1080px', background: color, zIndex: 40 });
  b.animate([{ clipPath: { left: 'inset(0 100% 0 0)', right: 'inset(0 0 0 100%)', up: 'inset(0 0 100% 0)', down: 'inset(100% 0 0 0)' }[from] }, { clipPath: 'inset(0 0 0 0)', offset: 0.5 }, { clipPath: { left: 'inset(0 0 0 100%)', right: 'inset(0 100% 0 0)', up: 'inset(100% 0 0 0)', down: 'inset(0 0 100% 0)' }[from] }], { delay: at, duration: dur * 2, easing: 'cubic-bezier(.7,0,.3,1)', fill: 'both' });
  return b;
}

/** A red outline with a small label, snapped onto a part of a screen (box in percent of the screen), for exactly as long as the voice is on it. */
function callout(screen, box, label, at, until, { tab = 'top' } = {}) {
  const frame = add(screen, '<div class="abs"></div>', { left: box[0] + '%', top: box[1] + '%', width: box[2] + '%', height: box[3] + '%', border: '5px solid #e1251b', zIndex: 6 });
  const tag = add(frame, `<div class="abs black red" style="font-size:24px;padding:4px 10px;white-space:nowrap;line-height:1.1">${label}</div>`, tab === 'top' ? { left: '-5px', top: '-38px' } : { left: '-5px', bottom: '-38px' });
  between(frame, at, until);
  snap(frame, at, 'pop', 180);
  return frame;
}
