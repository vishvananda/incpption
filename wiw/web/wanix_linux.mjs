import {compiler, linkerArguments, sdkLayer} from './alpine_replay.mjs';
import {invokeEmscripten} from './emscripten_host.mjs';
import {absolute, cppNames} from './planner_tools.mjs';
import {workspace} from './nano_plan.mjs';
import {loadSeed} from './seed_package.mjs';

export const linuxTarget = 'x86_64-linux-musl';
export const linuxRoot = '/tmp/will-linux';

const paired = new Set(['-I', '-isystem', '-iquote', '-include', '-imacros', '-D', '-U', '-x', '-MF', '-MT', '-MQ', '-L', '-l', '-Xlinker']);
const compileOnly = /^(?:-[IDUWOfgm]|-std=|-isystem|-iquote|-include|-imacros)/;
const dependency = /^-M(?:D|MD|P|F|T|Q)/;

function linkItems(args) {
  const items = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (paired.has(arg) || arg === '-o') {
      if (['-l', '-L'].includes(arg)) items.push(arg + args[i + 1]);
      if (arg === '-Xlinker') items.push(args[i + 1]);
      i++;
    } else if (arg.startsWith('-Wl,')) items.push(...arg.slice(4).split(','));
    else if (/^-l.|^-L.|^--?start-group$|^--?end-group$/.test(arg)) items.push(arg);
    else if (arg.startsWith('@')) throw Error('Linux response files need the Alpine planner.');
    else if (!arg.startsWith('-')) items.push(arg);
    else if (!compileOnly.test(arg) && !dependency.test(arg) &&
        !['-shared', '-pie', '-pthread', '-rdynamic', '-s', '-v'].includes(arg))
      throw Error('Linux linker option needs the Alpine planner: ' + arg);
  }
  return items;
}

export async function linuxToolchain(profile, readWorkspace) {
  const {machine, gcc} = profile.sdk;
  const gccRoot = '/usr/lib/gcc/' + machine + '/' + gcc;
  const cxx = '/usr/include/c++/' + gcc;
  const includes = profile.includePaths ?? {
    c:[gccRoot + '/include', '/usr/include'],
    'c++':[cxx, cxx + '/' + machine, cxx + '/backward', gccRoot + '/include', '/usr/include'],
  };
  const [headers, cppHeaders, module] = await Promise.all([
    sdkLayer(profile.headers), sdkLayer(profile.cxxHeaders), compiler(profile),
  ]);
  let linker, libraries;
  const loadLibraries = () => libraries ??= Promise.all([sdkLayer(profile.link), sdkLayer(profile.cxxLink)]);
  return {
    target:linuxTarget, module, sdk:[headers, cppHeaders],
    async guestFiles() {
      return [headers, cppHeaders, ...await loadLibraries()];
    },
    compileFlags(name, args) {
      const cpp = cppNames.has(name) || args.some(arg => /\.(?:C|cc|cpp|cxx|c\+\+)$/.test(arg));
      const standard = args.some(arg => arg.startsWith('-std=')) ? [] : [cpp ? '-std=gnu++17' : '-std=gnu17'];
      return ['-nostdinc', ...standard, ...args, ...includes[cpp ? 'c++' : 'c'].flatMap(path => ['-isystem', path])];
    },
    compileOptions(args) {
      const options = [];
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (paired.has(arg)) {
          if (!['-l', '-L', '-Xlinker', '-MF', '-MT', '-MQ'].includes(arg)) options.push(arg, args[i + 1]);
          i++;
        } else if ((compileOnly.test(arg) && !arg.startsWith('-Wl,')) || arg === '-pthread') options.push(arg);
      }
      return options;
    },
    linkFlags(name, args, output) {
      const shared = args.includes('-shared');
      const mode = shared ? ['-shared'] : ['-pie', '-dynamic-linker', '/lib/ld-musl-x86_64.so.1', '/usr/lib/Scrt1.o'];
      const runtime = cppNames.has(name) ? ['-lgcc_s', '-lgcc'] : ['-lgcc', '--as-needed', '-lgcc_s', '--no-as-needed'];
      return ['-m', 'elf_x86_64', ...mode, '-o', output, '/usr/lib/crti.o', gccRoot + '/crtbeginS.o',
        ...linkItems(args), ...(args.includes('-rdynamic') ? ['--export-dynamic'] : []),
        ...(args.includes('-s') ? ['-s'] : []), '-L' + gccRoot, '-L/usr/lib',
        ...(cppNames.has(name) ? ['-lstdc++', '-lm'] : []), ...runtime, '-lc',
        ...runtime, gccRoot + '/crtendS.o', '/usr/lib/crtn.o'];
    },
    async link(cwd, args, output, objects) {
      linker ??= loadSeed('lld', (profile.sharedAssets ?? '') + 'clang-seed/');
      const [tool, sdk, inputs] = await Promise.all([linker, loadLibraries(), readWorkspace()]);
      const files = [...inputs].map(([path, bytes]) => ({path:absolute(workspace, path).slice(1), bytes}));
      const result = await invokeEmscripten({...tool, program:'ld.lld', layers:sdk, files:[...files, ...objects],
        args:linkerArguments(args), cwd:cwd.slice(1), output:output.startsWith('/') ? '/inputs' + output : output});
      return result.bytes;
    },
  };
}
