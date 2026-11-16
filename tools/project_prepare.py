#!/usr/bin/env python3
"""Freeze complete project and SDK build recipes, then qualify the portable build."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import time
from artifact_transport import publish_bundle
from translation_profile import split_translations

EXTENSIONS={'.h','.hpp','.hh','.hxx','.inc','.inl','.def','.tcc','.c','.cc','.cpp','.cxx','.s','.S','.ipp','.modulemap','.gen','.glsl','.xpm'}

def digest(data): return hashlib.sha256(data).hexdigest()
def read(path): return json.loads(Path(path).read_text())
def save(path,value): Path(path).write_text(json.dumps(value,indent=2)+'\n')
def members(path): return subprocess.check_output(['llvm-ar-22','t',str(path)],text=True).splitlines()

class Profile:
    def __init__(self,evidence,root,target):
        self.evidence=evidence;self.root=root;self.target=target;self.directories=set();self.normalizations={};self.copied=set()
        self.mapping=[
            (evidence/'sdk-profile-emscripten-target/emscripten/cache/sysroot','emscripten/cache/sysroot'),
            (evidence/'sdk-profile/emscripten/cache/sysroot','emscripten/cache/sysroot'),
            (evidence/'sdk-profile-emscripten-target/cppgm_compat.h','cppgm_compat.h'),
            (evidence/'sdk-profile/cppgm_compat.h','cppgm_compat.h'),
            (evidence/'sdk-profile/emscripten','sdk'),
            (evidence/'emsdk/upstream/lib/clang','clang-resource'),
            (evidence/'openlara-repro-port/src','openlara/src'),
            (evidence/'d3wasm-source','doom'),
            (evidence/'godot-source','godot'),
            (Path(__file__).resolve().parents[1]/'third_party/runtime','sdk-compat')]
    def path(self,path):
        path=Path(path).absolute()
        for prefix,target in self.mapping:
            if path==prefix:return target
            if path.is_relative_to(prefix):return (Path(target)/path.relative_to(prefix)).as_posix()
        raise ValueError('unmapped project input: '+str(path))
    def copy(self,path):
        path=Path(path).absolute()
        if not path.exists():return
        # Both historical sysroots resolve to the selected Emscripten ABI profile.
        original=self.evidence/'sdk-profile/emscripten/cache/sysroot'
        if path==original or path.is_relative_to(original):
            path=self.evidence/'sdk-profile-emscripten-target/emscripten/cache/sysroot'/path.relative_to(original)
        if not path.exists():raise ValueError('selected ABI profile lacks '+str(path))
        if path.is_dir():
            if any(path==p or path.is_relative_to(p) for p in self.directories):return
            self.directories.add(path)
            for file in path.rglob('*'):
                if file.is_file() and not any(part.startswith('.') for part in file.relative_to(path).parts) and (file.suffix in EXTENSIONS or not file.suffix):self.copy(file)
            return
        if path in self.copied:return
        self.copied.add(path)
        portable=self.path(path);target=self.root/portable;target.parent.mkdir(parents=True,exist_ok=True)
        if not target.exists():shutil.copyfile(path,target)
        elif digest(target.read_bytes())!=digest(path.read_bytes()):raise ValueError('conflicting input '+str(target))
    def command(self,row,index,cwd):
        args=row['command'][1:];output=f'build/obj/{index:05}.o';result=[];source=None;language=None;i=0
        while i<len(args):
            arg=args[i];i+=1
            if arg=='-o':i+=1;continue
            if arg=='-x':language=args[i];result.extend([arg,language]);i+=1;continue
            if arg in ['-I','-isystem','-iquote','-include','-imacros'] or arg.startswith('-I') and len(arg)>2:
                joined=arg.startswith('-I') and len(arg)>2
                value=arg[2:] if joined else args[i]
                if not joined:i+=1
                path=Path(value) if Path(value).is_absolute() else cwd/value
                if path.exists():
                    self.copy(path);value=self.path(path)
                    result.extend(['-I'+value] if joined else [arg,value])
                elif arg in ['-include','-imacros']:result.extend([arg,value])
                continue
            if arg.startswith('--sysroot='):
                value=Path(arg.split('=',1)[1]);self.copy(value/'include');result.append('--sysroot='+self.path(value));continue
            if arg.startswith('-ffile-prefix-map='):
                # Canonical source paths already remove workstation locations.
                continue
            if arg.startswith('-fdebug-compilation-dir='):
                result.append('-fdebug-compilation-dir=/inputs');continue
            if arg.startswith(('-MMD','-MD')):continue
            if arg in ['-MF','-MT','-MQ']:i+=1;continue
            if not arg.startswith('-'):
                path=Path(arg) if Path(arg).is_absolute() else cwd/arg
                if path.is_file():
                    self.copy(path);arg=self.path(path)
                    if path.suffix in ['.c','.cc','.cpp','.cxx','.S','.s']:
                        source=arg;self.copy(path.parent)
            result.append(arg)
        if not source:raise ValueError('no source in '+str(row['command']))
        language=language or ('c' if source.endswith('.c') else 'assembler-with-cpp' if source.endswith(('.S','.s')) else 'c++')
        if language=='c++' and source.startswith('sdk/'):
            if '/libcxxabi/'in source or source.endswith('/libcxx/src/algorithm.cpp'):
                result=[v for v in result if not v.startswith('-std=')]+['-std=c++20']
            else:result.append('-Dconstinit=__attribute__((__require_constant_initialization__))')
        return dict(name=source,source=source,language=language,category='support' if source.startswith(('sdk/','sdk-compat/','emscripten/')) else 'project',
                    args=[*result,'-O3','-o',output],output=output)

def archive_bytes(rows,root):
    result=bytearray(b'!<arch>\n')
    for row in rows:
        name=row['name'].encode();data=(root/row['path']).read_bytes();size=len(name)+len(data)
        header=(f'#1/{len(name)}'.ljust(16)+'0'.ljust(12)+'0'.ljust(6)+'0'.ljust(6)+'100644'.ljust(8)+str(size).ljust(10)+'`\n').encode()
        result.extend(header+name+data)
        if size%2:result.extend(b'\n')
    return result

def recipe(e,target):
    folder={'lara':'openlara-rebased-current','doom':'d3wasm-rebased-current','godot':'godot-rebased-link'}[target]
    old=e/folder;archives=[]
    if target!='godot':
        rows=read(old/'summary.json')['rows']
        if target=='lara':
            by_path={row['output']:row for row in rows}
            for lib in sorted(old.glob('*.a')):
                archives.append(dict(original=str(lib),members=[dict(original=str(old/lib.stem/name),name=name) for name in members(lib)]))
        else:
            link=read(old/'link-command.json')
            for lib in [Path(value) for value in link if value.endswith('.a')]:
                group='app' if lib.name=='libidlib-startup.a' else 'sdk'
                archives.append(dict(original=str(lib),members=[dict(original=str(old/group/name),name=name) for name in members(lib)]))
            # Closure files are operands in the final link, not prebuilt libraries.
        return rows,archives,read(old/'link-command.json'),[e]*len(rows)
    rows=read(e/'godot-rebased-current/summary.json')['rows']
    database=read(e/'godot-source/compile_commands.json');cwd=[Path(item['directory']) for item in database]
    objects={item['output']:row['output'] for item,row in zip(database,rows)}
    for line in (e/'godot-verbose-dryrun.log').read_text().splitlines():
        if not line.startswith('emar '):continue
        args=shlex.split(line);name=args[2]
        archives.append(dict(original=str(old/name),members=[dict(original=objects.get(value,str(old/value)),name=Path(value).name) for value in args[3:]]))
        objects[name]=str(old/name)
    sdk_rows=read(e/'godot-sdk-cppgm/probe-rebased-current/summary.json')['rows'];plan=read(e/'godot-sdk-cppgm/plan.json');libs={}
    for item,row in zip(plan,sdk_rows):
        row=dict(row);row['output']=str(old/'sdk'/item['archive']/item['member'])
        rows.append(row);cwd.append(e)
        libs.setdefault(item['archive'],[]).append(dict(original=row['output'],name=item['member']))
    for closure in read(old/'sdk-closure.json'):
        row=dict(closure);row['output']=row['command'][row['command'].index('-o')+1]
        rows.append(row);cwd.append(e)
        # The recorded closure appends the corresponding object to libc/compiler_rt.
        lib=Path(row['output']).parent.name
        libs[lib].append(dict(original=row['output'],name=Path(row['output']).name))
    for name,items in libs.items():archives.append(dict(original=str(old/'sdk'/(name+'.a')),members=items))
    return rows,archives,read(old/'link-command.json'),cwd

def prepare(args,target):
    output=args.output/target
    previous=read(output/'build-plan.json') if args.resume and (output/'build-plan.json').is_file() else None
    output.mkdir(parents=True,exist_ok=args.resume);inputs=output/'inputs';inputs.mkdir(exist_ok=args.resume)
    rows,archive_plan,link,cwds=recipe(args.evidence,target);profile=Profile(args.evidence,inputs,target)
    extras_file=Path(__file__).resolve().parents[1]/'config/project-support.json'
    extras=read(extras_file).get(target,[]) if extras_file.exists() else []
    for extra in extras:
        source=str(Path(__file__).resolve().parents[1]/extra['site_source'])if extra.get('site_source')else str(args.evidence/'sdk-profile/emscripten'/extra['source'])
        if any(source in row['command']for row in rows):continue
        library=next(lib for lib in archive_plan if Path(lib['original']).name in ([extra['archive']]if extra.get('archive')else ['libc.a','libc-debug.a']))
        template=next(row for row in rows if '/musl/src/stdio/'in ' '.join(row['command']))
        command=list(template['command']);original_source=next(value for value in command if value.endswith('.c'))
        command[command.index(original_source)]=source
        original=str(Path(library['original']).parent/'extra'/extra['member'])
        command[command.index('-o')+1]=original
        rows.append(dict(command=command,output=original));cwds.append(args.evidence)
        library['members'].append(dict(original=original,name=extra['member']))
    commands=[];mapping={} 
    for index,(row,cwd) in enumerate(zip(rows,cwds)):
        command=profile.command(row,index,cwd);commands.append(command);mapping[row['output']]=command['output']
    archives=[]
    for index,row in enumerate(archive_plan):mapping[row['original']]=f'build/lib/{index:03}-{Path(row["original"]).name}'
    for row in archive_plan:
        archives.append(dict(name='Archive '+Path(row['original']).name,output=mapping[row['original']],
            members=[dict(path=mapping[item['original']],name=item['name']) for item in row['members']]))
    if target=='godot':
        original='godot/editor/translations/doc_translations.gen.cpp'
        command=next(row for row in commands if row['source']==original)
        raw=(inputs/original).read_bytes();main,parts=split_translations(raw)
        directory=Path(original).parent/'browser'
        files={'doc_translations.gen.cpp':main,**parts}
        for name,data in files.items():
            path=inputs/directory/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
        table=(directory/'doc_translations.gen.cpp').as_posix()
        command.update(name=table,source=table,args=[table if value==original else value for value in command['args']])
        owner=next(row for row in archives if any(member['path']==command['output']for member in row['members']))
        for name in parts:
            source=(directory/name).as_posix();output_path=f'build/obj/{len(commands):05}.o'
            args_part=[source if value==table else output_path if value==command['output']else value for value in command['args']]
            commands.append(dict(name=source,source=source,language='c++',category='project',args=args_part,output=output_path))
            owner['members'].append(dict(path=output_path,name=name+'.o'))
        profile.normalizations[original]=dict(kind='one translation data unit per locale',upstream_sha256=digest(raw),files={str(directory/name):digest(data)for name,data in files.items()})
    link_args=[];i=1
    while i<len(link):
        value=link[i];i+=1
        if value=='-o':i+=1;continue
        if value.endswith(('.a','.o')):
            if value not in mapping:raise ValueError('prebuilt link input remains: '+value)
            value=mapping[value]
        link_args.append(value)
    link_args+=['-o','build/'+target+'.wasm']
    imports=[link_args[i+1]for i,arg in enumerate(link_args)if arg=='--import-function']
    if target=='godot':imports.append('__c_longjmp')
    (inputs/'browser-imports.txt').write_text('\n'.join(imports)+'\n')
    manifest=dict(schema=2,id=target,compiler_manifest=digest((args.compiler_reference/'manifest.json').read_bytes()),
        commands=commands,archives=archives,link=dict(name='Link '+target,args=link_args,output='build/'+target+'.wasm'))
    if profile.normalizations:manifest['generated_inputs']=profile.normalizations
    manifest['source_date_epoch']=1735689600  # Stable __DATE__/__TIME__ in every project.
    if previous and previous['compiler_manifest']!=manifest['compiler_manifest']:raise ValueError('resume compiler differs')
    reusable={row['output']:row for row in previous['commands']} if previous and previous.get('source_date_epoch')==manifest.get('source_date_epoch') else {}
    if previous and previous.get('generated_inputs')!=manifest.get('generated_inputs'):
        reusable={key:row for key,row in reusable.items()if row['source']not in profile.normalizations}
    compiler=(args.compiler_reference/'native-compiler').resolve();(inputs/'build/obj').mkdir(parents=True,exist_ok=True);(output/'logs').mkdir(exist_ok=True)
    environment=os.environ.copy()
    if 'source_date_epoch'in manifest:
        shim=(output/'frozen-time.so').resolve()
        subprocess.run(['cc','-shared','-fPIC','-O2',str(Path(__file__).with_name('frozen_time.c')),'-o',str(shim)],check=True)
        environment.update(LD_PRELOAD=str(shim),TZ='UTC')
    start=time.monotonic()
    def compile_one(item):
        index,command=item;before=time.monotonic()
        if command['output'] in reusable and all(reusable[command['output']].get(key)==value for key,value in command.items()) and (inputs/command['output']).is_file() and reusable[command['output']].get('sha256') == digest((inputs/command['output']).read_bytes()):
            return index,dict(sha256=digest((inputs/command['output']).read_bytes()),seconds=0,reused=True)
        result=subprocess.run([str(compiler),*command['args']],cwd=inputs,capture_output=True,timeout=600,env=environment)
        (output/'logs'/f'{index:05}.log').write_bytes(result.stdout+result.stderr)
        if result.returncode:raise RuntimeError(command['source']+': '+result.stderr.decode(errors='replace')[-2000:])
        return index,dict(sha256=digest((inputs/command['output']).read_bytes()),seconds=time.monotonic()-before)
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures=[pool.submit(compile_one,item) for item in enumerate(commands)]
        for count,future in enumerate(as_completed(futures),1):
            index,result=future.result();commands[index].update(result)
            if count%100==0:print(target,count,'/',len(commands),flush=True)
    for archive in archives:
        path=inputs/archive['output'];path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(archive_bytes(archive['members'],inputs));archive['sha256']=digest(path.read_bytes())
    result=subprocess.run([str(compiler),*link_args],cwd=inputs,capture_output=True,timeout=600,env=environment)
    (output/'logs/link.log').write_bytes(result.stdout+result.stderr)
    if result.returncode:raise RuntimeError('Link '+target+': '+result.stderr.decode(errors='replace')[-2500:])
    manifest['link']['sha256']=digest((inputs/manifest['link']['output']).read_bytes())
    save(output/'native-complete.json',dict(seconds=time.monotonic()-start,units=len(commands),compiler_sha256=digest(compiler.read_bytes())))
    save(output/'build-plan.json',manifest)
    # Generated outputs are qualification evidence, not browser build inputs.
    files=[];raw=output/'bundle.bin'
    with raw.open('wb') as stream:
        for path in sorted(inputs.rglob('*')):
            if not path.is_file() or any(path.is_relative_to(inputs/name)for name in ['build','clang-build','wasi-build']) or (target=='godot'and path==inputs/'godot/editor/translations/doc_translations.gen.cpp'):continue
            data=path.read_bytes();files.append(dict(path=path.relative_to(inputs).as_posix(),offset=stream.tell(),size=len(data),sha256=digest(data)));stream.write(data)
    manifest.update(files=files,bundle_sha256=digest(raw.read_bytes()))
    if previous and (output/'manifest.json').is_file():
        existing=read(output/'manifest.json')
        if 'player'in existing:manifest['player']=existing['player']
    save(output/'manifest.json',manifest);(output/'manifest.sha256').write_text(digest((output/'manifest.json').read_bytes())+'\n')
    if (output/'chunks').exists():shutil.rmtree(output/'chunks')
    publish_bundle(raw,output,manifest,split_large_files=True);raw.unlink()
    print(target,'qualified',len(commands),'compiles',len(archives),'archives',flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['evidence','compiler-reference','output']:parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--resume',action='store_true');parser.add_argument('--target',choices=['lara','doom','godot','all'],default='all');parser.add_argument('--jobs',type=int,default=8)
    args=parser.parse_args();args.evidence=args.evidence.resolve();args.output=args.output.resolve();args.compiler_reference=args.compiler_reference.resolve()
    for target in ['lara','doom','godot'] if args.target=='all' else [args.target]:prepare(args,target)
