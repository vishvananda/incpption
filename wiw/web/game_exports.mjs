// Clang's Wasm ABI can export the argc/argv entry under this name. The frozen
// Emscripten runtime expects `main`. Adapt the host view without changing the
// generated binary, memory, table or upstream source/runtime files.
export function runtimeExports(exports) {
  if (typeof exports.main === 'function') return exports;
  if (typeof exports.__main_argc_argv !== 'function') throw Error('The game has no main entry point');
  return {...exports, main: exports.__main_argc_argv};
}

// Clang imports the Wasm-EH longjmp tag; cppgm defines the same tag internally.
export function runtimeImports(imports){
  imports.env??={};
  if(!imports.env.__c_longjmp)imports.env.__c_longjmp=new WebAssembly.Tag({parameters:['i32']});
  // Godot lays out the editor from these metrics. Its fixed backing canvas
  // is the available screen and has no device pixel scaling of its own.
  const host = imports.env;
  if (typeof host.godot_js_display_window_size_get === 'function') {
    host.godot_js_display_screen_size_get = host.godot_js_display_window_size_get;
    host.godot_js_display_screen_dpi_get = () => 96;
    host.godot_js_display_pixel_ratio_get = () => 1;
  }
  return imports;
}
