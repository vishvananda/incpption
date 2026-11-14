import {fetchBytes, hash} from './wasi_runtime.mjs';
import {bundleLayers} from './bundle_layers.mjs';
export async function loadLLVM(compiler, {shared = false} = {}) {
  const bytes = await fetchBytes('llvm/manifest.json');
  const expected = new TextDecoder().decode(await fetchBytes('llvm/manifest.sha256')).trim();
  if (await hash(bytes) !== expected) throw Error('LLVM manifest hash mismatch');
  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  if (manifest.schema !== 1 || manifest.compiler_manifest !== compiler.expectedManifest)
    throw Error('LLVM build uses a different compiler package');
  for (const runtime of Object.values(manifest.runtime))
    if (await hash(await fetchBytes('llvm/' + runtime.path)) !== runtime.sha256) throw Error('LLVM runtime hash mismatch');
  const layers = await bundleLayers('llvm/', manifest, {shared});
  return {manifest, layers};
}
