import type { Runtime } from '../types';

export interface CommandAnalysis {
  runtime: Runtime;
  registry?: 'npm' | 'pypi' | 'docker' | 'git';
  /** Package / image name without version. */
  packageName?: string;
  packageRef?: string;
  needsBuild: boolean;
}

export const commandBase = (cmd: string): string =>
  (cmd.split(/[\\/]/).pop() ?? cmd).toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');

export function stripNpmVersion(spec: string): string {
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

export function normalizePyName(spec: string): string {
  return (spec.split(/[=<>!~\[@;\s]/)[0] ?? spec).toLowerCase().replace(/[-_.]+/g, '-');
}

function firstPositional(args: string[], flagsWithValue: Set<string>): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return args[i + 1];
    if (a.startsWith('-')) {
      if (!a.includes('=') && flagsWithValue.has(a)) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

const NPX_FLAGS = new Set(['-p', '--package', '-c', '--call', '--registry', '--cache', '--userconfig', '-w', '--workspace']);
const UVX_FLAGS = new Set([
  '--from', '-p', '--python', '--with', '--with-requirements', '--with-editable', '--index-url',
  '--extra-index-url', '--index', '--default-index', '-i', '--constraint', '--overrides', '--cache-dir', '--directory',
]);
const DOCKER_VALUE_FLAGS = new Set([
  '-e', '--env', '-v', '--volume', '-p', '--publish', '--name', '--network', '--net', '--env-file', '-w', '--workdir',
  '--entrypoint', '-u', '--user', '--platform', '--mount', '-l', '--label', '--add-host', '--memory', '-m', '--cpus',
  '--pull', '--hostname', '-h', '--device', '--cap-add', '--security-opt', '--ulimit', '--shm-size', '--ipc',
]);

function npxLike(args: string[]): CommandAnalysis {
  let pkg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--package=')) { pkg = a.slice('--package='.length); break; }
    if (a === '-p' || a === '--package') { pkg = args[i + 1]; break; }
  }
  pkg ??= firstPositional(args, NPX_FLAGS);
  if (!pkg) return { runtime: 'node', needsBuild: false };
  if (/^[.~/]/.test(pkg)) return { runtime: 'node', needsBuild: true };
  if (/^(github:|git\+|https?:\/\/)/.test(pkg) || (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(pkg) && !pkg.startsWith('@'))) {
    return { runtime: 'node', registry: 'git', packageName: pkg, packageRef: `git:${pkg}`, needsBuild: false };
  }
  const name = stripNpmVersion(pkg);
  return { runtime: 'node', registry: 'npm', packageName: name, packageRef: `npm:${name}`, needsBuild: false };
}

function uvxLike(args: string[]): CommandAnalysis {
  let from: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--from') from = args[i + 1];
    else if (a.startsWith('--from=')) from = a.slice('--from='.length);
  }
  const target = from ?? firstPositional(args, UVX_FLAGS);
  if (!target) return { runtime: 'python', needsBuild: false };
  if (/^(git\+|https?:\/\/)/.test(target)) {
    const g = target.replace(/^git\+/, '');
    return { runtime: 'python', registry: 'git', packageName: g, packageRef: `git:${normalizeGitUrl(g)}`, needsBuild: false };
  }
  if (/^[.~/]/.test(target)) return { runtime: 'python', needsBuild: true };
  const name = normalizePyName(target);
  return { runtime: 'python', registry: 'pypi', packageName: name, packageRef: `pypi:${name}`, needsBuild: false };
}

export function normalizeGitUrl(u: string): string {
  return u.replace(/^git\+/, '').replace(/\.git(?=$|[#@])/, '').replace(/@[^#/]+(?=$|#)/, '').toLowerCase();
}

export function analyzeCommand(command: string, args: string[]): CommandAnalysis {
  const base = commandBase(command);
  if (base === 'cmd' && args[0]?.toLowerCase() === '/c' && args[1]) return analyzeCommand(args[1], args.slice(2));
  if (base === 'npx' || base === 'pnpx' || base === 'bunx') return npxLike(args);
  if ((base === 'pnpm' || base === 'yarn' || base === 'bun') && (args[0] === 'dlx' || args[0] === 'x')) return npxLike(args.slice(1));
  if (base === 'npm' && (args[0] === 'exec' || args[0] === 'x')) return npxLike(args.slice(1));
  if (base === 'uvx') return uvxLike(args);
  if (base === 'uv') {
    if (args[0] === 'tool' && args[1] === 'run') return uvxLike(args.slice(2));
    return { runtime: 'python', needsBuild: true };
  }
  if (base === 'pipx' && args[0] === 'run') {
    let spec: string | undefined;
    for (let i = 1; i < args.length; i++) if (args[i] === '--spec') spec = args[i + 1];
    const target = spec ?? firstPositional(args.slice(1), new Set(['--spec', '--python', '--index-url', '--pip-args']));
    if (!target) return { runtime: 'python', needsBuild: false };
    const name = normalizePyName(target);
    return { runtime: 'python', registry: 'pypi', packageName: name, packageRef: `pypi:${name}`, needsBuild: false };
  }
  if (base === 'docker' || base === 'podman') {
    if (args[0] !== 'run') return { runtime: 'docker', needsBuild: true };
    const value = firstPositional(args.slice(1), DOCKER_VALUE_FLAGS);
    if (!value) return { runtime: 'docker', needsBuild: false };
    const image = value.replace(/@sha256:.*$/, '').replace(/:[^/:]+$/, '');
    return { runtime: 'docker', registry: 'docker', packageName: image, packageRef: `docker:${image}`, needsBuild: false };
  }
  if (['node', 'deno', 'bun', 'tsx', 'ts-node'].includes(base)) return { runtime: 'node', needsBuild: true };
  if (/^python(\d(\.\d+)?)?$/.test(base) || base === 'py') return { runtime: 'python', needsBuild: true };
  if (['go', 'cargo', 'java', 'dotnet', 'ruby', 'php'].includes(base)) return { runtime: 'other', needsBuild: true };
  // A bare executable (must already be installed) or a path to one.
  return { runtime: 'binary', needsBuild: true };
}
