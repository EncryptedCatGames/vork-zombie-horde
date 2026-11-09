// Packs the game's quarry props for vork (textures embedded) and builds the rock field.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'node:fs';
import { PROP_DIRS, ROCKS } from './layout.mjs';

const V = `${process.env.ASSETS ?? new URL('../assets', import.meta.url).pathname}/detail/vprops`; // game props, not included (see README)
const OUT = new URL('./out/props/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

async function strip(doc) {
  await doc.transform(dequantize());
  for (const ext of doc.getRoot().listExtensionsUsed())
    if (['EXT_meshopt_compression', 'KHR_mesh_quantization', 'EXT_texture_webp'].includes(ext.extensionName)) ext.dispose();
}
function pick(dir, base, kind, max) {
  const sizes = fs.readdirSync(dir).map((f) => f.match(new RegExp(`^${base}_${kind}_(\\d+)\\.webp$`))).filter(Boolean).map((m) => +m[1]).sort((a, b) => b - a);
  const s = sizes.find((v) => v <= max) ?? sizes.at(-1);
  return `${dir}/${base}_${kind}_${s}.webp`;
}
async function material(doc, name, dir, base, tint) {
  const tex = async (f, k) => doc.createTexture(k).setImage(await sharp(f).png().toBuffer()).setMimeType('image/png').setURI(`${name}_${k}.png`);
  const orm = await tex(pick(dir, base, 'orm', 1024), 'orm');
  const m = doc.createMaterial(name).setBaseColorTexture(await tex(pick(dir, base, 'albedo', 2048), 'albedo'))
    .setNormalTexture(await tex(pick(dir, base, 'normal', 2048), 'normal'))
    .setMetallicRoughnessTexture(orm).setOcclusionTexture(orm).setRoughnessFactor(1).setMetallicFactor(1);
  if (tint) m.setBaseColorFactor([...tint, 1]);
  return m;
}

const info = {};
for (const [id, folder] of Object.entries(PROP_DIRS)) {
  const dir = `${V}/${folder}`;
  const glb = fs.readdirSync(dir).find((f) => f.endsWith('.glb') && !f.includes('-light') && !f.includes('.mobile'));
  const base = glb.replace('.glb', '');
  const out = `${OUT}${id}.glb`;
  const json = JSON.parse(fs.readFileSync(`${dir}/${base}.json`, 'utf8'));
  info[id] = { min: json.min, max: json.max };
  if (fs.existsSync(out)) continue;
  const doc = await io.read(`${dir}/${glb}`);
  await strip(doc);
  const mat = await material(doc, id, dir, base);
  for (const n of doc.getRoot().listNodes()) {
    if (n.getName().includes('@')) { n.dispose(); continue; }
    for (const p of n.getMesh()?.listPrimitives() ?? []) p.setMaterial(mat);
  }
  await io.write(out, doc);
  console.log('prop', id);
}
fs.writeFileSync(`${OUT}info.json`, JSON.stringify(info));

// rock field on the terrain height field
{
  const hb = fs.readFileSync(new URL('./out/height.bin', import.meta.url));
  const H = new Float32Array(hb.buffer, hb.byteOffset, hb.length / 4);
  const ground = (x, z) => { const fx = (x + 700) / 2, fz = (z + 1100) / 2, i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const g = (a, b) => H[b * 701 + a]; return (g(i, j) * (1 - tx) + g(i + 1, j) * tx) * (1 - tz) + (g(i, j + 1) * (1 - tx) + g(i + 1, j + 1) * tx) * tz; };
  const doc = await io.read(`${V}/d01-blast-rock/rock.glb`);
  await strip(doc);
  const mat = await material(doc, 'rock', `${V}/d01-blast-rock`, 'rock', [1.0, 0.9, 0.78]);
  const meshes = []; const scene = doc.getRoot().listScenes()[0];
  for (const n of doc.getRoot().listNodes()) {
    if (!n.getName().includes('@') && !n.getName().includes('pebbles') && n.getMesh()) {
      for (const p of n.getMesh().listPrimitives()) p.setMaterial(mat);
      meshes.push({ mesh: n.getMesh(), y: n.getTranslation()[1] });
    }
  }
  for (const n of doc.getRoot().listNodes()) n.dispose();
  ROCKS.forEach((r, i) => {
    const m = meshes[r.variant % meshes.length];
    scene.addChild(doc.createNode(`r${i}`).setMesh(m.mesh).setTranslation([r.x, ground(r.x, r.z) - 0.15 * r.s + m.y * r.s * r.sy, r.z])
      .setRotation([0, Math.sin(r.yaw / 2), 0, Math.cos(r.yaw / 2)]).setScale([r.s, r.s * r.sy, r.s]));
  });
  await io.write(`${OUT}rocks.glb`, doc);
  console.log('rocks', ROCKS.length);
}
