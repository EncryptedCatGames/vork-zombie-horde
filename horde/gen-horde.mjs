// Zombie horde scene: big quarry pit, 1M simulated zombies, the Charger ploughing through.
// node horde/gen-horde.mjs [zombies]   -> out/
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import fs from 'node:fs';
import { programs } from './sim/horde.mjs';
import { PLACED, MASTS, OBSTACLE_PROPS } from './layout.mjs';

const N = +(process.argv[2] ?? 1000000);
const NEAR = Math.min(N, Number(process.env.NEAR ?? Math.round(N * 0.08)));
const OUT = new URL('./out/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const REPO = process.env.ASSETS ?? new URL('../assets', import.meta.url).pathname; // game assets folder, not included (see README)
const FPS = 24, DURATION = 18, SIM_DT = 1 / 30;
const RENDER_FROM = 6, FREEZE_END = 8.3;
// timeline speed of the simulation: real time, frozen (barely creeping) 6.0-8.3, snap back
const SPEED = [[0, 1], [5.75, 1], [6.0, 0.015], [FREEZE_END, 0.015], [FREEZE_END + 0.25, 1], [99, 1]];
const speedAt = (T) => { if (T <= SPEED[0][0]) return SPEED[0][1];
  for (let k = 0; k < SPEED.length - 1; k++) if (T <= SPEED[k + 1][0]) { let u = (T - SPEED[k][0]) / (SPEED[k + 1][0] - SPEED[k][0]); u = u * u * (3 - 2 * u); return SPEED[k][1] + (SPEED[k + 1][1] - SPEED[k][1]) * u; }
  return SPEED[SPEED.length - 1][1]; };
const RES = (process.env.RES ?? '1080x1920').split('x').map(Number);
// landscape: wider lens so a centre 9:16 crop keeps roughly the vertical preview's framing
const LENSK = RES[0] > RES[1] ? 0.68 : 1, LENS0 = 17 * LENSK;
const CAR_Z0 = -720, CAR_V = 28;
const carZ = (t) => CAR_Z0 + CAR_V * t;

// ---------------------------------------------------------------- terrain
const hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
const sm = (t) => t * t * (3 - 2 * t);
const noise = (x, z) => { const i = Math.floor(x), j = Math.floor(z), fx = sm(x - i), fz = sm(z - j);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz; };
const fbm = (x, z) => noise(x, z) * 0.5 + noise(x * 2.1, z * 2.1) * 0.25 + noise(x * 4.3, z * 4.3) * 0.125;
const sstep = (a, b, x) => sm(Math.min(1, Math.max(0, (x - a) / (b - a))));
function benches(u, seedX, seedZ) {
  if (u <= 0) return 0;
  const k = Math.min(6, Math.floor(u / 16)), lu = u - k * 16;
  return 11 * k + (k < 6 ? 11 * sstep(0, 4, lu) : 0) + fbm(seedX, seedZ) * 1.2;
}
function terrainHeight(x, z) {
  const ax = Math.abs(x);
  let h = 0.8 * Math.exp(-((ax - 10.3) ** 2) / 2.2) * (0.7 + 0.6 * noise(z * 0.15, x > 0 ? 3 : 7));
  h += sstep(12, 24, ax) * (fbm(x * 0.03, z * 0.03) * 1.4 + fbm(x * 0.3, z * 0.3) * 0.2);
  const wob = (fbm(z * 0.01, x > 0 ? 11 : 17) - 0.45) * 30;
  const side = benches(ax - 640 - wob, x * 0.3, z * 0.3);
  const far = benches(-1110 - z - (fbm(x * 0.01, 5) - 0.45) * 30, x * 0.3, z * 0.3) * 0.6;
  const back = benches(z - 320 - (fbm(x * 0.01, 9) - 0.45) * 30, x * 0.3, z * 0.3);
  h += Math.max(side, far, back);
  return ax < 7 ? fbm(x * 0.7, z * 0.7) * 0.04 : h;
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
async function texturedMaterial(doc, name, { albedo, normal, orm, tint, minRough }) {
  const tex = async (f, k) => doc.createTexture(k).setImage(await sharp(f).png().toBuffer()).setMimeType('image/png').setURI(`${name}_${k}.png`);
  const m = doc.createMaterial(name).setBaseColorTexture(await tex(albedo, 'albedo')).setNormalTexture(await tex(normal, 'normal'));
  if (tint) m.setBaseColorFactor([...tint, 1]);
  const o = minRough ? doc.createTexture('orm').setImage(await sharp(orm).linear([1, 1, 1], [0, minRough, 0]).png().toBuffer()).setMimeType('image/png').setURI(`${name}_orm.png`) : await tex(orm, 'orm');
  return m.setMetallicRoughnessTexture(o).setOcclusionTexture(o).setRoughnessFactor(1).setMetallicFactor(1);
}

if (!fs.existsSync(`${OUT}terrain.glb`) || process.env.TERRAIN) {
  const doc = new Document(); const buf = doc.createBuffer(); const T = `${REPO}/textures/env/2k`;
  const mats = {
    road: await texturedMaterial(doc, 'road', { albedo: `${T}/quarryRoad_albedo.webp`, normal: `${T}/quarryRoad_normal.webp`, orm: `${T}/quarryRoad_orm.webp`, tint: [1.0, 0.86, 0.72] }),
    dirt: await texturedMaterial(doc, 'dirt', { albedo: `${T}/dirt_albedo.webp`, normal: `${T}/dirt_normal.webp`, orm: `${T}/dirt_orm.webp`, tint: [0.7, 0.6, 0.48], minRough: 95 }),
    face: await texturedMaterial(doc, 'face', { albedo: `${T}/quarryFace_albedo.webp`, normal: `${T}/quarryFace_normal.webp`, orm: `${T}/quarryFace_orm.webp` }),
  };
  const range = (a, b, st) => { const o = []; for (let v = a; v < b - 1e-6; v += st) o.push(+v.toFixed(3)); return o; };
  const xsHalf = [...range(0, 8, 0.5), ...range(8, 14, 0.5), ...range(14, 60, 1.5), ...range(60, 600, 3), ...range(600, 760, 1.2), ...range(760, 1600, 12), 1600];
  const xs = [...new Set([...xsHalf.map((v) => -v), ...xsHalf])].sort((a, b) => a - b);
  const zs = [...new Set([...range(-2500, -1200, 12), ...range(-1200, -1050, 1.2), ...range(-1050, 280, 2), ...range(280, 420, 1.2), ...range(420, 1200, 12), 1200])].sort((a, b) => a - b);
  const W = xs.length, H = zs.length;
  const pos = new Float32Array(W * H * 3), nrm = new Float32Array(W * H * 3);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = xs[i], z = zs[j], k = (j * W + i) * 3, e = 0.3;
    pos[k] = x; pos[k + 1] = terrainHeight(x, z); pos[k + 2] = z;
    const dx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e), dz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz); nrm[k] = -dx / l; nrm[k + 1] = 1 / l; nrm[k + 2] = -dz / l;
  }
  const groups = { road: [], dirt: [], face: [] };
  for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1, cx = (xs[i] + xs[i + 1]) / 2;
    const ny = (nrm[a * 3 + 1] + nrm[d * 3 + 1]) / 2;
    groups[Math.abs(cx) < 7.6 ? 'road' : ny < 0.72 ? 'face' : 'dirt'].push(a, c, b, b, c, d);
  }
  const mesh = doc.createMesh('terrain');
  for (const [g, idx] of Object.entries(groups)) {
    const remap = new Map(), P = [], Nn = [], UV = [], I = new Uint32Array(idx.length);
    idx.forEach((v, n) => {
      let r = remap.get(v);
      if (r === undefined) {
        r = remap.size; remap.set(v, r);
        const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
        P.push(x, y, z); Nn.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
        UV.push(...(g === 'face' ? [(x + z) / 11, -y / 11] : g === 'road' ? [x / 7, z / 7] : [x / 5, z / 5]));
      }
      I[n] = r;
    });
    mesh.addPrimitive(doc.createPrimitive().setMaterial(mats[g])
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(P)).setBuffer(buf))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(Nn)).setBuffer(buf))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(UV)).setBuffer(buf))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(I).setBuffer(buf)));
    console.log('terrain', g, I.length / 3, 'tris');
  }
  doc.createScene('s').addChild(doc.createNode('terrain').setMesh(mesh));
  await io.write(`${OUT}terrain.glb`, doc);
  // height field for the zombies: 2 m spacing over the simulation area
  const HW = 701, HH = 701, hf = new Float32Array(HW * HH);
  for (let j = 0; j < HH; j++) for (let i = 0; i < HW; i++) hf[j * HW + i] = terrainHeight(-700 + i * 2, -1100 + j * 2);
  fs.writeFileSync(`${OUT}height.bin`, Buffer.from(hf.buffer));
}

// ---------------------------------------------------------------- zombie types
const KINDS = ['zombie', 'zombieWoman', 'zombieFat', 'zombieCop', 'zombieWorker'];
const COUNTS = [7, 5, 3, 2, 3];                       // per 20 zombies
const SLOTS = []; { const seq = [0, 1, 4, 0, 2, 1, 0, 3, 1, 0, 4, 2, 0, 1, 0, 3, 4, 1, 2, 0]; const seen = KINDS.map(() => 0);
  for (const k of seq) SLOTS.push({ kind: k, rank: seen[k]++ }); }
const P = 16;
const kinds = KINDS.map((k) => JSON.parse(fs.readFileSync(`${OUT}${k}.json`, 'utf8')));
const PERIOD = kinds[0].period / 1.6;
const geometry = {}, kindBuffers = {}, images = {};
kinds.forEach((z) => {
  for (const g of Object.values(z.geometry)) g.material_ranges = g.material_ranges.map((r) => ({ ...r, count: r.count * 3 }));
  delete z.geometry[`${z.kind}_walk`];
  const b = fs.readFileSync(`${OUT}${z.kind}_f0_pos.bin`); const Pp = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
  let top = 0; for (let k = 1; k < Pp.length; k += 3) top = Math.max(top, Pp[k]);
  const hf = new Float32Array(Pp.length / 3); for (let k = 0; k < hf.length; k++) hf[k] = Pp[k * 3 + 1] / top;
  fs.writeFileSync(`${OUT}${z.kind}_hfrac.bin`, Buffer.from(hf.buffer));
  z.buffers[`${z.kind}_hfrac`] = { type: 'f32', file: `${z.kind}_hfrac.bin`, count: hf.length };
  for (const g of Object.values(z.geometry)) g.attributes.HFRAC = `${z.kind}_hfrac`;
  Object.assign(geometry, z.geometry); Object.assign(kindBuffers, z.buffers); Object.assign(images, z.images);
});

// ---------------------------------------------------------------- buffers
const GRID = 1400 * 1400 * 4;
const zeroBytes = Math.max(N * 16, GRID * 4);
if (!fs.existsSync(`${OUT}zeros.bin`) || fs.statSync(`${OUT}zeros.bin`).size !== zeroBytes) fs.writeFileSync(`${OUT}zeros.bin`, Buffer.alloc(zeroBytes));
const zb = (type, count) => ({ type, file: 'zeros.bin', count });
{ const q = new Float32Array(N * 4); for (let i = 0; i < N; i++) q[i * 4 + 3] = 1;
  if (!fs.existsSync(`${OUT}ident.bin`) || fs.statSync(`${OUT}ident.bin`).size !== N * 16) fs.writeFileSync(`${OUT}ident.bin`, Buffer.from(q.buffer)); }
const qb = (count) => ({ type: 'vec4', file: 'ident.bin', count });
const rowsOf = (vi) => Math.ceil(N / 20) * COUNTS[vi], nearRowsOf = (vi) => Math.ceil(NEAR / 20) * COUNTS[vi];
const instBuffers = {};
COUNTS.forEach((_, vi) => {
  const nr = Math.ceil(rowsOf(vi) / P), fr = nearRowsOf(vi);
  for (let k = 0; k < P; k++) Object.assign(instBuffers, { [`v${vi}w${k}_t`]: zb('vec3', nr), [`v${vi}w${k}_s`]: zb('vec3', nr), [`v${vi}w${k}_r`]: qb(nr) });
  for (const w of ['fly', 'dead']) Object.assign(instBuffers, { [`v${vi}${w}_t`]: zb('vec3', fr), [`v${vi}${w}_s`]: zb('vec3', fr), [`v${vi}${w}_r`]: qb(fr) });
});
const buffers = {
  ...kindBuffers, ...instBuffers,
  height: { type: 'f32', file: 'height.bin', count: 701 * 701 },
  grid: zb('u32', GRID), clock: zb('f32', 2),
  ...Object.fromEntries(['p', 'v', 'next_p', 'next_v'].map((k) => [k, zb('vec3', N)])),
  ...Object.fromEntries(['aux', 'next_aux'].map((k) => [k, zb('vec4', N)])),
};

// ---------------------------------------------------------------- props (obstacles for the crowd)
const propInfo = JSON.parse(fs.readFileSync(`${OUT}props/info.json`, 'utf8'));
const OBST = [];
for (const [id, x, z] of PLACED) if (OBSTACLE_PROPS.has(id)) {
  const { min, max } = propInfo[id];
  const r = Math.max(Math.abs(min[0]), Math.abs(max[0]), Math.abs(min[2]), Math.abs(max[2])) * (id === 'mast' ? 0.6 : 0.85);
  OBST.push([x, z, Math.max(0.8, r)]);
}
const prog = programs({ N, NEAR, P, POSE_DT: (PERIOD / P).toFixed(6), SPEED, ZBAND: [-780, -150], SLOTS, COUNTS, OBST });
const programsOut = Object.fromEntries(Object.entries(prog).map(([k, v]) => [k, { source: v.source, bindings: Object.fromEntries(v.bindings.map((b) => [b, b])), schedule: 'simulation', dispatch: v.dispatch }]));
programsOut.zombie_look = { source: fs.readFileSync(new URL('./sim/zombie_look.slang', import.meta.url), 'utf8') };

// ---------------------------------------------------------------- materials: the game's zombie looks, muted
const materials = {};
const lin = (c, mute = 0.35) => { const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return c.map((v) => +((v * (1 - mute) + l * mute) ** 2.2).toFixed(4)); };
const SKIN = lin([0.56, 0.62, 0.50]);
const OUTFIT = {
  zombie: [[0.30, 0.33, 0.34], [0.44, 0.46, 0.40]], zombieFat: [[0.45, 0.35, 0.25], [0.42, 0.55, 0.62]],
  zombieCop: [[0.12, 0.14, 0.22], [0.22, 0.32, 0.55]], zombieWorker: [[0.22, 0.28, 0.45], [0.95, 0.5, 0.1]],
};
const kindMats = kinds.map((z) => z.materials.map((m) => {
  const name = `${z.kind}_${m.name}`;
  const base = { albedo: { image: m.color }, normal_map: { image: m.normal }, hfrac: { attribute: 'HFRAC' }, brightness: 1.15 };
  if (!m.color) materials[name] = { inputs: { base_color: m.rgb && !m.name.startsWith('default') ? lin(m.rgb.map((v) => v ** (1 / 2.2)), 0.2) : [0.05, 0.04, 0.035], specular_roughness: 0.5 } };
  else if (z.kind === 'zombieWoman') materials[name] = { program: 'zombie_look', inputs: { ...base, low_color: lin([0.5, 0.55, 0.48]), high_color: lin([0.52, 0.5, 0.56]), split: 0.45, detail: 0.85, detail_average: 0.4 } };
  else if (m.name.includes('Body')) materials[name] = { program: 'zombie_look', inputs: { ...base, low_color: SKIN, high_color: SKIN, split: 0.5, detail: 0.62, detail_average: 0.28 } };
  else { const [lo, hi] = OUTFIT[z.kind]; materials[name] = { program: 'zombie_look', inputs: { ...base, low_color: lin(lo, z.kind === 'zombieWorker' ? 0.1 : 0.35), high_color: lin(hi, z.kind === 'zombieWorker' ? 0.1 : 0.35), split: 0.53, detail: 0.62, detail_average: 0.14 } }; }
  return name;
}));

// ---------------------------------------------------------------- nodes
const quatY = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const r3 = (v) => v.map((x) => +x.toFixed(4));
const zombieNodes = [];
kinds.forEach((z, vi) => {
  for (let k = 0; k < P; k++) zombieNodes.push({ type: 'mesh', name: `${z.kind}_w${k}`, geometry: `${z.kind}_f${k}`, materials: kindMats[vi],
    instances: { attributes: { TRANSLATION: `v${vi}w${k}_t`, ROTATION: `v${vi}w${k}_r`, SCALE: `v${vi}w${k}_s` } } });
  for (const [w, g] of [['fly', 'launch'], ['dead', 'dead']]) zombieNodes.push({ type: 'mesh', name: `${z.kind}_${w}`, geometry: `${z.kind}_${g}`, materials: kindMats[vi],
    instances: { attributes: { TRANSLATION: `v${vi}${w}_t`, ROTATION: `v${vi}${w}_r`, SCALE: `v${vi}${w}_s` } } });
});
const propNodes = PLACED.map(([id, x, z, yaw, sc], i) => ({ type: 'asset', name: `${id}-${i}`, file: `props/${id}.glb`,
  translation: r3([x, terrainHeight(x, z) - 0.05, z]), rotation: r3(quatY((yaw * Math.PI) / 180)), ...(sc ? { scale: [sc, sc, sc] } : {}) }));
const mastLights = MASTS.flatMap((m, i) => [-1, 1].map((s) => ({ type: 'light', name: `flood${i}${s > 0 ? 'a' : 'b'}`, shape: 'spot', energy: 26000,
  color: [1, 0.9, 0.74], spot_size: 1.15, spot_blend: 0.55, radius: 0.25, translation: r3([m.x - Math.sign(m.x) * 0.6, terrainHeight(m.x, m.z) + 21, m.z + s * 1.2]),
  target: r3([m.x * 0.1, 0, m.z + s * 14]) })));
const nodes = [
  { type: 'asset', name: 'terrain', file: 'terrain.glb' },
  { type: 'asset', name: 'rocks', file: 'props/rocks.glb' },
  ...propNodes, ...mastLights, ...zombieNodes,
  {
    type: 'node', name: 'rig', children: [
      { type: 'node', name: 'body', rotation: quatY(Math.PI), children: [
        { type: 'asset', name: 'car', file: 'charger-hot.glb', translation: [0, 0.55, 0],
          materials: { light_front: { inputs: { base_color: [1, 1, 1], emission_luminance: 4000, emission_color: [1, 0.93, 0.82] } },
            light_rear: { inputs: { base_color: [0.6, 0.02, 0.02], emission_luminance: 60, emission_color: [1, 0.05, 0.03] } },
            light_rear_rev: { inputs: { base_color: [0.25, 0.22, 0.2], specular_roughness: 0.4 } } } },
        ...[-1, 1].map((s) => ({ type: 'light', name: `beam${s > 0 ? 'R' : 'L'}`, shape: 'spot', energy: 22000, color: [1, 0.9, 0.75],
          spot_size: 0.75, spot_blend: 0.5, radius: 0.08, translation: [s * 0.62, 0.62, -2.75], rotation: [-0.06, 0, 0, 0.998] })),
      ] },
      { type: 'node', name: 'aim', translation: [0, 0.8, 0.4] },
    ],
  },
  { type: 'node', name: 'sky_rig', rotation: [0, 0.886, 0, 0.463], children: [
    { type: 'light', name: 'sky', shape: 'environment', energy: 1.0, color: [1, 0.8, 0.62], material: { program: 'std/environment_image', inputs: { image: { image: { file: 'sky.hdr' } } } } }] },
  { type: 'light', name: 'sun', shape: 'sun', energy: 4.2, color: [1, 0.6, 0.33], angle: 0.03, translation: [0, 12, -100], target: [0, 0, 0], visible_camera: false },
  { type: 'light', name: 'fill', shape: 'sun', energy: 1.3, color: [0.72, 0.82, 1], angle: 0.2, translation: [30, 45, 100], target: [0, 0, 0], visible_camera: false },
];

// ---------------------------------------------------------------- one shot: frozen orbit, snap, chase, rise
const n1 = (t, s) => noise(t * 2.1 + s, s * 3.7) - 0.5 + 0.5 * (noise(t * 8.3, s + 1.3) - 0.5);
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const ease = (t) => sm(Math.min(1, Math.max(0, t)));
// simulation clock, tick by tick exactly as the tick program advances it
const ticks = []; { let c = 0; for (let j = 0; j * SIM_DT <= DURATION + 1; j++) { ticks.push(c); c += SIM_DT * speedAt(j * SIM_DT); } }
const clockAt = (T) => { const f = T / SIM_DT, j = Math.floor(f); return ticks[j] + (ticks[j + 1] - ticks[j]) * (f - j); };
const carAt = (T) => [0, 0, carZ(clockAt(T))];
function shot(T) {
  const car = carAt(T);
  const aimCar = [0, 0.75, car[2] + 0.4];
  if (T < FREEZE_END) {
    // frozen moment: tight on the hood, orbiting out and round to behind-left
    const u = ease((T - RENDER_FROM) / (FREEZE_END - RENDER_FROM));
    const th = (-48 - 112 * u) * Math.PI / 180, r = 3.4 + 4.6 * u, h = 1.45 + 0.85 * u;
    return { pos: [car[0] + r * Math.sin(th), h, car[2] + 1.6 + r * Math.cos(th)], look: aimCar, lens: LENS0 };
  }
  // after the snap the camera trails the car, then rises into the reveal
  const th = (-160) * Math.PI / 180;
  const endOrbit = [8 * Math.sin(th), 2.3, 1.6 + 8 * Math.cos(th)];
  const u = ease((T - FREEZE_END - 0.4) / (DURATION - FREEZE_END - 0.4));
  const v = ease((T - FREEZE_END) / 0.9);
  const chase = lerp([-1.5, 3.0, -9], [-18, 150, -95], u ** 1.35);
  const off = lerp(endOrbit, chase, v);
  // the camera lags the car for a beat at the snap (the car leaps away)
  const lagZ = (carAt(FREEZE_END)[2] - car[2]) * (1 - v) * 0.85;
  const pos = [car[0] + off[0], off[1], car[2] + off[2] + lagZ];
  const look = lerp(aimCar, [0, 0, car[2] + 160], ease((T - FREEZE_END - 1.2) / 6));
  return { pos, look, lens: LENS0 + 7 * LENSK * u };
}
materials.optics = { program: 'std/camera', inputs: { lens: LENS0, clip_end: 5000 } };
nodes.push({ type: 'camera', name: 'cam', translation: [0, 1, 0], target: 'look', material: 'optics' });
nodes.push({ type: 'node', name: 'look' });
const keys = { rigT: [], rigR: [], wheels: { fl: [], fr: [], rl: [], rr: [] }, cam: [], look: [], lens: [] };
for (let f = 0; f <= DURATION * FPS * 2; f++) {
  const T = f / (FPS * 2), clk = clockAt(T), car = carAt(T);
  const bump = (noise(clk * 9, 2) - 0.5) * 0.05, pitch = (noise(clk * 7, 4) - 0.5) * 0.04, roll = (noise(clk * 6, 6) - 0.5) * 0.035;
  keys.rigT.push([T, r3([0, bump, car[2]])]);
  keys.rigR.push([T, r3([Math.sin(pitch / 2), 0, Math.sin(roll / 2), Math.cos(pitch / 2)])]);
  for (const w of Object.keys(keys.wheels)) keys.wheels[w].push([T, { euler: r3([-(CAR_V * clk) / 0.335, 0, 0]) }]);
  const sh = shot(T), amp = T < FREEZE_END ? 0.015 : 0.06;
  keys.cam.push([T, r3(sh.pos.map((v, i) => v + n1(T, i * 10 + 1) * amp))]);
  keys.look.push([T, r3(sh.look)]);
  keys.lens.push([T, +sh.lens.toFixed(3)]);
}
const tr = (path, k, interpolation = 'LINEAR') => ({ path, keys: k, interpolation });
const tracks = [
  tr(['nodes', 'rig', 'translation'], keys.rigT), tr(['nodes', 'rig', 'rotation'], keys.rigR),
  ...Object.keys(keys.wheels).map((w) => tr(['nodes', 'car', 'nodes', `wheel_${w}`, 'rotation'], keys.wheels[w])),
  tr(['nodes', 'cam', 'translation'], keys.cam), tr(['nodes', 'look', 'translation'], keys.look),
  tr(['materials', 'optics', 'inputs', 'lens'], keys.lens),
];

const scene = {
  version: 2, buffers, programs: programsOut, geometry, images, materials, nodes,
  simulation: { t0: 0, dt: SIM_DT, seed: 3, state: ['clock', 'height', 'p', 'v', 'aux', 'next_p', 'next_v', 'next_aux', 'grid', ...Object.keys(instBuffers)],
    init: ['init', ...COUNTS.map((_, vi) => `place${vi}`)], steps: ['tick', 'clear', 'grid', 'advance', ...COUNTS.map((_, vi) => `place${vi}`), 'commit'] },
  animation: [{ tracks }],
  render: { resolution: RES, fps: FPS, duration: DURATION, camera: 'cam', motion_blur: { shutter: 0.3 } },
};
fs.writeFileSync(`${OUT}scene.json`, JSON.stringify(scene));
console.log(`scene: ${N} zombies (${NEAR} near the road), walk period ${PERIOD.toFixed(2)} s`);
