# Build and artifact notes

The site is static. `tools/build.py` verifies input files against the locks in
`config/`, copies them into `dist/`, and adds the browser UI. No compiler runs
on a server when a visitor uses the site.

## Frozen inputs

`config/artifact-lock.json` pins the published cppgm seed, compiler source,
WASI SDK, all three project profiles, runtime glue, game data and the optional
clang source profile.
It preserves the compiler manifest and all byte-match reference files.

`config/clang-seed-lock.json` pins Clang and LLD seeds built by cppgm. Their
binary hashes equal those in the optional clang build manifest. They use the
same Emscripten host as the Clang built during inception². The comparison runs
Clang with LLD and cppgm with its internal linker. It does not use a server or
substitute a native Clang process.

The locks use immutable Pages deployment URLs, not a moving branch alias.
The build verifies every downloaded file. Source, SDK and seed chunks are
compressed before upload; the worker checks decoded hashes too. Large compiler
executables use 16 MiB ranges so every static file stays below Pages' 25 MiB
limit. Filesystem bundles normally split at file boundaries. A very large generated
source is split into ranges and reconstructed once in shared memory. Workers
share immutable file views without making a complete SDK copy per worker.
The file viewer uses small compressed shards and bounded previews for large
generated files; compilation always uses the complete checked source. The two
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
checks x86 output from native and Wasm compilers, and can rebuild a legacy OpenLara profile. Use `--reference-only` when preparing
the complete project profiles.
Current exports contain `cppgm`. Historical export names remain supported.

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

`tools/project_prepare.py` freezes all application and supporting source recipes
for OpenLara, Doom 3 and the Godot editor. Schema 2 lists every C, C++ and
assembly compilation, each archive's members and the final link. No precompiled
project objects or SDK libraries are supplied to the browser. The native
qualification uses the shipped cppgm binary and records output hashes. `tools/project_wasi.py` then builds the references with the actual shipped WASI
compiler. Browser cppgm builds must reproduce each WASI object, archive and final
module. Native hashes are retained separately so host-specific output changes
can be identified without weakening the browser checks. Compiler
self-build matching remains strict against the published compiler export.

Both compilers use the same source, ABI, SDK and O3 recipes. Supporting sources
needed by either optimizer are listed in `config/project-support.json` and built
by both. Clang's link allows only the recorded browser imports; missing C
library functions are link errors. A shared Emscripten ABI adapter supplies the
three setjmp helpers; clang imports the longjmp tag from the JavaScript host,
while cppgm defines the same tag internally. The adapter is compiled by both. Godot enables clang's legacy Wasm-EH setjmp lowering to use the same longjmp
runtime as cppgm. Assembly uses clang's in-process preprocessor
and assembler because a browser cannot spawn an external assembler.

Doom embeds the current date and time. Its profile fixes the compiler's realtime
clock to 2025-01-01 UTC for reproducible output. Native qualification uses
`tools/frozen_time.c` as a Linux preload shim; the browser uses a WASI clock
adapter. Clang receives matching predefined date/time values. Measurement uses
the unchanged monotonic clock. No project C/C++ source is changed for this.

Godot's generated documentation translation data is split into one unit per
locale and uses escaped byte strings instead of millions of initializer tokens. `tools/translation_profile.py`
retains every compressed byte and table length, adds one unused NUL per string,
and records original/encoded hashes in `generated_inputs`. This avoids exhausting
the WASI compiler's address space without removing translations or changing
editor implementation source. Both compilers consume the same encoded file.

`tools/project_player.py` prepares the projects' Emscripten JavaScript hosts.
It does not change the compiled Wasm bytes. Doom uses JSPI and downloads its demo
PK4 in the background during compilation. The player caches encoded chunks so
Play can reuse them without holding another complete data buffer in memory. Its known EM_ASM handlers are bound to the actual linked
addresses, so both linker layouts work without evaluating Wasm strings.
Godot accepts the browser-built bytes through its Engine loader and starts the
project manager. Game data and JavaScript hosts are static inputs.

`tools/project_refresh.py` requalifies frozen project inputs after a compiler
release, preserving the source, SDK and player files.
`tools/project_clang.py` checks the shared recipes and runtime closure with native
clang/LLD. `tools/llvm_refresh.py` requalifies the frozen clang profile after a
compiler release. `tools/package_payload.py` assembles the static payload and
its candidate lock. Publish only after full browser build and player checks.

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

The complete clang round trip is a separate manual CI job because it takes much
longer. Run it locally with `npm run test:roundtrip`, or select `clang_roundtrip`
when starting the Browser demo workflow. No source or build results are sent to a build server.

`npm run test:projects` compiles all three projects with both browser compilers
and checks both players. Godot coverage creates a project and opens its editor
after the runtime restarts; the home directory is persisted in IndexedDB.
`npm run test:players` rechecks saved browser outputs after host-only changes,
verifies that compiler inputs are unchanged and checks closing a focused dialog.
Deferred SDK focus callbacks are guarded after runtime shutdown. For a cppgm-only release check, `GAME_TEST_CPPGM_ONLY=1` stops the other
comparison build after cppgm completes and checks only the cppgm output.
This longer check is also a manual CI lane. Normal CI
uses OpenLara for the comparison and phone checks, plus a full cppgm self-build.

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
