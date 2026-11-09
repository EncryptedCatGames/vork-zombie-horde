// Mushroom cloud from solid billowing blobs (vork has no volumes): geometry, materials, nodes, tracks.
import fs from 'node:fs';

const hash = (i, j, k) => { const s = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453; return s - Math.floor(s); };
const sm = (t) => t * t * (3 - 2 * t);
function vnoise3(x, y, z) {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), fx = sm(x - i), fy = sm(y - j), fz = sm(z - k);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(hash(i, j, k), hash(i + 1, j, k), fx), l(hash(i, j + 1, k), hash(i + 1, j + 1, k), fx), fy),
    l(l(hash(i, j, k + 1), hash(i + 1, j, k + 1), fx), l(hash(i, j + 1, k + 1), hash(i + 1, j + 1, k + 1), fx), fy), fz);
}
const fbm = (x, y, z) => vnoise3(x, y, z) * 0.5 + vnoise3(x * 2.1, y * 2.1, z * 2.1) * 0.3 + vnoise3(x * 4.3, y * 4.3, z * 4.3) * 0.2;

// lumpy blob: a UV sphere pushed out by 3D noise; four variants
export function writeBlobs(OUT, variants = 4, SEG = 56, RINGS = 36) {
  const buffers = {}, geometry = {};
  for (let v = 0; v < variants; v++) {
    const P = [], UV = [];
    for (let r = 0; r <= RINGS; r++) for (let s = 0; s <= SEG; s++) {
      const th = (r / RINGS) * Math.PI, ph = (s / SEG) * Math.PI * 2;
      const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      const o = v * 17.3;
      const d = 0.78 + 0.42 * fbm(n[0] * 1.7 + o, n[1] * 1.7 + o, n[2] * 1.7 + o) + 0.12 * fbm(n[0] * 5 + o, n[1] * 5, n[2] * 5);
      P.push(n[0] * d, n[1] * d, n[2] * d); UV.push(s / SEG, r / RINGS);
    }
    const I = [];
    for (let r = 0; r < RINGS; r++) for (let s = 0; s < SEG; s++) {
      const a = r * (SEG + 1) + s, b = a + SEG + 1;
      I.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const N = new Float32Array(P.length);
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
      const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], w = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      for (const x of [a, b, c]) { N[x] -= n[0]; N[x + 1] -= n[1]; N[x + 2] -= n[2]; }
    }
    for (let k = 0; k < N.length; k += 3) { const l = Math.hypot(N[k], N[k + 1], N[k + 2]) || 1; N[k] /= l; N[k + 1] /= l; N[k + 2] /= l; }
    // make normals point outward
    let dot = 0; for (let k = 0; k < N.length; k += 3) dot += N[k] * P[k] + N[k + 1] * P[k + 1] + N[k + 2] * P[k + 2];
    if (dot < 0) for (let k = 0; k < N.length; k++) N[k] = -N[k];
    const w = (name, arr, type) => { fs.writeFileSync(`${OUT}${name}.bin`, Buffer.from(arr.buffer)); buffers[name] = { type, file: `${name}.bin`, count: type === 'u32' ? arr.length : arr.length / (type === 'vec2' ? 2 : 3) }; };
    w(`blob${v}_pos`, new Float32Array(P), 'vec3'); w(`blob${v}_nrm`, N, 'vec3'); w(`blob${v}_uv`, new Float32Array(UV), 'vec2'); w(`blob${v}_idx`, new Uint32Array(I), 'u32');
    geometry[`blob${v}`] = { attributes: { POSITION: `blob${v}_pos`, NORMAL: `blob${v}_nrm`, TEXCOORD_0: `blob${v}_uv` }, indices: `blob${v}_idx` };
  }
  return { buffers, geometry };
}

export const CLOUD_PROGRAM = `import vork;
import std.procedurals;
struct Inputs { float glow = 0.; float3 hot = float3(1., .45, .12); float3 dust = float3(.32, .27, .23); float cracks = .5; };
Closure surface(ShadingContext c, Inputs i) {
    Closure m = {};
    float n = noise(c.rest_position * 2.2, 2., 4.);
    float n2 = noise(c.rest_position * 6.5 + 3., 2., 3.);
    float up = saturate(c.NORMAL.y * .5 + .5);
    m.base_color = i.dust * (.55 + .7 * n) * lerp(.35, 1.35, up);
    m.specular_weight = .15; m.specular_roughness = .9;
    float crack = smoothstep(i.cracks, i.cracks + .25, n * .6 + n2 * .4);
    float under = saturate(-c.NORMAL.y);
    m.emission_luminance = i.glow * (.15 + crack * 1.2 + under * 1.5);
    m.emission_color = lerp(i.hot, float3(1., .85, .55), crack * saturate(i.glow / 2500.));
    return m;
}`;

// all cloud pieces as functions of age a (seconds since detonation, on the sim clock)
export function cloudPieces(GX, GZ, ground, C) {
  const pieces = [];
  const H = (a) => 40 + 30 * (1 - Math.exp(-a / 7)) * 7;          // fireball / cap centre height, decelerating rise
  const Rf = (a) => 85 * (1 - Math.exp(-a / 0.5));
  const vis = (a, from, ramp) => Math.max(0, Math.min(1, (a - from) / ramp));
  let sd = 3; const r = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  // fireball: a cluster that cools and merges into the cap
  for (let k = 0; k < 7; k++) {
    const o = [r() - 0.5, r() - 0.5, r() - 0.5];
    pieces.push({ mat: 'fire', at: (a) => {
      const R = Rf(a), f = 1 - vis(a, 2.5, 2.5);
      return { p: [GX + o[0] * R * 0.7, ground + H(a) + o[1] * R * 0.5, GZ + o[2] * R * 0.7], s: [R * 0.6 * f, R * 0.6 * f, R * 0.6 * f], rot: a * 0.15 + k };
    } });
  }
  // cap: a rolling ring plus a dome
  for (let k = 0; k < 18; k++) {
    const ang = (k / 18) * Math.PI * 2 + r() * 0.2, jitter = 0.85 + r() * 0.3;
    pieces.push({ mat: 'cap', at: (a) => {
      const g = sm(vis(a, 1.0, 2.0)), R = Rf(a), Rc = (0.45 * R + 10 * a) * jitter, sz = (0.42 * R + 3.5 * a) * g;
      return { p: [GX + Math.cos(ang) * Rc, ground + H(a) + 0.12 * R, GZ + Math.sin(ang) * Rc], s: [sz, sz * 0.72, sz], rot: -1.2 * a + k, axis: [-Math.sin(ang), 0, Math.cos(ang)] };
    } });
  }
  for (let k = 0; k < 3; k++) pieces.push({ mat: 'cap', at: (a) => {
    const g = sm(vis(a, 1.2, 2.0)), R = Rf(a), Rc = 0.45 * R + 10 * a;
    return { p: [GX + (k - 1) * Rc * 0.3, ground + H(a) + 0.35 * Rc + 0.15 * R, GZ + (k - 1) * Rc * 0.15], s: [Rc * 0.85 * g, Rc * 0.42 * g, Rc * 0.85 * g], rot: 0.1 * a + k };
  } });
  // stem
  for (let k = 0; k < 11; k++) pieces.push({ mat: 'stem', at: (a) => {
    const g = sm(vis(a, 0.6 + k * 0.08, 1.5)), top = H(a) - 0.2 * Rf(a), h = ((k + 0.5) / 11) * top;
    const w = (13 + 2.6 * a) * (0.8 + 0.4 * (k / 11)) * g;
    return { p: [GX + Math.sin(k * 2.1) * 3, ground + h, GZ + Math.cos(k * 1.3) * 3], s: [w, Math.max(0.01, top / 11 * 1.1 * g), w], rot: 0.4 * a + k };
  } });
  // base surge rolling out at the foot
  for (let k = 0; k < 40; k++) {
    const ang = (k / 40) * Math.PI * 2 + r() * 0.2, rj = 0.8 + r() * 0.5, sj = 0.6 + r() * 0.7;
    pieces.push({ mat: 'dust', at: (a) => {
      const g = sm(vis(a, 0.3, 1.2)) * (1 - 0.5 * vis(a, 10, 6)), Rb = (40 + 60 * Math.sqrt(Math.max(0, a))) * rj, sz = (10 + 2.2 * a) * sj * g;
      return { p: [GX + Math.cos(ang) * Rb, ground + sz * 0.15, GZ + Math.sin(ang) * Rb], s: [sz * 1.4, sz * 0.38, sz * 1.4], rot: 0.5 * a + k, axis: [-Math.sin(ang), 0, Math.cos(ang)] };
    } });
  }
  // the shockwave front: a low wall of dust sweeping outward at C
  for (let k = 0; k < 160; k++) {
    const ang = (k / 160) * Math.PI * 2 + r() * 0.03, sizeJ = 0.5 + r() * 0.7;
    pieces.push({ mat: 'front', at: (a) => {
      const rr = C * a * (0.97 + 0.06 * sizeJ), g = sm(vis(a, 0.15, 0.4)) * (1 - vis(a, 7, 3)), sz = (4 + rr * 0.012) * sizeJ * g;
      const x = GX + Math.cos(ang) * rr, z = GZ + Math.sin(ang) * rr;
      return { p: [x, ground + sz * 0.12, z], s: [sz * 1.9, sz * 0.45, sz * 1.9], rot: 2 * a + k, axis: [-Math.sin(ang), 0, Math.cos(ang)], groundAt: true };
    } });
  }
  return pieces;
}
