import {bundleLayers} from './bundle_layers.mjs';
import {fetchBytes, hash} from './transport_bytes.mjs';

export async function wasiSdk(options = {}) {
  const config = await fetch(new URL('settings.json', import.meta.url)).then(response => response.json());
  const prefix = (config.sharedAssets ?? '') + 'compiler/';
  const bytes = await fetchBytes(prefix + 'manifest.json');
  const checksum = new TextDecoder().decode(await fetchBytes(prefix + 'manifest.sha256')).trim();
  if (await hash(bytes) !== checksum) throw Error('WASI SDK manifest changed.');
  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  return bundleLayers(prefix, manifest, {...options, select:file => /^(sysroot|resource)\//.test(file.path)});
}
