// A fresh tool instance per invocation keeps Clang's process globals isolated.
const factories = new Map();
export async function invokeEmscripten({module, runtime, program, layers = [], files = [], args, output}) {
  if (!factories.has(runtime)) factories.set(runtime, import(runtime).then(value => value.default));
  const create = await factories.get(runtime), log = [];
  let exports, status = 0;
  const tool = await create({noInitialRun: true, thisProgram: program,
    print: line => log.push(line), printErr: line => log.push(line),
    quit(code, error) {status = code; if (error) throw error;},
    instantiateWasm(imports, receive) {
      const instance = new WebAssembly.Instance(module, imports); exports = instance.exports;
      receive(instance, module); return instance.exports;
    }});
  const fs = tool.FS, directories = new Set(['/inputs']);
  fs.mkdir('/inputs');
  function mount(path, bytes) {
    const parts = path.split('/'), name = parts.pop(), directory = '/inputs/' + parts.join('/');
    if (!directories.has(directory)) {fs.mkdirTree(directory); directories.add(directory);}
    fs.createDataFile(directory, name, bytes, true, false, true);
  }
  for (const layer of layers) for (const file of layer.files)
    mount(file.path, layer.bundle.subarray(file.offset, file.offset + file.size));
  for (const file of files) mount(file.path, file.bytes);
  fs.chdir('/inputs');
  fs.mkdirTree(output.split('/').slice(0, -1).join('/') || '.');
  try {status = tool.callMain(args) || status;}
  catch (error) {if (error.name === 'ExitStatus') status = error.status; else throw Error([...log, String(error)].join('\n'));}
  if (status) throw Error(log.join('\n') || `${program} exited ${status}`);
  const node = fs.lookupPath(output).node;
  const bytes = node.contents.subarray(0, node.usedBytes);
  return {status, log, bytes, memoryBytes: exports.memory.buffer.byteLength};
}
