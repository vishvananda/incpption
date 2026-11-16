# cppgm inception

[incpption.com](https://incpption.com/) runs C++ compilers in your browser.
It downloads static files. Compilation, linking, byte checks and gameplay run
on your device. There is no build server.

[cppgm](https://github.com/vishvananda/cppgm) is a C++ compiler designed
for fast compilation. The starting cppgm compiler is a self-compiled WebAssembly
build. This repository contains the site, workers and static hosting tools.
The compiler profile uses the official cppgm v0.9.5 export.

Choose a project and a workflow:

| Workflow | What runs in your browser |
| --- | --- |
| compilation | cppgm and Clang compile the same source at O3, with the same SDK and equal worker counts. Both start together. Each uses its own linker. |
| inception | cppgm builds itself. Every object and the final compiler must match the published bytes. That rebuilt compiler then builds the project. |
| inception² | cppgm builds clang, clang builds cppgm, and that compiler rebuilds a matching cppgm. The matching compiler then builds the project. This is a long build. |

OpenLara is the default project because its download is smaller. Doom 3 and
the Godot editor are also available. Workflow badges include game data in
their totals and show its size separately.
Each build compiles its C, C++ and assembly sources, including the supporting
SDK libraries. The grid shows every source, archive and final link. Selecting
another project keeps completed compiler stages and changes the final stage.
The final action plays the game or opens the editor in a separate modal.
In the comparison, the **Cppgm complete!** prompt leaves the build visible.
**Play now** stops clang and releases its workers before opening the game.
**Wait for clang** keeps the comparison running; the game opens when it finishes.

The clang and LLD seeds were built by cppgm and match the optional clang stage.
Build results stay in the current tab. Select a completed stage to review it.
Use **Rerun** to build again and clear later results. Download badges estimate
cold, compressed input downloads, counting shared files once per workflow. The comparison downloads shared
inputs once and shares their memory between the two compiler pools.
Comparison build times exclude seed loading. Workflow time includes loading.
Compiler setup downloads appear at the start of each lane. Both lanes share
the same source, headers and SDK. The result shows their measured build-time
ratio. Desktop game data downloads in the background during compilation and is cached
on the player origin for Play and later runs. If browser storage is unavailable,
Play downloads the data directly. Phones wait until compilation finishes before
caching large game data, so Doom’s download does not overlap the compiler heaps.
This is a comparison on your device, not a general compiler benchmark.
The [native compilation cost study](https://incpption.com/report.html) examines a separate sample
and explains its methods and limits.

Phones and Safari default to two compile workers, one in each comparison lane.
Phones load the linker in a fresh worker after compilation. Releases with the optional WASI host helpers reuse one compiler
instance per worker: its data, heap and stack are reset between files while
its reserved memory and browser execution state stay warm. Clang’s executable is hashed and compiled as a stream. On phones its single
compiler worker loads it directly, without another coordinator module. Clang also reuses
its Wasm instance, with fresh JavaScript runtime and filesystem state for each
file. Both optimizations apply on phones and desktops. Older cppgm releases
release each phone worker after a file.
Idle workers are released as soon as their queue finishes. Four workers remain
available on phones in the Workers selector beside Start. Desktops can use up to
eight workers. The comparison selector shows workers per compiler.
The Safari default avoids competition for WebKit’s limited fast Wasm memory
reservations, which can put one compiler on a slower execution path.

Source browsing loads small source shards. The compiler and SDK load only when
you compile. The code viewer shows source, LowIR, WebAssembly or x86 assembly.
Generated headers, JavaScript runtime glue and game assets are supplied inputs.
Project SDK libraries are built from source. Doom downloads its demo data during
compilation; playing it requires a browser with WebAssembly JSPI support. A byte match checks reproduction of the pinned build, not correctness
of every possible program.

## Edit the report

Edit [web/report.md](web/report.md). It contains the text, tables and chart data.
HTML is generated during the normal site build.

```sh
npm run preview:report
```

Open http://127.0.0.1:8000/report.html and refresh after saving. This preview
needs no compiler downloads. `npm run build:report` writes a standalone preview
to `build/report-preview/`.

The YAML header controls page metadata. Layout comments keep section links
stable and mark the chart, stat cards and FAQ. An italic line above a table
becomes its caption. The page shell is [web/report.template.html](web/report.template.html);
styling and chart interaction remain in `web/report.css` and `web/report.mjs`.

## Run locally

Use Python 3.11+ and Node 22+:

```sh
npm ci
npm run build
npm run check
npx playwright install chromium webkit
npm test
npm run test:completion
npm run test:comparison
npm run test:mobile
npm run test:safari
SAFARI_TEST_MOBILE=1 SAFARI_TEST_WORKERS=2 npm run test:safari
```

The build fetches hash-pinned static packages from the URLs in `config/`.
It caches them in `.cache/` and writes the site to `dist/`.
Serve `dist/` with the cross-origin isolation headers in `config/_headers`.
These allow workers to share immutable inputs. Without isolation, each build
uses one worker. The comparison still runs both compilers in separate workers.

The **Real Safari** Actions workflow runs the published site in Apple Safari on
a macOS runner. It checks both compilers, playback and the complete self-build.
It accepts a deployment URL and worker count, so previous releases can be tested.

See [build and artifact notes](docs/build-and-artifacts.md) for package
preparation, the optional full clang round trip and Cloudflare Pages deployment.

## Source and licenses

- [cppgm compiler](https://github.com/vishvananda/cppgm)
- [LLVM and Clang](https://github.com/llvm/llvm-project)
- [OpenLara](https://github.com/XProger/OpenLara)
- [Doom 3 web port](https://github.com/gabrielcuvillier/d3wasm)
- [Godot](https://github.com/godotengine/godot)

Site source is [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and `third_party/`.
Downloaded projects, SDK files and game data retain their own licenses.
Their manifests and the site's **Credits** page list their sources and notices.
