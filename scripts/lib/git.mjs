// Hardened git access for the registry checks, CC0-1.0 like everything else here.
//
// Everything the registry reads from a publisher comes through this module. The
// rules, in the order they bite:
//
// - A repository is only ever an https URL on an allow-listed host with exactly
//   the host's number of path segments (addressOf); records that do not fit are
//   refused before they reach git.
// - git runs through execFileSync with an argument list, never a shell, so no
//   value from a record is ever interpolated into a command line.
// - Every URL or revision from a record is passed after --end-of-options, so a
//   value that starts with "-" can never be read as an option.
// - git only talks https to a remote (GIT_ALLOW_PROTOCOL); tests add file for
//   local repositories that stand in for https URLs.
// - The user's and the system's git configuration are not read, and every
//   inherited GIT_* variable is dropped, so a local insteadOf rewrite, hook
//   setting or GIT_DIR cannot change what is fetched or run.
// - Hooks and file-system monitors never run (-c core.hooksPath, core.fsmonitor),
//   replace refs are ignored (core.useReplaceRefs, GIT_NO_REPLACE_OBJECTS), and a
//   cached repository is used only after its configuration, alternates, grafts,
//   replace refs, links and objects have been verified (cacheRepoSound); the cache
//   lives outside the checkout, in a per-user directory (defaultCacheDir), so
//   nothing a pull request commits can plant a repository there. Two runs that
//   start on an empty cache are safe: each repository is made in a temporary
//   directory and renamed into place.
// - A commit only counts when it is in the history of the repository's default
//   branch: GitHub serves a fork's commits through the parent's URL, so "can be
//   fetched" alone would let a fork's commit be registered under the parent.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { devNull, homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const commitPattern = /^[0-9a-f]{40}$/;
// The hosts a repository may live on, each with the number of path segments
// that name a repository there. Adding a host is a reviewed change to this list.
export const repositoryHosts = new Map([['github.com', 2]]);
const segmentPattern = /^[A-Za-z0-9_.-]+$/;
// A branch or tag name: no leading "-", ".", "/", no "..".
export const refNamePattern = /^(?![-.\/])(?!.*\.\.)[A-Za-z0-9._\/-]+$/;
// A path inside a repository: relative, no "..", no glob characters.
const filePathPattern = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)\.(?:\/|$))[A-Za-z0-9_.\/-]+$/;
export const isRepositoryPath = (path) => typeof path === 'string' && filePathPattern.test(path) && !path.endsWith('/');

let allowedProtocols = 'https';
export const setGitProtocols = (protocols) => { allowedProtocols = protocols; };
const keptGitVariables = new Set(['GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_TRACE', 'GIT_TRACE_PACKET', 'GIT_CURL_VERBOSE']);
export const gitEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') || keptGitVariables.has(name))),
  GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: allowedProtocols, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1',
  // A replace ref in a repository must never make one commit read as another.
  GIT_NO_REPLACE_OBJECTS: '1',
});
// Hooks are pointed at a path with no hooks in it, and fsmonitor is off, so a
// repository in the cache cannot run code of its own however it got there.
const safeGitConfig = ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', '-c', 'core.useReplaceRefs=false'];
export const git = (args, options = {}) => execFileSync('git', [...safeGitConfig, ...args], { stdio: 'pipe', env: gitEnv(), maxBuffer: 256 * 1024 * 1024, ...options }).toString();
export const lastLine = (error) => String(error.stderr ?? error.message).trim().split('\n').filter(Boolean).pop() ?? 'failed';

// Creates `dir` (private) if it is missing, and refuses it unless it is a real
// directory: a symbolic link there could point the cache anywhere.
export function ensurePlainDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} is not a directory; the git cache holds only real directories`);
}

// The per-user directory the git caches live in: $XDG_CACHE_HOME or ~/.cache,
// then ovdb-directory. Never inside a checkout. Created 0700; refused unless it
// is a real directory (not a symbolic link) owned by the current user and not
// writable by anyone else.
export function defaultCacheDir() {
  const base = process.env.XDG_CACHE_HOME && isAbsolute(process.env.XDG_CACHE_HOME) ? process.env.XDG_CACHE_HOME : join(homedir(), '.cache');
  const dir = join(base, 'ovdb-directory');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} is not a directory; the git cache must be a real per-user directory`);
  if (process.getuid && stat.uid !== process.getuid()) throw new Error(`${dir} is owned by another user; the git cache must be yours`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${dir} is writable by others; the git cache must be private (chmod 700)`);
  return dir;
}

// The configuration a repository this module made can have. Anything else in a
// cached repository's config (hooksPath, fsmonitor, insteadOf, an include,
// an alias, a credential or protocol setting) means it was not made here.
const safeConfigKeys = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/,
  /^remote\.origin\.(url|fetch|promisor|partialclonefilter)$/,
  /^extensions\.(partialclone|objectformat)$/,
  /^branch\.[^.]+\.(remote|merge)$/,
];

// Whether anything below `dir` is a symbolic link.
const containsLink = (dir) => readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isSymbolicLink() || (entry.isDirectory() && containsLink(join(dir, entry.name))));

// Whether a cached bare repository is what this module made: only safe
// configuration; no alternates, grafts, replace refs or links anywhere inside it;
// the shallow file is what a one-commit fetch writes (`commit`, for an
// openCommit repository) or absent (a history clone is whole); and every
// object it holds hashes to its name (git fsck). A repository that fails is
// thrown away and fetched again.
export function cacheRepoSound(dir, { commit } = {}) {
  try {
    if (existsSync(join(dir, 'objects', 'info', 'alternates')) || existsSync(join(dir, 'commondir')) || existsSync(join(dir, 'info', 'grafts'))) return false;
    const replace = join(dir, 'refs', 'replace');
    if (existsSync(replace) && readdirSync(replace).length > 0) return false;
    if (existsSync(join(dir, 'packed-refs')) && /refs\/replace\//.test(readFileSync(join(dir, 'packed-refs'), 'utf8'))) return false;
    if (containsLink(dir)) return false;
    const shallow = join(dir, 'shallow');
    if (commit === undefined ? existsSync(shallow) : (existsSync(shallow) && readFileSync(shallow, 'utf8').trim() !== commit)) return false;
    const keys = git(['config', '--file', join(dir, 'config'), '--list', '--name-only']).split('\n').filter(Boolean);
    if (!keys.every((key) => safeConfigKeys.some((pattern) => pattern.test(key)))) return false;
    git(['-C', dir, 'fsck', '--no-dangling', '--no-progress']);
    return true;
  } catch {
    return false;
  }
}

export const historyPath = (cacheDir, url, branch) => join(cacheDir, createHash('sha256').update(`${url}#${branch}`).digest('hex').slice(0, 32));

// The canonical https form of a repository, or null. One spelling per
// repository: an allow-listed host (no www., no IP literal, no port, no user),
// exactly the host's number of path segments, none of them "." or "..", no
// `.git` suffix in any case, no trailing slash, query or fragment.
export function repositoryKey(repository) {
  if (typeof repository !== 'string' || !repository.startsWith('https://')) return null;
  const [host, ...segments] = repository.slice('https://'.length).split('/');
  if (!repositoryHosts.has(host) || segments.length !== repositoryHosts.get(host)) return null;
  if (!segments.every((segment) => segmentPattern.test(segment) && segment !== '.' && segment !== '..')) return null;
  if (/\.git$/i.test(segments.at(-1))) return null;
  return `${host}/${segments.join('/')}`;
}
// meaning://{host}/{path} for https://{host}/{path}, or null.
export const addressOf = (repository) => (repositoryKey(repository) ? `meaning://${repositoryKey(repository)}` : null);

// The branch a repository's HEAD names (its default branch), from ls-remote.
export function defaultBranch(url) {
  const head = git(['ls-remote', '--symref', '--end-of-options', url, 'HEAD']);
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head);
  if (!match) throw new Error(`${url} does not name a default branch`);
  return match[1];
}

// Only a commit in the history of the branch counts: this keeps a bare,
// commits-only (tree:0) clone of the branch per URL in cacheDir, fetches it
// again once per run (`fetched` remembers), and asks git whether the commit is
// an ancestor of the branch (or the branch itself). A commit the clone does
// not have is not in that history either.
// Moves a freshly made repository `work` into place as `dir`. An existing `dir`
// that `good()` accepts (another run made it first) is kept and `work` dropped; one
// that is not good is renamed away first, never deleted in place, so that two runs
// never remove a directory the other is moving in.
function install(work, dir, good, scratch) {
  try { renameSync(work, dir); return; } catch (error) { if (!existsSync(dir)) throw error; }
  if (good()) { rmSync(work, { recursive: true, force: true }); return; }
  const aside = mkdtempSync(join(scratch, '.old-'));
  try { renameSync(dir, join(aside, 'old')); } catch { /* another run moved it already */ }
  rmSync(aside, { recursive: true, force: true });
  try { renameSync(work, dir); } catch (error) {
    if (!good()) throw error;
    rmSync(work, { recursive: true, force: true });
  }
}

// Brings the branch of a cached history clone up to date. Two runs may do this to
// the same clone at once; git locks the ref, so a lost race is simply retried.
function fetchBranch(dir, url, ref) {
  for (let attempt = 1; ; attempt += 1) {
    try { git(['-C', dir, 'fetch', '-q', '--force', '--end-of-options', url, `+${ref}:${ref}`]); return; } catch (error) { if (attempt === 4) throw error; }
  }
}

export function onBranch(url, branch, commit, cacheDir, fetched = new Set()) {
  if (!commitPattern.test(commit) || !refNamePattern.test(branch)) return false;
  const dir = historyPath(cacheDir, url, branch);
  const ref = `refs/heads/${branch}`;
  if (!fetched.has(dir)) {
    try {
      if (existsSync(join(dir, 'HEAD')) && cacheRepoSound(dir)) fetchBranch(dir, url, ref);
      else {
        // Clone into a private temporary directory and rename it into place, so that
        // two runs that start on a cold cache never see a half-made repository; the
        // one that loses the rename uses the winner's.
        mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
        const work = mkdtempSync(join(cacheDir, '.clone-'));
        try {
          git(['clone', '-q', '--bare', '--template=', '--filter=tree:0', '--single-branch', '--branch', branch, '--end-of-options', url, join(work, 'repo')]);
          install(join(work, 'repo'), dir, () => existsSync(join(dir, 'HEAD')) && cacheRepoSound(dir), cacheDir);
        } finally { rmSync(work, { recursive: true, force: true }); }
        fetchBranch(dir, url, ref);
      }
    } catch (error) {
      throw new Error(`cannot read the history of ${branch} in ${url}: ${lastLine(error)}`);
    }
    fetched.add(dir);
  }
  try {
    git(['-C', dir, 'merge-base', '--is-ancestor', '--end-of-options', commit, ref]);
    return true;
  } catch {
    return false;
  }
}

const regularModes = new Set(['100644', '100755']);

// One commit of a repository as a read-only file tree: a bare repository in
// cacheDir that holds only that commit (shallow fetch). Files are read from the
// object store with `git cat-file`, never checked out, so a symbolic link in
// the repository is just a tree entry: status() reports it as 'link' and read()
// refuses it. Returns { commit, status(path), read(path), match(pattern) }.
export function openCommit(url, commit, cacheDir) {
  if (!commitPattern.test(commit)) throw new Error(`${commit} is not a full commit id`);
  const dir = join(cacheDir, `${createHash('sha256').update(url).digest('hex').slice(0, 24)}-${commit}`);
  const ready = () => {
    try { git(['-C', dir, 'cat-file', '-e', `${commit}^{commit}`]); return true; } catch { return false; }
  };
  if (!(existsSync(join(dir, 'HEAD')) && cacheRepoSound(dir, { commit }) && ready())) {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const work = mkdtempSync(join(cacheDir, '.fetch-'));
    try {
      git(['init', '-q', '--bare', '--template=', work]);
      git(['-C', work, 'fetch', '-q', '--depth', '1', '--end-of-options', url, commit]);
      if (git(['-C', work, 'rev-parse', 'FETCH_HEAD']).trim() !== commit) throw new Error('did not fetch that commit');
      install(work, dir, () => existsSync(join(dir, 'HEAD')) && cacheRepoSound(dir, { commit }) && ready(), cacheDir);
    } catch (error) {
      rmSync(work, { recursive: true, force: true });
      throw new Error(`cannot fetch ${commit} from ${url}: ${lastLine(error)}`);
    }
  }
  const entries = new Map(git(['-C', dir, 'ls-tree', '-r', '-z', '--end-of-options', commit]).split('\0').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t');
    return [path, meta.split(' ')[0]];
  }));
  const status = (path) => {
    if (!entries.has(path)) return 'missing';
    return regularModes.has(entries.get(path)) ? 'file' : 'link';
  };
  const read = (path) => {
    if (status(path) !== 'file') throw new Error(`${path} is not a regular file at ${commit}`);
    return git(['-C', dir, 'cat-file', 'blob', `${commit}:${path}`]);
  };
  // `*` matches within one path segment, so `*.meaning.yaml` is the root.
  const match = (pattern) => {
    if (!pattern.includes('*')) return entries.has(pattern) ? [pattern] : [];
    const regExp = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    return [...entries.keys()].filter((path) => regExp.test(path)).sort();
  };
  return { commit, status, read, match };
}
