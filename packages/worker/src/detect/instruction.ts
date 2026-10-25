import type { CallsAfter, ToolCall } from '@fb/core';
import { splitPasted } from './prefilter.ts';

/**
 * Instruction or correction, for messages about git. "This should be on its own branch, do not merge back to main,
 * don't push a PR yet" matches the prefilter ("should be") and reads like pushback to a model, but it is a constraint
 * on what the agent does next: it becomes a miss only when there is evidence the forbidden thing happened, an agent
 * action before the message (then the words are about it) or after it (then the agent broke the instruction).
 */
export type GitAction = 'push' | 'merge' | 'rebase' | 'pr' | 'commit';

/** The git actions a message talks about, by the words for them. */
const SUBJECT: [GitAction, RegExp][] = [
  ['push', /\b(?:force[- ]?)?push(?:es|ed|ing)?\b/i],
  ['merge', /\bmerg(?:e|es|ed|ing)\b/i],
  ['rebase', /\brebas(?:e|es|ed|ing)\b/i],
  ['pr', /\b(?:PRs?|pull requests?)\b/i],
  ['commit', /\bcommit(?:s|ted|ting)?\b/i],
];
/** A branch is the subject too ("keep it on its own branch"), though no single command breaks that. */
const BRANCH = /\bbranch(?:es)?\b/i;

/** Words that say the thing already happened: a correction, whatever else the message says. */
const HAPPENED: RegExp[] = [
  /\byou(?:'ve| have)? (?:just |already |again |accidentally |still )?(?:pushed|merged|committed|opened|created|rebased|force[- ]?pushed|deleted|reset|made|put)\b/i,
  /\bI (?:already )?(?:said|told|asked)\b/i,
  /\bwhy (?:did|have|would|are) you\b/i,
  /\byou (?:didn'?t|did not|forgot|were supposed|weren'?t supposed|keep)\b/i,
  /\b(?:should(?:n'?t| not)? have|(?:was|were)(?:n'?t| not)? supposed)\b/i,
  /\b(?:went|landed|ended up|got (?:pushed|merged|committed)|(?:was|were|been) (?:pushed|merged|committed|opened|rebased)|(?:is|are) (?:now |already )?(?:on|in) (?:main|master))\b/i,
  /\bagain\b/i,
  /\b(?:revert|undo|roll ?back)\b/i,
  /\bstop \w+ing\b/i,
  // Something is wrong with what is there: a report, not an order.
  /\b(?:broke|broken|fail(?:s|ed|ing)?|wrong|missing|lost)\b/i,
];

/** Words that point at what happens next: a modal, a prohibition, a time word, or a message that opens with a verb. */
const NEXT: RegExp[] = [
  /\b(?:do not|don'?t|dont|never|no need to|avoid)\b/i,
  /\b(?:yet|for now|until|before (?:you|we|I|it)|from now on|going forward|when (?:you'?re|it'?s) done)\b/i,
  // A request. A bare "should" is not: "the PR should have the tests" is about work already there.
  /\b(?:make sure|please|let'?s|can you|could you|go ahead|I want (?:it|this|you))\b/i,
  /^\s*(?:put|keep|create|make|base|start|work|branch|use|commit|push|open|merge|rebase|cut|move|leave|hold)\b/i,
];
/**
 * A prohibition and the few words after it, up to the end of its clause (a lookahead, so "do not merge back to main,
 * dont push" finds both, and "Don't use that API, it's deprecated. Commit when done." forbids no commit).
 */
const NEGATION = /\b(?:do not|don'?t|dont|never|no need to|avoid|not)\b(?=((?:\s+[^\s,.;:!?]+){1,5}))/gi;

/**
 * Words that say something about the work is wrong or should change: a complaint or a request about the code or the
 * content, which a git word in the same message does not make an instruction ("That's not right, the commit message
 * should say what changed, please amend it"). The model decides those.
 */
const COMPLAINT: RegExp[] = [
  /\b(?:nope|wrong|incorrect|inaccurate|misleading|confusing|deprecated|bad|ugly|sloppy|messy|unclear|outdated|buggy)\b/i,
  /\b(?:not|isn'?t|aren'?t|wasn'?t) (?:right|correct|accurate|good|what|how|the (?:approach|way|right|one))\b/i,
  /\bthat'?s not\b/i,
  /\bcan you not\b/i,
  // A request to change code or content.
  /\b(?:fix|fixes|change|amend|rewrite|reword|rename|update|edit|remove|delete|add|replace|refactor|cover|clean ?up|tweak|adjust)\b/i,
  // The work itself: code, tests, files, secrets.
  /\b(?:tests?|api|schema|function|endpoint|bug|secrets?|description|message|title)\b/i,
  // A file or a path ("the .env file", "auth/session.ts", `code`).
  /(?:^|\s)\.[a-z]\w*\b|\b[\w-]+\/[\w./-]+|\b[\w-]+\.(?:[jt]sx?|py|go|rs|rb|java|kt|swift|sql|json|ya?ml|md|css|html|sh|toml|env)\b|`[^`]+`/i,
];

/** The command (or a command after ;, &&, || or |) runs git or gh; a quoted "git push" in an echo does not. */
const AT_COMMAND = String.raw`(?:^|[;&|(]\s*)`;
const COMMAND: [GitAction, RegExp][] = [
  ['push', new RegExp(`${AT_COMMAND}git\\s+(?:-C\\s+\\S+\\s+)?push\\b`)],
  ['merge', new RegExp(`${AT_COMMAND}(?:git\\s+(?:-C\\s+\\S+\\s+)?merge\\b|gh\\s+pr\\s+merge\\b)`)],
  ['rebase', new RegExp(`${AT_COMMAND}git\\s+(?:-C\\s+\\S+\\s+)?rebase\\b`)],
  ['pr', new RegExp(`${AT_COMMAND}gh\\s+pr\\s+create\\b`)],
  ['commit', new RegExp(`${AT_COMMAND}git\\s+(?:-C\\s+\\S+\\s+)?commit\\b`)],
];
const MCP_TOOL: [GitAction, RegExp][] = [
  ['push', /(?:^|_)push_files$/],
  ['merge', /(?:^|_)merge_pull_request$/],
  ['pr', /(?:^|_)create_pull_request$/],
];

/** The git actions these tool calls took, each once, in the order first taken. */
export function gitActions(calls: ToolCall[]): GitAction[] {
  const out: GitAction[] = [];
  const add = (a: GitAction) => out.includes(a) || out.push(a);
  for (const c of calls) {
    if (c.command) for (const [a, re] of COMMAND) if (c.command.split('\n').some((line) => re.test(line.trim()))) add(a);
    for (const [a, re] of MCP_TOOL) if (re.test(c.name)) add(a);
  }
  return out;
}

/**
 * Words that name code or what it does: a complaint about these is about the code, even when it is said of a PR
 * ("This PR breaks login on token expiry").
 */
const CODE_TALK: RegExp[] = [
  /\b(?:break|breaks|broke|broken|crash(?:es|ed)?|bug(?:s|gy)?|regress(?:es|ed|ion)?|fail(?:s|ed|ing|ure)?|errors?|exceptions?|leaks?|slow|timeouts?)\b/i,
  /\b(?:tests?|login|logout|auth\w*|tokens?|sessions?|api|endpoints?|schema|database|queries|query|functions?|class(?:es)?|components?|types?|config|build|ci|lint)\b/i,
  // A file or a path.
  /(?:^|\s)\.[a-z]\w*\b|\b[\w-]+\/[\w./-]+|\b[\w-]+\.(?:[jt]sx?|py|go|rs|rb|java|kt|swift|sql|json|ya?ml|md|css|html|sh|toml|env)\b|`[^`]+`/i,
];
const codeTalk = (text: string) => CODE_TALK.some((re) => re.test(splitPasted(text).prose));

/**
 * A process miss: about the git process itself (branches, pushing, merging, pull request state, commit hygiene), not
 * the code. The feedback and its lesson are both about git, it is not a review comment on a file, the lesson names no
 * file (`paths`, when known, and none in its rule) and the feedback names no file or code behaviour. It is tied to no
 * file. The post-mortem applies it to new misses and the worker to the misses stored before it (postmortem/subjects.ts).
 */
export function isProcessMiss(o: { feedbackText: string; rule: string | null; commentPath: string | null; paths?: string[] }): boolean {
  return !o.commentPath && !o.paths?.length && aboutGit(o.feedbackText) && !!o.rule && aboutGit(o.rule) && !codeTalk(o.feedbackText) && !codeTalk(o.rule);
}

/**
 * Bump when the instruction rule changes (gitInstruction, gitEvidence): pending Inbox items flagged from sessions are
 * judged by it once more at worker start (pendingInstructions.ts). 1: instruction or correction, for git. 2: only a
 * message that is wholly a constraint on git (it forbids something, with no complaint or request about the work) is
 * an instruction, and it waits until its session is idle.
 */
export const DETECT_RULES_VERSION = 2;

/**
 * An instruction in a session that was active this recently waits before it is judged, later messages or not: what the
 * agent does next (a push it was told not to make) is not recorded yet.
 */
export const INSTRUCTION_WAIT_MS = 30 * 60_000;

/**
 * For a message the prefilter flagged: null when it is not an instruction about git (the model decides as usual);
 * 'instruction' when it is one and nothing it forbids happened; 'wait' while its session is still active;
 * else the git calls that broke it, the evidence the model is shown. Without callsAfter only the calls before the
 * message are known, and an instruction with nothing done before it stays an instruction.
 */
export async function gitEvidence(
  turn: { uuid: string; text: string; precedingToolCalls?: ToolCall[] },
  callsAfter: ((turnUuid: string) => Promise<CallsAfter | null>) | undefined,
  now: number,
): Promise<null | 'instruction' | 'wait' | ToolCall[]> {
  const before = turn.precedingToolCalls ?? [];
  if (!gitInstruction(turn.text, { before, after: [] }).instruction) return null;
  const after = callsAfter ? await callsAfter(turn.uuid) : null;
  // While the session is active the forbidden call may not be recorded yet, later messages or not ("don't push yet",
  // "looks good", then a push): judged once it has been idle a while, so it is never cleared too early.
  if (after?.endedAt && now - Date.parse(after.endedAt) < INSTRUCTION_WAIT_MS) return 'wait';
  const calls = after?.calls ?? [];
  const g = gitInstruction(turn.text, { before, after: calls });
  if (!g.violated.length) return 'instruction';
  return calls.filter((c) => gitActions([c]).some((a) => g.violated.includes(a)));
}

export type GitInstruction = {
  /** Forward-looking words about git with nothing done yet that they talk about: not pushback on its own. */
  instruction: boolean;
  /** The git actions the message talks about. */
  subjects: GitAction[];
  /** Those it forbids ("do not merge", "don't push a PR yet"). */
  forbids: GitAction[];
  /** Those the agent had taken before the message (the words are then about something that happened). */
  done: GitAction[];
  /** Forbidden actions the agent took after the message: evidence the instruction was broken. */
  violated: GitAction[];
};

const subjectsOf = (text: string) => SUBJECT.filter(([, re]) => re.test(text)).map(([a]) => a);

/** Whether the typed words (not what was pasted) are about git: pushes, merges, pull requests, commits, branches. */
export function aboutGit(text: string): boolean {
  const prose = splitPasted(text).prose;
  return subjectsOf(prose).length > 0 || BRANCH.test(prose);
}

/**
 * Whether `text` (a developer's message) is an instruction about git rather than a correction, given the agent's tool
 * calls `before` it (since the previous message) and `after` it (the rest of the session as recorded so far).
 */
export function gitInstruction(text: string, calls: { before: ToolCall[]; after: ToolCall[] }): GitInstruction {
  const prose = splitPasted(text).prose;
  const subjects = subjectsOf(prose);
  if (!aboutGit(text)) return { instruction: false, subjects, forbids: [], done: [], violated: [] };
  const forbids = [...new Set([...prose.matchAll(NEGATION)].flatMap((m) => subjectsOf(m[1])))];
  const done = gitActions(calls.before).filter((a) => subjects.includes(a));
  const violated = gitActions(calls.after).filter((a) => forbids.includes(a));
  // Only a constraint (something it forbids) can be shown broken by a later call, and only a message that is wholly
  // that constraint is safe to clear without the model: any complaint, request to change the work, or prohibition
  // of something other than git ("don't use that API") goes to the model.
  const otherProhibition = [...prose.matchAll(NEGATION)].some((m) => !subjectsOf(m[1]).length && !BRANCH.test(m[1]));
  const instruction = forbids.length > 0 && !done.length && !otherProhibition
    && !HAPPENED.some((re) => re.test(prose)) && !COMPLAINT.some((re) => re.test(prose)) && NEXT.some((re) => re.test(prose));
  return { instruction, subjects, forbids, done, violated };
}
