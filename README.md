# cpp inception

Source and Cloudflare Pages configuration for **https://incpption.com**.
This repository is private. The compiler source link in the page points to
[cppgm-extended](https://github.com/vishvananda/cppgm-extended).

The shipped compiler is cppgm compiled by native cppgm into WebAssembly.
It rebuilds itself in the visitor's browser. Every object and the final Wasm
module must match the frozen native outputs byte for byte. The rebuilt compiler
then builds OpenLara to Wasm and runs the game in the same browser.

All compilation, linking, comparisons, example execution, and gameplay run
locally. The server delivers static files. Edited source and generated outputs
are never uploaded. Browser requests only download the site and its inputs.

## Build and test

Use Node 22 or newer, Python 3.10 or newer, and curl:

```sh
npm ci
npm run check
npm run build
npx playwright install chromium
npm test
```

The build downloads about 66 MiB of immutable assets into ignored `.cache/`,
checks every SHA-256 against `config/artifact-lock.json`, and assembles `dist/`.
It does not build the compiler or modify the original payload. A qualified local
copy can be used instead:

```sh
python3 tools/build.py --artifact-dir /path/to/qualified/static-payload --force
```

The browser test serves `dist/` with the required isolation headers. It checks
mobile layout, GitHub and Share, both explorer targets, invalid-source recovery,
eight concurrent compiler workers, cancellation and restart, actual downloaded
compiler bytes, game compilation, game bytes, WebGL rendering, and keyboard input.
Results and screenshots go to ignored `build/test-results/`.

```sh
# The second rebuild is optional in the page and in CI.
DEMO_TEST_SECOND_BUILD=1 npm test
# Exercise the fallback without cross-origin isolation.
DEMO_TEST_ISOLATION=0 DEMO_TEST_WORKERS=1 npm test
npm run test:inspector
npm run test:game
```

## Parallel compilation

Auto uses up to eight workers, limited by `navigator.hardwareConcurrency`.
Each source has a fresh WASI instance. Workers share immutable source and SDK
bytes through SharedArrayBuffer and receive a structured-cloned compiled
WebAssembly.Module. Output buffers transfer to the coordinator without copying;
the coordinator checks bytes and links objects in the frozen source order.
The final link runs once after compilation. OpenLara uses up to three workers
because it has three translation units.

The page owns all compiler workers and terminates them together on cancellation,
failure, or completion. Without cross-origin isolation it uses one worker.
`config/_headers` enables COOP/COEP for the deployed static site. Guest memory is
reported per compiler instance, not as total browser memory.

## Payload and site provenance

Website changes and compiler provenance have separate versions. `web/` contains
the current interface and browser orchestration. `config/artifact-lock.json`
pins a qualified compiler, frozen sources, SDK libraries, game sources, runtime
glue, reference outputs, and demo assets at an immutable deployment URL.

`dist/compiler/` and `dist/game/` retain their original manifests and runner files
unchanged. Those old runner files are provenance records; the active page uses
the current workers at the site root. `dist/site-release.json` records the site
Git revision, payload lock hash, compiler manifest hash, and compiler hash.
Never edit payload hashes to silence a mismatch: qualify the replacement payload
and update the complete lock deliberately.

Binary assets in the pinned payload are gzip bytes at their logical paths.
Cloudflare Pages does not preserve a custom Content-Encoding for these files.
`transport_bytes.mjs` checks the gzip signature and decompresses explicitly before
checking hashes or executing Wasm. All runtime dependencies are served locally;
the page does not need a third-party script CDN.

The tools for preparing the OpenLara/Emscripten profile are retained in `tools/`.
They are maintainer tools and are not part of an ordinary site build. The current
payload uses Emscripten 4.0.9 with a private libc++ ABI1 profile. All game program
sources compile in the browser; SDK and runtime libraries are prebuilt. The two
`.c` game sources compile as C++, as in the upstream Web build.

## Deployment

Cloudflare Pages project: `cpp-inception`. Canonical domain: `incpption.com`.
The account and project are recorded in `site.json`; Wrangler configuration is in
`wrangler.toml`. With an authenticated Wrangler 4.127.0:

```sh
npm ci
npm run build
npm test
wrangler pages deploy dist --project-name cpp-inception --branch main
```

No Cloudflare credential belongs in this repository. CI builds and runs the full
browser journey on pushes and pull requests; deployment uses the qualified
commit after those checks. CI can run the optional second rebuild through
workflow dispatch. DNS is a proxied CNAME from `incpption.com` to
`cpp-inception.pages.dev`.

See `LICENSE`, `NOTICE`, `third_party/`, and the deployed credits page for retained
attribution and dependency licenses. Game demo assets retain their owners'
copyrights.
