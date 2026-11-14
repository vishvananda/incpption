# cpp inception

Private source and Cloudflare Pages configuration for **https://incpption.com**.
The public compiler lives in [cppgm-extended](https://github.com/vishvananda/cppgm-extended).

Three browser-local workflows share one progress grid and a fixed source browser:

- **cpp:** self-compiled cppgm seed → OpenLara → play.
- **inception:** seed → matching cppgm rebuild → OpenLara → play.
- **inception²:** seed → LLVM → Clang-produced cppgm → matching cppgm rebuild → OpenLara → play.

The starting compiler is the official `wasm32-wasip1` reference export from
cppgm main. Matching checks every corresponding object and the final module
against that published build. A match establishes reproducibility for these
frozen inputs and settings; it does not establish general compiler correctness.

Compilation, linking, comparisons, code views and gameplay run locally.
The server supplies static inputs. Edited source and generated code are never
uploaded. The game opens in a modal on a separate static origin, so a busy renderer
cannot block the build page or its Close button. Browser-built bytes pass
directly between the two frames with postMessage; neither host receives them.
Closing the modal removes the player and stops its rendering and audio.

## Build and test

Use Node 22 or newer, Python 3.10 or newer, and curl:

```sh
npm ci
npm run check
npm run test:transport
python3 tests/project_sources_test.py
python3 tests/llvm_profile_test.py
node tests/highlight_test.mjs
npm run build
npx playwright install chromium webkit
npm test
npm run test:mobile
GAME_TEST_TOUCH=1 npm run test:game
```

`tools/build.py` verifies all payload files against `config/artifact-lock.json`
and assembles `dist/`. The payload is cached in ignored `.cache/`. The complete
payload includes the optional LLVM sources; visitors download those inputs only
when building or inspecting LLVM. A local qualified copy can replace downloads:

```sh
python3 tools/build.py --artifact-dir /path/to/static-payload --force
```

The normal browser test checks source/LowIR/Wasm/x86 views, complete downloads
with bounded previews, invalid-source recovery, concurrent compilation, cancel
and restart, byte matching, persistent phase times, and actual gameplay.
Phone checks cover Chromium gameplay with simultaneous touch inputs and
Chromium/WebKit layout at 320, 390 and 430 pixels. Chromium is the qualified
compiler runtime. Results and screenshots are saved under ignored `build/`.

```sh
npm run test:inspector
# Long: compile all LLVM sources, run Clang, match cppgm, build and play OpenLara.
npm run test:roundtrip
# The single-worker fallback also works without cross-origin isolation.
DEMO_TEST_ISOLATION=0 DEMO_TEST_WORKERS=1 npm test
```

CI runs the normal tests on pushes and pull requests. The longer Clang roundtrip
has a separate, opt-in `clang_roundtrip` workflow-dispatch job.

## Build inputs and provenance

`web/` contains the current interface and orchestration. The artifact lock pins
immutable compiler, game and LLVM input packages. The source manifests and
published compiler bytes retain their original hashes. `site-release.json`
records the site revision, artifact lock, compiler manifest and seed hashes.
Never change hashes to hide a mismatch: independently qualify a new package.

`tools/reference_prepare.py` converts the official reference export to the site
profile. It verifies export provenance, rebuilds the compiler independently,
checks exact seed equality and native/WASI x86 outputs, and rebuilds OpenLara
with the same compiler. `tools/llvm_prepare.py` packages a frozen LLVM build
only after all native and WASI object hashes agree. It omits LLVM objects,
archives and executables. The source overlays in `patches/llvm/` use Emscripten's
stack API, disable process-level crash recovery inside the worker, and flatten
two long StringSwitch call chains. `tools/llvm_source_profile.py` splits
consecutive generated ARM case labels with empty statements. These source
shapes stay within the browser call-stack limit and retain the same behavior;
the ARM object remains byte-identical.

LLVM's node builds Clang and LLD from 2,374 C/C++ files. cppgm links LLD, then
that newly built LLD links Clang. Clang compiles all cppgm sources; the seed
links those objects to a WASI compiler. That compiler rebuilds cppgm with the
canonical settings. Only this final cppgm rebuild is labelled **matches**.
Clang uses Wasm exception handling and disables bulk-memory lowering to avoid
LLVM 22's internal landing-pad TLS flags. The normal linker TLS checks stay on.

SDK libraries, Emscripten JavaScript glue, generated LLVM headers and game assets
are supplied inputs. No prebuilt LLVM program object or executable is shipped.
OpenLara's two `.c` files retain its upstream C++ build mode. LLVM's nine C
translation units use cppgm's real C mode.

`tools/artifact_transport.py` splits bundles at file boundaries into gzip chunks
below Cloudflare Pages' 25 MiB file limit. The browser verifies each decoded
chunk and file and shares immutable input views through SharedArrayBuffer.
It does not concatenate the full source/SDK bundle or copy it per worker.
Static hosting can strip Content-Encoding, so `transport_bytes.mjs` also
recognizes and decompresses gzip bytes explicitly. All dependencies are local;
no third-party script CDN is required.

Each source has a fresh compiler instance. Up to eight workers share the
compiled WebAssembly.Module; output buffers transfer to the coordinator.
Linking follows the frozen source order. Compile workers stop before the large
LLVM link. Cancel and failure terminate all workers. Without cross-origin
isolation, the demo uses one worker. Guest memory is reported per instance.

The source browser fetches individual hashed files without loading the compiler.
Headers are browseable inputs, not extra compile jobs. LowIR and Wasm/x86 views
are generated on request using each project's frozen flags. LLVM and OpenLara
use their supplied Wasm SDK profiles. The editable example supports both targets.

## Compiler portability experiments

`tools/prepare_emscripten.py` prepares a private Emscripten 4.0.9 profile with
libc++ ABI version 1. It records header patches and rebuilt runtime archive
hashes. The public visibility-event member is protected from musl's internal
`hidden` macro when compiling SDK sources.

`tools/probe_project.py` compiles a frozen Emscripten compilation database with
the native cppgm executable, targeting Wasm. It chooses C or C++ per source,
keeps each compilation-database entry distinct, and records commands, errors,
times and object hashes. Its summary measures compilation only. It does not
qualify linking, runtime behavior or browser build speed. Keep experiment data
outside this repository; these experiments do not change the published demo.

```sh
python3 tools/probe_project.py --database /path/to/compile_commands.json \
  --profile /path/to/private-sdk --compiler /path/to/cppgm++ \
  --output /path/to/new-observations --jobs 8
```

## Deployment

Cloudflare Pages project: `cpp-inception`. Domain: `incpption.com`.
Account and project are in `site.json`; isolation headers are in `config/_headers`.
The small player uses Pages project `cpp-inception-player` and
`player/wrangler.toml`. `tools/player_build.py` extracts only its host code,
Emscripten glue and notices. It contains no prebuilt game or compiler. Pin its
immutable `game_frame.html` URL in `site.json` before deploying the main site.
The player adds Cross-Origin-Resource-Policy so the isolated build page can
embed it. Local tests use a separate loopback hostname to exercise the same
origin boundary.
Use authenticated Wrangler 4.127.0 after validation:

```sh
python3 tools/player_build.py --site dist --output build/player
cd player
wrangler pages deploy ../build/player --project-name cpp-inception-player --branch main
cd ..
# Pin the returned immutable player URL in site.json, then rebuild dist.
wrangler pages deploy dist --project-name cpp-inception --branch main
```

Keep credentials out of this repository. Website updates and compiler provenance
have separate revisions. See `LICENSE`, `NOTICE`, `third_party/` and the deployed
credits for retained attribution. Game assets retain their owners' copyrights.
