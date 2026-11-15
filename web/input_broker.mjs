import {fetchBytes} from './transport_bytes.mjs';
// The comparison shares downloads as well as inputs. A promise is installed
// before fetch starts, so simultaneous requests never download a bundle twice.
export class InputBroker {
  constructor() {this.cache=new Map();this.ports=new Set();this.abort=new AbortController();this.closed=false;}
  connect(port) {
    this.ports.add(port);
    port.onmessage=async({data:{id,path}})=>{
      try{
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
