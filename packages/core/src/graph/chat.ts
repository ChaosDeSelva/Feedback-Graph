import { conditionalWrite } from './conditionalWrite.ts';
import { randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import {
  ChatBusyError, cleanChatAnswer, cleanChatContext, cleanChatError, cleanChatSources, cleanChatText, cleanChatTitle, ORPHANED_TURN, withPackSizes,
  type ChatAnswer, type ChatConversation, type ChatJob, type ChatPack, type ChatProvider, type ChatSource, type ChatThread, type ChatTurn, type PendingChatTurn,
} from '../chat.ts';
import { REDACT_PAGE, redactedChanges, redactStoredRow } from '../redact.ts';
import type { ChatStore } from '../store.ts';
import type { GraphRepo } from './repo.ts';

/** A turn's stored text the redaction re-run reads: the question or answer, the pack, the error, the answer and sources (JSON). */
const TURN_TEXT = ['id', 'text', 'context', 'error', 'answer', 'sources'] as const;
/** The fields of a turn the redaction re-run may rewrite. */
const TURN_FIELDS = ['text', 'context', 'error', 'answer', 'sources'] as const;

export const newChatId = () => `chat-${randomUUID()}`;
export const newChatTurnId = () => `chatturn-${randomUUID()}`;

const parse = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/**
 * Ask conversations: ChatConversation and ChatTurn nodes keyed by id, joined by property (no edges, like ProjectLink),
 * both carrying projectKey so deleting a project removes them. A turn's answer and sources are JSON text; the pack's
 * context is kept on the user turn only.
 */
export class ChatRepo implements ChatStore {
  readonly g: GraphRepo;
  constructor(g: GraphRepo) {
    this.g = g;
  }

  async listConversations(q: { projectKeys?: string[] }): Promise<ChatConversation[]> {
    const rows = await this.g.run(
      `MATCH (c:ChatConversation) WHERE $keys IS NULL OR c.projectKey IN $keys
       OPTIONAL MATCH (t:ChatTurn {conversationId: c.id}) WHERE t.status IN ['pending', 'answering']
       WITH c, count(t) > 0 AS pending
       RETURN c, pending ORDER BY c.updatedAt DESC, c.id DESC`,
      { keys: q.projectKeys ?? null },
    );
    return rows.map((r) => conversationOf(r.get('c').properties, r.get('pending')));
  }

  async createConversation(input: { projectKey: string; title: string; provider: ChatProvider | null; run?: string | null }): Promise<ChatConversation> {
    const now = new Date().toISOString();
    const [r] = await this.g.run(
      `CREATE (c:ChatConversation {id: $id, projectKey: $projectKey, title: $title, provider: $provider, nextSeq: 1, createdAt: $now, updatedAt: $now, run: $run})
       RETURN c`,
      { id: newChatId(), projectKey: input.projectKey, title: cleanChatTitle(input.title), provider: input.provider, now, run: input.run ?? null },
    );
    return conversationOf(r.get('c').properties, false);
  }

  async updateConversation(id: string, patch: { title?: string; provider?: ChatProvider | null }): Promise<ChatConversation | null> {
    const rows = await this.g.run(
      `MATCH (c:ChatConversation {id: $id})
       SET c.title = CASE WHEN $setTitle THEN $title ELSE c.title END,
           c.provider = CASE WHEN $setProvider THEN $provider ELSE c.provider END,
           c.updatedAt = $now
       WITH c
       OPTIONAL MATCH (t:ChatTurn {conversationId: c.id}) WHERE t.status IN ['pending', 'answering']
       RETURN c, count(t) > 0 AS pending`,
      {
        id,
        setTitle: patch.title !== undefined,
        title: patch.title === undefined ? null : cleanChatTitle(patch.title),
        setProvider: patch.provider !== undefined,
        provider: patch.provider ?? null,
        now: new Date().toISOString(),
      },
    );
    return rows[0] ? conversationOf(rows[0].get('c').properties, rows[0].get('pending')) : null;
  }

  async conversation(id: string): Promise<ChatThread | null> {
    const rows = await this.g.run(
      `MATCH (c:ChatConversation {id: $id})
       OPTIONAL MATCH (t:ChatTurn {conversationId: c.id})
       WITH c, t ORDER BY t.seq
       RETURN c, collect(t) AS turns`,
      { id },
    );
    if (!rows[0]) return null;
    const props = (rows[0].get('turns') as { properties: Record<string, unknown> }[]).map((t) => t.properties);
    const turns = withPackSizes(props.map((p) => ({ turn: turnOf(p), contextChars: typeof p.context === 'string' ? p.context.length : null })));
    return { ...conversationOf(rows[0].get('c').properties, turns.some((t) => t.status === 'pending' || t.status === 'answering')), turns };
  }

  async addUserTurn(conversationId: string, text: string, pack: ChatPack): Promise<ChatThread | null> {
    const now = new Date().toISOString();
    // One statement: the conversation is write-locked first, so two questions sent at once cannot both get in.
    const rows = await this.g.run(
      `MATCH (c:ChatConversation {id: $id})
       SET c.updatedAt = c.updatedAt
       WITH c
       OPTIONAL MATCH (waiting:ChatTurn {conversationId: c.id}) WHERE waiting.status IN ['pending', 'answering']
       WITH c, count(waiting) AS busy, coalesce(c.nextSeq, 1) AS seq
       FOREACH (_ IN CASE WHEN busy = 0 THEN [1] ELSE [] END |
         SET c.nextSeq = seq + 2, c.updatedAt = $now
         CREATE (:ChatTurn {id: $userId, conversationId: c.id, projectKey: c.projectKey, seq: seq, role: 'user', text: $text,
                            status: 'done', error: null, answer: null, sources: '[]', provider: null, context: $context,
                            createdAt: $now, startedAt: null, finishedAt: $now})
         CREATE (:ChatTurn {id: $assistantId, conversationId: c.id, projectKey: c.projectKey, seq: seq + 1, role: 'assistant', text: '',
                            status: 'pending', error: null, answer: null, sources: $sources, provider: null,
                            createdAt: $now, startedAt: null, finishedAt: null}))
       RETURN busy`,
      {
        id: conversationId,
        userId: newChatTurnId(),
        assistantId: newChatTurnId(),
        text: cleanChatText(text),
        context: cleanChatContext(pack.context),
        sources: JSON.stringify(cleanChatSources(pack.sources)),
        now,
      },
    );
    if (!rows[0]) return null;
    if (Number(rows[0].get('busy')) > 0) throw new ChatBusyError();
    return this.conversation(conversationId);
  }

  async nextPendingTurn(o: { id?: string } = {}): Promise<ChatJob | null> {
    const [r] = await this.g.run(
      `MATCH (t:ChatTurn {status: 'pending', role: 'assistant'}) WHERE $id IS NULL OR t.id = $id
       WITH t ORDER BY t.createdAt, t.id LIMIT 1
       OPTIONAL MATCH (q:ChatTurn {conversationId: t.conversationId, seq: t.seq - 1})
       RETURN t.id AS id, t.conversationId AS conversationId, q.id AS questionId, q.context AS context`,
      { id: o.id ?? null },
    );
    if (!r) return null;
    const conversation = await this.conversation(r.get('conversationId'));
    const turn = conversation?.turns.find((t) => t.id === r.get('id'));
    const question = conversation?.turns.find((t) => t.id === r.get('questionId'));
    if (!conversation || !turn || !question) {
      // An orphan (its conversation or question gone) would head the queue forever: fail it, so the next one goes.
      await this.g.run(`MATCH (t:ChatTurn {id: $id, status: 'pending'}) SET t.status = 'failed', t.error = $error, t.finishedAt = $now`, { id: r.get('id'), error: ORPHANED_TURN, now: new Date().toISOString() });
      return null;
    }
    return { conversation, turn, question, context: (r.get('context') as string | null) ?? '' };
  }

  async pendingTurns(limit = 200): Promise<PendingChatTurn[]> {
    const rows = await this.g.run(
      `MATCH (t:ChatTurn {status: 'pending', role: 'assistant'})
       OPTIONAL MATCH (c:ChatConversation {id: t.conversationId})
       RETURN t.id AS id, t.conversationId AS conversationId, c.provider AS provider, t.createdAt AS createdAt
       ORDER BY t.createdAt, t.id LIMIT $limit`,
      { limit: neo4j.int(limit) },
    );
    return rows.map((r) => ({ id: r.get('id'), conversationId: r.get('conversationId'), provider: r.get('provider') ?? null, createdAt: r.get('createdAt') }));
  }

  async setQueueAhead(updates: { id: string; ahead: number }[]): Promise<void> {
    if (!updates.length) return;
    await this.g.run(`UNWIND $u AS u MATCH (t:ChatTurn {id: u.id, status: 'pending'}) SET t.queueAhead = u.ahead`, { u: updates.map((x) => ({ id: x.id, ahead: neo4j.int(x.ahead) })) });
  }

  async markAnswering(turnId: string, provider: string): Promise<boolean> {
    return this.transition(
      `MATCH (t:ChatTurn {id: $id, status: 'pending'}) SET t.status = 'answering', t.provider = $provider, t.startedAt = $now`,
      { id: turnId, provider },
    );
  }

  async saveAnswer(turnId: string, answer: ChatAnswer): Promise<boolean> {
    const a = cleanChatAnswer(answer);
    return this.transition(
      `MATCH (t:ChatTurn {id: $id, status: 'answering'})
       SET t.status = 'done', t.answer = $answer, t.text = $text, t.error = null, t.finishedAt = $now`,
      { id: turnId, answer: JSON.stringify(a), text: a.answer },
    );
  }

  async failTurn(turnId: string, error: string): Promise<boolean> {
    return this.transition(
      `MATCH (t:ChatTurn {id: $id}) WHERE t.status IN ['pending', 'answering']
       SET t.status = 'failed', t.error = $error, t.finishedAt = $now`,
      { id: turnId, error: cleanChatError(error) },
    );
  }

  async retryTurn(conversationId: string, turnId: string): Promise<ChatThread | null> {
    const ok = await conditionalWrite(this.g, async query => {
      const [r] = await query(`MATCH (t:ChatTurn {id: $id, conversationId: $conversationId, role: 'assistant', status: 'failed'})
        SET t.status = 'pending', t.error = null, t.answer = null, t.text = '', t.startedAt = null, t.finishedAt = null
        WITH t OPTIONAL MATCH (c:ChatConversation {id: t.conversationId}) SET c.updatedAt = $now RETURN count(t) AS n`,
        { id: turnId, conversationId, now: new Date().toISOString() });
      return Number(r?.get('n') ?? 0) > 0;
    }, Boolean);
    return ok ? this.conversation(conversationId) : null;
  }

  async deleteConversation(id: string): Promise<boolean> {
    const [, [r]] = await this.g.runInTransaction([
      [`MATCH (t:ChatTurn {conversationId: $id}) DETACH DELETE t`, { id }],
      [`OPTIONAL MATCH (c:ChatConversation {id: $id}) WITH c, c IS NOT NULL AS existed DETACH DELETE c RETURN existed`, { id }],
    ]);
    return !!r?.get('existed');
  }

  async chatQueue(): Promise<{ waiting: number; oldestAt: string | null; running: { id: string; projectKey: string; startedAt: string }[] }> {
    const [r] = await this.g.run(
      `OPTIONAL MATCH (p:ChatTurn {status: 'pending', role: 'assistant'})
       WITH count(p) AS waiting, min(p.createdAt) AS oldest
       OPTIONAL MATCH (a:ChatTurn {status: 'answering', role: 'assistant'})
       WITH waiting, oldest, a ORDER BY a.startedAt, a.id
       RETURN waiting, oldest, [x IN collect(a) | {id: x.id, projectKey: x.projectKey, startedAt: x.startedAt}] AS running`,
    );
    return {
      waiting: Number(r?.get('waiting') ?? 0),
      oldestAt: (r?.get('oldest') as string | null) ?? null,
      running: ((r?.get('running') ?? []) as { id: string; projectKey: string; startedAt: string }[]).map((x) => ({ id: x.id, projectKey: x.projectKey, startedAt: x.startedAt })),
    };
  }

  async requeueStaleTurns(): Promise<number> {
    const [r] = await this.g.run(
      `MATCH (t:ChatTurn {status: 'answering'}) SET t.status = 'pending', t.startedAt = null RETURN count(t) AS n`,
    );
    return Number(r?.get('n') ?? 0);
  }

  async redactStoredTurns(afterRead?: () => Promise<unknown>): Promise<number> {
    let changed = 0;
    for (let after = ''; ;) {
      const rows = await this.g.run(
        `MATCH (t:ChatTurn) WHERE t.id > $after
         RETURN t.id AS id, t.text AS text, t.context AS context, t.error AS error, t.answer AS answer, t.sources AS sources ORDER BY t.id LIMIT $page`,
        { after, page: neo4j.int(REDACT_PAGE) },
      );
      if (!rows.length) break;
      after = rows[rows.length - 1].get('id');
      const page = rows.flatMap((r) => {
        const row = Object.fromEntries(TURN_TEXT.map((k) => [k, r.get(k) ?? null])) as Record<string, unknown> & { id: string };
        const out = redactStoredRow(row, ['text', 'context', 'error'], ['answer', 'sources']);
        if (!out) return [];
        const { id, set, was, fields } = redactedChanges(row, out, TURN_FIELDS);
        return [{ id, vals: set, prev: was, fields }];
      });
      if (!page.length) continue;
      await afterRead?.();
      // Each changed field only while it is still what was read: the runner may answer a turn (answer, text) between.
      const same = (f: string) => `('${f}' IN c.fields AND t.${f} = c.prev.${f})`;
      const [r] = await this.g.run(
        `UNWIND $page AS c MATCH (t:ChatTurn {id: c.id})
         WITH t, c, ${TURN_FIELDS.map((f) => `${same(f)} AS ${f}Same`).join(', ')}
         SET ${TURN_FIELDS.map((f) => `t.${f} = CASE WHEN ${f}Same THEN c.vals.${f} ELSE t.${f} END`).join(', ')}
         RETURN count(CASE WHEN ${TURN_FIELDS.map((f) => `${f}Same`).join(' OR ')} THEN 1 END) AS n`,
        { page },
      );
      changed += Number(r?.get('n') ?? 0);
    }
    return changed;
  }

  /** Run a guarded SET (a MATCH that finds the turn only in the right state); true when it changed one, and bump its conversation. */
  private async transition(cypher: string, params: Record<string, unknown>): Promise<boolean> {
    const now = new Date().toISOString();
    const [r] = await this.g.run(
      `${cypher}
       WITH t
       OPTIONAL MATCH (c:ChatConversation {id: t.conversationId})
       SET c.updatedAt = $now
       RETURN count(t) AS n`,
      { ...params, now },
    );
    return Number(r?.get('n') ?? 0) > 0;
  }
}

function conversationOf(p: Record<string, unknown>, pending: boolean): ChatConversation {
  return {
    id: p.id as string,
    projectKey: p.projectKey as string,
    title: (p.title as string) ?? '',
    provider: (p.provider as ChatProvider | null) ?? null,
    createdAt: p.createdAt as string,
    updatedAt: p.updatedAt as string,
    pending: !!pending,
    ...(p.run ? { run: p.run as string } : {}),
  };
}

function turnOf(p: Record<string, unknown>): ChatTurn {
  return {
    id: p.id as string,
    conversationId: p.conversationId as string,
    seq: Number(p.seq),
    role: p.role as ChatTurn['role'],
    text: (p.text as string) ?? '',
    status: p.status as ChatTurn['status'],
    error: (p.error as string | null) ?? null,
    answer: parse<ChatAnswer | null>(p.answer, null),
    sources: parse<ChatSource[]>(p.sources, []),
    provider: (p.provider as string | null) ?? null,
    createdAt: p.createdAt as string,
    startedAt: (p.startedAt as string | null) ?? null,
    finishedAt: (p.finishedAt as string | null) ?? null,
    queueAhead: p.status === 'pending' && p.queueAhead != null ? Number(p.queueAhead) : null,
  };
}
