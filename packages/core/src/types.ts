/** How a local MCP server is run. */
export type Runtime = 'node' | 'python' | 'docker' | 'binary' | 'other';

/** A value the user has to provide before installing (API key, folder, ...). */
export interface InputField {
  /** Env var name, header name, or a label for an argument. */
  key: string;
  /** Where the value ends up. */
  target: 'env' | 'header' | 'arg' | 'url';
  required: boolean;
  secret: boolean;
  kind: 'text' | 'path';
  description?: string;
  defaultValue?: string;
  /** Template with `{value}`, e.g. "Bearer {value}", "--api-key={value}", or a full URL. */
  template?: string;
  /** For target = 'arg': index into `args`. */
  argIndex?: number;
}

export interface McpLocalSpec {
  kind: 'mcp-local';
  runtime: Runtime;
  command: string;
  args: string[];
  /** Fixed env values (placeholders are moved to `inputs`). */
  env: Record<string, string>;
  inputs: InputField[];
  /** Package identity, e.g. "npm:@playwright/mcp", "pypi:mcp-server-fetch", "docker:ghcr.io/x/y", "git:https://...". */
  packageRef?: string;
  /** True when it only works after cloning/building source or installing a binary by hand. */
  needsBuild: boolean;
}

export interface McpRemoteSpec {
  kind: 'mcp-remote';
  url: string;
  transport: 'http' | 'sse';
  /** Fixed header values (placeholders are moved to `inputs`). */
  headers: Record<string, string>;
  inputs: InputField[];
}

export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
}

export interface SkillSpec {
  kind: 'skill';
  source: RepoRef;
  /** Repo-relative directory that contains SKILL.md ('' = repo root). */
  dir: string;
  /** Files inside `dir` (relative to it), used to download the skill. */
  files?: string[];
}

export interface PluginSpec {
  kind: 'plugin';
  plugin: string;
  /** `source` is what `claude plugin marketplace add` takes, e.g. "owner/repo". */
  marketplace?: { name?: string; source?: string };
}

export interface McpbSpec {
  kind: 'mcpb';
  source?: RepoRef;
  manifestPath?: string;
  downloadUrl?: string;
  /** Release assets; several when there is one per platform (e.g. darwin-arm64). */
  assets?: { name: string; url: string }[];
  inputs: InputField[];
}

export type InstallSpec = McpLocalSpec | McpRemoteSpec | SkillSpec | PluginSpec | McpbSpec;

export type EvidenceVia =
  | 'user-input'
  | 'server.json'
  | 'marketplace.json'
  | 'plugin.json'
  | 'SKILL.md'
  | 'manifest.json'
  | 'release-asset'
  | 'deeplink'
  | 'readme-config'
  | 'readme-command'
  | 'package.json'
  | 'pyproject.toml';

export interface Evidence {
  via: EvidenceVia;
  file?: string;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface Candidate {
  /** Stable identity used to merge duplicates found in different places. */
  id: string;
  /** Groups alternative ways of installing the same thing. */
  group: string;
  /** Suggested config key (plugin / skill names are kept exactly as published). */
  name: string;
  /** Human-friendly title when the project provides one. */
  title?: string;
  description?: string;
  spec: InstallSpec;
  evidence: Evidence[];
  confidence: Confidence;
  /** User-facing notes (Chinese). */
  warnings: string[];
}

export interface CandidateGroup {
  group: string;
  primary: Candidate;
  alternatives: Candidate[];
}

export interface RepoMeta {
  owner: string;
  repo: string;
  ref: string;
  url: string;
  description?: string;
  stars?: number;
  archived?: boolean;
  license?: string;
}

export type InputKind = 'github' | 'command' | 'config' | 'url' | 'local' | 'empty' | 'unknown';

export interface DetectResult {
  inputKind: InputKind;
  repo?: RepoMeta;
  groups: CandidateGroup[];
  /** User-facing notes (Chinese). */
  notes: string[];
}

/** Minimal fetch shape so callers can inject Tauri's fetch or a test double. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}>;

/** A read-only view of a repository or a local folder. */
export interface RepoView {
  source: RepoRef;
  /** Repo-relative POSIX paths of files (already narrowed to `subpath`). */
  files: string[];
  read(path: string): Promise<string | null>;
  subpath?: string;
  truncated?: boolean;
  meta?: RepoMeta;
  releaseAssets?(): Promise<{ name: string; url: string }[]>;
}
