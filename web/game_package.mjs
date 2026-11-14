import {hash, fetchBytes, insert, shareBytes, fileView} from './wasi_runtime.mjs';
import {bundleLayers} from './bundle_layers.mjs';

// Both the build and code explorer consume the same pinned game inputs.
export async function loadGamePackage(compiler, {shared = false} = {}) {
  const bytes = await fetchBytes('game/manifest.json');
  const expected = new TextDecoder().decode(await fetchBytes('game/manifest.sha256')).trim();
  if (await hash(bytes) !== expected) throw Error('game manifest hash mismatch');
  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  if (manifest.schema !== 1 || manifest.compiler_manifest !== compiler.expectedManifest)
    throw Error('game package uses a different compiler manifest');
  for (const [path, digest] of Object.entries(manifest.runner_files))
    if (await hash(await fetchBytes('game/' + path)) !== digest) throw Error(`game runner changed: ${path}`);
  const layers = await bundleLayers('game/', manifest, {shared});
  compiler.layers.push(...layers);
  for (const layer of layers) for (const file of layer.files)
    insert(compiler.root, file.path, fileView(layer.bundle.subarray(file.offset, file.offset + file.size)));
  return {manifest, expected};
}
