// Cache encoded game data in the player origin, where Play will read it.
// Preload one chunk at a time; no second full game-data buffer is retained.
import {decodeBytes} from './transport_bytes.mjs';
const pending=new Map(), cacheName='incpption-game-data-v1';
const cacheKey=(url,sha)=>{const key=new URL(url);key.searchParams.set('inception-sha256',sha);return key.href;};
async function cache(){try{return await globalThis.caches?.open(cacheName);}catch{return null;}}
async function populate(store,url,key){
  if(!pending.has(key))pending.set(key,(async()=>{
    const response=await fetch(url,{priority:'low',cache:'no-cache'});
    if(!response.ok)throw Error(`Game data: HTTP ${response.status}`);
    await store.put(key,response);
  })().finally(()=>pending.delete(key)));
  await pending.get(key);
}
export async function assetBytes(url,sha){
  const store=await cache(),key=cacheKey(url,sha);
  if(store){
    try{
      if(!await store.match(key))await populate(store,url,key);
      const response=await store.match(key);
      if(response)return decodeBytes(response);
    }catch{/* Storage may be full or unavailable. Play can still fetch directly. */}
  }
  const response=await fetch(url,{cache:'no-cache'});
  if(!response.ok)throw Error(`Game data: HTTP ${response.status}`);
  return decodeBytes(response);
}
export async function discardAsset(url,sha){const store=await cache();await store?.delete(cacheKey(url,sha));}
export async function preloadAssets(player,onProgress=()=>{}){
  const store=await cache();if(!store)throw Error('Browser storage unavailable');
  const total=player.assets.reduce((n,asset)=>n+asset.chunks.reduce((n,row)=>n+(row.encoded_bytes||row.size),0),0);
  let loaded=0;onProgress(loaded,total);
  for(const asset of player.assets)for(const row of asset.chunks){
    const url=new URL(`assets/${asset.name}/${row.path}`,player.baseURL).href,key=cacheKey(url,row.sha256);
    if(!await store.match(key))await populate(store,url,key);
    loaded+=row.encoded_bytes||row.size;onProgress(loaded,total);
  }
}
