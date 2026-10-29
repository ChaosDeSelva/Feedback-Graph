import { AsyncLocalStorage } from 'node:async_hooks';
import type { GraphStore, KnowledgeStore, FactsStore, DocsStore, LinksStore, ActivityStore, InsightsStore, PortabilityStore, EmbeddingsStore, SelectionStore, CodeGraphStore, SessionsStore, ChatStore, RunsStore, Store } from './store.ts';
import type { RunOwner, RunPrincipal } from './types.ts';

type Mode = 'read' | 'write' | 'internal';
type MethodKeys<T> = { [K in keyof T]-?: NonNullable<T[K]> extends (...args: any[]) => any ? K : never }[keyof T];
type Policy<T> = { [K in MethodKeys<T>]-?: Mode };
/** Exhaustive semantic contract: a new Store method requires an explicit classification. */
export const STORE_WRITE_POLICY = {
  graph: {
    upsertSession: 'write',
    canonicalProject: 'write',
    projectByAlias: 'read',
    projectsMissingRemote: 'read',
    setProjectRemote: 'write',
    projectsMissingFolder: 'read',
    fillProjectFolder: 'write',
    unclassifiedTurns: 'read',
    recordClassifyFailure: 'write',
    callsAfter: 'read',
    sessionInstructionFiles: 'read',
    givenUpTurns: 'read',
    requeueGivenUpTurns: 'write',
    saveClassification: 'write',
    listCandidates: 'read',
    candidateDetail: 'read',
    pendingExternalItems: 'read',
    pendingSessionItems: 'read',
    redactStoredCandidates: 'write',
    skipPendingItem: 'write',
    ruleSkippedItems: 'read',
    reopenRuleSkippedItem: 'write',
    setExternalLinks: 'write',
    decide: 'write',
    pruneTurnText: 'write',
    upsertExternalThread: 'write',
    refreshExternalThreadState: 'write',
    workSessions: 'read',
    heartbeat: 'write',
    workerStatus: 'read',
    stats: 'read',
  } satisfies Policy<GraphStore>,
  knowledge: {
    feedbackNeedingPostmortem: 'read',
    postmortemBacklog: 'read',
    postmortemQueue: 'read',
    recordPostmortemFailure: 'write',
    retryPostmortem: 'internal',
    savePostmortem: 'write',
    missesWithoutSubject: 'read',
    processMisses: 'read',
    setMissSubject: 'write',
    listLessons: 'read',
    lessonDetail: 'read',
    updateLesson: 'write',
    decidedLessons: 'read',
    backfillProposedAs: 'write',
    setLessonChecks: 'write',
    setLessonPaths: 'write',
    staleLessonChecks: 'read',
    commentLessons: 'read',
    clearMachineOwnerMarks: 'write',
    requestLessonRecheck: 'write',
    similarLessons: 'read',
    searchLessons: 'read',
    relatedMisses: 'read',
    createManualFeedback: 'write',
    recordPreDoneCheck: 'write',
    upsertLesson: 'write',
    redactStoredLessons: 'write',
    redactStoredMisses: 'write',
    saveDemoMiss: 'write',
    removeDemo: 'write',
  } satisfies Policy<KnowledgeStore>,
  facts: {
    fileHashes: 'read',
    fileScanVersions: 'read',
    olderScannerFiles: 'read',
    saveFileFacts: 'write',
    markFilesRemoved: 'write',
    replaceProjectFacts: 'write',
    replaceScopeFacts: 'write',
    factsToRecheck: 'read',
    applyFactChecks: 'write',
    requestFilesScan: 'write',
    scanRequests: 'read',
    clearScanRequests: 'write',
    addOwnerFact: 'write',
    currentSources: 'read',
    listFacts: 'read',
    searchFacts: 'read',
    unscoredFacts: 'read',
    setFactRelevance: 'internal',
    requestScan: 'write',
    scanJob: 'read',
    nextScanJob: 'read',
    requeueScanJob: 'write',
    scanQueue: 'read',
    recordScanFailure: 'write',
    updateScanJob: 'write',
    requeueStaleScans: 'write',
    listProjects: 'read',
    setPinned: 'write',
    redactStoredFacts: 'write',
    reopenInstructionFacts: 'write',
    redactionRepairCandidates: 'read',
  } satisfies Policy<FactsStore>,
  docs: {
    upsertDoc: 'write',
    nextDocToRead: 'read',
    markDocReading: 'write',
    saveDocReading: 'write',
    recordDocFailure: 'write',
    requeueStaleDocs: 'write',
    requeueDocRead: 'internal',
    queueRedactionRepair: 'write',
    docImage: 'read',
    listDocs: 'read',
    deleteDoc: 'internal',
    searchDocs: 'read',
    linkedDocs: 'read',
    projectTickets: 'read',
    getCursor: 'read',
    setCursor: 'write',
    cursorsWithPrefix: 'read',
    deleteCursor: 'write',
    redactStoredDocs: 'write',
  } satisfies Policy<DocsStore>,
  links: {
    listLinks: 'read',
    replaceDetected: 'write',
    setLink: 'write',
    deleteLink: 'internal',
  } satisfies Policy<LinksStore>,
  activity: {
    record: 'write',
    list: 'read',
    get: 'read',
    removeRun: 'write',
    redactStoredActivity: 'write',
  } satisfies Policy<ActivityStore>,
  insights: {
    projectGraph: 'read',
    patterns: 'read',
  } satisfies Policy<InsightsStore>,
  portability: {
    restorePrivateProject: 'write',
    exportData: 'read',
    deleteProject: 'write',
  } satisfies Policy<PortabilityStore>,
  embeddings: {
    stored: 'read',
    check: 'write',
    reembed: 'write',
  } satisfies Policy<EmbeddingsStore>,
  selection: {
    get: 'read',
    current: 'read',
    ensure: 'write',
    setTracked: 'write',
    aliases: 'read',
    scope: 'read',
    saveCandidates: 'write',
    candidates: 'read',
    keysWithData: 'read',
    exclusive: 'read',
    forgetReads: 'write',
    forgottenReads: 'read',
  } satisfies Policy<SelectionStore>,
  codegraph: {
    replaceCodeMap: 'write',
    requestCodeMapRebuild: 'internal',
    purgeOrphanCodeFiles: 'write',
    codeMapRebuildsRequested: 'read',
    codeMap: 'read',
    codeMapMeta: 'read',
    recordSessionFiles: 'write',
    sessionFiles: 'read',
    editedPaths: 'read',
    moduleContext: 'read',
    impact: 'read',
    hotspots: 'read',
    mapGraph: 'read',
    lessonsForPaths: 'read',
    outsideMap: 'read',
  } satisfies Policy<CodeGraphStore>,
  sessions: {
    claimRun: 'internal',
    runFor: 'read',
    list: 'read',
    detail: 'read',
    work: 'read',
    turns: 'read',
    save: 'write',
    recordFailure: 'write',
    setState: 'write',
    requestRebuild: 'write',
    turnEvidence: 'read',
    redactStoredSummaries: 'write',
  } satisfies Policy<SessionsStore>,
  chat: {
    listConversations: 'read',
    createConversation: 'write',
    updateConversation: 'write',
    conversation: 'read',
    addUserTurn: 'write',
    nextPendingTurn: 'write',
    pendingTurns: 'read',
    setQueueAhead: 'write',
    markAnswering: 'write',
    saveAnswer: 'write',
    failTurn: 'write',
    retryTurn: 'internal',
    deleteConversation: 'write',
    requeueStaleTurns: 'write',
    chatQueue: 'read',
    redactStoredTurns: 'write',
  } satisfies Policy<ChatStore>,
  runs: {
    items: 'read',
    remove: 'write',
    claim: 'write',
    owner: 'read',
  } satisfies Policy<RunsStore>,
  store: {
    ensureSchema: 'write',
    ping: 'read',
    close: 'write',
  } satisfies Policy<Store>,
};

type Writer = { claim: () => Promise<void>; claimed?: Promise<void>; tail: Promise<unknown> };
const requestWriter = new AsyncLocalStorage<Writer | undefined>();
const inWrite = new AsyncLocalStorage<Writer>();
/** A request has no owner until its first semantic write, after route/tool argument validation. */
export const withStoreWriteAuthorizer = <T>(claim: () => Promise<void>, fn: () => T): T => requestWriter.run({ claim, tail: Promise.resolve() }, fn);
export const withoutStoreWriteAuthorizer = <T>(fn: () => T): T => requestWriter.run(undefined, fn);
export async function authorizeStoreWrite(): Promise<void> {
  const writer = requestWriter.getStore();
  if (writer) await (writer.claimed ??= Promise.resolve().then(() => withoutStoreWriteAuthorizer(writer.claim)));
}
/** Only conditional adapters whose transaction rolled back may invalidate that transaction's claim cache. */
export function storeWriteAuthorizationCheckpoint(): () => void {
  const writer = requestWriter.getStore(); const before = writer?.claimed;
  return () => { if (writer && before === undefined) writer.claimed = undefined; };
}

async function writing<T>(fn: () => Promise<T>, internal: boolean): Promise<T> {
  const writer = requestWriter.getStore();
  if (!writer || inWrite.getStore() === writer) return fn();
  const result = writer.tail.then(() => inWrite.run(writer, async () => { if (!internal) await authorizeStoreWrite(); return fn(); }));
  writer.tail = result.catch(() => {});
  return result;
}

const proxies = new WeakMap<object, Map<object, object>>();
export function guardStoreMethods<T extends object>(value: T, policy: object): T {
  const prior = proxies.get(value)?.get(policy); if (prior) return prior as T;
  const map = proxies.get(value) ?? new Map<object, object>(); proxies.set(value, map);
  const proxy = new Proxy(value, { get(target, key) {
    const item = Reflect.get(target, key);
    if (typeof item !== 'function') return item;
    const mode = (policy as Record<PropertyKey, Mode>)[key];
    return mode === 'write' || mode === 'internal'
      ? (...args: unknown[]) => writing(() => Reflect.apply(item, target, args), mode === 'internal')
      : item.bind(target);
  } });
  map.set(policy, proxy); proxies.set(proxy, map);
  return proxy;
}

export function guardStore(store: Store): Store {
  const out = guardStoreMethods(store, STORE_WRITE_POLICY.store);
  const groups = ['graph', 'knowledge', 'facts', 'docs', 'links', 'activity', 'insights', 'portability', 'embeddings', 'selection', 'codegraph', 'sessions', 'chats', 'runs'] as const;
  const parts = Object.fromEntries(groups.filter(key => store[key] && typeof store[key] === 'object').map(key => [key, guardStoreMethods(store[key], STORE_WRITE_POLICY[key === 'chats' ? 'chat' : key])]));
  return new Proxy(out, { get(target, key) { return key in parts ? parts[key as string] : Reflect.get(target, key); } });
}

type ClaimExecutor = (run: string, principal: RunPrincipal, actor: string | null) => Promise<RunOwner>;
const claimExecutor = new AsyncLocalStorage<{ store: object; claim: ClaimExecutor }>();
export const withRunClaimExecutor = <T>(store: object, claim: ClaimExecutor, fn: () => T): T => claimExecutor.run({ store, claim }, fn);
export const runClaimExecutor = (store: object): ClaimExecutor | undefined => { const current = claimExecutor.getStore(); return current?.store === store ? current.claim : undefined; };

export class LegacyRunClaimError extends Error {
  constructor(run: string) { super(`run ${run} has legacy records without an ownership capability; use owner-authorized cleanup, not a new labelled write`); this.name = 'LegacyRunClaimError'; }
}
