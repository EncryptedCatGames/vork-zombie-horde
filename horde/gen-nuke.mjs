// Zombie horde scene: big quarry pit, 1M simulated zombies, the Charger ploughing through.
// node horde/gen-nuke.mjs [zombies]   -> out/
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import fs from 'node:fs';
import { programs } from './sim/nuke.mjs';
import { writeBlobs, CLOUD_PROGRAM, cloudPieces } from './cloud.mjs';
import { PLACED, MASTS, OBSTACLE_PROPS } from './layout.mjs';

const N = +(process.argv[2] ?? 1000000);
const NEAR = N;   // everyone can be hit
const OUT = new URL('./out/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const REPO = process.env.ASSETS ?? new URL('../assets', import.meta.url).pathname; // game assets folder, not included (see README)
const FPS = 24, DURATION = 31, SIM_DT = 1 / 30;
const SIM_PASS = 9.1;
const RENDER_FROM = 6, T_PASS = 9.25, FREEZE_END = 10.45, CUT = 0;
// timeline speed of the simulation: real time, frozen (barely creeping) 6.0-8.3, snap back
const SPEED = [[0, 1], [T_PASS - 0.15, 1], [T_PASS + 0.05, 0.02], [FREEZE_END - 0.2, 0.02], [FREEZE_END + 0.05, 1], [99, 1]];
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
  // low-poly flung and dead poses (the shockwave can throw anyone; keeps 1M under the triangle budget)
  const lo = JSON.parse(fs.readFileSync(`${OUT}lo/${z.kind}.json`, 'utf8'));
  const ren = (n) => `lo_${n}`;
  for (const [k, b] of Object.entries(lo.buffers)) kindBuffers[ren(k)] = { ...b, file: `lo/${b.file}` };
  const lb = fs.readFileSync(`${OUT}lo/${z.kind}_f0_pos.bin`); const Lp = new Float32Array(lb.buffer, lb.byteOffset, lb.length / 4);
  let ltop = 0; for (let k = 1; k < Lp.length; k += 3) ltop = Math.max(ltop, Lp[k]);
  const lhf = new Float32Array(Lp.length / 3); for (let k = 0; k < lhf.length; k++) lhf[k] = Lp[k * 3 + 1] / ltop;
  fs.writeFileSync(`${OUT}lo/${z.kind}_hfrac.bin`, Buffer.from(lhf.buffer));
  kindBuffers[`lo_${z.kind}_hfrac`] = { type: 'f32', file: `lo/${z.kind}_hfrac.bin`, count: lhf.length };
  for (const pose of ['launch', 'dead']) {
    const g = lo.geometry[`${z.kind}_${pose}`];
    geometry[`lo_${z.kind}_${pose}`] = { attributes: { POSITION: ren(g.attributes.POSITION), NORMAL: ren(g.attributes.NORMAL), TEXCOORD_0: ren(g.attributes.TEXCOORD_0), HFRAC: `lo_${z.kind}_hfrac` },
      indices: ren(g.indices), material_ranges: g.material_ranges.map((r) => ({ ...r, count: r.count * 3 })) };
  }
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
const CAM_X = 3.4;
// strikes: [x, z, sim time, radius]
const IMPACTS = (() => {
  let sd = 21; const r = () => { sd = (sd * 16807) % 2147483647; return sd / 2147483647; };
  const Zp = carZ(SIM_PASS), out = [];
  // during the skim: ahead in the crowd, either side of the road
  for (let k = 0; k < 9; k++) out.push([(r() < 0.5 ? -1 : 1) * (12 + r() * 45), Zp - 25 - r() * 130, 6.3 + k * 0.32 + r() * 0.15, 8 + r() * 3]);
  // just before the pass, beside the car: the freeze holds it mid-blast
  out.push([22, Zp - 9, SIM_PASS - 0.35, 9.5]);
  // the barrage during the rise: walking across the pit around and ahead of the car
  for (let k = 0; k < 30; k++) {
    const t = SIM_PASS + 0.5 + k * 0.2 + r() * 0.12, cz = carZ(t);
    out.push([(r() < 0.5 ? -1 : 1) * (14 + r() * 140), cz + 10 + r() * 230, t, 8 + r() * 4]);
  }
  return out;
})();
const NUKE = { x: -40, z: -700, t: 15.5, c: 95, vapour: 55, reach: 700 };
const AREA = [260, -820, 260];
const prog = programs({ NUKE, AREA, IMPACTS, CAMLINE: [CAM_X, (carZ(SIM_PASS) - 10).toFixed(1), (carZ(SIM_PASS) + 80).toFixed(1)], N, NEAR, P, POSE_DT: (PERIOD / P).toFixed(6), SPEED, ZBAND: [-780, -150], SLOTS, COUNTS, OBST });
const programsOut = Object.fromEntries(Object.entries(prog).map(([k, v]) => [k, { source: v.source, bindings: Object.fromEntries(v.bindings.map((b) => [b, b])), schedule: 'simulation', dispatch: v.dispatch }]));
programsOut.cloud = { source: CLOUD_PROGRAM };
const blobs = writeBlobs(OUT);
Object.assign(buffers, blobs.buffers);
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
  for (const [w, g] of [['fly', 'launch'], ['dead', 'dead']]) zombieNodes.push({ type: 'mesh', name: `${z.kind}_${w}`, geometry: `lo_${z.kind}_${g}`, materials: kindMats[vi],
    instances: { attributes: { TRANSLATION: `v${vi}${w}_t`, ROTATION: `v${vi}${w}_r`, SCALE: `v${vi}${w}_s` } } });
});
const propNodes = PLACED.map(([id, x, z, yaw, sc], i) => ({ type: 'asset', name: `${id}-${i}`, file: `props/${id}.glb`,
  translation: r3([x, terrainHeight(x, z) - 0.05, z]), rotation: r3(quatY((yaw * Math.PI) / 180)), ...(sc ? { scale: [sc, sc, sc] } : {}) }));
const mastLights = MASTS.flatMap((m, i) => [-1, 1].map((s) => ({ type: 'light', name: `flood${i}${s > 0 ? 'a' : 'b'}`, shape: 'spot', energy: i < 9 ? 20000 : 42000,
  color: [1, 0.78, 0.52], spot_size: 1.15, spot_blend: 0.55, radius: 0.25, translation: r3([m.x - Math.sign(m.x) * 0.6, terrainHeight(m.x, m.z) + 21, m.z + s * 1.2]),
  target: r3([m.x * 0.1, 0, m.z + s * 14]) })));
const FIRES = [[17, -383, 4.5], [18, -468, 2.6], [-20, -608, 2.8], [22, -588, 4.2], [-26, -420, 2.4]];
const fireNodes = FIRES.flatMap(([x, z, y], i) => {
  const g = terrainHeight(x, z);
  return [
    { type: 'light', name: `fireL${i}`, shape: 'point', energy: 30000, color: [1, 0.45, 0.13], radius: 1.2, translation: r3([x, g + y + 1.5, z]) },
    ...Array.from({ length: 7 }, (_, k) => ({ type: 'mesh', name: `flame${i}_${k}`, geometry: { std: 'sphere', radius: 0.5 },
      materials: ['flame'], translation: r3([x + Math.sin(k * 2.3) * 1.1, g + y + 0.4 + k * 0.35, z + Math.cos(k * 1.7) * 1.1]),
      scale: r3([1.2 - k * 0.12, 1.6 - k * 0.1, 1.2 - k * 0.12]), visible_shadow: false })),
  ];
});
materials.flame = { inputs: { base_color: [0, 0, 0], emission_luminance: 3500, emission_color: [1, 0.42, 0.1], specular_weight: 0 } };
const strikeNodes = IMPACTS.flatMap(([x, z, t, R], i) => {
  const g = terrainHeight(x, z);
  materials[`fb${i}`] = { inputs: { base_color: [0, 0, 0], emission_luminance: 0, emission_color: [1, 0.36, 0.07], specular_weight: 0 } };
  return [
    { type: 'mesh', name: `rk${i}`, geometry: { std: 'sphere', radius: 0.5 }, materials: ['rocket'], scale: [0, 0, 0], visible_shadow: false },
    { type: 'light', name: `rkL${i}`, shape: 'point', energy: 0, color: [1, 0.7, 0.4], radius: 0.3 },
    { type: 'light', name: `fl${i}`, shape: 'point', energy: 0, color: [1, 0.62, 0.3], radius: 2, translation: r3([x, g + 4, z]) },
    { type: 'mesh', name: `fb${i}`, geometry: { std: 'sphere', radius: 1 }, materials: [`fb${i}`], translation: r3([x, g + 1.2, z]), scale: [0, 0, 0], visible_shadow: false },
  ];
});
materials.rocket = { inputs: { base_color: [0, 0, 0], emission_luminance: 9000, emission_color: [1, 0.85, 0.6], specular_weight: 0 } };
Object.assign(geometry, blobs.geometry);
const GROUND0 = terrainHeight(NUKE.x, NUKE.z);
const CLOUD = cloudPieces(NUKE.x, NUKE.z, GROUND0, NUKE.c).filter((p) => p.mat !== 'dust');
materials.cfire = { program: 'cloud', inputs: { glow: 0, hot: [1, 0.5, 0.15], dust: [0.35, 0.25, 0.2], cracks: 0.3 } };
materials.ccap = { program: 'cloud', inputs: { glow: 0, hot: [1, 0.4, 0.1], dust: [0.3, 0.26, 0.23], cracks: 0.55 } };
materials.cstem = { program: 'cloud', inputs: { glow: 0, hot: [1, 0.38, 0.1], dust: [0.22, 0.19, 0.16], cracks: 0.6 } };
materials.cdust = { program: 'cloud', inputs: { glow: 0, hot: [1, 0.4, 0.12], dust: [0.24, 0.2, 0.17], cracks: 0.75 } };
materials.cfront = { program: 'cloud', inputs: { glow: 0, hot: [1, 0.5, 0.2], dust: [0.3, 0.25, 0.2], cracks: 0.85 } };
const cloudNodes = CLOUD.map((pc, i) => ({ type: 'mesh', name: `cl${i}`, geometry: `blob${i % 4}`, materials: [`c${pc.mat}`], scale: [0, 0, 0] }));
const nukeLights = [
  { type: 'light', name: 'nukeFlash', shape: 'point', energy: 0, color: [1, 0.95, 0.88], radius: 30, translation: r3([NUKE.x, GROUND0 + 120, NUKE.z]) },
  { type: 'light', name: 'nukeGlow', shape: 'point', energy: 0, color: [1, 0.5, 0.18], radius: 40, translation: r3([NUKE.x, GROUND0 + 80, NUKE.z]) },
];
const nodes = [
  ...cloudNodes, ...nukeLights,
  ...strikeNodes,
  ...fireNodes,
  { type: 'asset', name: 'terrain', file: 'terrain.glb' },
  { type: 'asset', name: 'rocks', file: 'props/rocks.glb' },
  ...propNodes, ...mastLights, ...zombieNodes,
  {
    type: 'node', name: 'rig', children: [
      { type: 'node', name: 'body', rotation: quatY(Math.PI), children: [
        { type: 'asset', name: 'car', file: 'charger-hot.glb', translation: [0, 0.55, 0],
          materials: { light_front: { inputs: { base_color: [1, 1, 1], emission_luminance: 9000, emission_color: [1, 0.93, 0.82] } },
            light_rear: { inputs: { base_color: [0.6, 0.02, 0.02], emission_luminance: 400, emission_color: [1, 0.05, 0.03] } },
            light_rear_rev: { inputs: { base_color: [0.25, 0.22, 0.2], specular_roughness: 0.4 } } } },
        ...[-1, 1].map((s) => ({ type: 'light', name: `beam${s > 0 ? 'R' : 'L'}`, shape: 'spot', energy: 20000, color: [1, 0.9, 0.75],
          spot_size: 0.75, spot_blend: 0.5, radius: 0.08, translation: [s * 0.62, 0.62, -2.75], rotation: [-0.06, 0, 0, 0.998] })),
      ] },
      { type: 'node', name: 'aim', translation: [0, 0.8, 0.4] },
    ],
  },
  { type: 'node', name: 'sky_rig', rotation: [0, 0.886, 0, 0.463], children: [
    { type: 'light', name: 'sky', shape: 'environment', energy: 0.45, color: [0.62, 0.68, 1.0], material: { program: 'std/environment_image', inputs: { image: { image: { file: 'sky.hdr' } } } } }] },
  { type: 'light', name: 'sun', shape: 'sun', energy: 1.6, color: [1, 0.42, 0.16], angle: 0.03, translation: [0, 7, -100], target: [0, 0, 0], visible_camera: false },
  { type: 'light', name: 'fill', shape: 'sun', energy: 0.6, color: [0.6, 0.68, 1], angle: 0.2, translation: [30, 45, 100], target: [0, 0, 0], visible_camera: false },
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
  const car = carAt(T), Zp = carAt(T_PASS)[2];
  const aimCar = [0, 0.8, car[2] + 0.4];
  const orbit = (th, r, h) => [r * Math.sin(th), h, car[2] + r * Math.cos(th)];
  if (T < T_PASS) {
    // skim just over the heads toward the oncoming car, slowing as it arrives
    const u = (T - RENDER_FROM) / (T_PASS - RENDER_FROM), k = 1 - (1 - u) ** 1.6;
    const pos = [CAM_X, 2.45, Zp + 72 - (72 - 4.5) * k];
    const look = lerp([0, 1.3, pos[2] - 60], aimCar, ease(u * 1.4 - 0.2));
    return { pos, look, lens: 19 };
  }
  if (T < FREEZE_END + 0.3) {
    // frozen pass: swing 180 degrees round the car, from front-right to behind
    const u = ease((T - T_PASS) / (FREEZE_END + 0.3 - T_PASS));
    const th = (38 + 162 * u) * Math.PI / 180;
    return { pos: orbit(th, 5.4 + 1.5 * u, 2.45 + 0.6 * u), look: aimCar, lens: 19 + 3 * u };
  }
  // follow and rise over the barrage, then the flash: swing round to face the blast and climb
  const TN = nukeSceneTime();
  const start = [6.9 * Math.sin(200 * Math.PI / 180), 3.05, 6.9 * Math.cos(200 * Math.PI / 180)];
  if (T < TN) {
    const u = ease((T - FREEZE_END - 0.3) / (TN - FREEZE_END - 0.3));
    const off = lerp(start, [-14, 48, -42], u ** 1.2);
    return { pos: [off[0], off[1], car[2] + off[2]], look: lerp(aimCar, [0, 0, car[2] + 90], ease(u * 1.3)), lens: 22 };
  }
  const w = ease((T - TN) / 3.2);
  const T_LOW = TN + 3.4, T_RISE = TN + 7.6;
  let off;
  if (T < T_LOW) off = lerp([-14, 48, -42], [16, 9, 26], ease((T - TN) / (T_LOW - TN)));
  else if (T < T_RISE) off = lerp([16, 9, 26], [20, 6, 34], ease((T - T_LOW) / (T_RISE - T_LOW)));
  else off = lerp([20, 6, 34], [40, 170, 210], ease((T - T_RISE) / (DURATION - T_RISE)) ** 1.15);
  const u = ease((T - TN) / (DURATION - TN));
  const pos = [off[0], off[1], car[2] + off[2]];
  const lookFwd = [0, 0, car[2] + 90];
  const lookBlast = lerp([0, 2, car[2] - 30], [NUKE.x, GROUND0 + 150, NUKE.z], T < TN + 7.6 ? 0.35 : 0.62);
  return { pos, look: lerp(lookFwd, lookBlast, w), lens: 20 + 4 * u };
}
let TN_CACHE = null;
function nukeSceneTime() {
  if (TN_CACHE !== null) return TN_CACHE;
  for (let T = 0; T < DURATION; T += 0.005) if (clockAt(T) >= NUKE.t) { TN_CACHE = T; return T; }
  return (TN_CACHE = DURATION);
}
// sim-clock time when the shock front reaches a moving point
const frontHits = (posAt) => { for (let T = nukeSceneTime(); T < DURATION; T += 0.01) { const p = posAt(T), a = clockAt(T) - NUKE.t;
  if (NUKE.c * a >= Math.hypot(p[0] - NUKE.x, p[2] - NUKE.z)) return T; } return 1e9; };
materials.optics = { program: 'std/camera', inputs: { lens: LENS0, clip_end: 5000 } };
nodes.push({ type: 'camera', name: 'cam', translation: [0, 1, 0], target: 'look', material: 'optics' });
nodes.push({ type: 'node', name: 'look' });
const keys = { rigT: [], rigR: [], wheels: { fl: [], fr: [], rl: [], rr: [] }, cam: [], look: [], lens: [] };
const T_CARHIT = frontHits(carAt), T_CAMHIT = frontHits((T) => shot(T).pos);
const kick = (T, at, dur) => { const d = T - at; return d < 0 ? 0 : Math.sin(Math.min(1, d / dur) * Math.PI) * Math.exp(-d * 1.6); };
for (let f = 0; f <= DURATION * FPS * 2; f++) {
  const T = f / (FPS * 2), clk = clockAt(T), car = carAt(T);
  const bump = (noise(clk * 9, 2) - 0.5) * 0.05, pitch = (noise(clk * 7, 4) - 0.5) * 0.04, roll = (noise(clk * 6, 6) - 0.5) * 0.035;
  const kb = kick(T, T_CARHIT, 0.7);
  keys.rigT.push([T, r3([0.6 * kb, bump + 1.3 * kb, car[2]])]);
  const pt = pitch - 0.22 * kb, rl = roll + 0.16 * kb;
  keys.rigR.push([T, r3([Math.sin(pt / 2), 0, Math.sin(rl / 2), Math.cos(pt / 2)])]);
  for (const w of Object.keys(keys.wheels)) keys.wheels[w].push([T, { euler: r3([-(CAR_V * clk) / 0.335, 0, 0]) }]);
  const sh = shot(T), amp = (T < FREEZE_END ? 0.02 : 0.06) + 2.2 * kick(T, T_CAMHIT, 0.5) + 0.6 * kick(T, nukeSceneTime(), 0.3);
  keys.cam.push([T, r3(sh.pos.map((v, i) => v + n1(T, i * 10 + 1) * amp))]);
  keys.look.push([T, r3(sh.look)]);
  keys.lens.push([T, +sh.lens.toFixed(3)]);
}
const tr = (path, k, interpolation = 'LINEAR') => ({ path, keys: k, interpolation });
const flicker = [];
const FALL = 1.1;   // seconds of flight before impact
const strikeTracks = [];
const cloudTracks = [];
{
  const ageAt = (T) => clockAt(T) - NUKE.t;
  const perPiece = CLOUD.map(() => ({ t: [], s: [], r: [] }));
  const glow = { fire: [], cap: [], stem: [], dust: [], front: [] }, flashE = [], glowE = [], flashC = [];
  for (let f = 0; f <= DURATION * FPS; f++) {
    const T = +(f / FPS).toFixed(5), a = ageAt(T);
    CLOUD.forEach((pc, i) => {
      if (a <= 0) { perPiece[i].t.push([T, [NUKE.x, GROUND0 - 50, NUKE.z]]); perPiece[i].s.push([T, [0, 0, 0]]); perPiece[i].r.push([T, [0, 0, 0, 1]]); return; }
      const st = pc.at(a); let pos = st.p;
      if (st.groundAt) pos = [pos[0], terrainHeight(pos[0], pos[2]) + (pos[1] - GROUND0), pos[2]];
      const ax = st.axis ?? [0, 1, 0], h = st.rot / 2;
      perPiece[i].t.push([T, r3(pos)]); perPiece[i].s.push([T, r3(st.s.map((v) => Math.max(0, v)))]);
      perPiece[i].r.push([T, r3([ax[0] * Math.sin(h), ax[1] * Math.sin(h), ax[2] * Math.sin(h), Math.cos(h)])]);
    });
    const A = Math.max(0, a), on = a > 0 ? 1 : 0;
    glow.fire.push([T, Math.round(on * (1800 * Math.exp(-A / 0.35) + 60 * Math.exp(-A / 2.5)))]);
    glow.cap.push([T, +(on * (220 * Math.exp(-A / 1.2) + 4 * Math.exp(-A / 6))).toFixed(2)]);
    glow.stem.push([T, +(on * (150 * Math.exp(-A / 1.0) + 5 * Math.exp(-A / 5))).toFixed(2)]);
    glow.dust.push([T, Math.round(on * 120 * Math.exp(-A / 1.0))]);
    glow.front.push([T, Math.round(on * 60 * Math.exp(-A / 0.6))]);
    flashE.push([T, Math.round(on * 1.2e7 * Math.exp(-A / 0.09))]);
    glowE.push([T, Math.round(on * (9e5 * Math.exp(-A / 1.5) + 4e4))]);
    flashC.push([T, +(on * Math.min(1, 0.9 * Math.exp(-Math.max(0, A - 0.05) / 0.06))).toFixed(4)]);
  }
  CLOUD.forEach((pc, i) => cloudTracks.push(
    { path: ['nodes', `cl${i}`, 'translation'], keys: perPiece[i].t, interpolation: 'LINEAR' },
    { path: ['nodes', `cl${i}`, 'scale'], keys: perPiece[i].s, interpolation: 'LINEAR' },
    { path: ['nodes', `cl${i}`, 'rotation'], keys: perPiece[i].r, interpolation: 'LINEAR' }));
  for (const [m, k] of Object.entries(glow)) cloudTracks.push({ path: ['materials', `c${m}`, 'inputs', 'glow'], keys: k, interpolation: 'LINEAR' });
  cloudTracks.push({ path: ['nodes', 'nukeFlash', 'energy'], keys: flashE, interpolation: 'LINEAR' },
    { path: ['nodes', 'nukeGlow', 'energy'], keys: glowE, interpolation: 'LINEAR' },
    { path: ['materials', 'gradeMat', 'inputs', 'flash'], keys: flashC, interpolation: 'LINEAR' });
}
IMPACTS.forEach(([x, z, ti, R], i) => {
  const g = terrainHeight(x, z), from = [x + 10, g + 190, z - 70], to = [x, g, z];
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], L = Math.hypot(...d), n = d.map((v) => v / L);
  // rotate +Z onto the flight direction
  const ax = [-n[1], n[0], 0], al = Math.hypot(...ax), ang = Math.acos(n[2]);
  const q = r3([ax[0] / al * Math.sin(ang / 2), ax[1] / al * Math.sin(ang / 2), 0, Math.cos(ang / 2)]);
  const rkT = [], rkS = [], rkE = [], flE = [], fbS = [], fbE = [];
  for (let f = 0; f <= DURATION * FPS * 2; f++) {
    const T = +(f / (FPS * 2)).toFixed(5), c = clockAt(T);
    const u = (c - (ti - FALL)) / FALL;                   // 0..1 in flight
    const flying = u >= 0 && u < 1;
    rkT.push([T, r3(flying ? from.map((v, k) => v + (to[k] - v) * u) : to)]);
    rkS.push([T, flying ? [0.35, 0.35, 9] : [0, 0, 0]]);
    rkE.push([T, flying ? 3000 : 0]);
    const a = c - ti;                                    // seconds since impact
    flE.push([T, a < 0 ? 0 : Math.round(60000 * Math.exp(-a / 0.12))]);
    const grow = a < 0 ? 0 : Math.min(1, a / 0.3) ** 0.5, alive = a >= 0 && a < 0.8;
    fbS.push([T, alive ? r3([1, 0.75, 1].map((k) => k * (0.8 + R * 0.38 * grow) * (a > 0.45 ? Math.max(0.2, 1 - (a - 0.45) / 0.35) : 1))) : [0, 0, 0]]);
    fbE.push([T, a < 0 ? 0 : Math.round(700 * Math.exp(-a / 0.22))]);
  }
  strikeTracks.push(
    { path: ['nodes', `rk${i}`, 'translation'], keys: rkT, interpolation: 'LINEAR' }, { path: ['nodes', `rk${i}`, 'rotation'], keys: [[0, q]], interpolation: 'STEP' },
    { path: ['nodes', `rk${i}`, 'scale'], keys: rkS, interpolation: 'STEP' },
    { path: ['nodes', `rkL${i}`, 'translation'], keys: rkT, interpolation: 'LINEAR' }, { path: ['nodes', `rkL${i}`, 'energy'], keys: rkE, interpolation: 'STEP' },
    { path: ['nodes', `fl${i}`, 'energy'], keys: flE, interpolation: 'LINEAR' },
    { path: ['nodes', `fb${i}`, 'scale'], keys: fbS, interpolation: 'LINEAR' },
    { path: ['materials', `fb${i}`, 'inputs', 'emission_luminance'], keys: fbE, interpolation: 'LINEAR' });
});
FIRES.forEach((f, i) => {
  const ek = [], sk = [];
  for (let j = 0; j <= DURATION * 30; j++) { const t = j / 30; const n = noise(t * 7 + i * 13, i) * 0.6 + noise(t * 19 + i * 5, i + 3) * 0.4;
    ek.push([+t.toFixed(4), Math.round(9000 + 13000 * n)]); }
  flicker.push(tr(['nodes', `fireL${i}`, 'energy'], ek));
  for (let k = 0; k < 7; k++) { const kk = [];
    for (let j = 0; j <= DURATION * 15; j++) { const t = j / 15, n = noise(t * 6 + k * 3.1 + i, k + i * 7);
      const b = 1.2 - k * 0.12; kk.push([+t.toFixed(4), r3([b * (0.7 + 0.6 * n), (1.6 - k * 0.1) * (0.6 + 0.9 * n), b * (0.7 + 0.6 * n)])]); }
    flicker.push(tr(['nodes', `flame${i}_${k}`, 'scale'], kk)); }
});
const tracks = [
  tr(['nodes', 'rig', 'translation'], keys.rigT), tr(['nodes', 'rig', 'rotation'], keys.rigR),
  ...Object.keys(keys.wheels).map((w) => tr(['nodes', 'car', 'nodes', `wheel_${w}`, 'rotation'], keys.wheels[w])),
  tr(['nodes', 'cam', 'translation'], keys.cam), tr(['nodes', 'look', 'translation'], keys.look),
  tr(['materials', 'optics', 'inputs', 'lens'], keys.lens),
  ...flicker,
  ...strikeTracks,
  ...cloudTracks,
];

const COPY = { program: { source: 'import vork; struct Inputs {}; float4 composite(CompositeContext c, Inputs i) { return compositor_sample(c.uv); }' } };
function bloomGraph(inputs, res, prefix = 'bloom') {
  const divisor = 2, size = res.map((x) => Math.ceil(x / divisor)), levels = Math.max(1, Math.floor(Math.log2(Math.max(1, Math.min(...size) * 0.5))));
  const g = [{ name: `${prefix}.original`, material: COPY }];
  const node = (stage, scale, extra, name) => { g.push({ name: name ?? `${prefix}.s${g.length}`, resolution: scale, material: { program: 'std/bloom', inputs: { ...inputs, stage, source: { node: g[g.length - 1].name }, ...extra } } }); };
  node('prepare', size, { divisor, original: { node: `${prefix}.original` } }, `${prefix}.0`);
  for (let l = 1; l < levels; l++) node('downsample', size.map((x) => Math.max(1, x >> l)), { karis: l === 1 }, `${prefix}.${l}`);
  for (let l = levels - 2; l >= 0; l--) node('upsample', size.map((x) => Math.max(1, x >> l)), { fine: { node: `${prefix}.${l}` } });
  node('combine', 1, { original: { node: `${prefix}.original` }, levels });
  return g;
}
const haze = { name: 'haze', material: { program: { source: `import vork;
struct Inputs { Image depth; };
float4 composite(CompositeContext c, Inputs i) {
    float4 col = compositor_sample(c.uv);
    float d = compositor_sample(i.depth, c.uv).r;
    if (!(d < 3000.)) return col;                         // sky
    float f = min(.32, 1. - exp(-d / 1500.));
    float3 hz = lerp(float3(.06, .075, .13), float3(.2, .12, .07), saturate(1. - c.uv.y * 1.6));  // cool overhead, warm low glow
    return float4(lerp(col.rgb, hz, f * .7), col.a);
}` }, inputs: { depth: { channel: 'depth' } } } };
const gradeSrc = `import vork;
struct Inputs { float flash = 0.; };
float h(float2 p) { return frac(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }
float4 composite(CompositeContext c, Inputs i) {
    float4 col = compositor_sample(c.uv);
    float l = dot(col.rgb, float3(.2126, .7152, .0722));
    float k = l / (l + .18);                               // shadows -> teal, highlights -> orange
    float3 tint = lerp(float3(.82, 1.0, 1.12), float3(1.18, .98, .78), smoothstep(.15, .75, k));
    float3 rgb = col.rgb * tint;
    rgb = pow(max(rgb, 0.), float3(1.06)) * 1.15;          // a little more contrast
    float2 q = c.uv - .5; float v = 1. - dot(q, q) * 1.35; // vignette
    rgb *= saturate(v);
    rgb *= 1. + (h(c.uv * c.size) - .5) * .05;             // grain
    rgb = lerp(rgb, float3(6., 5.6, 5.), i.flash);          // the nuclear flash
    return float4(rgb, col.a);
}`;
materials.gradeMat = { program: { source: gradeSrc }, inputs: { flash: 0 } };
const grade = { name: 'grade', material: 'gradeMat' };
const compositor = [haze, ...bloomGraph({ threshold: 3.0, strength: 0.18, smoothness: 0.3 }, RES), grade];
const scene = {
  version: 2, buffers, programs: programsOut, geometry, images, materials, nodes,
  simulation: { t0: 0, dt: SIM_DT, seed: 3, state: ['clock', 'height', 'p', 'v', 'aux', 'next_p', 'next_v', 'next_aux', 'grid', ...Object.keys(instBuffers)],
    init: ['init', ...COUNTS.map((_, vi) => `place${vi}`)], steps: ['tick', 'clear', 'grid', 'advance', ...COUNTS.map((_, vi) => `place${vi}`), 'commit'] },
  animation: [{ tracks }],
  render: { resolution: RES, fps: FPS, duration: DURATION, camera: 'cam', motion_blur: { shutter: 0.2 }, compositor },
};
fs.writeFileSync(`${OUT}scene.json`, JSON.stringify(scene));
console.log(`scene: ${N} zombies (${NEAR} near the road), walk period ${PERIOD.toFixed(2)} s`);
