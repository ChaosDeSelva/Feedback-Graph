import type { SymbolKind } from '@fb/core';

/** One list of symbol kinds, shared with the stores (core SYMBOL_KINDS; Postgres checks it). */
export type { SymbolKind };

/**
 * lang is the grammar name for parsed languages ('typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'csharp', 'swift'),
 * 'gdscript', or else the bare extension ('json', 'md') or lowercased file name ('dockerfile').
 */
export type CodeFile = { path: string; lang: string; hash: string; loc: number; isTest: boolean };

export type CodeSymbol = {
  id: string;
  path: string;
  name: string;
  kind: SymbolKind;
  exported: boolean;
  /** 1-based, inclusive: "12-30". */
  lines: string;
};

export type CodeImport = {
  from: string;
  /** A repo-relative file path, or 'pkg:<name>' for anything outside the repo. */
  to: string;
  names: string[];
  /** The specifier as written; lets an unchanged file's imports be re-resolved without reparsing it. */
  spec: string;
};

/**
 * candidates: files worth mapping before the cap (absent on a map from before it was counted). unresolved: imports
 * that look like they name a repo file (an alias, a workspace package) but resolved to none, so edges are missing.
 */
export type CodeMap = {
  files: CodeFile[];
  symbols: CodeSymbol[];
  /** Every edge of the import index: from and to mapped and outside files. */
  imports: CodeImport[];
  /** The import index past the cap: candidates not mapped (no symbols), whose edges are kept. Sorted by path. */
  outside?: CodeFile[];
  candidates?: number | null;
  unresolved?: number | null;
};

/**
 * `signal`: stop parsing (the worker is shutting down); the build then rejects with the signal's reason. maxFiles null:
 * the cap scales with the repo (scan/rank.ts mapCap). priority: paths kept before the rest (files sessions edited).
 * churn: commits per path (churn.ts); with the import in-degree it decides which files a capped map keeps.
 */
export type BuildOpts = {
  maxFiles: number | null;
  maxBytes: number;
  concurrency?: number;
  signal?: AbortSignal;
  priority?: string[];
  churn?: Map<string, { commits: number; lastTs?: string }>;
};

/** An import as the parser saw it, before resolution. names: '*' is the whole module, 'default' the default export. */
export type RawImport = { spec: string; names: string[] };

export type Extracted = { symbols: Omit<CodeSymbol, 'id' | 'path'>[]; imports: RawImport[] };
