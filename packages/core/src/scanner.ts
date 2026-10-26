/** Bump when the extraction prompts change, so the log says which prompt produced a fact. */
export const SCAN_PROMPT_VERSION = 'scan-v6';
/**
 * Bump when what the scan does without a model changes: the worker's manifest reader (deterministicFacts), the citation
 * checks (checkCitations), the shard planner (scan/shard.ts) or the per-shard file list.
 */
export const SCAN_READER_VERSION = 'reader-v3';
/**
 * The scanner version stored with every file a scan reads (FactsStore.fileScanVersions). A file read by another
 * version is rescanned even when its hash is unchanged: a new prompt or reader must reach the facts already stored,
 * not only files that change later. The scan reads them again when you start one (scans spend your model budget, so
 * none starts on its own); until then the Projects page and `fg status` count them (FactsStore.olderScannerFiles).
 */
export const SCANNER_VERSION = `${SCAN_PROMPT_VERSION}+${SCAN_READER_VERSION}`;
