"""Publish checked, per-file source views from the frozen compiler/game bundles."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from artifact_transport import logical_bytes


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _logical_bytes(path):
    return logical_bytes(path)


def _source_path(value):
    if not isinstance(value, str):
        raise RuntimeError('project source path must be a string')
    path = PurePosixPath(value)
    if path.is_absolute() or not value or '\\' in value or '..' in path.parts or str(path) != value:
        raise RuntimeError('invalid project source path: ' + value)
    return path


def _manifest(directory):
    data = _logical_bytes(directory / 'manifest.json')
    checksum = directory / 'manifest.sha256'
    if checksum.is_file() and _logical_bytes(checksum).decode().strip() != _digest(data):
        raise RuntimeError('project manifest hash mismatch: ' + str(directory))
    manifest = json.loads(data)
    if manifest.get('schema') not in [1,2] or not isinstance(manifest.get('files'), list):
        raise RuntimeError('unsupported project manifest: ' + str(directory))
    return manifest, _digest(data)


def _publish(assets, name, data):
    target = assets / name
    if target.exists():
        if target.read_bytes() != data:
            raise RuntimeError('content-addressed source asset changed: ' + str(target))
    else:
        target.write_bytes(data)
    return 'assets/' + name


def _project(directory, manifest, assets, project_id, name, root, build_sources):
    bundle = _logical_bytes(directory / 'bundle.bin')
    if _digest(bundle) != manifest.get('bundle_sha256'):
        raise RuntimeError('project bundle hash mismatch: ' + str(directory))
    selected = []
    seen = set()
    extensions = {'.cpp', '.c', '.h', '.hpp', '.inc', '.def'}
    for row in manifest['files']:
        path = _source_path(row['path'])
        if not path.is_relative_to(root) or path.suffix not in extensions:
            continue
        if row['path'] in seen:
            raise RuntimeError('duplicate project source: ' + row['path'])
        seen.add(row['path'])
        offset, size = row.get('offset'), row.get('size')
        if (type(offset) is not int or type(size) is not int or offset < 0 or size < 0
                or offset > len(bundle) or size > len(bundle) - offset):
            raise RuntimeError('invalid source bundle bounds: ' + row['path'])
        checksum = row.get('sha256')
        content = memoryview(bundle)[offset:offset + size]
        if not isinstance(checksum, str) or not re.fullmatch(r'[0-9a-f]{64}', checksum) or _digest(content) != checksum:
            raise RuntimeError('project source hash mismatch: ' + row['path'])
        url = _publish(assets, 'source.' + checksum + '.txt', content)
        selected.append(dict(path=row['path'], url=url, sha256=checksum))
    if not isinstance(build_sources, list) or not build_sources:
        raise RuntimeError('project has no build sources: ' + project_id)
    for source in build_sources:
        _source_path(source)
        if source not in seen:
            raise RuntimeError('build source is missing from project: ' + source)
    if len(set(build_sources)) != len(build_sources):
        raise RuntimeError('duplicate build source: ' + project_id)
    return dict(id=project_id, name=name, root=root, buildSources=build_sources,
                files=sorted(selected, key=lambda row: row['path']))


def prepare_sources(payload: Path, output: Path) -> str:
    """Return a content-hashed project index URL; never mutate the input payload."""
    payload, output = Path(payload).resolve(), Path(output).resolve()
    assets = output / 'assets'
    if output.is_relative_to(payload) or assets.resolve().is_relative_to(payload):
        raise RuntimeError('source asset output must be outside the frozen payload')
    compiler, compiler_hash = _manifest(payload)
    game, _ = _manifest(payload / 'openlara')
    if game.get('compiler_manifest') != compiler_hash:
        raise RuntimeError('game sources refer to a different compiler manifest')
    commands = game.get('commands')
    if not isinstance(commands, list) or len(commands) < 2:
        raise RuntimeError('game manifest has no source build commands')
    game_sources = []
    for command in commands[:-1]:
        args = command.get('args')
        if not isinstance(args, list) or args.count('-c') != 1 or args.index('-c') + 1 >= len(args):
            raise RuntimeError('game source command needs one -c argument')
        game_sources.append(args[args.index('-c') + 1])
    assets.mkdir(parents=True, exist_ok=True)
    projects = [
        _project(payload / 'openlara', game, assets, 'game', 'OpenLara', 'openlara/src', game_sources),
        _project(payload, compiler, assets, 'cppgm', 'cppgm', 'dev', compiler.get('sources')),
    ]
    if (payload / 'llvm/manifest.json').is_file():
        llvm, _ = _manifest(payload / 'llvm')
        projects.append(_project(payload / 'llvm', llvm, assets, 'llvm', 'LLVM', '',
            [row['source'] for row in llvm['commands']]))
    data = (json.dumps(dict(schema=1, projects=projects), indent=2) + '\n').encode()
    return _publish(assets, 'projects.' + _digest(data) + '.json', data)

class SourceAssets:
    """Small compressed source shards keep large SDK trees within host file limits."""
    def __init__(self, assets):
        self.assets=assets;self.seen={};self.data=bytearray();self.pending=[]
    def add(self,data,checksum):
        if checksum in self.seen:return self.seen[checksum]
        if self.data and len(self.data)+len(data)>1024*1024:self.flush()
        truncated=len(data)>512*1024
        preview=data[:120000] if truncated else data
        row=dict(offset=len(self.data),size=len(preview),sha256=_digest(preview),truncated=truncated,sourceBytes=len(data));self.seen[checksum]=row
        self.pending.append(row);self.data.extend(preview)
        return row
    def flush(self):
        if not self.pending:return
        import gzip
        raw=bytes(self.data);name='source.'+_digest(raw)+'.bin'
        target=self.assets/name
        if not target.exists():target.write_bytes(gzip.compress(raw,compresslevel=6,mtime=0))
        for row in self.pending:row['url']='assets/'+name
        self.data.clear();self.pending.clear()


def prepare_projects(payload,output,registry):
    """Publish complete project/SDK source views from schema-2 frozen packages."""
    assets=output/'assets';assets.mkdir(parents=True,exist_ok=True);publisher=SourceAssets(assets);projects=[]
    def project(directory,project_id,name,root,build_sources,units=None):
        manifest,_=_manifest(directory);bundle=_logical_bytes(directory/'bundle.bin')
        if _digest(bundle)!=manifest['bundle_sha256']:raise RuntimeError('source bundle changed')
        rows=[];seen=set()
        for row in manifest['files']:
            path=_source_path(row['path'])
            if root and not path.is_relative_to(root):continue
            if path.suffix not in {'.cpp','.cc','.cxx','.c','.h','.hpp','.hh','.inc','.inl','.def','.S','.s','.xpm','.glsl',''}:continue
            if row['path']in seen:raise RuntimeError('duplicate source input')
            seen.add(row['path'])
            if type(row['offset'])is not int or type(row['size'])is not int or row['offset']<0 or row['size']<0 or row['offset']>len(bundle)or row['size']>len(bundle)-row['offset']:raise RuntimeError('invalid source input bounds')
            data=memoryview(bundle)[row['offset']:row['offset']+row['size']]
            if len(data)!=row['size'] or _digest(data)!=row['sha256']:raise RuntimeError('source input changed')
            rows.append(dict(path=row['path'],sha256=row['sha256'],blob=publisher.add(data,row['sha256'])))
        available={row['path']for row in rows}
        if not set(build_sources)<=available:raise RuntimeError('compiled source absent from project index')
        item=dict(id=project_id,name=name,root=root,buildSources=list(dict.fromkeys(build_sources)),files=rows)
        if units:item['buildUnits']=units
        projects.append(item)
    _,compiler_hash=_manifest(payload)
    for project_id,metadata in registry.items():
        if not metadata.get('available'):continue
        directory=payload/'projects'/project_id;manifest,_=_manifest(directory)
        if manifest.get('compiler_manifest')!=compiler_hash:raise RuntimeError('project sources use a different compiler manifest')
        units=[*manifest['commands'],*manifest['archives'],manifest['link']]
        project(directory,project_id,metadata['name'],'',[row['source']for row in manifest['commands']],
                [dict(name=row['name'],source=row.get('source'),category=row.get('category','link'))for row in units])
    compiler,_=_manifest(payload)
    project(payload,'cppgm','cppgm','dev',compiler['sources'])
    clang,_=_manifest(payload/'llvm')
    project(payload/'llvm','llvm','clang','',[row['source']for row in clang['commands']])
    publisher.flush()
    data=(json.dumps(dict(schema=1,projects=projects),separators=(',',':'))+'\n').encode()
    return _publish(assets,'projects.'+_digest(data)+'.json',data)
