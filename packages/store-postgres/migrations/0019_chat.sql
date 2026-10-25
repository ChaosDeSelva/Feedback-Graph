-- Ask: conversations about one project, answered by the worker's chat runner. Never exported or synced; deleted with
-- their project (project_key on both tables). provider: null uses CHAT_LLM's default.
CREATE TABLE chat_conversations (
  id          text PRIMARY KEY,
  project_key text NOT NULL,
  title       text NOT NULL,
  provider    text CONSTRAINT chat_conversations_provider_check CHECK (provider IN ('claude', 'codex', 'local')),
  next_seq    integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE INDEX chat_conversations_project ON chat_conversations (project_key);

-- One row per message: a user turn holds the question and the context pack it was sent with (context, capped at 60 KB);
-- its assistant turn holds the pack's numbered sources and, once done, the answer {answer, examples, prompt}.
CREATE TABLE chat_turns (
  id              text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,
  project_key     text NOT NULL,
  seq             integer NOT NULL,
  role            text NOT NULL CONSTRAINT chat_turns_role_check CHECK (role IN ('user', 'assistant')),
  text            text NOT NULL DEFAULT '',
  status          text NOT NULL CONSTRAINT chat_turns_status_check CHECK (status IN ('pending', 'answering', 'done', 'failed')),
  error           text,
  answer          jsonb,
  sources         jsonb NOT NULL DEFAULT '[]',
  provider        text,
  context         text,
  created_at      timestamptz NOT NULL,
  started_at      timestamptz,
  finished_at     timestamptz,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX chat_turns_pending ON chat_turns (created_at, id) WHERE status = 'pending' AND role = 'assistant';
CREATE INDEX chat_turns_project ON chat_turns (project_key);
