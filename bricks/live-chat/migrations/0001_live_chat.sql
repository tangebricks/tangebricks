-- live-chat 0001: Support conversations, messages, and canned replies
-- Modular: No cross-brick foreign key on workspace_id or user_id.
-- Prefixed with chat_ to avoid schema collision.

CREATE TABLE IF NOT EXISTS chat_conversations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  customer_id TEXT NOT NULL CHECK (length(customer_id) <= 128),
  customer_email TEXT CHECK (customer_email IS NULL OR length(customer_email) <= 255),
  customer_name TEXT CHECK (customer_name IS NULL OR length(customer_name) <= 100),
  assigned_agent_id TEXT CHECK (assigned_agent_id IS NULL OR length(assigned_agent_id) <= 128),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'resolved', 'closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'urgent')),
  channel TEXT NOT NULL DEFAULT 'widget' CHECK (channel IN ('widget', 'email', 'in_app')),
  last_message_preview TEXT CHECK (last_message_preview IS NULL OR length(last_message_preview) <= 255),
  last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS chat_conv_ws_status_idx ON chat_conversations(workspace_id, status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'agent', 'bot', 'system')),
  sender_id TEXT NOT NULL CHECK (length(sender_id) <= 128),
  sender_name TEXT NOT NULL CHECK (length(sender_name) <= 100),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8192),
  attachments_json TEXT NOT NULL DEFAULT '[]' CHECK (length(attachments_json) <= 2048),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS chat_messages_conv_idx ON chat_messages(conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS chat_canned_replies (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  shortcut TEXT NOT NULL CHECK (length(shortcut) BETWEEN 1 AND 32),
  title TEXT NOT NULL CHECK (length(title) <= 100),
  content TEXT NOT NULL CHECK (length(content) <= 4096),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, shortcut)
);
