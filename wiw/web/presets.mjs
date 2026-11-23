export const qrRepo = 'fukuchi/libqrencode';
const qrRevision = '715e29fd4cd71b6e452ae0f4e36d917b43122ce8';
const zlibRepo = 'madler/zlib';
const zlibRevision = '51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf';

export const extraProjects = [
  {repo:qrRepo, title:'QR Code generator', ref:qrRevision},
  {repo:zlibRepo, title:'zlib', ref:zlibRevision, nano:true},
  {repo:'olzhasar/sdl-tetris', title:'SDL Tetris', prepared:true},
  {repo:'benhoyt/inih', title:'INI reader (macOS arm64)', prepared:true},
];

export function presetRecipe({repo, commit}, target) {
  if (repo.toLowerCase() === zlibRepo && commit === zlibRevision && target === 'wasm32-wasip1')
    return {system:'configure', options:['--static'], target:'libz.a'};
  if (repo.toLowerCase() !== qrRepo || commit !== qrRevision) return {system:'auto'};
  const options = ['-DWITHOUT_PNG=ON', '-DWITH_TESTS=OFF', '-DWITH_TOOLS=ON'];
  if (target === 'wasm32-wasip1') {
    // Results for this release's header checks against the staged WASI SDK.
    // The guest still runs CMake and Ninja to generate this commit's plan.
    options.push('-DCMAKE_C_COMPILER_ID=CPPGM', '-DCMAKE_C_COMPILER_ID_RUN=TRUE',
      '-DCMAKE_C_COMPILER_FORCED=TRUE', '-DCMAKE_DISABLE_FIND_PACKAGE_Threads=TRUE',
      '-DCMAKE_DISABLE_FIND_PACKAGE_PNG=TRUE', '-DCMAKE_DISABLE_FIND_PACKAGE_Iconv=TRUE',
      '-DHAVE_STRDUP=0', ...['DLFCN', 'INTTYPES', 'MEMORY', 'STDINT', 'STDLIB', 'STRINGS',
        'STRING', 'GETOPT', 'SYS_TIME', 'TIME', 'PTHREAD'].map(name => '-DHAVE_' + name + '_H=1'));
  }
  return {system:'cmake', options};
}
