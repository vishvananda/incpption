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
    if manifest.get('schema') != 1 or not isinstance(manifest.get('files'), list):
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
