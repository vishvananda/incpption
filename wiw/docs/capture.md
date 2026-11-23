# Generate build plans from source

## Upstream web targets

Fresh source checkouts produce the application build commands. These captures used Emscripten 4.0.9 and the source revisions below.

| Project | Capture source | Application commands |
| --- | --- | --- |
| [OpenLara](https://github.com/XProger/OpenLara/tree/3b268ca4bf986c380f44a26ffd9218bf6d376249) | Expand the checked-in `src/platform/web/build_wasm.bat` variables | 3 compilations and one Emscripten invocation with preload assets |
| [Doom 3](https://github.com/gabrielcuvillier/d3wasm/tree/48f8f65d1216db3ee0b11872bb3b413febadc669) | Configure `neo/` with the Emscripten CMake toolchain, then read Ninja commands | 266 compilations, one archive, and one link |
| [Godot](https://github.com/godotengine/godot/tree/ed1daf0bf001b61586d9930840f2f1394092c079) | SCons dry run for the web editor | 2,547 compilations, 62 archives, a link, and generator actions |

```sh
python3 tools/capture_web.py openlara "$OPENLARA_CHECKOUT" "$CAPTURE"
python3 tools/capture_web.py doom "$DOOM_CHECKOUT" "$CAPTURE" --emsdk "$EMSDK"
python3 tools/capture_web.py godot "$GODOT_CHECKOUT" "$CAPTURE" --emsdk "$EMSDK"
```

Use fresh checkouts and an activated Emscripten SDK. Install SCons for the Godot capture or pass its executable with `--scons`.

The traces are inputs to a portable plan. Emscripten discovers additional libraries and ports during the link, supplies startup code, and emits JavaScript glue. Doom 3 requests SDL2, Vorbis, Ogg, JPEG, and zlib through its link settings. Godot's Python generators create required source and headers. Its web link includes pre-JavaScript, JavaScript libraries, and browser import settings. OpenLara's recipe also names preload data. cppgm needs the OpenLara source port for legacy byte encoding and current browser APIs. An unmodified checkout reproduced the UTF-8 error in `src/lang.h` with the qualified sysroot.

The command listings are useful for inspecting a project’s upstream web target. The replay exporter below runs the build and records the expanded Emscripten inputs, including the files generated during the build. The built-in demo links still use the qualified incpption plans.

## Repositories without a WASI target

[xxHash 0.8.3](https://github.com/Cyan4973/xxHash/tree/e626a72bc2321cd320e953a0ccf1584cad60f363) cross-configured through its existing CMake build and the WASI SDK's preview 1 toolchain. The exporter obtained `xxhash.c`, its header dependency and compile flags from CMake and the compiler's dependency scan. The user chooses the exported API. Chromium built the generated plan with cppgm and the downloaded module reported version 0.8.3 and returned the expected XXH64 empty-input hash.

```sh
cmake -S "$XXHASH_CHECKOUT/cmake_unofficial" -B "$BUILD" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK/share/cmake/wasi-sdk-p1.cmake" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DXXHASH_BUILD_XXHSUM=OFF -DBUILD_SHARED_LIBS=OFF

python3 tools/cmake_wasi_plan.py --source "$XXHASH_CHECKOUT" --build "$BUILD" \
  --sdk "$WASI_SDK" --target xxhash --repo Cyan4973/xxHash \
  --commit e626a72bc2321cd320e953a0ccf1584cad60f363 \
  --output xxhash.wasm --export XXH_versionNumber --export XXH64
```

[zlib 1.3.1](https://github.com/madler/zlib/tree/51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf) also cross-configured cleanly. Its plan captured 15 compilation units and the generated `zconf.h`. The first replay used the driver's default C++ mode for `.c` inputs. The runner now selects C explicitly. Chromium built the plan and the downloaded module compressed and decompressed a test payload.

This capture path uses native CMake and WASI Clang for configuration and dependency discovery. The browser builds the generated plan with cppgm. The site can also capture WASI plans in the browser with NanoVM or Alpine. Cross-configure recipes may need to provide results for checks that try to run a WASI target executable.

## Capture a replayable Emscripten web build

Use Emscripten 4.0.9, a matching native and WASI build of cppgm, and a
Linux host with Python 3.9+, `strace` and a C compiler. Start with a fresh checkout
and run the project's web build command. Configure out-of-tree CMake builds
before invoking the capture tool. The tool runs the build command locally,
so only use source and build commands you trust.

```sh
git clone https://github.com/olzhasar/sdl-tetris.git
git -C sdl-tetris checkout 428d99d52a1de2448c7442d2655fae56aa6e9e96

python3 tools/emscripten_plan.py \
  --workspace sdl-tetris --output tetris-plan \
  --emsdk "$EMSDK" --compiler "$CPPGM_NATIVE" --cache "$SDL_SDK_CACHE" \
  --repo olzhasar/sdl-tetris --commit 428d99d52a1de2448c7442d2655fae56aa6e9e96 \
  --entry dist/index.html -- make wasm
```

The capture uses Emscripten's driver to expand the compile, library, port and
link settings. cppgm compiles the project translation units. A file-open
trace records the headers and generated inputs actually read by cppgm.
LLD's reproduction archive identifies the SDK libraries and import files.
The exporter records any Binaryen steps and hashes their outputs. It keeps
the SDK archives separate so that browser builds with the same SDK inputs can
reuse the compressed download.

Use the Binaryen source revision `1217a95eb` from Emscripten 4.0.9 and
build its browser tools with that SDK.

```sh
cmake -S "$BINARYEN_SOURCE" -B binaryen-web -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
  -DBUILD_FOR_BROWSER=ON -DBUILD_TESTS=OFF -DBUILD_EMSCRIPTEN_TOOLS_ONLY=ON \
  -DEMSCRIPTEN_ENABLE_SINGLE_FILE=OFF -DENABLE_BIGINT=ON \
  -DBYN_ENABLE_LTO=OFF -DBYN_ENABLE_ASSERTIONS=OFF -DENABLE_WERROR=OFF
cmake --build binaryen-web --target wasm-opt wasm-metadce wasm-emscripten-finalize
```

Add `--binaryen binaryen-web --emscripten-plan tetris-plan` to the usual
`npm run stage` arguments. Open the printed plan path with
`?repo=olzhasar/sdl-tetris&plan=<path>`. The browser runs cppgm, the
archiver, LLD, and the recorded Binaryen tools. It checks the final module
against the native capture and offers a ZIP with the Wasm and web files.
Serve the extracted directory over HTTP and open the plan's HTML entry point.

The browser plan carries the JavaScript, HTML shell and preloaded data that
Emscripten prepared during capture. The Wasm is built from source on each run.
SDK archives are supplied by the selected SDK. The current capture path
supports one executable link per plan.

The 4.0.9 SDK used in these experiments has the Emscripten header spelling
normalizations already used by incpption. For C++ builds, use the matching
libc++ ABI profile and pass its `--compat` header. OpenLara also uses the
existing source port for legacy encoded strings and browser API calls.
The Doom 3 plan captures the upstream Asyncify link. Its game data is
distributed separately.

Godot's SCons generator puts the entire documentation translation catalog
in one C++ file. Generate that file first, then split it in the capture
checkout so each locale fits in the Wasm compiler's memory. The split
preserves the compressed bytes and the translation table lengths.

```sh
scons -C "$GODOT" platform=web target=editor threads=no wasm_simd=no \
  lto=none optimize=speed editor/translations/doc_translations.gen.cpp
python3 tools/godot_translations.py "$GODOT"

python3 tools/emscripten_plan.py \
  --workspace "$GODOT" --output godot-plan --emsdk "$EMSDK" \
  --compiler "$CPPGM_NATIVE" --cache "$CPP_SDK_CACHE" --compat "$CPP_SDK_COMPAT" \
  --repo godotengine/godot --commit ed1daf0bf001b61586d9930840f2f1394092c079 \
  --entry bin/.web_zip/godot.editor.html --link-opt=-O1 -- \
  scons platform=web target=editor threads=no wasm_simd=no lto=none optimize=speed
```

The `--link-opt=-O1` option applies to the separate Emscripten link.
SCons still compiles every translation unit at `-O3`.
