import {mountInputs} from './emscripten_inputs.mjs';
import {errorText} from './error_text.mjs';
import {emscriptenInstance, finishEmscriptenProcess} from './emscripten_process.mjs';
// A fresh JavaScript host keeps filesystem and exit state isolated.
const factories = new Map();
export async function invokeEmscripten({module, runtime, program, layers = [], files = [], args, output, cwd = ""}) {
  if (!factories.has(runtime)) factories.set(runtime, import(runtime).then(value => value.default));
  const create = await factories.get(runtime), log = [];
  let exports, status = 0, succeeded = false;
  try {
    const tool = await create({noInitialRun: true, thisProgram: program,
      print: line => log.push(line), printErr: line => log.push(line),
      quit(code, error) {status = code; if (error) throw error;},
      instantiateWasm(imports, receive) {
        const instance = emscriptenInstance(module, imports, program); exports = instance.exports;
        receive(instance, module); return instance.exports;
      }});
    const fs = tool.FS, directories = new Set(['/inputs']);
    mountInputs(fs,layers);
    function mount(path, bytes) {
      const parts = path.split('/'), name = parts.pop(), directory = '/inputs/' + parts.join('/');
      if (!directories.has(directory)) {fs.mkdirTree(directory); directories.add(directory);}
      fs.createDataFile(directory, name, bytes, true, false, true);
    }
    for (const file of files) mount(file.path, file.bytes);
    if (cwd) fs.mkdirTree('/inputs/' + cwd);
    fs.chdir(cwd ? '/inputs/' + cwd : '/inputs');
    fs.mkdirTree(output.split('/').slice(0, -1).join('/') || '.');
    try {status = tool.callMain([...args]) || status;}
    catch (error) {if (error.name === 'ExitStatus') status = error.status; else throw Error([...log, errorText(error)].join('\n'));}
    if (status) throw Error(log.join('\n') || `${program} exited ${status}`);
    const node = fs.lookupPath(output).node;
    const bytes = node.contents.length===node.usedBytes?node.contents:node.contents.slice(0,node.usedBytes);
    succeeded = true;
    return {status, log, bytes, memoryBytes: exports.memory?.buffer.byteLength ?? 0};
  } finally {finishEmscriptenProcess(module, succeeded);}
}
