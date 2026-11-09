// Writes out/scene.json: the set, the car's motion, four cameras with cuts.
import fs from 'node:fs';
import { FPS, DURATION, RAMP, LAND, SPRAY, sprayPos, carPose, simTime, wheelAngle, noise } from './layout.mjs';

const OUT = new URL('./out/', import.meta.url).pathname;
const quatY = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const quatXZ = (pitch, roll) => { // pitch about X, then roll about Z
  const cx = Math.cos(pitch / 2), sx = Math.sin(pitch / 2), cz = Math.cos(roll / 2), sz = Math.sin(roll / 2);
  return [sx * cz, -sx * sz, cx * sz, cx * cz];
};
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const ease = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const shake = (T, amp, seed) => [0, 1, 2].map((k) => amp * (noise(T * 2.3 + seed, k * 7.1) - 0.5 + 0.5 * (noise(T * 9.7, seed + k * 3.3) - 0.5)));
const r3 = (v) => v.map((x) => +x.toFixed(4));

const props = [
  ['dump-truck', [-27, 0, -10], 1.2], ['bulldozer', [31, 0, 14], -0.6], ['haul-truck', [24, 0, -42], 0.15],
  ['excavator', [40, 0, -72], 2.3], ['loader', [21, 0, -100], -0.9], ['haul-truck', [-23, 0, -178], 3.0],
  ['excavator', [-88, 9, -150], 1.0], ['loader', [-19, 0, -240], 0.5], ['dump-truck', [26, 0, -265], 2.6],
];

const nodes = [
  { type: 'asset', name: 'terrain', file: 'terrain.glb' },
  { type: 'asset', name: 'rocks', file: 'rocks.glb' },
  { type: 'asset', name: 'spray', file: 'spray.glb' },
  ...props.map(([id, p, yaw], i) => ({ type: 'asset', name: `${id}-${i}`, file: `${id}.glb`, translation: p, rotation: quatY(yaw) })),
  {
    type: 'node', name: 'rig', children: [
      {
        type: 'asset', name: 'car', file: 'charger.glb', translation: [0, 0.55, 0],
        materials: {
          light_front: { inputs: { base_color: [1, 1, 1], emission_luminance: 400, emission_color: [1, 0.9, 0.75] } },
          light_rear: { inputs: { base_color: [0.6, 0.02, 0.02], emission_luminance: 35, emission_color: [1, 0.05, 0.03] } },
          light_rear_rev: { inputs: { base_color: [0.25, 0.22, 0.2], specular_roughness: 0.4 } },
        },
      },
      { type: 'node', name: 'aim', translation: [0, 0.75, -0.2] },
    ],
  },
  {
    type: 'node', name: 'sky_rig', rotation: [0, 0.886, 0, 0.463], children: [
      { type: 'light', name: 'sky', shape: 'environment', energy: 0.75, color: [1, 0.84, 0.68], material: { program: 'std/environment_image', inputs: { image: { image: { file: 'sky.hdr' } } } } },
    ],
  },
  { type: 'light', name: 'sun', shape: 'sun', energy: 4.5, color: [1, 0.64, 0.36], angle: 0.03, translation: [0, 8.7, -100], target: [0, 0, 0], visible_camera: false },
];

// Cameras
const cams = {
  A: { from: 0, to: 3.2, lens: [24, 24] }, B: { from: 3.2, to: 6.4, lens: [30, 30] },
  C: { from: 6.4, to: 9.4, lens: [17, 17] }, D: { from: 9.4, to: DURATION, lens: [32, 26] },
};
const ZA = carPose(simTime(2.45)).z;
function camPos(name, T, car) {
  const u = (T - cams[name].from) / (cams[name].to - cams[name].from);
  if (name === 'A') return lerp([-4.0, 0.45, ZA], [-4.0, 0.45, ZA], 0).map((v, i) => v + shake(T, 0.05, 1)[i]);
  if (name === 'B') {
    const off = lerp([-2.6, 0.5, -5.5], [-4.4, 0.95, 1.2], ease(u));
    return [car[0] + off[0], off[1], car[2] + off[2]].map((v, i) => v + shake(T, 0.06, 2)[i]);
  }
  if (name === 'C') return [-7.5, 0.4, -170].map((v, i) => v + shake(T, 0.03, 3)[i]);
  return lerp([17, 1.6, -206], [4, 7, -266], ease(u)).map((v, i) => v + shake(T, 0.04, 4)[i]);
}
for (const name of Object.keys(cams))
  nodes.push({ type: 'camera', name: `cam${name}`, translation: [0, 1, 0], target: 'aim', material: `optics${name}` });
const materials = Object.fromEntries(Object.keys(cams).map((n) => [`optics${n}`, { program: 'std/camera', inputs: { lens: cams[n].lens[0], clip_end: 3000 } }]));

// Tracks
const frames = Math.round(DURATION * FPS);
const tr = (path, keys, interpolation = 'LINEAR') => ({ path, keys, interpolation });
const rigT = [], rigR = [], wheelR = { fl: [], fr: [], rl: [], rr: [] }, wheelT = { fl: [], fr: [], rl: [], rr: [] };
const camT = { A: [], B: [], C: [], D: [] }, lensD = [];
const sprayT = SPRAY.map(() => []), sprayS = SPRAY.map(() => []), sprayR = SPRAY.map(() => []);
const wheelBase = { fl: [-0.755, -0.215, -1.67], fr: [0.755, -0.215, -1.67], rl: [-0.75, -0.215, 1.3], rr: [0.75, -0.215, 1.3] };
const STEP = 2; // keys per frame, so the shutter sees curved motion
for (let f = 0; f <= frames * STEP; f++) {
  const T = +(f / (FPS * STEP)).toFixed(5), s = simTime(T), p = carPose(s);
  rigT.push([T, r3([0, p.y, p.z])]);
  rigR.push([T, r3(quatXZ(p.pitch, p.roll))]);
  const a = wheelAngle(s);
  for (const w of Object.keys(wheelR)) {
    wheelR[w].push([T, { euler: r3([a, 0, 0]) }]);
    wheelT[w].push([T, r3(lerp(wheelBase[w], [wheelBase[w][0], wheelBase[w][1] - 0.09, wheelBase[w][2]], p.air))]);
  }
  SPRAY.forEach((q, i) => {
    const t = s - LAND.s, on = t > q.delay;
    sprayT[i].push([T, r3(sprayPos(q, t))]);
    sprayS[i].push([T, on ? [q.s, q.s, q.s] : [0, 0, 0]]);
    sprayR[i].push([T, { euler: r3([q.spin * Math.max(0, t), q.spin * 0.6 * Math.max(0, t), 0]) }]);
  });
  for (const c of Object.keys(cams)) camT[c].push([T, r3(camPos(c, T, [0, p.y, p.z]))]);
  lensD.push([T, +(cams.D.lens[0] + (cams.D.lens[1] - cams.D.lens[0]) * ease((T - cams.D.from) / (cams.D.to - cams.D.from))).toFixed(3)]);
}
const tracks = [
  tr(['nodes', 'rig', 'translation'], rigT), tr(['nodes', 'rig', 'rotation'], rigR),
  ...Object.keys(wheelR).flatMap((w) => [tr(['nodes', 'car', 'nodes', `wheel_${w}`, 'rotation'], wheelR[w]), tr(['nodes', 'car', 'nodes', `wheel_${w}`, 'translation'], wheelT[w])]),
  ...Object.keys(cams).map((c) => tr(['nodes', `cam${c}`, 'translation'], camT[c])),
  ...SPRAY.flatMap((q, i) => [tr(['nodes', 'spray', 'nodes', `p${i}`, 'translation'], sprayT[i]), tr(['nodes', 'spray', 'nodes', `p${i}`, 'scale'], sprayS[i], 'STEP'), tr(['nodes', 'spray', 'nodes', `p${i}`, 'rotation'], sprayR[i])]),
  tr(['materials', 'opticsD', 'inputs', 'lens'], lensD),
  tr(['render', 'camera'], Object.entries(cams).map(([c, v]) => [v.from, `cam${c}`]), 'STEP'),
];

const scene = {
  version: 2, nodes, materials, animation: [{ tracks }],
  render: { resolution: [1920, 1080], fps: FPS, duration: DURATION, motion_blur: { shutter: 0.5 } },
};
fs.writeFileSync(`${OUT}scene.json`, JSON.stringify(scene));
console.log('scene ok; landing at sim', LAND.s.toFixed(2), 'z', LAND.z.toFixed(1), 'ZA', ZA.toFixed(1), 'frames', frames);
