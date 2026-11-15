# cppgm inception

[incpption.com](https://incpption.com/) runs C++ compilers in your browser.
It downloads static files. Compilation, linking, byte checks and gameplay run
on your device. There is no build server.

[cppgm](https://github.com/vishvananda/cppgm) is a C++ compiler designed
for fast compilation. The starting cppgm compiler is a self-compiled WebAssembly
build. This repository contains the site, workers and static hosting tools.
The compiler profile uses the official cppgm v0.9.0 export.

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

The clang and LLD seeds were built by cppgm and match the optional clang stage.
Build results stay in the current tab. Select a completed stage to review it.
Use **Rerun** to build again and clear later results. Download badges estimate
cold, compressed input downloads, counting shared files once per workflow. The comparison downloads shared
inputs once and shares their memory between the two compiler pools.
Comparison build times exclude seed loading. Workflow time includes loading.
Compiler setup downloads appear at the start of each lane. Both lanes share
the same source, headers and SDK. The result shows their measured build-time
ratio. Game data downloads in the background during compilation and is cached
on the player origin for Play and later runs. If browser storage is unavailable,
Play downloads the data directly.
This is a comparison on your device, not a general compiler benchmark.

Source browsing loads small source shards. The compiler and SDK load only when
you compile. The code viewer shows source, LowIR, WebAssembly or x86 assembly.
Generated headers, JavaScript runtime glue and game assets are supplied inputs.
Project SDK libraries are built from source. Doom downloads its demo data during
compilation; playing it requires a browser with WebAssembly JSPI support. A byte match checks reproduction of the pinned build, not correctness
of every possible program.

## Run locally

Use Python 3.11+ and Node 22+:

```sh
npm ci
npm run build
npm run check
npx playwright install chromium webkit
npm test
npm run test:comparison
npm run test:mobile
```

The build fetches hash-pinned static packages from the URLs in `config/`.
It caches them in `.cache/` and writes the site to `dist/`.
Serve `dist/` with the cross-origin isolation headers in `config/_headers`.
These allow workers to share immutable inputs. Without isolation, each build
uses one worker. The comparison still runs both compilers in separate workers.

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
