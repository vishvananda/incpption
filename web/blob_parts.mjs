import {fetchBytes} from './transport_bytes.mjs';
import {assetBytes,discardAsset} from './asset_cache.mjs';
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
export async function loadBlob(record,base,onProgress=()=>{}){
  if(!Number.isSafeInteger(record.bytes)||record.bytes<0||record.bytes>1024*1048576)throw Error('Invalid data size');
  const bytes=new Uint8Array(record.bytes);let offset=0;
  for(const row of record.chunks){
    if(row.offset!==offset||!Number.isSafeInteger(row.size)||row.size<0||row.size>bytes.length-offset||!/^[-\w.]+\.bin$/.test(row.path))throw Error('Invalid data chunk');
    const url=new URL(row.path,base).href,part=await assetBytes(url,row.sha256);
    if(part.length!==row.size||await hash(part)!==row.sha256){await discardAsset(url,row.sha256);throw Error('Data chunk checksum differs');}
    bytes.set(part,offset);offset+=part.length;onProgress(offset,bytes.length);
  }
  if(offset!==bytes.length||await hash(bytes)!==record.sha256)throw Error('Data checksum differs');return bytes;
}
export async function loadPlayerInputs(player,onProgress){
  const runtimeURL=new URL(player.runtime,player.baseURL).href;
  if(await hash(await fetchBytes(runtimeURL))!==player.runtime_sha256)throw Error('Project runtime changed');
  const assets=[];
  for(const record of player.assets){const base=new URL('assets/'+record.name+'/',player.baseURL);assets.push({name:record.mount,bytes:await loadBlob(record,base,onProgress)});}
  return {runtimeURL,assets};
}
