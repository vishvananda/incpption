import {fetchBytes} from './transport_bytes.mjs';
// The comparison shares downloads as well as inputs. A promise is installed
// before fetch starts, so simultaneous requests never download a bundle twice.
export class InputBroker {
  constructor() {this.cache=new Map();this.ports=new Set();this.abort=new AbortController();this.closed=false;}
  connect(port) {
    this.ports.add(port);
    port.onmessage=async({data})=>{
      const {id,path}=data;
      try{
        if(data.kind==='file'){
          if(!Number.isSafeInteger(data.size)||data.size<0||data.size>512*1048576||!/^([a-f0-9]{64})$/.test(data.sha256))throw Error('Invalid large source file');
          const key='file:'+data.sha256;
          if(!this.cache.has(key))this.cache.set(key,(async()=>{
            const bytes=new Uint8Array(globalThis.crossOriginIsolated?new SharedArrayBuffer(data.size):new ArrayBuffer(data.size));let offset=0;
            for(const part of data.parts){
              const url=new URL(part.path,location.href);
              if(url.origin!==location.origin||part.offset!==offset||!Number.isSafeInteger(part.size)||part.size<0||part.size>data.size-offset)throw Error('Invalid source segment');
              const chunk=await fetchBytes(url.href,{signal:this.abort.signal});
              if(chunk.length!==part.size)throw Error('Large source chunk size differs');
              bytes.set(chunk,offset);offset+=chunk.length;
            }
            if(offset!==data.size)throw Error('Incomplete large source file');return bytes;
          })());
          const bytes=await this.cache.get(key);if(!this.closed)port.postMessage({id,bytes});return;
        }
        const url=new URL(path,location.href);
        if(url.origin!==location.origin)throw Error('Input URL must use the site origin');
        if(!this.cache.has(url.href))this.cache.set(url.href,fetchBytes(url.href,{signal:this.abort.signal}).then(bytes=>{
          if(!url.pathname.endsWith('.bin')||!globalThis.crossOriginIsolated||typeof SharedArrayBuffer==='undefined')return bytes;
          const shared=new Uint8Array(new SharedArrayBuffer(bytes.length));shared.set(bytes);return shared;
        }));
        const bytes=await this.cache.get(url.href);
        if(!this.closed)port.postMessage({id,bytes});
      }catch(error){if(!this.closed)port.postMessage({id,error:String(error)});}
    };
    return ()=>{port.close();this.ports.delete(port);};
  }
  close(){this.closed=true;this.abort.abort();for(const port of this.ports)port.close();this.ports.clear();this.cache.clear();}
}
