import {
  ChatBusyError, cleanChatAnswer, cleanChatContext, cleanChatError, cleanChatSources, cleanChatText, cleanChatTitle, newChatId, newChatTurnId, ORPHANED_TURN, withPackSizes,
  type ChatAnswer, type ChatConversation, type ChatJob, type ChatPack, type ChatProvider, type ChatStore, type ChatThread, type ChatTurn,
} from '@fb/core';
import type pg from 'pg';
import { iso, toJson, tx, type Db } from './db.ts';

const PENDING = `EXISTS (SELECT 1 FROM chat_turns t WHERE t.conversation_id = c.id AND t.status IN ('pending', 'answering'))`;

/** Ask conversations and their turns (chat_conversations, chat_turns), as the Neo4j ChatRepo keeps them. */
export class PgChatStore implements ChatStore {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async listConversations(q: { projectKeys?: string[] }): Promise<ChatConversation[]> {
    const { rows } = await this.db.pool.query(
      `SELECT c.*, ${PENDING} AS pending FROM chat_conversations c
       WHERE $1::text[] IS NULL OR c.project_key = ANY($1)
       ORDER BY c.updated_at DESC, c.id COLLATE "C" DESC`,
      [q.projectKeys ?? null],
    );
    return rows.map(conversationOf);
  }

  async createConversation(input: { projectKey: string; title: string; provider: ChatProvider | null }): Promise<ChatConversation> {
    const now = new Date();
    const { rows: [row] } = await this.db.pool.query(
      `INSERT INTO chat_conversations (id, project_key, title, provider, next_seq, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, $5, $5) RETURNING *, false AS pending`,
      [newChatId(), input.projectKey, cleanChatTitle(input.title), input.provider, now],
    );
    return conversationOf(row);
  }

  async updateConversation(id: string, patch: { title?: string; provider?: ChatProvider | null }): Promise<ChatConversation | null> {
    const { rows: [row] } = await this.db.pool.query(
      `UPDATE chat_conversations c SET
         title = CASE WHEN $2 THEN $3 ELSE c.title END,
         provider = CASE WHEN $4 THEN $5 ELSE c.provider END,
         updated_at = $6
       WHERE c.id = $1
       RETURNING c.*, ${PENDING} AS pending`,
      [id, patch.title !== undefined, patch.title === undefined ? null : cleanChatTitle(patch.title), patch.provider !== undefined, patch.provider ?? null, new Date()],
    );
    return row ? conversationOf(row) : null;
  }

  async conversation(id: string): Promise<ChatThread | null> {
    return threadOf(this.db.pool, id);
  }

  async addUserTurn(conversationId: string, text: string, pack: ChatPack): Promise<ChatThread | null> {
    const now = new Date();
    const added = await tx(this.db, async (c) => {
      // The row lock makes two questions sent at once take turns, so only one gets in.
      const { rows: [conv] } = await c.query('SELECT id, project_key, next_seq FROM chat_conversations WHERE id = $1 FOR UPDATE', [conversationId]);
      if (!conv) return false;
      const { rowCount } = await c.query(`SELECT 1 FROM chat_turns WHERE conversation_id = $1 AND status IN ('pending', 'answering') LIMIT 1`, [conversationId]);
      if (rowCount) throw new ChatBusyError();
      const seq = Number(conv.next_seq);
      await c.query(
        `INSERT INTO chat_turns (id, conversation_id, project_key, seq, role, text, status, sources, context, created_at, finished_at)
         VALUES ($1, $2, $3, $4, 'user', $5, 'done', '[]', $6, $7, $7),
                ($8, $2, $3, $4 + 1, 'assistant', '', 'pending', $9::jsonb, NULL, $7, NULL)`,
        [newChatTurnId(), conversationId, conv.project_key, seq, cleanChatText(text), cleanChatContext(pack.context), now, newChatTurnId(), toJson(cleanChatSources(pack.sources))],
      );
      await c.query('UPDATE chat_conversations SET next_seq = $2, updated_at = $3 WHERE id = $1', [conversationId, seq + 2, now]);
      return true;
    });
    return added ? this.conversation(conversationId) : null;
  }

  async nextPendingTurn(): Promise<ChatJob | null> {
    const { rows: [r] } = await this.db.pool.query(
      `SELECT t.id, t.conversation_id, q.id AS question_id, q.context
       FROM chat_turns t LEFT JOIN chat_turns q ON q.conversation_id = t.conversation_id AND q.seq = t.seq - 1
       WHERE t.status = 'pending' AND t.role = 'assistant'
       ORDER BY t.created_at, t.id COLLATE "C" LIMIT 1`,
    );
    if (!r) return null;
    const conversation = await this.conversation(r.conversation_id);
    const turn = conversation?.turns.find((t) => t.id === r.id);
    const question = conversation?.turns.find((t) => t.id === r.question_id);
    if (!conversation || !turn || !question) {
      // An orphan (its conversation or question gone) would head the queue forever: fail it, so the next one goes.
      await this.db.pool.query(`UPDATE chat_turns SET status = 'failed', error = $2, finished_at = $3 WHERE id = $1 AND status = 'pending'`, [r.id, ORPHANED_TURN, new Date()]);
      return null;
    }
    return { conversation, turn, question, context: r.context ?? '' };
  }

  async markAnswering(turnId: string, provider: string): Promise<boolean> {
    return this.transition(`UPDATE chat_turns SET status = 'answering', provider = $2, started_at = $3 WHERE id = $1 AND status = 'pending'`, [turnId, provider, new Date()]);
  }

  async saveAnswer(turnId: string, answer: ChatAnswer): Promise<boolean> {
    const a = cleanChatAnswer(answer);
    return this.transition(
      `UPDATE chat_turns SET status = 'done', answer = $2::jsonb, text = $4, error = NULL, finished_at = $3 WHERE id = $1 AND status = 'answering'`,
      [turnId, toJson(a), new Date(), a.answer],
    );
  }

  async failTurn(turnId: string, error: string): Promise<boolean> {
    return this.transition(
      `UPDATE chat_turns SET status = 'failed', error = $2, finished_at = $3 WHERE id = $1 AND status IN ('pending', 'answering')`,
      [turnId, cleanChatError(error), new Date()],
    );
  }

  async retryTurn(conversationId: string, turnId: string): Promise<ChatThread | null> {
    const ok = await this.transition(
      `UPDATE chat_turns SET status = 'pending', error = NULL, answer = NULL, text = '', started_at = NULL, finished_at = NULL
       WHERE id = $1 AND conversation_id = $2 AND role = 'assistant' AND status = 'failed'`,
      [turnId, conversationId],
    );
    return ok ? this.conversation(conversationId) : null;
  }

  async deleteConversation(id: string): Promise<boolean> {
    return tx(this.db, async (c) => {
      await c.query('DELETE FROM chat_turns WHERE conversation_id = $1', [id]);
      return ((await c.query('DELETE FROM chat_conversations WHERE id = $1', [id])).rowCount ?? 0) > 0;
    });
  }

  async requeueStaleTurns(): Promise<number> {
    const { rowCount } = await this.db.pool.query(`UPDATE chat_turns SET status = 'pending', started_at = NULL WHERE status = 'answering'`);
    return rowCount ?? 0;
  }

  /** A guarded UPDATE of one turn; true when it changed it, and then its conversation's updated_at is bumped. */
  private async transition(sql: string, params: unknown[]): Promise<boolean> {
    return tx(this.db, async (c) => {
      const { rows } = await c.query(`${sql} RETURNING conversation_id`, params);
      if (!rows.length) return false;
      await c.query('UPDATE chat_conversations SET updated_at = $2 WHERE id = $1', [rows[0].conversation_id, new Date()]);
      return true;
    });
  }
}

async function threadOf(q: pg.Pool | pg.PoolClient, id: string): Promise<ChatThread | null> {
  const { rows: [conv] } = await q.query(`SELECT c.*, ${PENDING} AS pending FROM chat_conversations c WHERE c.id = $1`, [id]);
  if (!conv) return null;
  const { rows } = await q.query('SELECT * FROM chat_turns WHERE conversation_id = $1 ORDER BY seq', [id]);
  return { ...conversationOf(conv), turns: withPackSizes(rows.map((r) => ({ turn: turnOf(r), contextChars: typeof r.context === 'string' ? r.context.length : null }))) };
}

function conversationOf(r: Record<string, any>): ChatConversation {
  return {
    id: r.id,
    projectKey: r.project_key,
    title: r.title,
    provider: r.provider ?? null,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    pending: !!r.pending,
  };
}

function turnOf(r: Record<string, any>): ChatTurn {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    seq: Number(r.seq),
    role: r.role,
    text: r.text ?? '',
    status: r.status,
    error: r.error ?? null,
    answer: r.answer ?? null,
    sources: r.sources ?? [],
    provider: r.provider ?? null,
    createdAt: iso(r.created_at)!,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}
