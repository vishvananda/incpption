import {hash, fetchBytes, insert, shareBytes, fileView} from './wasi_runtime.mjs';

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
  let bundle = await fetchBytes('game/bundle.bin');
  if (await hash(bundle) !== manifest.bundle_sha256) throw Error('game bundle hash mismatch');
  for (const file of manifest.files) {
    const contents = bundle.subarray(file.offset, file.offset + file.size);
    if (await hash(contents) !== file.sha256) throw Error(`game input changed: ${file.path}`);
  }
  if (shared) bundle = shareBytes(bundle);
  compiler.layers.push({files: manifest.files, bundle});
  for (const file of manifest.files)
    insert(compiler.root, file.path, fileView(bundle.subarray(file.offset, file.offset + file.size)));
  return {manifest, expected};
}
