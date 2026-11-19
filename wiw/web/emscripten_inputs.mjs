// Index immutable inputs once per worker. Each fresh tool gets its own MEMFS
// nodes, created on lookup, rather than thousands of eagerly mounted headers.
const indexes=new WeakMap();
function index(layers){
  if(indexes.has(layers))return indexes.get(layers);
  const root={children:new Map()};
  for(const layer of layers)for(const row of layer.files){let dir=root;const parts=row.path.split('/');for(const part of parts.slice(0,-1)){if(!dir.children.has(part))dir.children.set(part,{children:new Map()});dir=dir.children.get(part);}dir.children.set(parts.at(-1),{bytes:layer.bundle.subarray(row.offset,row.offset+row.size)});}
  indexes.set(layers,root);return root;
}
export function mountInputs(fs,layers){
  const tree=index(layers),memfs=fs.filesystems.MEMFS;
  function decorate(node,entry){
    const ops=node.node_ops;
    node.node_ops={...ops,
      lookup(parent,name){
        if(Object.hasOwn(parent.contents,name))return parent.contents[name];
        const item=entry.children.get(name);if(!item)throw new fs.ErrnoError(44);
        const child=memfs.createNode(parent,name,item.children?0o40755:0o100444,0);
        if(item.children)decorate(child,item);else{child.contents=item.bytes;child.usedBytes=item.bytes.length;}
        return child;
      },
      readdir(parent){return ['.','..',...new Set([...entry.children.keys(),...Object.keys(parent.contents)])];}
    };
  }
  fs.mkdir('/inputs');
  fs.mount({mount(mount){const root=memfs.mount(mount);decorate(root,tree);return root;}},{},'/inputs');
}
