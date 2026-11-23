import {relativePath} from './plans.mjs';

export const maxWorkspace = 128 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', {fatal:true});
const text = bytes => decoder.decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));

function nameOf(header) {
  const name = text(header.subarray(0, 100));
  // GNU tar uses this field for timestamps. POSIX ustar uses a path prefix.
  const prefix = header[262] === 0 ? text(header.subarray(345, 500)) : '';
  return prefix ? prefix + '/' + name : name;
}

function targetOf(path, target) {
  if (target.startsWith('/')) return null;
  const parts = path.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

function readArchive(bundle) {
  if (bundle.length > maxWorkspace) throw Error('The configured workspace is too large.');
  const files = new Map(), links = new Map(), names = new Set();
  let longName, longLink, at = 0;
  while (at + 512 <= bundle.length && bundle[at]) {
    const header = bundle.subarray(at, at + 512);
    const sizeText = text(header.subarray(124, 136)).trim();
    const size = /^[0-7]+$/.test(sizeText) ? parseInt(sizeText, 8) : -1;
    if (size < 0 || size > bundle.length - at - 512) throw Error('Invalid Wanix workspace archive.');
    const bytes = bundle.subarray(at + 512, at + 512 + size);
    const type = header[156];
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 76) {longName = text(bytes); continue;}
    if (type === 75) {longLink = text(bytes); continue;}
    const name = (longName ?? nameOf(header)).replace(/^\.\//, '').replace(/\/$/, '');
    const link = longLink ?? text(header.subarray(157, 257));
    longName = longLink = undefined;
    if (type === 53 || name === '.') continue;
    const path = relativePath(name);
    if (names.has(path) || names.size >= 100000) throw Error('Invalid Wanix workspace file: ' + path);
    names.add(path);
    if (type === 0 || type === 48) files.set(path, bytes);
    else if (type === 50) links.set(path, targetOf(path, link));
    else if (type === 49) links.set(path, targetOf('', link));
    else throw Error('Unsupported Wanix workspace entry: ' + path);
  }
  if (at + 512 > bundle.length) throw Error('Incomplete Wanix workspace archive.');
  return {files, links};
}

function resolveLinks(files, links) {
  const result = new Map(files);
  for (const [path, target] of links) {
    let next = target, hops = 0;
    while (links.has(next) && hops++ < 40) next = links.get(next);
    if (files.has(next)) result.set(path, files.get(next));
  }
  return result;
}

export function workspaceCache() {
  const files = new Map(), links = new Map();
  const remove = path => {files.delete(path); links.delete(path);};
  return (bundle, removed) => {
    const changed = readArchive(bundle);
    if (!Array.isArray(removed) || removed.length > 100000) throw Error('Invalid Wanix workspace removals.');
    for (const path of removed) remove(relativePath(path));
    for (const [path, bytes] of changed.files) {
      remove(path);
      files.set(path, new Uint8Array(bytes));
    }
    for (const [path, target] of changed.links) {
      remove(path);
      links.set(path, target);
    }
    if (files.size + links.size > 100000 ||
        [...files.values()].reduce((total, bytes) => total + bytes.length, 0) > maxWorkspace)
      throw Error('The configured workspace is too large.');
    return resolveLinks(files, links);
  };
}
