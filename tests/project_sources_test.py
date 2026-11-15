import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from project_sources import prepare_sources, prepare_projects


def digest(data):
    return hashlib.sha256(data).hexdigest()


class ProjectSourcesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = self.root / 'payload'
        self.output = self.root / 'output'

    def package(self, directory, files, extra, compressed=False):
        directory.mkdir(parents=True)
        bundle = b''
        rows = []
        for path, content in files:
            rows.append(dict(path=path, offset=len(bundle), size=len(content), sha256=digest(content)))
            bundle += content
        manifest = dict(schema=1, files=rows, bundle_sha256=digest(bundle), **extra)
        data = (json.dumps(manifest, indent=2) + '\n').encode()
        (directory / 'manifest.json').write_bytes(data)
        (directory / 'bundle.bin').write_bytes(gzip.compress(bundle) if compressed else bundle)
        return digest(data)

    def fixture(self, compressed=False):
        source = b'// preserved bytes\r\nint game() { return 7; }\n'
        checksum = self.package(self.payload, [('dev/main.cpp', source), ('dev/detail.h', b'#pragma once\n'),
                                ('sysroot/include/private.h', b'excluded SDK header')],
                                dict(sources=['dev/main.cpp']), compressed)
        self.package(self.payload / 'openlara', [('openlara/src/main.cpp', source),
                     ('openlara/src/header.h', b'// game header\n'), ('assets/media.bin', b'excluded media')],
                     dict(compiler_manifest=checksum, commands=[dict(args=['-O3', '-c', 'openlara/src/main.cpp', '-o', 'main.o']),
                                                               dict(args=['main.o', '-o', 'game.wasm'])]), compressed)

    def read_index(self):
        url = prepare_sources(self.payload, self.output)
        data = (self.output / url).read_bytes()
        self.assertEqual(url, 'assets/projects.' + digest(data) + '.json')
        return json.loads(data)

    def test_plain_and_gzip_preserve_bytes_and_deduplicate(self):
        for compressed in [False, True]:
            with self.subTest(compressed=compressed):
                self.payload = self.root / ('gzip' if compressed else 'plain')
                self.output = self.root / ('gzip-output' if compressed else 'plain-output')
                self.fixture(compressed)
                before = {str(p): p.read_bytes() for p in self.payload.rglob('*') if p.is_file()}
                index = self.read_index()
                self.assertEqual([p['id'] for p in index['projects']], ['game', 'cppgm'])
                game, compiler = index['projects']
                self.assertEqual(game['buildSources'], ['openlara/src/main.cpp'])
                self.assertEqual(compiler['buildSources'], ['dev/main.cpp'])
                game_source = next(f for f in game['files'] if f['path'].endswith('main.cpp'))
                compiler_source = next(f for f in compiler['files'] if f['path'].endswith('main.cpp'))
                self.assertEqual(game_source['url'], compiler_source['url'])
                self.assertEqual((self.output / game_source['url']).read_bytes(), b'// preserved bytes\r\nint game() { return 7; }\n')
                self.assertEqual(len(list((self.output / 'assets').glob('source.*.txt'))), 3)
                self.assertEqual(before, {str(p): p.read_bytes() for p in self.payload.rglob('*') if p.is_file()})
                self.assertEqual(index, self.read_index())

    def test_bundle_hash_rejects_corruption(self):
        self.fixture()
        with (self.payload / 'bundle.bin').open('ab') as stream:
            stream.write(b'corruption')
        with self.assertRaisesRegex(RuntimeError, 'bundle hash mismatch'):
            self.read_index()

    def change_game(self, change):
        path = self.payload / 'openlara/manifest.json'
        manifest = json.loads(path.read_bytes())
        change(manifest)
        path.write_text(json.dumps(manifest))

    def test_source_hash_is_checked_separately(self):
        self.fixture(True)
        self.change_game(lambda m: m['files'][0].update(sha256='0' * 64))
        with self.assertRaisesRegex(RuntimeError, 'source hash mismatch'):
            self.read_index()

    def test_mismatched_compiler_provenance(self):
        self.fixture()
        self.change_game(lambda m: m.update(compiler_manifest='0' * 64))
        with self.assertRaisesRegex(RuntimeError, 'different compiler manifest'):
            self.read_index()

    def test_source_bounds_and_paths(self):
        for change, message in [(lambda m: m['files'][0].update(size=10**6), 'source bundle bounds'),
                                (lambda m: m['files'][0].update(path='openlara/src/../escape.cpp'), 'source path')]:
            with self.subTest(message=message):
                self.payload = self.root / message.replace(' ', '-')
                self.fixture()
                self.change_game(change)
                with self.assertRaisesRegex(RuntimeError, message):
                    self.read_index()

    def test_missing_build_source_and_input_mutation_guard(self):
        self.fixture()
        self.change_game(lambda m: m['commands'][0].update(args=['-c', 'openlara/src/missing.cpp']))
        with self.assertRaisesRegex(RuntimeError, 'build source is missing'):
            self.read_index()
        with self.assertRaisesRegex(RuntimeError, 'outside the frozen payload'):
            prepare_sources(self.payload, self.payload / 'assets-output')


    def test_complete_profiles_include_sdk_and_assembly_with_bounded_source_views(self):
        checksum=self.package(self.payload,[('dev/main.cpp',b'int main(){}')],dict(sources=['dev/main.cpp']))
        self.package(self.payload/'llvm',[('clang/main.cpp',b'int main(){}')],dict(commands=[dict(source='clang/main.cpp')]))
        large=b'// generated source\n'*40000
        files=[('game/main.cpp',b'int main(){}'),('sdk/libc.c',b'int support;'),('sdk/memory.S',b'.text\n'),('game/generated.cpp',large)]
        commands=[dict(name=path,source=path,category='support'if path.startswith('sdk/')else'project')for path,_ in files]
        self.package(self.payload/'projects/doom',files,dict(compiler_manifest=checksum,commands=commands,archives=[dict(name='Archive libc')],link=dict(name='Link Doom')))
        url=prepare_projects(self.payload,self.output,{'doom':dict(available=True,name='Doom 3')})
        index=json.loads((self.output/url).read_bytes());project=index['projects'][0]
        self.assertEqual(project['buildSources'],[path for path,_ in files]);self.assertEqual(len(project['buildUnits']),6)
        by_path={row['path']:row for row in project['files']};row=by_path['game/generated.cpp'];blob=row['blob']
        self.assertTrue(blob['truncated']);self.assertEqual(blob['sourceBytes'],len(large));self.assertLessEqual(blob['size'],120000)
        shard=gzip.decompress((self.output/blob['url']).read_bytes());preview=shard[blob['offset']:blob['offset']+blob['size']]
        self.assertEqual(preview,large[:120000]);self.assertEqual(digest(preview),blob['sha256']);self.assertEqual(digest(large),row['sha256'])
        self.assertEqual(by_path['game/main.cpp']['blob'],index['projects'][1]['files'][0]['blob'])
        manifest_path=self.payload/'projects/doom/manifest.json';manifest=json.loads(manifest_path.read_text());manifest['compiler_manifest']='0'*64;manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RuntimeError,'different compiler'):
            prepare_projects(self.payload,self.output,{'doom':dict(available=True,name='Doom 3')})


if __name__ == '__main__':
    unittest.main()
