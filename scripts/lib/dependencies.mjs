import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { openDependency } from './git.mjs';

// Same literal repeatable binding grammar as the reviewed OVDB interface.
// Parse every supplied flag first; open Git readers only when referenced.
export function dependencyReaders(values, open = openDependency) {
  const paths = new Map();
  for (const value of values) {
    const equal = value.indexOf('=');
    const key = value.slice(0, equal);
    const path = value.slice(equal + 1);
    const match = /^https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)@([0-9a-f]{40})$/.exec(key);
    if (equal < 0 || !match || [match[1], match[2]].some((part) => part === '.' || part === '..') || match[2].endsWith('.git') || !isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) throw new Error('invalid --dependency; expected https://github.com/owner/repo@40-lowercase-hex=/absolute/checkout');
    if (!statSync(path).isDirectory()) throw new Error('--dependency path must be a directory');
    if (paths.has(key) && paths.get(key) !== path) throw new Error('conflicting --dependency paths for one repository/revision');
    paths.set(key, path);
  }
  return new Map([...paths].map(([key, path]) => {
    let reader;
    const ensure = () => reader ??= open(path, key.slice(key.lastIndexOf('@') + 1));
    return [key, { get commit() { return ensure().commit; }, status: (file) => ensure().status(file), readBytes: (file, limit) => ensure().readBytes(file, limit) }];
  }));
}

export function directoryArguments(args, defaultRoot, open) {
  let root;
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dependency') {
      if (++i === args.length) throw new Error('--dependency requires a value');
      values.push(args[i]);
    } else if (args[i].startsWith('--dependency=')) values.push(args[i].slice(13));
    else if (args[i].startsWith('-') || root !== undefined) throw new Error(`unexpected argument ${args[i]}`);
    else root = args[i];
  }
  return { root: root ?? defaultRoot, representationDependencies: dependencyReaders(values, open) };
}
