# Will it Wasm?

Build a public GitHub C or C++ repository in the browser with [cppgm](https://github.com/vishvananda/cppgm). The local server serves build inputs and relays GitHub source archives. The browser runs the planner, compiler, and linker.

OpenLara, Doom 3, and the Godot editor are the first examples. They replay the qualified [incpption](https://github.com/vishvananda/incpption) Emscripten packages. The browser compiles project source and the supporting libraries in each plan. The package supplies pinned SDK headers, generated inputs, and the JavaScript runtime. The demo opens after a successful build and loads its runtime and any game data. Use **Play** or **Open editor preview** to reopen it.

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
| `--nano-source`, `--nano-wasm`, `--nano-make`, `--nano-make-source` | Enable NanoVM with the source checkout, BusyBox Wasm build, static RISC-V GNU Make, and GNU Make 4.4.1 source archive pinned in [nanovm.json](config/nanovm.json). |
| `--wanix-source`, `--wanix`, `--wanix-extras`, `--wanix-make`, `--wanix-apks` | Enable Wanix Linux with the source revision and packages pinned in [wanix.json](config/wanix.json). |
| `--macho-compiler` | The `bin/cppgm.wasm` from the pinned cppgm WASI release for Apple Silicon output. |
| `--binaryen` and `--emscripten-plan` | Optional browser Binaryen build and captured Emscripten plan. |

```sh
npm run stage -- --incpption "$INCPPTION_SITE" --alpine "$ALPINE_GUEST" \
  --replay "$REPLAY_SITE" --compiler "$CPPGM_WASM" --wasi-probe "$STATIC_CPPGM"
npm start
```

Open [http://127.0.0.1:8327/](http://127.0.0.1:8327/). The staging command prepares `dist/`, compresses the compiler, and links to the large SDK and project assets. Build input files stay outside Git. The examples use their qualified cppgm v0.9.6 compiler to reproduce the original objects and executable hashes.

To enable NanoVM, add `--nano-source "$NANO_CHECKOUT" --nano-wasm "$NANO_WASM"
--nano-make "$RISCV_MAKE" --nano-make-source "$MAKE_SOURCE"` to the staging
command. Keep `--wasi-probe` for Alpine fallback builds that target WASI.

To enable Wanix Linux, add `--wanix-source "$WANIX_CHECKOUT" --wanix "$WANIX_NPM"
--wanix-extras "$WANIX_EXTRAS_NPM" --wanix-make "$ALPINE_X86_MAKE" --wanix-apks "$WANIX_APKS"`.
Staging builds the pinned Wanix kernel with Go and limits the Linux guest's
filesystem export to its build image. Use the [Wanix runtime package](https://registry.npmjs.org/wanix/-/wanix-0.4.0-rc2.tgz),
[Wanix extras package](https://registry.npmjs.org/wanix-extras/-/wanix-extras-0.4.0-rc2.tgz),
and [Alpine Make package](https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86/make-4.4.1-r3.apk).
Place the APKs specified in the `alpinePackages` table in `$WANIX_APKS`. Each URL uses the
form `https://dl-cdn.alpinelinux.org/alpine/v3.22/<repo>/x86/<filename>`.

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

### Apple Silicon plan

Choose **INI reader (macOS arm64)**, then **Build** and **Download inih**. The
browser uses the published cppgm v0.9.7 Wasm compiler and the existing Wasm LLD
to build an ad-hoc-signed executable for Apple Silicon running macOS 11 or
later. The compiled program reads an INI file and prints its keys and values.

```sh
printf '[build]\ntarget = arm64\n' > settings.ini
chmod +x ./inih
./inih settings.ini
```

A plan of `kind: "macho"` uses the same `sources`, `files`, `generated`, and
`compileFlags` as the WASI plan. Set `output` to the executable name. List
the macOS `libSystem` functions the program imports by their C names, such as
`fopen`. The profile uses macOS's installed `libSystem` and supplies only the
target headers named in the plan. It does not include a macOS SDK or generate
Mach-O plans from Alpine. [Example profile](web/plans/inih-macos-arm64.json)

When staging this profile, pass `--macho-compiler` the extracted `bin/cppgm.wasm`
from the published archive. The stage tool checks the binary against the release
pin in [macos-arm64.json](config/macos-arm64.json). The frozen browser game
plans keep their qualified compiler builds for reproducibility.

### Generate a plan in the browser

The **Build** button starts a saved plan immediately. If there is no plan, it asks before downloading and starting a guest. Select **zlib** and choose **Start NanoVM** to run `configure --static` and capture `make libz.a` for WASI. The browser downloads about 1 MiB for NanoVM and Make, plus the compiler, SDK and project source.

For WASI configure and Make projects, WIW offers NanoVM first. Wanix Linux handles CMake and Ninja, configure scripts, and Make with one guest image. The image also includes Bash and pkg-config. It uses the browser compiler and linker to check the selected target.

For **Linux x86-64**, Wanix runs configure in its 32-bit Linux guest and cross-compiles with the x86-64 musl SDK. Meson, Python configure with Ninja, and projects that need to execute Linux x86-64 programs during configuration use the original Alpine guest. Each guest downloads after you choose its **Start** button. Retries reuse the source archive.

For a subdirectory, target, or project-specific flags, a repository can supply `.willitwasm/configure.json`.

```json
{
  "system": "cmake",
  "sourceDirectory": "tools/example",
  "options": ["-DBUILD_TESTING=OFF"],
  "target": "example"
}
```

The default target is **WebAssembly (WASI)** when a WASI planner is available.
The guest runs configure checks against the WASI SDK. The browser builds the
result with cppgm and its built-in linker.

The **QR Code generator** example starts with its GitHub source and CMake
options. The recipe supplies known header check results for the staged WASI SDK.
Wanix Linux runs CMake and Ninja to capture the build plan. Choose **Build**, confirm
with **Start Wanix Linux**. The QR generator opens when the build succeeds. Use **Try QR generator** to reopen it.
Its plan is saved in this browser after the first run.

The browser saves the resulting CWL v1.2 workflow and its configured workspace in IndexedDB, then replays them through cppgm and the archiver. Linux plans link with Wasm LLD. Choose **Download plan** to get a portable `.wwplan` file. Open it on another device with **Open a saved plan**, or host it and use `&plan=`. The file starts with a four-byte little-endian JSON header length, the plan header with inline CWL and the snapshot’s SHA-256, and the packed workspace. A JSON descriptor of kind `alpine-cwl` can also carry a `workflowURL` and `snapshotURL` with `snapshotSha256`.

## Generate from an upstream repository

[Capture results and commands](docs/capture.md) show the upstream web build commands and how to generate a reusable plan. The site examples use the qualified, expanded packages. The capture tools can list upstream commands or record a complete Emscripten replay plan. A replay plan builds the Wasm in the browser and offers the packaged page through **Play** and as a ZIP download. **Play** runs local package assets in an isolated frame. An app that needs network access, shared memory, or relative JavaScript module imports may need to be served from the ZIP.

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
node tests/macho-browser.mjs
node tests/nano-browser.mjs
node tests/alpine-browser.mjs
node tests/alpine-wasi-browser.mjs
node tests/emscripten-browser.mjs /web-plans/owner/project/commit/plan.json
```
