// Static hosts may strip Content-Encoding from precompressed binary assets.
// Recover the logical bytes in either case, then let the caller verify hashes.
let inputPort, sequence=0;
const pending=new Map();
export function useInputPort(port) {
  inputPort=port;
  if(port)port.onmessage=({data})=>{
    const request=pending.get(data.id);if(!request)return;
    pending.delete(data.id);if(data.error)request.reject(Error(data.error));else request.resolve(data.bytes);
  };
}
export async function fetchBytes(path, {signal}={}) {
  // Executable chunks have one consumer and are assembled into a module buffer.
  // Keep them out of the shared filesystem cache to avoid retaining a second
  // complete Clang/LLD binary for the duration of the comparison.
  if(inputPort && !new URL(path,self.location.href).pathname.includes('/clang-seed/'))return new Promise((resolve,reject)=>{
    const id=++sequence;pending.set(id,{resolve,reject});
    inputPort.postMessage({id,path:new URL(path,self.location.href).href});
  });
  const response = await fetch(path, {cache: 'no-cache', signal});
  if (!response.ok) throw Error(`${path}: HTTP ${response.status}`);
  return decodeBytes(response);
}
export async function decodeBytes(response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function fetchJoined(parts,size,sha256,{shared=false}={}) {
  if(inputPort)return new Promise((resolve,reject)=>{
    const id=++sequence;pending.set(id,{resolve,reject});
    inputPort.postMessage({id,kind:'file',parts:parts.map(part=>({...part,path:new URL(part.path,self.location.href).href})),size,sha256});
  });
  const bytes=new Uint8Array(shared&&globalThis.crossOriginIsolated?new SharedArrayBuffer(size):new ArrayBuffer(size));
  for(const part of parts){const chunk=await fetchBytes(part.path);if(chunk.length!==part.size)throw Error('Large source chunk size differs');bytes.set(chunk,part.offset);}
  return bytes;
}
