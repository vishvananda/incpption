import {archive} from './ar.mjs';
import {createArchive} from './archive.mjs';
import {errorText} from './error_text.mjs';
import {captureWorkflow, workspace} from './nano_plan.mjs';
import {workspacePath} from './wasi_runtime.mjs';

export const target = 'wasm32-wasip1', sdkRoot = '/tmp/will-wasi';
export const compilerNames = ['cc', 'gcc', 'clang', 'cppgm', 'c++', 'g++', 'clang++'];
export const makefiles = ['GNUmakefile', 'makefile', 'Makefile'];
export const cppNames = new Set(['c++', 'g++', 'clang++']);
export const compilerInput = /\.(?:c|cc|cpp|cxx|c\+\+|s)$/i;
const encoder = new TextEncoder();
const placeholder = encoder.encode('Will it Wasm build plan output\n');
export const absolute = (cwd, path) => '/' + workspacePath(cwd, path);
export const quote = arg => "'" + arg.replaceAll("'", "'\\''") + "'";
export const command = args => args.map(quote).join(' ');

function linkInputs(args, cwd) {
  const paths = [], libraries = [], directories = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['-o', '-h', '-soname', '--soname', '-dynamic-linker', '--dynamic-linker', '-rpath'].includes(arg)) i++;
    else if (arg.startsWith('-L')) directories.push(arg.slice(2) || args[++i]);
    else if (arg.startsWith('-l')) {
      const name = arg.slice(2) || args[++i];
      if (name) libraries.push(name.startsWith(':') ? name.slice(1) : 'lib' + name + '.a');
    } else if (!arg.startsWith('-') && /\.(?:o|obj|a|so(?:\.\d+)*)$/i.test(arg)) paths.push(absolute(cwd, arg));
  }
  for (const directory of directories.filter(Boolean))
    for (const library of libraries) {
      paths.push(absolute(absolute(cwd, directory), library));
      if (library.endsWith('.a')) paths.push(absolute(absolute(cwd, directory), library.slice(0, -2) + '.so'));
    }
  return paths;
}

export function toolRelay({read, write, runCompiler, native, identify}) {
  const actions = [], produced = new Set();
  let recording = false, captureError;
  const success = {exitCode:0};
  const record = async (cwd, name, args, output, inputs = []) => {
    const path = absolute(cwd, output);
    if (!(cwd === workspace || cwd.startsWith(workspace + '/')) || !path.startsWith(workspace + '/') ||
        produced.has(path) || actions.length >= 10000)
      throw Error('Unsupported Make output: ' + path);
    await write(path, placeholder);
    produced.add(path);
    actions.push({command:name, cwd, args, output:path, inputs});
    return success;
  };
  const archiveTool = async (cwd, name, args) => {
    if (args[0] === '--version') return {exitCode:0,
      stdout:(identify ? 'GNU ' + name + ' (Will it Wasm) 2.40' : 'Will it Wasm ' + name) + '\n'};
    if (identify && (args[0] === '-h' || args[0] === '--help')) return {exitCode:0, stdout:'Usage: ' + name + ' [-D] [rcs] archive files\n'};
    if (name === 'ranlib') return await read(absolute(cwd, args.at(-1) ?? '.')) ? success : {exitCode:1};
    const [flags, output, ...members] = args;
    const operation = flags?.replace(/^-/, '');
    if (!/^[qrcsDu]+$/.test(operation) || !/[qr]/.test(operation) || !output || !members.length)
      throw Error('Unsupported ar command: ' + args.join(' '));
    const inputs = members.map(member => absolute(cwd, member));
    if (recording) return record(cwd, 'ar', [operation, output, ...members], output, inputs);
    const membersWithBytes = await Promise.all(inputs.map(async (path, i) => {
      const bytes = await read(path);
      if (!bytes) throw Error('Missing archive input: ' + path);
      return {name:members[i].split('/').at(-1), bytes};
    }));
    await write(absolute(cwd, output), native ? createArchive(membersWithBytes) : archive(membersWithBytes));
    return success;
  };
  const dispatch = async ({argv, cwd, ...context}) => {
    const [tool, ...args] = argv;
    const name = tool.split('/').at(-1);
    if (name === 'ar' || name === 'ranlib') return archiveTool(cwd, name, args);
    if (['-dumpmachine', '-print-target-triple'].includes(args[0]))
      return {exitCode:0, stdout:(native?.target ?? target) + '\n'};
    const identity = identify?.(args);
    if (identity) return {exitCode:0, ...identity};
    const inputs = args.filter(arg => !arg.startsWith('-') && compilerInput.test(arg));
    const language = !cppNames.has(name) && !args.includes('-x') && inputs.some(arg => arg.endsWith('.c')) ? ['-x', 'c'] : [];
    const compileArgs = values => native ? native.compileFlags(name, values) :
      ['--target=' + target, '--sysroot=' + sdkRoot + '/sysroot', '-resource-dir=' + sdkRoot + '/resource', ...language, ...values];
    const flags = compileArgs(args);
    const out = args.lastIndexOf('-o'), compile = args.includes('-c');
    const probe = ['-E', '-S', '-M', '-MM', '-fsyntax-only'].some(flag => args.includes(flag));
    const links = !compile && !probe ? linkInputs(args, cwd) : [];
    if (native && !compile && !probe && (out >= 0 || inputs.length || links.length)) {
      const output = out >= 0 ? args[out + 1] : 'a.out';
      if (!output) throw Error('Missing compiler output name.');
      const linkArgs = [...args], objects = [];
      const argsWithoutInputs = args.filter((arg, i) => arg !== '-o' && args[i-1] !== '-o' && !inputs.includes(arg));
      const options = native.compileOptions(argsWithoutInputs);
      for (const [index, input] of inputs.entries()) {
        const object = '.wiw-link-' + actions.length + '-' + index + '.o';
        const objectArgs = compileArgs([...options, '-c', input, '-o', object]);
        if (recording) await record(cwd, 'cppgm', objectArgs, object);
        else {
          const result = await runCompiler({cwd, flags:objectArgs, inputs:[input], ...context, returnBytes:true});
          if (result.exitCode) return result;
          if (!result.bytes) throw Error('The compiler did not produce ' + object);
          objects.push({path:absolute(cwd, object).slice(1), bytes:result.bytes});
        }
        linkArgs[linkArgs.indexOf(input)] = object;
      }
      const linkerArgs = native.linkFlags(name, linkArgs, output);
      if (recording) {
        const dependencies = linkInputs(linkerArgs, cwd).filter(path => path !== absolute(cwd, output) && produced.has(path));
        return record(cwd, 'ld.lld', linkerArgs, output, dependencies);
      }
      await write(absolute(cwd, output), await native.link(cwd, linkerArgs, output, objects));
      return success;
    }
    if (recording && !probe && (compile || inputs.length || links.length)) {
      if (compile && inputs.length !== 1) throw Error('The planner can record one source file per compiler command.');
      const output = out >= 0 ? args[out + 1] : compile ? inputs[0].split('/').at(-1).replace(compilerInput, '.o') : 'a.out';
      if (!output) throw Error('Missing compiler output name.');
      const dep = args.indexOf('-MF');
      if (dep >= 0 && args[dep + 1]) await write(absolute(cwd, args[dep + 1]), encoder.encode(output + ':\n'));
      return record(cwd, compile ? 'cppgm' : 'wasi-link', out >= 0 ? flags : [...flags, '-o', output], output,
        compile ? [] : links.filter(path => path !== absolute(cwd, output) && produced.has(path)));
    }
    return runCompiler({cwd, flags, inputs, ...context});
  };
  const call = async request => {
    try {return await dispatch(request);}
    catch (error) {
      if (recording) captureError ??= error;
      return {exitCode:1, stderr:errorText(error) + '\n'};
    }
  };
  return {
    call,
    start: () => {recording = true;},
    finish: exists => {
      if (captureError) throw captureError;
      return captureWorkflow(actions, exists, !native);
    },
    produced,
  };
}
