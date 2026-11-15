// The stock shim reallocates on every extending write. Compiler/linker outputs
// need amortized growth while exposing only their logical length to WASI.
export function growingFileClass(File,OpenFile){
  class OutputHandle extends OpenFile{
    fd_write(data){const result=this.fd_pwrite(data,this.file_pos);if(!result.ret)this.file_pos+=BigInt(result.nwritten);return result;}
    fd_pwrite(data,offset){
      if(this.file.readonly)return super.fd_pwrite(data,offset);
      const start=Number(offset),end=start+data.length;this.file.resize(Math.max(this.file.used,end));this.file.storage.set(data,start);
      return{ret:0,nwritten:data.length};
    }
    fd_allocate(offset,length){this.file.resize(Math.max(this.file.used,Number(offset+length)));return 0;}
    fd_filestat_set_size(length){this.file.resize(Number(length));return 0;}
  }
  return class OutputFile extends File{
    constructor(){super([]);}
    get data(){return this.storage.subarray(0,this.used);}
    set data(value){this.storage=value;this.used=value.length;}
    resize(length){
      if(!Number.isSafeInteger(length)||length<0)throw Error('Invalid output size');
      if(length>this.storage.length){const bytes=new Uint8Array(Math.max(length,1024,this.storage.length*2));bytes.set(this.data);this.storage=bytes;}
      if(length<this.used)this.storage.fill(0,length,this.used);
      this.used=length;
    }
    path_open(...args){const result=super.path_open(...args);if(!result.ret){const handle=new OutputHandle(this);handle.file_pos=result.fd_obj.file_pos;result.fd_obj=handle;}return result;}
    take(){const data=this.storage.length===this.used?this.storage:this.data.slice();this.data=new Uint8Array();return data;}
  };
}
