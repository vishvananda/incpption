# cppgm inception

[incpption.com](https://incpption.com/) runs C++ compilers in your browser.
It downloads static files. Compilation, linking, byte checks and gameplay run
on your device. There is no build server.

[cppgm](https://github.com/vishvananda/cppgm-extended) is a C++ compiler designed
for fast compilation. The starting cppgm compiler is a self-compiled WebAssembly
build. This repository contains the site, workers and static hosting tools.
The compiler repository and executable are being renamed to `cppgm`; older
published packages still use the name `cppgm++`.

Choose a project and a workflow:

| Workflow | What runs in your browser |
| --- | --- |
| compile | cppgm and Clang compile the same source at O3, with the same SDK and equal worker counts. Both start together. Each uses its own linker. |
| inception | cppgm builds itself. Every object and the final compiler must match the published bytes. That rebuilt compiler then builds the project. |
| inception² | cppgm builds LLVM, Clang builds cppgm, and that compiler rebuilds a matching cppgm. The matching compiler then builds the project. This is a long build. |

OpenLara is the current packaged target. Doom 3 and the Godot editor have native
build and browser execution prototypes; their browser build packages are still
being prepared. Selecting them preserves the compiler stages and changes only
the final project stage. The site does not offer an unqualified build as ready.

The Clang and LLD seeds were built by cppgm and match the optional LLVM stage.
Build results stay in the current tab. Select a completed stage to review it.
Use **Rerun** to build again and clear later results. Download badges estimate
cold, compressed input downloads, counting shared files once per workflow. The comparison downloads shared
inputs once and shares their memory between the two compiler pools.
Comparison build times exclude seed loading. Workflow time includes loading.
This is a comparison on your device, not a general compiler benchmark.

Source browsing loads individual files. The compiler and SDK load only when
you compile. The code viewer shows source, LowIR, WebAssembly or x86 assembly.
Supplied inputs include SDK libraries, generated headers, runtime glue and game
assets. A byte match checks reproduction of the pinned build, not correctness
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
preparation, the optional full LLVM round trip and Cloudflare Pages deployment.

## Source and licenses

- [cppgm compiler](https://github.com/vishvananda/cppgm-extended)
- [LLVM and Clang](https://github.com/llvm/llvm-project)
- [OpenLara](https://github.com/XProger/OpenLara)
- [Doom 3 web port](https://github.com/gabrielcuvillier/d3wasm)
- [Godot](https://github.com/godotengine/godot)

Site source is [Apache-2.0](LICENSE). See [NOTICE](NOTICE) and `third_party/`.
Downloaded projects, SDK files and game data retain their own licenses.
Their manifests and the site's **Credits** page list their sources and notices.
