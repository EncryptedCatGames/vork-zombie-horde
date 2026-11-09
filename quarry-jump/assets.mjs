// Builds self-contained glbs for vork: props with embedded textures, a rocks field, the terrain.
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { dequantize } from '@gltf-transform/functions';
import fs from 'node:fs';
import { terrainHeight, ROCKS, RAMP, SPRAY } from './layout.mjs';

const REPO = process.env.ASSETS ?? new URL('../assets', import.meta.url).pathname; // game assets folder, not included (see README)
const OUT = new URL('./out/', import.meta.url).pathname;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const png = async (file, size) => {
  let img = sharp(file);
  if (size) img = img.resize(size, size);
  return img.png().toBuffer();
};

async function stripCompression(doc) {
  await doc.transform(dequantize());
  for (const ext of doc.getRoot().listExtensionsUsed())
    if (['EXT_meshopt_compression', 'KHR_mesh_quantization', 'EXT_texture_webp'].includes(ext.extensionName)) ext.dispose();
}

async function texturedMaterial(doc, name, base, { albedo, normal, orm, tint, minRough }) {
  const tex = async (f, uri) => doc.createTexture(uri).setImage(await png(f)).setMimeType('image/png').setURI(`${name}_${uri}.png`);
  const m = doc.createMaterial(name).setBaseColorTexture(await tex(albedo, 'albedo'))
    .setNormalTexture(await tex(normal, 'normal'));
  if (tint) m.setBaseColorFactor([...tint, 1]);
  const ormTex = minRough
    ? doc.createTexture('orm').setImage(await sharp(orm).linear([1, 1, 1], [0, minRough, 0]).png().toBuffer()).setMimeType('image/png').setURI(`${name}_orm.png`)
    : await tex(orm, 'orm');
  m.setMetallicRoughnessTexture(ormTex).setOcclusionTexture(ormTex).setRoughnessFactor(1).setMetallicFactor(1);
  return m;
}

// Quarry machines: keep LOD0, attach the baked textures.
const PROPS = {
  excavator: 'q01-excavator/excavator', 'haul-truck': 'q02-haul-truck/haul-truck', bulldozer: 'q03-bulldozer/bulldozer',
  loader: 'q04-wheel-loader/loader', 'dump-truck': 'q05-dump-truck/dump-truck',
};
for (const [id, p] of Object.entries(PROPS)) {
  const dir = `${REPO}/detail/vprops/${p.split('/')[0]}`, base = p.split('/')[1];
  const doc = await io.read(`${REPO}/detail/vprops/${p}.glb`);
  await stripCompression(doc);
  const pick = (k) => [2048, 1024, 512].map((s) => `${dir}/${base}_${k}_${s}.webp`).find((f) => fs.existsSync(f));
  const mat = await texturedMaterial(doc, id, base, { albedo: pick('albedo'), normal: pick('normal'), orm: pick('orm') });
  for (const n of doc.getRoot().listNodes()) {
    if (n.getName().includes('@')) { n.dispose(); continue; }
    for (const prim of n.getMesh()?.listPrimitives() ?? []) prim.setMaterial(mat);
  }
  await io.write(`${OUT}${id}.glb`, doc);
  console.log('prop', id);
}

// Rocks: one glb, meshes reused by many placed nodes; plus the landing spray pebbles.
{
  const src = await io.read(`${REPO}/detail/vprops/d01-blast-rock/rock.glb`);
  await stripCompression(src);
  const dir = `${REPO}/detail/vprops/d01-blast-rock`;
  const mat = await texturedMaterial(src, 'rock', 'rock', { albedo: `${dir}/rock_albedo_2048.webp`, normal: `${dir}/rock_normal_2048.webp`, orm: `${dir}/rock_orm_1024.webp`, tint: [1.0, 0.9, 0.78] });
  const meshes = {};
  for (const n of src.getRoot().listNodes()) {
    const nm = n.getName();
    if (nm.includes('@')) continue;
    const mesh = n.getMesh(); if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) prim.setMaterial(mat);
    meshes[nm] = { mesh, t: n.getTranslation() };
  }
  const scene = src.getRoot().listScenes()[0];
  for (const c of scene.listChildren()) scene.removeChild(c);
  const variants = Object.keys(meshes).filter((k) => !k.includes('pebbles'));
  ROCKS.forEach((r, i) => {
    const v = meshes[variants[r.variant % variants.length]];
    const node = src.createNode(`r${i}`).setMesh(v.mesh)
      .setTranslation([r.x, terrainHeight(r.x, r.z) - 0.15 * r.s + v.t[1] * r.s, r.z])
      .setRotation([0, Math.sin(r.yaw / 2), 0, Math.cos(r.yaw / 2)]).setScale([r.s, r.s * r.sy, r.s]);
    scene.addChild(node);
  });
  // drop the original nodes that still hang off the root
  for (const n of src.getRoot().listNodes()) if (!/^r\d+$/.test(n.getName())) n.dispose();
  await io.write(`${OUT}rocks.glb`, src);
  // spray pebbles: same meshes, posed by the scene's tracks
  for (const n of src.getRoot().listNodes()) n.dispose();
  SPRAY.forEach((p, i) => scene.addChild(src.createNode(`p${i}`).setMesh(meshes[variants[p.variant % variants.length]].mesh).setScale([0, 0, 0])));
  await io.write(`${OUT}spray.glb`, src);
  console.log('rocks', ROCKS.length, 'variants', variants.length);
}

// Terrain: haul road, windrow berms, quarry floor, benched walls, the kicker ramp.
{
  const doc = new Document();
  const buf = doc.createBuffer();
  const T = `${REPO}/textures/env/2k`;
  const mats = {
    road: await texturedMaterial(doc, 'road', 'road', { albedo: `${T}/quarryRoad_albedo.webp`, normal: `${T}/quarryRoad_normal.webp`, orm: `${T}/quarryRoad_orm.webp`, tint: [1.0, 0.86, 0.72] }),
    dirt: await texturedMaterial(doc, 'dirt', 'dirt', { albedo: `${T}/dirt_albedo.webp`, normal: `${T}/dirt_normal.webp`, orm: `${T}/dirt_orm.webp`, tint: [0.82, 0.7, 0.56], minRough: 95 }),
    face: await texturedMaterial(doc, 'face', 'face', { albedo: `${T}/quarryFace_albedo.webp`, normal: `${T}/quarryFace_normal.webp`, orm: `${T}/quarryFace_orm.webp` }),
  };
  const range = (a, b, st) => { const o = []; for (let v = a; v < b - 1e-6; v += st) o.push(+v.toFixed(3)); return o; };
  const xsHalf = [...range(0, 8, 0.5), ...range(8, 14, 0.4), ...range(14, 70, 2), ...range(70, 140, 0.75), ...range(140, 400, 6), 400];
  const xs = [...new Set([...xsHalf.map((v) => -v), ...xsHalf])].sort((a, b) => a - b);
  const zs = [...new Set([...range(-1500, -700, 10), ...range(-700, 300, 1.5), ...range(RAMP.lip - 6, RAMP.start + 2, 0.2), 300])].sort((a, b) => a - b);
  const W = xs.length, H = zs.length;
  const pos = new Float32Array(W * H * 3), nrm = new Float32Array(W * H * 3);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = xs[i], z = zs[j], k = (j * W + i) * 3, e = 0.25;
    pos[k] = x; pos[k + 1] = terrainHeight(x, z); pos[k + 2] = z;
    const dx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e);
    const dz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz); nrm[k] = -dx / l; nrm[k + 1] = 1 / l; nrm[k + 2] = -dz / l;
  }
  const groups = { road: [], dirt: [], face: [] };
  for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
    const ny = (nrm[a * 3 + 1] + nrm[d * 3 + 1]) / 2;
    const onRamp = Math.abs(cx) < 6 && cz > RAMP.lip - 1.5 && cz < RAMP.start;
    const g = onRamp ? 'dirt' : Math.abs(cx) < 7.6 ? 'road' : ny < 0.72 ? 'face' : 'dirt';
    groups[g].push(a, c, b, b, c, d);
  }
  const tile = { road: 7, dirt: 5, face: 9 };
  const mesh = doc.createMesh('terrain');
  for (const [g, idx] of Object.entries(groups)) {
    const remap = new Map(); const P = [], N = [], UV = [], I = new Uint32Array(idx.length);
    idx.forEach((v, n) => {
      let r = remap.get(v);
      if (r === undefined) {
        r = remap.size; remap.set(v, r);
        const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
        P.push(x, y, z); N.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
        if (g === 'face') UV.push(z / tile.face, -y / tile.face);
        else if (g === 'road') UV.push(x / tile.road, z / tile.road);
        else UV.push(x / tile.dirt, z / tile.dirt);
      }
      I[n] = r;
    });
    const prim = doc.createPrimitive().setMaterial(mats[g])
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(P)).setBuffer(buf))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(N)).setBuffer(buf))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(UV)).setBuffer(buf))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(I).setBuffer(buf));
    mesh.addPrimitive(prim);
    console.log('terrain', g, I.length / 3, 'tris');
  }
  doc.createScene('s').addChild(doc.createNode('terrain').setMesh(mesh));
  await io.write(`${OUT}terrain.glb`, doc);
}
