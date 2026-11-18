// MyPACS motion layer: builds the living background, runs the cursor lighting, staggers entrances.
// Load after mockstore.js (it reads the Settings switches from there).
(function () {
  const root = document.documentElement;
  const s = window.MockStore ? MockStore.settings() : { background: true, lighting: true, motion: true };
  root.dataset.bg = s.background ? 'on' : 'off';
  root.dataset.light = s.lighting ? 'on' : 'off';
  root.dataset.motion = s.motion ? 'on' : 'off';
  const zq = new URLSearchParams(location.search).get('size');   // ?size=90 previews a size without saving it
  root.dataset.size = ['100', '90', '80'].includes(zq) ? zq : (s.size || '100');
  window.MyFx = { apply(k, on) { root.dataset[k] = on ? 'on' : 'off'; }, size(v) { root.dataset.size = v; window.dispatchEvent(new Event('resize')); } };

  // ---- living background: slow drifting colour clouds over the Figma image ----
  const host = document.querySelector('.backdrop, .home, .signin .art .base');
  if (host) {
    const aurora = document.createElement('div'); aurora.className = 'aurora';
    const blobs = [
      // colour, left, top, drift x, drift y, scale, seconds, size, opacity
      ['rgba(64,224,190,.55)', '-10%', '35%', '38rem', '-16rem', 1.25, 24, '105rem', .5],
      ['rgba(20,120,110,.7)', '45%', '-25%', '-30rem', '22rem', 1.15, 31, '120rem', .55],
      ['rgba(150,120,255,.38)', '60%', '40%', '-24rem', '-20rem', 1.3, 27, '80rem', .45],
      ['rgba(170,240,205,.42)', '15%', '70%', '46rem', '-10rem', 1.1, 35, '90rem', .4],
    ];
    blobs.forEach(([c, l, t, x, y, sc, d, w, o], n) => {
      const i = document.createElement('i');
      i.style.cssText = `--c:${c};left:${l};top:${t};--x:${x};--y:${y};--s:${sc};--d:${d}s;--w:${w};--o:${o};animation-delay:${-n * 7}s`;
      aurora.append(i);
    });
    const grain = document.createElement('div'); grain.className = 'grain';
    const bg = host.querySelector(':scope > .bg, :scope > img');
    if (bg) bg.after(aurora, grain); else host.prepend(aurora, grain);
    if (!document.querySelector('.signin')) { const spot = document.createElement('div'); spot.className = 'spot'; grain.after(spot); }
  }

  // ---- entrance order ----
  document.querySelectorAll('.stage > *, .home > *').forEach((el, n) => el.style.setProperty('--i', Math.min(n, 34)));

  // ---- cursor lighting: a soft spot on the page and a highlight on every .lit glass panel ----
  let tx = innerWidth / 2, ty = innerHeight * .3, x = tx, y = ty, raf = 0, seen = false;
  function frame() {
    x += (tx - x) * .14; y += (ty - y) * .14;
    root.style.setProperty('--px', x + 'px'); root.style.setProperty('--py', y + 'px');
    root.style.setProperty('--nx', (x / innerWidth * 2 - 1).toFixed(3)); root.style.setProperty('--ny', (y / innerHeight * 2 - 1).toFixed(3));
    const reach = innerWidth * .09;
    document.querySelectorAll('.lit').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.bottom < -reach || r.top > innerHeight + reach) return;
      const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
      el.style.setProperty('--mx', (x - r.left) + 'px'); el.style.setProperty('--my', (y - r.top) + 'px');
      el.style.setProperty('--lo', Math.max(0, 1 - Math.hypot(dx, dy) / reach).toFixed(3));
    });
    raf = Math.abs(tx - x) + Math.abs(ty - y) > .3 ? requestAnimationFrame(frame) : 0;
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  addEventListener('pointermove', e => {
    tx = e.clientX; ty = e.clientY;
    if (!seen) { seen = true; root.style.setProperty('--spot', 1); }
    kick();
  }, { passive: true });
  addEventListener('scroll', kick, { passive: true });
  document.addEventListener('pointerleave', () => root.style.setProperty('--spot', 0));
  document.addEventListener('pointerenter', () => seen && root.style.setProperty('--spot', 1));

  // ---- small helpers the pages share ----
  MyFx.count = function (el, to, pad) {            // count a number up from 0
    const fmt = n => pad ? String(n).padStart(pad, '0') : String(n);
    if (root.dataset.motion === 'off' || document.hidden) { el.textContent = fmt(to); return; }
    const from = parseInt(el.textContent, 10) || 0, t0 = performance.now(), dur = 900;
    (function tick(t) {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(Math.round(from + (to - from) * e));
      if (k < 1) requestAnimationFrame(tick);
    })(t0);
  };
  MyFx.swap = function (el, text) {                // change a text with a small rise
    if (el.textContent === String(text)) return;
    el.textContent = text; el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap');
  };
  MyFx.toast = function (text) {
    let t = document.querySelector('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.append(t); }
    t.textContent = text; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2200);
  };
})();
