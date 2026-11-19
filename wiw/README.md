# Will it Wasm?

Build a public GitHub C or C++ repository in the browser with [cppgm](https://github.com/vishvananda/cppgm). The local server serves build inputs and relays GitHub source archives. The browser runs the compiler, linker, and Alpine guest.

OpenLara, Doom 3, and the Godot editor are the first examples. They replay the qualified [incpption](https://github.com/vishvananda/incpption) Emscripten packages. The browser compiles project source and the supporting libraries in each plan. The package supplies pinned SDK headers, generated inputs, and the JavaScript runtime. The **Play** or **Open editor preview** button loads that runtime and any game data after the build.

## Start locally

Use Node.js 22 or later and Python 3. Stage these inputs once.

| Stage option | Input |
| --- | --- |
| `--incpption` | A built incpption site with all three projects and its compiler, shim, vendor, and linker files |
| `--alpine` | The Slim Alpine experiment’s `configure/` directory with `guest.json` and the referenced chunks |
| `--replay` | The Alpine browser replay site with `plans/manifest.json`, the SDK layers, and a cppgm Wasm binary |
| `--wasi-probe` | A static x86-64 Linux cppgm executable for configure checks in the Alpine guest. |
| `--shared-root` | Use incpption's asset URLs when this app is mounted at `/wiw/`. |
| `--compiler` | Optional raw Wasm seed for portable plans. Use an optimized `-O3` binary for the performance profile. |
| `--binaryen` and `--emscripten-plan` | Optional browser Binaryen build and captured Emscripten plan. |

```sh
npm run stage -- --incpption "$INCPPTION_SITE" --alpine "$ALPINE_GUEST" --replay "$REPLAY_SITE" --compiler "$CPPGM_WASM"
npm start
```

Open [http://127.0.0.1:8327/](http://127.0.0.1:8327/). The staging command prepares `dist/`, compresses the compiler, and links to the large SDK and project assets. Build input files stay outside Git. The examples use their qualified cppgm v0.9.6 compiler to reproduce the original objects and executable hashes.

The server binds to loopback. Set `WILLITWASM_HOST` and `WILLITWASM_PORT` to change the listener. It sets the isolation headers required to share input memory across workers. Codeload restricts cross-origin archive reads, so the server relays only public GitHub tarballs pinned by commit. A hosted version needs the same headers and archive route.

## Find and reuse a plan

```text
/?repo=https://github.com/owner/project
/?repo=https://github.com/owner/project&ref=v1.2.3
/?repo=https://github.com/owner/project&plan=https://example.org/build.wwplan
```

Encode the query parameters when building a link. An explicit `plan` takes priority. Otherwise the three example URLs use their frozen incpption packages. For other repositories the app resolves the selected ref to a full commit, then looks for the publisher’s `.willitwasm/plan.json`, a plan saved in the browser, and an optional registry. Pass `--registry https://example.org/plans.json` when staging to enable a read-only index. It maps lowercase `owner/repo@commit` keys to plan URLs.

```json
{
  "schema": "willitwasm/v1",
  "plans": {
    "owner/project@0123456789abcdef0123456789abcdef01234567": "./project.wwplan"
  }
}
```

Plan URLs and any asset URLs they reference must allow browser reads. Resolve source inputs at the commit named by the plan. For a repository-hosted WASI plan, omit `commit` to bind the plan to the commit from which the app fetched it. Shared plans include the full commit.

### WASI plan

A WASI plan lists the translation units and additional source inputs, such as headers. Paths are relative to the GitHub repository root. The browser serves them to the compiler under `checkout/` and supplies the pinned WASI SDK. Flags for `-Icheckout/include`, defines, language versions and libraries can be included as separate string arguments.

```json
{
  "schema": "willitwasm/v1",
  "kind": "wasi",
  "repo": "owner/project",
  "sources": ["src/main.c"],
  "files": ["include/options.h"],
  "compileFlags": ["-std=c17", "-Icheckout/include"],
  "linkFlags": [],
  "output": "project.wasm"
}
```

### Alpine plan

When the app finds no plan it offers to run the planner. The first use downloads about 115 MiB of the Alpine image. The browser caches the verified chunks. The WASI flow also loads the SDK and a static cppgm for guest probes. After approval the app fetches the pinned source archive, starts Alpine in a worker, and streams the configure and build output to the console.

The guest’s pinned SDK captures commands for CMake, Meson, configure and Make, plain Make, or Python configure with Ninja. For a subdirectory, target, or project-specific flags, a repository can supply `.willitwasm/configure.json`. For example:

```json
{
  "system": "cmake",
  "sourceDirectory": "tools/example",
  "options": ["-DBUILD_TESTING=OFF"],
  "target": "example"
}
```

The default target is **WebAssembly (WASI)** when a probe compiler is staged.
It supports CMake and Make recipes. CMake runs its compiler checks against the WASI SDK.
The browser builds the resulting Wasm with cppgm and its built-in linker.
The Linux x86-64 target remains available. Repositories with a prepared
Emscripten plan can replay their browser-specific targets directly.

The **QR Code generator** example starts with its GitHub source and CMake
options. The recipe supplies known header check results for the staged WASI SDK.
Alpine runs CMake and Ninja to capture the build plan. Choose **Generate in
Alpine**, then **Try QR generator** to run the new Wasm and display its SVG output.
Its plan is saved in this browser after the first run.

The browser saves the resulting CWL v1.2 workflow and its configured workspace in IndexedDB, then replays them through cppgm and the archiver. Linux plans link with Wasm LLD. Choose **Download plan** to get a portable `.wwplan` file. Open it on another device with **Open a saved plan**, or host it and use `&plan=`. The file starts with a four-byte little-endian JSON header length, the plan header with inline CWL and the snapshot’s SHA-256, and the packed workspace. A JSON descriptor of kind `alpine-cwl` can also carry a `workflowURL` and `snapshotURL` with `snapshotSha256`.

## Generate from an upstream repository

[Capture results and commands](docs/capture.md) show the upstream web build commands and how to generate a reusable plan. The site examples use the qualified, expanded packages. The capture tools can list upstream commands or record a complete Emscripten replay plan. A replay plan builds the Wasm in the browser and downloads the web files as a ZIP.

A project can also cross-configure with a WASI toolchain even if it has no WASI build target. The CMake exporter reads the target's compilation database, scans the source dependencies, and includes generated headers in the plan. The [xxHash WASI plan](web/plans/xxhash-wasi.json) was generated this way and builds in the browser.

```text
/?repo=https://github.com/Cyan4973/xxHash&plan=/plans/xxhash-wasi.json
```

## Checks

`npm test` checks plan discovery, commit pinning, saved bundles, storage input limits, and Alpine batch encoding.

Run the browser tests against the staged local server with Playwright and Chromium installed. Set `PLAYWRIGHT_PATH` to another checkout’s installed Playwright when reusing it.

```sh
node tests/browser.mjs lara doom godot
node tests/wasi-browser.mjs
node tests/cmake-wasi-browser.mjs web/plans/xxhash-wasi.json
node tests/alpine-browser.mjs
node tests/alpine-wasi-browser.mjs
node tests/emscripten-browser.mjs /web-plans/owner/project/commit/plan.json
```
