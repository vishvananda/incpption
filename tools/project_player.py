#!/usr/bin/env python3
"""Prepare supplied Emscripten host glue for complete browser-built projects."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from artifact_transport import publish_binary

ROOT=Path(__file__).resolve().parents[1]
def sha(data):return hashlib.sha256(data).hexdigest()
def save(path,value):path.write_text(json.dumps(value,indent=2)+'\n')
def asset(path,output,name):
    manifest=output.parent/'manifest.json'
    previous=json.loads(manifest.read_text()).get('player',{}).get('assets',[])if manifest.exists()else[]
    for row in previous:
        if row['name']==name and row['bytes']==path.stat().st_size and all((output/name/chunk['path']).is_file()for chunk in row['chunks']):
            with path.open('rb')as stream:checksum=hashlib.file_digest(stream,'sha256').hexdigest()
            if checksum==row['sha256']:return dict(row)
    record=publish_binary(path,output/name,prefix='part');return dict(name=name,**record)
def raw_asm_strings(evidence,wasm):
    sys.path.insert(0,str(evidence/'sdk-profile/emscripten'))
    from tools import webassembly,extract_metadata
    with webassembly.Module(wasm) as module:
        exports={row.name:row for row in module.get_exports()}
        start=extract_metadata.get_global_value(module.get_global(exports['__start_em_asm'].index));end=extract_metadata.get_global_value(module.get_global(exports['__stop_em_asm'].index))
        segment,offset=extract_metadata.find_segment_with_address(module,start)
        data=module.read_at(segment.offset,segment.size);result={};position=offset
        while position<offset+end-start:
            stop=data.index(b'\0',position);result[start+position-offset]=data[position:stop].decode();position=stop+1
        return result

def prepare(evidence,project,target):
    os.environ['EM_CONFIG']=str(evidence/'emsdk/.emscripten')
    manifest=json.loads((project/'manifest.json').read_text());player=project/'player'
    if player.exists():shutil.rmtree(player)
    player.mkdir();assets=project/'assets';assets.mkdir(exist_ok=True)
    original={'doom':'d3wasm-rebased-current','godot':'godot-rebased-link'}.get(target)
    if target=='lara':
        runtime=(evidence/'openlara-runtime.mjs').read_bytes();name='runtime.'+sha(runtime)[:16]+'.mjs';(player/name).write_bytes(runtime)
        names=['level/1/TITLE.PSX','level/1/LEVEL1.PSX','level/1/AMERTIT.PNG','level/1/AZTECLOA.PNG','audio/1/track_02.ogg','audio/1/track_05.ogg']
        entries=[asset(evidence/'openlara-assets'/name,assets,f'asset{index:02}')|{'mount':name}for index,name in enumerate(names)]
        descriptor=dict(kind=target,runtime='player/'+name,assets=entries)
    else:
        work=project/'host-build';work.mkdir(exist_ok=True);module=project/'inputs'/manifest['link']['output'];command=json.loads((evidence/original/'post-command.json').read_text())
        args=[];i=0
        while i<len(command):
            value=command[i];i+=1
            if value in ['--pre-js','--shell-file','-o']:i+=1;continue
            if value=='--post-link':args.extend([value,str(module.resolve())]);i+=1;continue
            args.append(value)
        factory=work/'factory.mjs'
        args.extend(['-sMODULARIZE=1','-sEXPORT_ES6=1','-sINVOKE_RUN=0','-sEXPORTED_RUNTIME_METHODS=FS,callMain,ccall','-o',str(factory.resolve())])
        if target=='doom':
            strings=raw_asm_strings(evidence,module)
            trusted='new Map(['+','.join('['+json.dumps(text)+',ASM_CONSTS['+str(address)+']]'for address,text in strings.items())+'])'
            hook=work/'browser-host.js'
            hook.write_text('''// Bind only the frozen SDK's known EM_ASM handlers to actual linked addresses.
Module['inceptionRelocateAsm']=function(exports){
  var trusted='''+trusted+''';var bytes=new Uint8Array(exports.memory.buffer);
  var start=Number(exports.__start_em_asm.value),end=Number(exports.__stop_em_asm.value),map={};
  if(start<0||end<start||end>bytes.length)throw Error('Invalid EM_ASM bounds');
  var decoder=new TextDecoder();
  for(var at=start;at<end;){var stop=bytes.indexOf(0,at);if(stop<at||stop>=end)throw Error('Invalid EM_ASM string');
    var handler=trusted.get(decoder.decode(bytes.subarray(at,stop)));if(typeof handler!=='function')throw Error('Unknown EM_ASM handler');map[at]=handler;at=stop+1;}
  ASM_CONSTS=map;
};
Module['inceptionSetMainLoop']=function(callback,fps,infinite){return setMainLoop(callback,fps,infinite);};
Module['pauseMainLoop']=function(){MainLoop.pause();};
Module['resumeMainLoop']=function(){MainLoop.resume();};
Module['inceptionMount']=function(data){
  FS.mkdirTree('/usr/local/share/d3wasm/base');FS.mkdirTree('/home/web_user');
  FS.createDataFile('/usr/local/share/d3wasm/base','demo00.pk4',data,true,false,true);
  FS.mount(IDBFS,{},'/home/web_user');addRunDependency('inception-home');
  FS.syncfs(true,function(error){if(error)throw error;
    FS.mkdirTree('/home/web_user/.config/d3wasm');FS.mkdirTree('/home/web_user/.local/d3wasm/base');removeRunDependency('inception-home');});
};
''')
            args.extend(['--pre-js',str(hook.resolve()),'-sEXPORT_NAME=createDoom'])
        if target=='godot':
            hook=work/'browser-host.js';hook.write_text("Module['pauseMainLoop']=function(){MainLoop.pause();};Module['resumeMainLoop']=function(){MainLoop.resume();};\n")
            args.extend(['--pre-js',str(hook.resolve())])
        result=subprocess.run(args,capture_output=True,timeout=300)
        (work/'post-link.log').write_bytes(result.stdout+result.stderr)
        if result.returncode:raise RuntimeError(result.stderr.decode()[-3500:])
        if sha(module.read_bytes())!=manifest['link']['sha256']:raise ValueError('JS preparation changed the compiler output')
        data=factory.read_bytes()
        if target=='godot':
            # Deferred IME/focus callbacks can run after GodotConfig.clear().
            needle=b'GodotConfig.canvas.focus();'
            if needle not in data:raise ValueError('Godot focus bridge changed')
            data=data.replace(needle,b'GodotConfig.canvas?.focus();')
        name='factory.'+sha(data)[:16]+'.mjs';(player/name).write_bytes(data)
        if target=='doom':
            entries=[asset(evidence/original/'demo00.data',assets,'demo00')|{'mount':'/usr/local/share/d3wasm/base/demo00.pk4'}]
            descriptor=dict(kind=target,runtime='player/'+name,assets=entries,jspi=True)
        else:
            source=evidence/'godot-source/platform/web/js/engine'
            engine=(source/'engine.js').read_text()
            needle='\tEngine.load = function (basePath, size) {'
            if engine.count(needle)!=1:raise ValueError('Godot engine loader changed')
            addition='''\tEngine.loadBytes = function(bytes,basePath){
        loadPath=basePath;
        loadPromise=Promise.resolve({clone:function(){return new Response(new ReadableStream({start:function(controller){controller.enqueue(bytes);controller.close();}}),{headers:{'Content-Type':'application/wasm'}});}});
        return loadPromise;
    };
'''
            engine=engine.replace(needle,addition+needle).replace("\tSafeEngine['load'] = Engine.load;","\tSafeEngine['load'] = Engine.load;\n\tSafeEngine['loadBytes'] = Engine.loadBytes;")
            config=(source/'config.js').read_text().replace("onSuccess(result['instance'], result['module']);","onSuccess({exports:runtimeExports(result['instance'].exports)}, result['module']);")
            needle="'instantiateWasm': function (imports, onSuccess) {"
            if config.count(needle)!=1:raise ValueError('Godot instantiate adapter changed')
            config=config.replace(needle,needle+'\nimports=runtimeImports(imports);')
            combined="import Godot from './"+name+"';\nimport {runtimeExports,runtimeImports} from '../../../game_exports.mjs';\n"+(source/'features.js').read_text()+'\n'+(source/'preloader.js').read_text()+'\n'+config+'\n'+engine+'\nexport default Engine;\n'
            engine_name='engine.'+sha(combined.encode())[:16]+'.mjs';(player/engine_name).write_text(combined)
            for path in (evidence/'godot-rebased-browser').glob('godot.editor.audio*.js'):shutil.copyfile(path,player/path.name)
            descriptor=dict(kind=target,runtime='player/'+engine_name,runtimeBase='player/godot.editor',assets=[])
    # Player code is supplied SDK glue, never a precompiled game/editor module.
    descriptor['runtime_sha256']=sha((project/descriptor['runtime']).read_bytes())
    manifest['player']=descriptor;save(project/'manifest.json',manifest);(project/'manifest.sha256').write_text(sha((project/'manifest.json').read_bytes())+'\n')
    print('Prepared player:',target,flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--evidence',type=Path,required=True);p.add_argument('--projects',type=Path,required=True);p.add_argument('--target',choices=['lara','doom','godot','all'],default='all');a=p.parse_args()
    for target in ['lara','doom','godot']if a.target=='all'else[a.target]:prepare(a.evidence.resolve(),a.projects.resolve()/target,target)
