// lib/db.js — Database schema initialization
// Run this once after deployment by hitting /api/init-db with admin password

import { sql } from '@vercel/postgres';

export async function initDatabase() {
  // Sessions table — one row per (student_id, session_start)
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      student_id VARCHAR(64) NOT NULL,
      session_id VARCHAR(64) NOT NULL UNIQUE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_agent TEXT,
      ip_hash VARCHAR(64)
    );
  `;

  // Messages table — every user/assistant message logged
  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(64) NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      student_id VARCHAR(64) NOT NULL,
      role VARCHAR(16) NOT NULL,
      content TEXT NOT NULL,
      tokens_prompt INTEGER,
      tokens_completion INTEGER,
      model VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  // Summaries table — one row per session, updated as conversation grows.
  // last_summarized_message_id = the id of the most recent message included in the summary.
  // Anything with id > that is "fresh" and sent verbatim.
  await sql`
    CREATE TABLE IF NOT EXISTS summaries (
      session_id VARCHAR(64) PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      summary_text TEXT NOT NULL,
      last_summarized_message_id INTEGER NOT NULL,
      compression_count INTEGER NOT NULL DEFAULT 1,
      tokens_used INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  // Indexes for fast export queries
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_student ON messages(student_id, created_at);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id);`;

  return { ok: true };
}
