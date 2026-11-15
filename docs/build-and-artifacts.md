# Build and artifact notes

The site is static. `tools/build.py` verifies input files against the locks in
`config/`, copies them into `dist/`, and adds the browser UI. No compiler runs
on a server when a visitor uses the site.

## Frozen inputs

`config/artifact-lock.json` pins the published cppgm seed, compiler source,
WASI SDK, OpenLara source and assets, and the optional LLVM source profile.
It preserves the compiler manifest and all byte-match reference files.

`config/clang-seed-lock.json` pins Clang and LLD seeds built by cppgm. Their
binary hashes equal those in the optional LLVM build manifest. They use the
same Emscripten host as the Clang built during inception². The comparison runs
Clang with LLD and cppgm with its internal linker. It does not use a server or
substitute a native Clang process.

The locks use immutable Pages deployment URLs, not a moving branch alias.
The build verifies every downloaded file. Source, SDK and seed chunks are
compressed before upload; the worker checks decoded hashes too. Large compiler
executables use 16 MiB ranges so every static file stays below Pages' 25 MiB
limit. Filesystem bundles split at file boundaries, so workers can share
immutable file views without making a complete SDK copy per worker. The two
comparison pools also share downloaded input buffers. Their shared cache is
released on completion or cancellation.

To prepare a new Clang seed package from a qualified LLVM build:

```sh
python3 tools/seed_prepare.py --llvm /path/to/qualified/llvm \
  --binaries /path/to/qualified/inputs/bin --output build/clang-seed
python3 tools/build.py --force --seed-dir build/clang-seed
npm run test:comparison
```

The tool rejects binaries whose hashes differ from the LLVM manifest. After
qualification, publish that static package and update the seed lock with its
immutable URL and encoded file hashes. For local work, an existing qualified
main payload can replace downloads with `--artifact-dir /path/to/payload`.

`tools/reference_prepare.py` can prepare a package from an official reference
export. It checks the seed, recompiles the compiler, checks its output bytes,
checks x86 output from native and Wasm compilers, and rebuilds OpenLara.
Legacy exports contain the executable `cppgm++`; the site calls it cppgm and
retains compatibility with those frozen packages during the rename.

## Compiler and project profiles

`tools/llvm_prepare.py` prepares LLVM 22.1.2 source for the browser round trip.
The profile supplies generated headers, SDK archives and runtime glue. It
compiles C sources as C. It uses Wasm exceptions and disables bulk-memory
instructions for Clang's cppgm output. The cppgm seed links those objects to
make a WASI compiler. That compiler must reproduce the cppgm reference bytes.

The LLVM source adaptations are recorded in `patches/llvm/` and the manifest.
They use the Emscripten stack API, disable process crash recovery, flatten two
MSP430 StringSwitch chains, and split long generated ARM case-label chains.
The generated ARM change preserves the resulting object bytes.

The current OpenLara package compiles its three application units, then links
against supplied SDK archives. Upstream OpenLara also compiles its two `.c`
units as C++ in this web build. `tools/openlara_prepare.py` freezes the source,
SDK, commands, runtime and game assets. The build date is fixed for byte checks.

Doom 3 and Godot need separate frozen packages and browser compilation checks
before they are enabled. Native prototype success and execution of native-built
Wasm in a browser do not qualify compilation inside the browser. Godot's output
is the editor, so its final action will open the editor rather than start a game.

`tools/prepare_emscripten.py` and `tools/probe_project.py` support compiler/SDK
experiments. They are not part of a visitor's build path. These newer profiles
can differ from the pinned public site package.

## Tests

Normal CI runs syntax, highlighting, transport, source-profile and state tests;
a real cppgm self-build; the two-compiler comparison; and mobile/player checks.
The comparison waits for both compilers and inputs before releasing either
build. It gives each the same worker count and O3 source settings. Its build
times exclude download/preparation; total workflow time includes them. Concurrent
toolchains share the device, so these results are not an isolated benchmark.

```sh
npm run check
npm run test:workflow
npm run test:transport
python3 tests/project_sources_test.py
python3 tests/llvm_profile_test.py
node tests/highlight_test.mjs
npm test
npm run test:comparison
npm run test:mobile
GAME_TEST_TOUCH=1 npm run test:game
```

The complete LLVM round trip is a separate manual CI job because it takes much
longer. Run it locally with `npm run test:roundtrip`, or select `clang_roundtrip`
when starting the Browser demo workflow. No results are sent to a build server.

## Deploy

Cloudflare Pages serves the site. The page and all workers need the isolation
headers in `config/_headers`. `_headers` also controls code and asset caching.
The game uses a separate static player origin to keep its renderer from blocking
the parent's controls. Browser-built bytes pass directly to that frame through
`postMessage`. Closing the modal removes the frame and stops rendering/audio.

```sh
npm run build
python3 tools/player_build.py --site dist --output build/player
cd player
wrangler pages deploy ../build/player --project-name cpp-inception-player --branch main
```

Pin the returned immutable player URL in `site.json`, then rebuild the site and
publish from the repository root:

```sh
npm run build
wrangler pages deploy dist --project-name cpp-inception --branch main
```

The player only needs publishing when its source or runtime changes. Site builds
include the code revision and input hashes in `site-release.json`.
