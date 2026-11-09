import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
const [,, inp, out] = process.argv;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(inp);
for (const ext of doc.getRoot().listExtensionsUsed()) {
  if (['EXT_meshopt_compression','EXT_texture_webp','KHR_mesh_quantization'].includes(ext.extensionName)) ext.dispose();
}
for (const t of doc.getRoot().listTextures()) {
  if (t.getMimeType() === 'image/webp') { t.setImage(await sharp(Buffer.from(t.getImage())).png().toBuffer()); t.setMimeType('image/png'); t.setURI(t.getURI().replace(/\.webp$/,'.png')); }
}
await io.write(out, doc);
console.log('ok', doc.getRoot().listTextures().length, 'textures', doc.getRoot().listExtensionsUsed().map(e=>e.extensionName));
