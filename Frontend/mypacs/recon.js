// MyPACS 3D reconstruction: ray-marches a DICOM series (converted by tools/dicom2vol.py) on the GPU.
// Space used everywhere: millimetres in patient axes, x = left, y = posterior, z = superior, origin at the corner of the scan.
(function () {
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  if (new URLSearchParams(location.search).get('embed')) document.documentElement.classList.add('embed');
  const set = window.MockStore ? MockStore.settings() : { lighting: true, motion: true };
  const vp = $('#vp'), cv = $('#gl'), draw = $('#draw'), dock = $('#dock');
  const gl = cv.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
  if (!gl) { $('#loading span').textContent = 'This browser cannot draw 3D (WebGL 2 is missing).'; return; }

  const params3 = new URLSearchParams(location.search);
  const S = {
    mode: 'solid', iso: .2, axis: 2, pieces: 6, gap: 0, gapNow: 0, gapOn: 40, cut: [0, 0, 0],
    yaw: .55, pitch: .12, dist: 600, pan: [0, 0, 0], tool: 'rotate', box: false, spin: false,
    light: [-.45, .5], lightTo: [-.45, .5], fade: 0, vy: 0, vp: 0, probe: null, hover: null, measures: [], pending: null,
  };
  let V = null;                 // the loaded volume
  const cache = new Map();
  const FOV = Math.tan(15 * Math.PI / 180);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---------- shader ----------
  const VS = `#version 300 es
  in vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;
  const FS = `#version 300 es
  precision highp float; precision highp sampler3D;
  uniform sampler3D uVol;            // r = value (0..1 of the bright end), g = filled body mask
  uniform vec3 uSize, uVox, uEye, uRight, uUp, uFwd, uCut, uLight;
  uniform vec2 uRes; uniform float uTan, uIso, uGap, uPieces, uStep, uFade;
  uniform int uMode, uAxis;          // 0 solid, 1 threshold, 2 glass, 3 MIP
  out vec4 o;
  float comp(vec3 v, int a){ return a == 0 ? v.x : a == 1 ? v.y : v.z; }
  // exploded space -> scan space. false in the gaps and in the cut-away parts. edge = mm to the nearest cut face
  bool toVol(vec3 e, out vec3 v, out float edge){
    v = e; edge = 1e3;
    if (uGap > .01) {
      float len = comp(uSize, uAxis), piece = len / uPieces, t = comp(e, uAxis) + (uPieces - 1.) * uGap * .5, per = piece + uGap;
      float idx = clamp(floor(t / per), 0., uPieces - 1.), f = t - idx * per;
      if (f < 0. || f > piece) return false;
      float va = idx * piece + f; edge = min(f, piece - f);
      if (uAxis == 0) v.x = va; else if (uAxis == 1) v.y = va; else v.z = va;
    }
    vec3 lo = vec3(0., uSize.y * uCut.y, 0.), hi = uSize * vec3(1. - uCut.x, 1., 1. - uCut.z);
    vec3 d = min(v - lo, hi - v); float m = min(d.x, min(d.y, d.z));
    if (m < 0.) return false;
    edge = min(edge, m); return true;
  }
  float field(vec3 e, out float raw, out float edge){
    vec3 v; raw = 0.;
    if (!toVol(e, v, edge)) return -1.;
    vec2 s = texture(uVol, v / uSize).rg; raw = s.r;
    return uMode == 0 ? s.g - .5 : s.r - uIso;
  }
  float fld(vec3 e){ float a, b; return field(e, a, b); }
  void main(){
    vec2 ndc = gl_FragCoord.xy / uRes * 2. - 1.;
    vec3 rd = normalize(uFwd + ndc.x * (uRes.x / uRes.y) * uTan * uRight + ndc.y * uTan * uUp);
    vec3 bg = mix(vec3(.035, .085, .085), vec3(0.), clamp(length(ndc) * .85, 0., 1.));
    vec3 bmin = vec3(0.), bmax = uSize; float ext = (uPieces - 1.) * uGap * .5;
    if (uAxis == 0) { bmin.x -= ext; bmax.x += ext; } else if (uAxis == 1) { bmin.y -= ext; bmax.y += ext; } else { bmin.z -= ext; bmax.z += ext; }
    vec3 inv = 1. / rd, t0 = (bmin - uEye) * inv, t1 = (bmax - uEye) * inv, tn = min(t0, t1), tf = max(t0, t1);
    float ta = max(max(tn.x, tn.y), max(tn.z, 0.)), tb = min(tf.x, min(tf.y, tf.z));
    vec3 col = bg;
    if (tb > ta) {
      float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
      float t = ta + uStep * jit, raw, edge, f;
      if (uMode < 2) {
        bool hit = false;
        for (int i = 0; i < 1500; i++) { if (t > tb) break; if (field(uEye + rd * t, raw, edge) >= 0.) { hit = true; break; } t += uStep; }
        if (hit) {
          float a = t - uStep, b = t;
          for (int i = 0; i < 6; i++) { float m = (a + b) * .5; if (fld(uEye + rd * m) >= 0.) b = m; else a = m; }
          vec3 p = uEye + rd * b; f = field(p, raw, edge);
          vec3 h = uVox, g = vec3(fld(p + vec3(h.x, 0., 0.)) - fld(p - vec3(h.x, 0., 0.)), fld(p + vec3(0., h.y, 0.)) - fld(p - vec3(0., h.y, 0.)), fld(p + vec3(0., 0., h.z)) - fld(p - vec3(0., 0., h.z))) / h;
          vec3 n = length(g) > 1e-6 ? -normalize(g) : -rd;
          vec3 l = normalize(uLight); float dif = max(dot(n, l), 0.), facing = max(dot(n, -rd), 0.);
          if (edge < .3 * min(uVox.x, min(uVox.y, uVox.z))) {          // a cut face: show the real slice
            float gry = pow(clamp(raw * 1.1, 0., 1.), .85);
            col = vec3(gry) * (.82 + .18 * dif) + vec3(.0, .012, .012);
          } else {                                                      // the natural surface
            float spec = pow(max(dot(n, normalize(l - rd)), 0.), 42.), rim = pow(1. - facing, 3.);
            col = mix(vec3(.035, .14, .14), vec3(.80, .94, .89), dif * .82 + .18 * facing) + spec * .22 + rim * vec3(.16, .40, .37);
          }
          col = mix(col, bg, clamp((b - ta) / (tb - ta + 1.), 0., 1.) * .18);
        }
      } else if (uMode == 2) {
        vec3 acc = vec3(0.); float al = 0.;
        for (int i = 0; i < 1500; i++) {
          if (t > tb || al > .97) break;
          f = field(uEye + rd * t, raw, edge);
          if (f > 0.) { float a = smoothstep(0., .22, f) * .05 * uStep; vec3 c = mix(vec3(.06, .42, .40), vec3(1., .98, .9), smoothstep(.12, .85, raw)); acc += (1. - al) * a * c; al += (1. - al) * a; }
          t += uStep;
        }
        col = acc + bg * (1. - al);
      } else {
        float m = 0.;
        for (int i = 0; i < 1500; i++) { if (t > tb) break; field(uEye + rd * t, raw, edge); m = max(m, raw); t += uStep; }
        col = max(bg, pow(m, 1.25) * vec3(.9, 1., .97));
      }
    }
    o = vec4(col * uFade, 1.);
  }`;
  function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  const prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const U = {}; for (const n of ['uVol', 'uSize', 'uVox', 'uEye', 'uRight', 'uUp', 'uFwd', 'uCut', 'uLight', 'uRes', 'uTan', 'uIso', 'uGap', 'uPieces', 'uStep', 'uFade', 'uMode', 'uAxis']) U[n] = gl.getUniformLocation(prog, n);
  const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();

  // ---------- loading ----------
  async function gunzip(url) {
    const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status);
    return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  async function fetchSeries(id) {
    if (cache.has(id)) return cache.get(id);
    const meta = await (await fetch('data/' + id + '/meta.json')).json();
    const [a, b] = await Promise.all([gunzip('data/' + id + '/vol.u16.gz'), gunzip('data/' + id + '/mask.u8.gz')]);
    const u16 = new Uint16Array(a), mask = new Uint8Array(b), n = u16.length, r8 = new Uint8Array(n), rg = new Uint8Array(n * 2), k = 255 / meta.hi;
    for (let i = 0; i < n; i++) { const v = u16[i] * k; r8[i] = v > 255 ? 255 : v; rg[2 * i] = r8[i]; rg[2 * i + 1] = mask[i]; }
    const v = { meta, u16, mask, r8, rg, dims: meta.dims, sp: meta.spacing, size: meta.dims.map((d, i) => d * meta.spacing[i]) };
    cache.set(id, v); return v;
  }
  async function load(id) {
    $('#loading').classList.remove('off');
    $$('#series button').forEach(b => b.setAttribute('aria-pressed', b.dataset.id === id));
    let v; try { v = await fetchSeries(id); } catch (e) { $('#loading span').textContent = 'Could not read the series: ' + e.message; return; }
    apply(v);
  }
  function apply(v) {
    V = v;
    gl.bindTexture(gl.TEXTURE_3D, tex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG8, v.dims[0], v.dims[1], v.dims[2], 0, gl.RG, gl.UNSIGNED_BYTE, v.rg);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    const m = v.meta;
    S.iso = clamp(m.iso / m.hi * 1.6, .02, .9); S.measures = []; S.pending = null; S.hover = null;
    S.probe = v.size.map(x => x / 2);
    $('#iso').value = Math.round(S.iso * 100);
    view0(false); fillPanel(); syncInputs(); drawSlices(); listMeasures();
    $('#loading').classList.add('off');
    if (set.motion) { S.fade = 0; S.yaw -= .9; anim.yaw = S.yaw + .9; } else S.fade = 1;
    kick();
  }
  function view0(smooth) {
    const r = Math.hypot(...V.size) / 2, t = { yaw: .55, pitch: .12, dist: r / FOV * 1.02 };
    if (smooth && set.motion) Object.assign(anim, t, { pan: [0, 0, 0] }); else { Object.assign(S, t); S.pan = [0, 0, 0]; }
  }

  // ---------- camera and mapping ----------
  const w2v = w => [w[0], -w[2], w[1]];             // viewing axes (x right, y up, z to the viewer) -> patient axes
  function cam() {
    const cy = Math.cos(S.yaw), sy = Math.sin(S.yaw), cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    const off = [sy * cp, sp, cy * cp], right = [cy, 0, -sy], up = [-sy * sp, cp, -cy * sp];
    const eyeW = [0, 1, 2].map(i => S.pan[i] + off[i] * S.dist), c = V.size.map(x => x / 2), e = w2v(eyeW);
    return { eye: [e[0] + c[0], e[1] + c[1], e[2] + c[2]], right: w2v(right), up: w2v(up), fwd: w2v(off.map(x => -x)), rw: right, uw: up };
  }
  function v2e(v) {                                 // scan space -> exploded space
    const e = v.slice();
    if (S.gapNow > .01) { const a = S.axis, piece = V.size[a] / S.pieces, i = clamp(Math.floor(v[a] / piece), 0, S.pieces - 1); e[a] = v[a] + i * S.gapNow - (S.pieces - 1) * S.gapNow / 2; }
    return e;
  }
  function e2v(e) {                                 // same test as toVol() in the shader
    const v = e.slice();
    if (S.gapNow > .01) {
      const a = S.axis, piece = V.size[a] / S.pieces, t = e[a] + (S.pieces - 1) * S.gapNow / 2, per = piece + S.gapNow;
      const i = clamp(Math.floor(t / per), 0, S.pieces - 1), f = t - i * per;
      if (f < 0 || f > piece) return null; v[a] = i * piece + f;
    }
    const z = V.size;
    if (v[0] < 0 || v[0] > z[0] * (1 - S.cut[0]) || v[1] < z[1] * S.cut[1] || v[1] > z[1] || v[2] < 0 || v[2] > z[2] * (1 - S.cut[2])) return null;
    return v;
  }
  function tri(arr, v) {                            // trilinear sample, 0..1
    const [nx, ny, nz] = V.dims, s = V.sp;
    const x = clamp(v[0] / s[0] - .5, 0, nx - 1.001), y = clamp(v[1] / s[1] - .5, 0, ny - 1.001), z = clamp(v[2] / s[2] - .5, 0, nz - 1.001);
    const x0 = x | 0, y0 = y | 0, z0 = z | 0, fx = x - x0, fy = y - y0, fz = z - z0, o = (z0 * ny + y0) * nx + x0, sy = nx, sz = nx * ny;
    const a = arr[o] * (1 - fx) + arr[o + 1] * fx, b = arr[o + sy] * (1 - fx) + arr[o + sy + 1] * fx;
    const c = arr[o + sz] * (1 - fx) + arr[o + sz + 1] * fx, d = arr[o + sz + sy] * (1 - fx) + arr[o + sz + sy + 1] * fx;
    return ((a * (1 - fy) + b * fy) * (1 - fz) + (c * (1 - fy) + d * fy) * fz) / 255;
  }
  function fieldAt(e) { const v = e2v(e); if (!v) return -1; return S.mode === 'solid' || S.mode === 'mip' ? tri(V.mask, v) - .5 : tri(V.r8, v) - S.iso; }
  function rayAt(px, py) {
    const c = cam(), w = vp.clientWidth, h = vp.clientHeight, nx = px / w * 2 - 1, ny = 1 - py / h * 2, k = w / h * FOV;
    const d = [0, 1, 2].map(i => c.fwd[i] + nx * k * c.right[i] + ny * FOV * c.up[i]), l = Math.hypot(...d);
    return { o: c.eye, d: d.map(x => x / l) };
  }
  function pick(px, py) {                           // first surface point under a screen position, in scan space
    const { o, d } = rayAt(px, py), ext = (S.pieces - 1) * S.gapNow / 2; let ta = 0, tb = 1e9;
    for (let i = 0; i < 3; i++) {
      const lo = i === S.axis ? -ext : 0, hi = V.size[i] + (i === S.axis ? ext : 0), a = (lo - o[i]) / d[i], b = (hi - o[i]) / d[i];
      ta = Math.max(ta, Math.min(a, b)); tb = Math.min(tb, Math.max(a, b));
    }
    if (!(tb > ta)) return null;
    const step = Math.min(...V.sp) * .8, at = t => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    for (let t = ta + 1e-3; t <= tb; t += step) {
      if (fieldAt(at(t)) >= 0) {
        let a = t - step, b = t; for (let i = 0; i < 8; i++) { const m = (a + b) / 2; if (fieldAt(at(m)) >= 0) b = m; else a = m; }
        return e2v(at(b));
      }
    }
    return null;
  }
  function project(e) {
    const c = cam(), d = [e[0] - c.eye[0], e[1] - c.eye[1], e[2] - c.eye[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const z = dot(d, c.fwd), w = vp.clientWidth, h = vp.clientHeight;
    return [(dot(d, c.right) / (z * FOV * w / h) + 1) / 2 * w, (1 - dot(d, c.up) / (z * FOV)) / 2 * h, z];
  }
  const vox = v => v.map((x, i) => clamp(Math.floor(x / V.sp[i]), 0, V.dims[i] - 1));
  const valAt = v => { const [i, j, k] = vox(v), r = V.meta.rescale || { scale: 1, offset: 0 }; return Math.round(V.u16[(k * V.dims[1] + j) * V.dims[0] + i] * r.scale + r.offset); };

  // ---------- drawing ----------
  let raf = 0, sharpT = 0, coarse = false;
  const anim = {};                                   // targets being eased towards
  function render(scale) {
    if (!V) return;
    const dpr = Math.min(devicePixelRatio || 1, 1.5) * scale, w = Math.max(2, Math.round(vp.clientWidth * dpr)), h = Math.max(2, Math.round(vp.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, w, h);
    const c = cam(), ms = Math.min(...V.sp);
    const lw = [0, 1, 2].map(i => -w2vInv(c.fwd)[i] + S.light[0] * c.rw[i] + S.light[1] * c.uw[i]);
    gl.uniform1i(U.uVol, 0); gl.uniform3fv(U.uSize, V.size); gl.uniform3fv(U.uVox, V.sp);
    gl.uniform3fv(U.uEye, c.eye); gl.uniform3fv(U.uRight, c.right); gl.uniform3fv(U.uUp, c.up); gl.uniform3fv(U.uFwd, c.fwd);
    gl.uniform3fv(U.uCut, S.cut); gl.uniform3fv(U.uLight, w2v(lw)); gl.uniform2f(U.uRes, w, h);
    gl.uniform1f(U.uTan, FOV); gl.uniform1f(U.uIso, S.iso); gl.uniform1f(U.uGap, S.gapNow); gl.uniform1f(U.uPieces, S.pieces);
    gl.uniform1f(U.uStep, ms * (scale < 1 ? 1.15 : .7)); gl.uniform1f(U.uFade, S.fade);
    gl.uniform1i(U.uMode, { solid: 0, iso: 1, glass: 2, mip: 3 }[S.mode]); gl.uniform1i(U.uAxis, S.axis);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    overlay();
  }
  const w2vInv = v => [v[0], v[2], -v[1]];
  function frame() {
    raf = 0; let busy = false;
    const ease = (k, rate) => { if (anim[k] === undefined) return; const d = anim[k] - S[k]; if (Math.abs(d) < 1e-3 * (Math.abs(anim[k]) + 1)) { S[k] = anim[k]; delete anim[k]; } else { S[k] += d * rate; busy = true; } };
    ease('yaw', .07); ease('pitch', .1); ease('dist', .12); ease('gapNow', .13);
    if (anim.pan) { let d = 0; S.pan = S.pan.map((p, i) => { d += Math.abs(anim.pan[i] - p); return p + (anim.pan[i] - p) * .12; }); if (d < .2) { S.pan = anim.pan; delete anim.pan; } else busy = true; }
    if (S.fade < 1) { S.fade = Math.min(1, S.fade + .035); busy = true; }
    if (!drag && (Math.abs(S.vy) > 1e-4 || Math.abs(S.vp) > 1e-4)) { S.yaw += S.vy; S.pitch = clamp(S.pitch + S.vp, -1.5, 1.5); S.vy *= .92; S.vp *= .92; busy = true; }
    if (S.spin && !drag) { S.yaw += .006; busy = true; }
    const dl = Math.abs(S.lightTo[0] - S.light[0]) + Math.abs(S.lightTo[1] - S.light[1]);
    if (dl > .004) { S.light[0] += (S.lightTo[0] - S.light[0]) * .12; S.light[1] += (S.lightTo[1] - S.light[1]) * .12; busy = true; }
    coarse = busy || !!drag || sliding;
    render(coarse ? .6 : 1);
    if (busy) kick(); else if (coarse) { clearTimeout(sharpT); sharpT = setTimeout(kick, 140); }
  }
  let sliding = false;
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }

  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, text) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; draw.append(e); return e; }
  function overlay() {
    draw.textContent = '';
    const P = v => project(v2e(v));
    if (S.box && S.gapNow < .5) {                    // size box around the body, with its three lengths
      const b = V.meta.bodyBox.map((r, i) => [r[0] * V.sp[i], (r[1] + 1) * V.sp[i]]), cn = [];
      for (let i = 0; i < 8; i++) cn.push([b[0][i & 1], b[1][i >> 1 & 1], b[2][i >> 2 & 1]]);
      const pc = cn.map(P), mid = P([0, 1, 2].map(i => (b[i][0] + b[i][1]) / 2)), best = [null, null, null];
      for (let i = 0; i < 8; i++) for (let a = 0; a < 3; a++) {
        const j = i | (1 << a); if (j === i) continue;
        el('line', { class: 'box', x1: pc[i][0], y1: pc[i][1], x2: pc[j][0], y2: pc[j][1] });
        const mx = (pc[i][0] + pc[j][0]) / 2, my = (pc[i][1] + pc[j][1]) / 2, far = Math.hypot(mx - mid[0], my - mid[1]);
        if (!best[a] || far > best[a].far) best[a] = { far, i, j, mx, my };
      }
      best.forEach((e, a) => {
        el('line', { class: 'dim', x1: pc[e.i][0], y1: pc[e.i][1], x2: pc[e.j][0], y2: pc[e.j][1] });
        const ox = e.mx - mid[0], oy = e.my - mid[1], l = Math.hypot(ox, oy) || 1;
        el('text', { class: 'dim', x: e.mx + ox / l * 34, y: e.my + oy / l * 18 + 5 }, V.meta.bodyExtentMm[a].toFixed(0) + ' mm');
      });
    }
    const ms = S.pending && S.hover ? [...S.measures, [S.pending, S.hover]] : S.measures;
    for (const [a, b] of ms) {
      const pa = P(a), pb = P(b);
      el('line', { x1: pa[0], y1: pa[1], x2: pb[0], y2: pb[1] }); el('circle', { cx: pa[0], cy: pa[1], r: 4 }); el('circle', { cx: pb[0], cy: pb[1], r: 4 });
      el('text', { x: (pa[0] + pb[0]) / 2, y: (pa[1] + pb[1]) / 2 - 9 }, mm(a, b).toFixed(1) + ' mm');
    }
    if (S.pending && !S.hover) { const p = P(S.pending); el('circle', { cx: p[0], cy: p[1], r: 4 }); }
    if (S.probe && S.tool === 'probe') { const p = P(S.probe); el('circle', { class: 'ring', cx: p[0], cy: p[1], r: 8 }); el('circle', { cx: p[0], cy: p[1], r: 2.5 }); }
    const m = V.meta, deg = x => Math.round(x * 180 / Math.PI);
    $('#ov-tl').textContent = m.label + '  ·  ' + m.modality + ' ' + m.bodyPart + '\n' + m.dims.join(' × ') + ' voxels  ·  ' + m.spacing.map(x => +x.toFixed(2)).join(' × ') + ' mm';
    $('#ov-tr').textContent = { solid: 'Solid surface', iso: 'Threshold ' + Math.round(S.iso * m.hi), glass: 'Glass  from ' + Math.round(S.iso * m.hi), mip: 'Maximum intensity' }[S.mode]
      + (S.gapNow > .5 ? '\nExploded  ' + S.pieces + ' × ' + (V.size[S.axis] / S.pieces).toFixed(1) + ' mm' : '');
    $('#ov-bl').textContent = 'Turn ' + deg(((S.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) + '°   Tilt ' + deg(S.pitch) + '°';
  }
  const mm = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // ---------- flat slices ----------
  const PL = { ax: { u: 0, v: 1, n: 2, flip: false }, co: { u: 0, v: 2, n: 1, flip: true }, sa: { u: 1, v: 2, n: 0, flip: true } };
  function drawSlices() {
    if (!V) return;
    const [nx, ny, nz] = V.dims, D = V.dims, idx = vox(S.probe), k = 255 / V.meta.hi, strd = [1, nx, nx * ny];
    for (const pane of $$('.pane')) {
      const p = PL[pane.dataset.plane], c = pane.querySelector('canvas'), w = D[p.u], h = D[p.v];
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const ctx = c.getContext('2d'), im = ctx.createImageData(w, h), px = im.data, base = idx[p.n] * strd[p.n];
      for (let y = 0, q = 0; y < h; y++) { const row = base + (p.flip ? h - 1 - y : y) * strd[p.v]; for (let x = 0; x < w; x++, q += 4) { const g = Math.min(255, V.u16[row + x * strd[p.u]] * k); px[q] = px[q + 1] = px[q + 2] = g; px[q + 3] = 255; } }
      ctx.putImageData(im, 0, 0);
      const box = pane.querySelector('.box'), fit = pane.querySelector('.fit2'), mw = V.size[p.u], mh = V.size[p.v], s = Math.min(box.clientWidth / mw, box.clientHeight / mh);
      fit.style.width = mw * s + 'px'; fit.style.height = mh * s + 'px';
      const fu = S.probe[p.u] / mw, fv = S.probe[p.v] / mh;
      pane.querySelector('i.v').style.left = fu * 100 + '%'; pane.querySelector('i.h').style.top = (p.flip ? 1 - fv : fv) * 100 + '%';
      pane.querySelector('.cap span').textContent = (idx[p.n] + 1) + ' / ' + D[p.n];
    }
    const o = V.meta.origin, pos = idx.map((i, a) => o[a] + i * V.sp[a]), L = [['R', 'L'], ['A', 'P'], ['I', 'S']];
    $('#p-pos').textContent = pos.map((x, a) => L[a][x >= 0 ? 1 : 0] + ' ' + Math.abs(x).toFixed(1)).join('  ') + ' mm';
    $('#p-vox').textContent = idx.map(i => i + 1).join(', ');
    $('#p-val').textContent = valAt(S.probe) + (V.meta.unit === 'HU' ? ' HU' : V.meta.unit === 'BQML' ? ' Bq/ml' : '');
  }
  function setProbe(v) { S.probe = v.map((x, i) => clamp(x, 0, V.size[i] - 1e-3)); drawSlices(); kick(); }
  for (const pane of $$('.pane')) {
    const p = PL[pane.dataset.plane], fit = pane.querySelector('.fit2'), box = pane.querySelector('.box');
    const at = e => { const r = fit.getBoundingClientRect(), v = S.probe.slice(), fu = clamp((e.clientX - r.left) / r.width, 0, 1), fv = clamp((e.clientY - r.top) / r.height, 0, 1); v[p.u] = fu * V.size[p.u]; v[p.v] = (p.flip ? 1 - fv : fv) * V.size[p.v]; setProbe(v); };
    box.addEventListener('pointerdown', e => { if (!V) return; box.setPointerCapture(e.pointerId); at(e); box.onpointermove = at; });
    box.addEventListener('pointerup', () => { box.onpointermove = null; });
    box.addEventListener('wheel', e => { if (!V) return; e.preventDefault(); const v = S.probe.slice(); v[p.n] += Math.sign(e.deltaY) * V.sp[p.n] * (p.n === 2 ? -1 : 1); setProbe(v); }, { passive: false });
  }

  // ---------- pointer on the 3D view ----------
  let drag = null, hoverRaf = 0, lastMove = null;
  const local = e => { const r = vp.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  vp.addEventListener('contextmenu', e => e.preventDefault());
  vp.addEventListener('pointerdown', e => {
    if (!V) return; vp.setPointerCapture(e.pointerId);
    const [x, y] = local(e), mode = e.button === 2 || e.shiftKey ? 'pan' : S.tool;
    drag = { mode, x, y, sx: x, sy: y, moved: 0 }; S.vy = S.vp = 0; delete anim.yaw; delete anim.pitch;
    vp.style.cursor = mode === 'pan' || mode === 'rotate' ? 'grabbing' : 'crosshair'; kick();
  });
  vp.addEventListener('pointermove', e => {
    if (!V) return; const [x, y] = local(e);
    if (set.lighting) { S.lightTo = [(x / vp.clientWidth * 2 - 1) * .9, (1 - y / vp.clientHeight * 2) * .9 + .15]; kick(); }
    if (drag) {
      const dx = x - drag.x, dy = y - drag.y; drag.x = x; drag.y = y; drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.mode === 'rotate') { S.yaw -= dx * .0075; S.pitch = clamp(S.pitch + dy * .0075, -1.5, 1.5); S.vy = -dx * .0075; S.vp = dy * .0075; }
      else if (drag.mode === 'pan') { const c = cam(), k = S.dist * FOV * 2 / vp.clientHeight; S.pan = S.pan.map((p, i) => p - c.rw[i] * dx * k + c.uw[i] * dy * k); }
      kick(); return;
    }
    lastMove = [x, y];
    if (!hoverRaf && (S.tool === 'measure' || S.tool === 'probe')) hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0; const h = pick(...lastMove); S.hover = h;
      $('#ov-br').textContent = h ? 'Value ' + valAt(h) + '\nVoxel ' + vox(h).map(i => i + 1).join(', ') : '';
      if (S.pending) overlay();
    });
  });
  vp.addEventListener('pointerup', e => {
    if (!drag) return; const d = drag; drag = null; setTool(S.tool);
    if (!set.motion) S.vy = S.vp = 0;
    if (d.moved < 5 && d.mode !== 'pan') {
      const h = pick(d.sx, d.sy);
      if (d.mode === 'probe' && h) setProbe(h);
      if (d.mode === 'measure' && h) {
        if (S.pending) { S.measures.push([S.pending, h]); S.pending = null; listMeasures(); } else S.pending = h;
      }
    }
    kick();
  });
  vp.addEventListener('pointerleave', () => { S.hover = null; S.lightTo = [-.45, .5]; kick(); });
  vp.addEventListener('wheel', e => { if (!V) return; e.preventDefault(); const r = Math.hypot(...V.size) / 2; anim.dist = clamp((anim.dist || S.dist) * Math.exp(e.deltaY * .0012), r * .6, r / FOV * 3); kick(); }, { passive: false });
  vp.addEventListener('dblclick', e => { if (S.tool === 'rotate') { const h = pick(...local(e)); if (h) { setProbe(h); } } });

  function listMeasures() {
    const box = $('#mlist');
    if (!S.measures.length) { box.innerHTML = '<span class="none">Pick the ruler, then click two points on the surface.</span>'; return; }
    box.innerHTML = S.measures.map(([a, b], i) => '<div class="m"><span>Length ' + (i + 1) + '</span><b>' + mm(a, b).toFixed(1) + ' mm</b></div>').join('');
  }

  // ---------- tools, controls ----------
  function setTool(t) {
    S.tool = t; if (t !== 'measure') S.pending = null;
    const btn = dock.querySelector('[data-tool="' + t + '"]'), sel = dock.querySelector('.sel');
    dock.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', b === btn));
    sel.style.translate = (btn.offsetLeft - sel.offsetLeft) + 'px 0';
    vp.style.cursor = { rotate: 'grab', pan: 'move', measure: 'crosshair', probe: 'crosshair' }[t];
    if (!S.hover) $('#ov-br').textContent = ''; kick();
  }
  const ACT = {
    explode() { const on = S.gap < .5; S.gap = on ? S.gapOn : 0; if (!on) S.gapOn = Math.max(10, Math.round(anim.gapNow ?? S.gapNow)); setGap(); syncInputs(); },
    box() { S.box = !S.box; flags(); kick(); },
    spin() { S.spin = !S.spin; flags(); kick(); },
    clear() { S.measures = []; S.pending = null; listMeasures(); kick(); },
    reset() { S.cut = [0, 0, 0]; S.gap = 0; setGap(); view0(true); syncInputs(); kick(); },
    full() { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}); },
  };
  function setGap() { if (set.motion) anim.gapNow = S.gap; else S.gapNow = S.gap; flags(); kick(); }
  function flags() {
    dock.querySelector('[data-act="explode"]').classList.toggle('flag', S.gap > .5);
    dock.querySelector('[data-act="box"]').classList.toggle('flag', S.box);
    dock.querySelector('[data-act="spin"]').classList.toggle('flag', S.spin);
  }
  dock.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  dock.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => ACT[b.dataset.act]()));
  function segSet(id, v) { $$('#' + id + ' button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === String(v))); }
  function syncInputs() {
    segSet('mode', S.mode); segSet('axis', S.axis);
    $('#c-iso').hidden = S.mode === 'solid' || S.mode === 'mip';
    const put = (id, val, text) => { const i = $('#' + id); i.value = val; i.style.setProperty('--k', (val - i.min) / (i.max - i.min) * 100 + '%'); i.parentElement.querySelector('output').textContent = text; };
    put('iso', Math.round(S.iso * 100), V ? String(Math.round(S.iso * V.meta.hi)) : '');
    put('pieces', S.pieces, S.pieces + (V ? ' × ' + (V.size[S.axis] / S.pieces).toFixed(0) + ' mm' : ''));
    put('gap', Math.round(S.gap), Math.round(S.gap) + ' mm');
    [0, 1, 2].forEach(a => put('cut' + a, Math.round(S.cut[a] * 100), V ? (S.cut[a] * V.size[a]).toFixed(0) + ' mm' : ''));
    flags();
  }
  const onRange = (id, fn) => { const i = $('#' + id); i.addEventListener('input', () => { sliding = true; fn(+i.value); syncInputs(); kick(); }); i.addEventListener('change', () => { sliding = false; kick(); }); };
  onRange('iso', v => S.iso = v / 100);
  onRange('pieces', v => S.pieces = v);
  onRange('gap', v => { S.gap = v; if (v > .5) S.gapOn = v; S.gapNow = v; delete anim.gapNow; });
  [0, 1, 2].forEach(a => onRange('cut' + a, v => S.cut[a] = v / 100));
  $('#mode').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.mode = b.dataset.v; syncInputs(); kick(); });
  $('#axis').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.axis = +b.dataset.v; if (S.gap < .5) { S.gap = S.gapOn; setGap(); } syncInputs(); kick(); });
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#tabs button').forEach(x => x.setAttribute('aria-pressed', x === b)); $$('.side .tab').forEach(t => t.hidden = t.dataset.tab !== b.dataset.tab);
  });
  addEventListener('keydown', e => {
    if (e.target.matches('input,textarea') || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === '1') setTool('rotate'); else if (k === '2') setTool('pan'); else if (k === 'm') setTool('measure'); else if (k === 'i') setTool('probe');
    else if (k === 'e') ACT.explode(); else if (k === 'b') ACT.box(); else if (k === 't') ACT.spin(); else if (k === 'r') ACT.reset(); else if (k === 'f') ACT.full();
    else if (k === 'escape') { S.pending = null; setTool('rotate'); }
    else if (k === 'arrowleft') { anim.yaw = (anim.yaw ?? S.yaw) - .35; kick(); } else if (k === 'arrowright') { anim.yaw = (anim.yaw ?? S.yaw) + .35; kick(); }
    else if (k === 'arrowup') { anim.pitch = clamp((anim.pitch ?? S.pitch) + .25, -1.5, 1.5); kick(); } else if (k === 'arrowdown') { anim.pitch = clamp((anim.pitch ?? S.pitch) - .25, -1.5, 1.5); kick(); }
  });
  addEventListener('resize', () => { drawSlices(); kick(); });

  function fillPanel() {
    const m = V.meta, e = m.bodyExtentMm;
    const cnt = (id, to) => window.MyFx && MyFx.count ? MyFx.count($(id), Math.round(to)) : ($(id).textContent = Math.round(to));
    cnt('#s-w', e[0]); cnt('#s-d', e[1]); cnt('#s-h', e[2]);
    $('#s-vox').textContent = 'Scan ' + V.size.map(x => x.toFixed(0)).join(' × ') + ' mm  ·  voxel ' + m.spacing.map(x => +x.toFixed(2)).join(' × ') + ' mm';
    $('#h-meta').textContent = m.dims[2] + ' slices rebuilt  ·  ' + m.dims.join(' × ');
    let html = '', sec = '';
    for (const [s, label, val, unit] of m.tags) {
      if (s !== sec) { html += '<h3>' + s + '</h3>'; sec = s; }
      html += '<div class="kv"><span>' + label + '</span>' + (val ? '<b></b>' : '<b class="blank">blank in the file</b>') + '</div>';
    }
    $('#tags').innerHTML = html;
    const filled = m.tags.filter(t => t[2]); $$('#tags .kv b:not(.blank)').forEach((b, i) => b.textContent = filled[i][2] + (filled[i][3] ? ' ' + filled[i][3] : ''));
    $('#credit').textContent = m.credit;
  }

  // ---------- start ----------
  const sbox = $('#series');
  fetch('data/index.json').then(r => r.json()).catch(() => []).then(ids => Promise.all(ids.map(id => fetch('data/' + id + '/meta.json').then(r => r.json()).catch(() => null)))).then(ms => {
    ms.filter(Boolean).forEach(m => { const b = document.createElement('button'); b.dataset.id = m.id; b.textContent = m.label; b.addEventListener('click', () => load(m.id)); sbox.append(b); });
    const want = new URLSearchParams(location.search).get('series'), first = ms.find(m => m && m.id === want) || ms.find(Boolean);
    if (params3.get('wait')) return;
    if (first) load(first.id); else $('#loading span').textContent = 'No converted series found in data/. Run tools/dicom2vol.py first.';
  });
  const back = new URLSearchParams(location.search).get('mrn'); if (back) $('#back').href = 'viewer.html?mrn=' + encodeURIComponent(back);
  setTool('rotate'); syncInputs();
  // the viewer can hand over a volume it built itself (a DICOM folder opened from this computer)
  addEventListener('message', e => {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'mypacs-volume') return;
    const { meta, u16, mask } = e.data, n = u16.length, r8 = new Uint8Array(n), rg = new Uint8Array(n * 2), k = 255 / meta.hi;
    for (let i = 0; i < n; i++) { const x = u16[i] * k; r8[i] = x > 255 ? 255 : x; rg[2 * i] = r8[i]; rg[2 * i + 1] = mask[i]; }
    $$('#series button').forEach(b => b.setAttribute('aria-pressed', false));
    apply({ meta, u16, mask, r8, rg, dims: meta.dims, sp: meta.spacing, size: meta.dims.map((d, i) => d * meta.spacing[i]) });
  });
  if (params3.get('wait') && parent !== window) { $('#loading span').textContent = 'Building the 3D model…'; parent.postMessage({ type: 'mypacs-3d-ready' }, location.origin); }
  window.Recon = { S, render: () => render(1), pick, load, state: () => V && { id: V.meta.id, dims: V.dims } };
})();
