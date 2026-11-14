"""Prepare pinned, local-only decoder/highlighter assets for the code explorer."""
import json
from pathlib import Path
import re
import shutil

HERE = Path(__file__).resolve().parent


def prepare_vendor(destination):
    destination.mkdir()
    modules = HERE.parent / "node_modules"
    for name, version in [("iced-x86", "1.22.0"), ("wabt", "1.0.39"), ("prismjs", "1.30.0")]:
        if json.loads((modules / name / "package.json").read_text())["version"] != version:
            raise RuntimeError(f"expected {name} {version}; run npm ci in {HERE}")
    iced = (modules / "iced-x86/iced_x86.js").read_text()
    # The pinned npm entry is CommonJS. Keep the generated bindings intact and
    # replace only their export spelling and synchronous Node-only Wasm loader.
    iced = re.sub(r"^exports\.(\w+) = \1;$", r"export {\1};", iced, flags=re.M)
    start = iced.index("const wasmPath = `${__dirname}/iced_x86_bg.wasm`;")
    iced = iced[:start] + """import {fetchBytes} from '../transport_bytes.mjs';
const wasmModule = await WebAssembly.compile(await fetchBytes(new URL('./iced.wasm', import.meta.url)));
const wasm = new WebAssembly.Instance(wasmModule, __wbg_get_imports()).exports;
wasm.__wbindgen_start();
"""
    (destination / "iced.mjs").write_text(iced)
    shutil.copyfile(modules / "iced-x86/iced_x86_bg.wasm", destination / "iced.wasm")
    shutil.copyfile(modules / "iced-x86/LICENSE.txt", destination / "iced-LICENSE.txt")
    (destination / "wabt.mjs").write_text((modules / "wabt/index.js").read_text() + "\nexport default WabtModule;\n")
    shutil.copyfile(modules / "wabt/LICENSE", destination / "wabt-LICENSE.txt")
    prism = "\n".join((modules / "prismjs" / name).read_text() for name in
                       ["components/prism-core.js", "components/prism-clike.js",
                        "components/prism-c.js", "components/prism-cpp.js"])
    (destination / "prism.mjs").write_text(prism + "\nexport default globalThis.Prism;\n")
    shutil.copyfile(modules / "prismjs/LICENSE", destination / "prism-LICENSE.txt")
