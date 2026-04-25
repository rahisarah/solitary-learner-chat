// api/chat.js — Main chat endpoint with rolling summary compression
// - API key lives in env var OPENAI_API_KEY (server-side only)
// - Memory strategy:
//     * Up to MEMORY_THRESHOLD (50) messages: send everything verbatim
//     * Above that: send [running summary of older messages] + [most recent KEEP_RECENT verbatim]
//     * Summary is updated when the verbatim window grows past MEMORY_THRESHOLD again
// - Every user + assistant message is logged to Postgres regardless of compression.
//   Compression ONLY affects what's sent to OpenAI; raw logs are preserved for research.

import OpenAI from 'openai';
import { sql } from '@vercel/postgres';
import crypto from 'crypto';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = 'gpt-5.4-mini';
const SUMMARIZER_MODEL = 'gpt-5.4-nano'; // cheaper model for summarization
const MEMORY_THRESHOLD = 50;  // start compressing once total messages exceed this
const KEEP_RECENT = 20;       // how many most-recent messages to keep verbatim after compressing
const MAX_MESSAGE_LENGTH = 4000;

const SYSTEM_PROMPT = `You are a helpful Python and data science tutor assisting undergraduate students in a 2-day Python data science workshop in Kolkata, India. Help them understand concepts, debug code, and work through exercises. Be encouraging, clear, and pedagogical. When students ask about concepts, explain them step by step. When they share code, help them think through what's wrong rather than just giving answers when possible.`;

const SUMMARIZER_PROMPT = `You are summarizing a tutoring conversation between a Python student and an AI tutor so the tutor can remember context across a long session. Produce a compact summary (under 250 words) that preserves:
- What topics/concepts the student has worked on
- Specific code, errors, or examples that came up
- The student's current level of understanding and any misconceptions noted
- Any ongoing exercise or problem they were working on
- Important preferences or context the student shared

Write in third-person notes form. Be specific (mention variable names, error types, libraries). Skip pleasantries and small talk. If a previous summary is provided, integrate it — keep older context in compressed form, expand on newer developments.`;

function hashIp(ip) {
  return crypto.createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 16);
}

function validateStudentId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{3,32}$/.test(id);
}

function validateSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

/**
 * If conversation has grown past MEMORY_THRESHOLD, compress older messages into a summary.
 * Idempotent: if there's nothing new to summarize, does nothing.
 *
 * Returns: { summaryText|null, lastSummarizedId|0 }
 */
async function maybeCompress(sessionId) {
  // 1. Count total messages in session
  const { rows: countRows } = await sql`
    SELECT COUNT(*)::int AS n
    FROM messages WHERE session_id = ${sessionId};
  `;
  const totalMessages = countRows[0].n;

  // 2. Load existing summary if any
  const { rows: sumRows } = await sql`
    SELECT summary_text, last_summarized_message_id, compression_count
    FROM summaries WHERE session_id = ${sessionId};
  `;
  const existingSummary = sumRows[0] || null;

  // 3. If under threshold, no compression needed
  if (totalMessages <= MEMORY_THRESHOLD) {
    return {
      summaryText: existingSummary?.summary_text || null,
      lastSummarizedId: existingSummary?.last_summarized_message_id || 0,
    };
  }

  // 4. Determine which messages to fold into the summary.
  //    We want to keep KEEP_RECENT most recent messages verbatim.
  //    Everything else goes into summary.
  const lastSummarizedId = existingSummary?.last_summarized_message_id || 0;

  // Find the boundary: keep only the most recent KEEP_RECENT verbatim
  const { rows: boundaryRows } = await sql`
    SELECT id FROM messages
    WHERE session_id = ${sessionId}
    ORDER BY id DESC
    OFFSET ${KEEP_RECENT - 1} LIMIT 1;
  `;
  if (boundaryRows.length === 0) {
    return {
      summaryText: existingSummary?.summary_text || null,
      lastSummarizedId,
    };
  }
  const newCutoffId = boundaryRows[0].id;
  // Messages with id < newCutoffId go into the summary; id >= newCutoffId stay verbatim

  // 5. If nothing new to summarize since last time, return existing summary as-is
  if (newCutoffId <= lastSummarizedId + 1) {
    return {
      summaryText: existingSummary?.summary_text || null,
      lastSummarizedId,
    };
  }

  // 6. Fetch messages to summarize (after last summary, before the new cutoff)
  const { rows: toSummarize } = await sql`
    SELECT role, content
    FROM messages
    WHERE session_id = ${sessionId}
      AND id > ${lastSummarizedId}
      AND id < ${newCutoffId}
    ORDER BY id ASC;
  `;

  if (toSummarize.length === 0) {
    return {
      summaryText: existingSummary?.summary_text || null,
      lastSummarizedId,
    };
  }

  // 7. Build summarizer input
  const transcript = toSummarize
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  const summarizerInput = existingSummary
    ? `PREVIOUS SUMMARY (covers earlier part of session):\n${existingSummary.summary_text}\n\nNEW MESSAGES TO INTEGRATE:\n${transcript}\n\nProduce an updated summary integrating the previous summary with these new messages.`
    : `MESSAGES TO SUMMARIZE:\n${transcript}\n\nProduce a summary.`;

  // 8. Call summarizer
  let newSummary;
  let tokensUsed = null;
  try {
    const completion = await openai.chat.completions.create({
      model: SUMMARIZER_MODEL,
      messages: [
        { role: 'system', content: SUMMARIZER_PROMPT },
        { role: 'user', content: summarizerInput },
      ],
    });
    newSummary = completion.choices?.[0]?.message?.content?.trim() || '';
    tokensUsed = (completion.usage?.prompt_tokens || 0) + (completion.usage?.completion_tokens || 0);
  } catch (err) {
    console.error('Summarization failed, falling back to existing summary:', err);
    // Soft-fail: if summarizer is down, just keep existing summary and don't update cutoff.
    return {
      summaryText: existingSummary?.summary_text || null,
      lastSummarizedId,
    };
  }

  if (!newSummary) {
    return {
      summaryText: existingSummary?.summary_text || null,
      lastSummarizedId,
    };
  }

  // 9. Persist new summary
  const newLastId = newCutoffId - 1;
  const newCompressionCount = (existingSummary?.compression_count || 0) + 1;
  await sql`
    INSERT INTO summaries (session_id, summary_text, last_summarized_message_id, compression_count, tokens_used, updated_at)
    VALUES (${sessionId}, ${newSummary}, ${newLastId}, ${newCompressionCount}, ${tokensUsed}, NOW())
    ON CONFLICT (session_id)
    DO UPDATE SET
      summary_text = EXCLUDED.summary_text,
      last_summarized_message_id = EXCLUDED.last_summarized_message_id,
      compression_count = EXCLUDED.compression_count,
      tokens_used = EXCLUDED.tokens_used,
      updated_at = NOW();
  `;

  return { summaryText: newSummary, lastSummarizedId: newLastId };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { studentId, sessionId, message } = req.body || {};

    if (!validateStudentId(studentId)) return res.status(400).json({ error: 'Invalid student ID' });
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });
    if (typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} chars)` });
    }

    const userAgent = req.headers['user-agent'] || '';
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '';
    const ipHash = hashIp(ip);

    // Upsert session
    await sql`
      INSERT INTO sessions (student_id, session_id, user_agent, ip_hash)
      VALUES (${studentId}, ${sessionId}, ${userAgent}, ${ipHash})
      ON CONFLICT (session_id)
      DO UPDATE SET last_active_at = NOW();
    `;

    // Log user message immediately (full fidelity, always)
    await sql`
      INSERT INTO messages (session_id, student_id, role, content)
      VALUES (${sessionId}, ${studentId}, 'user', ${message});
    `;

    // Compress if needed
    const { summaryText, lastSummarizedId } = await maybeCompress(sessionId);

    // Fetch verbatim messages: everything after the last summarized id
    const { rows: recent } = await sql`
      SELECT role, content
      FROM messages
      WHERE session_id = ${sessionId} AND id > ${lastSummarizedId}
      ORDER BY id ASC;
    `;

    // Build the message array to send to OpenAI:
    //   [system prompt]
    //   [optional summary as a system message]
    //   [recent messages verbatim]
    const apiMessages = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (summaryText) {
      apiMessages.push({
        role: 'system',
        content: `Earlier conversation summary (for your context — the student does not see this):\n\n${summaryText}`,
      });
    }
    for (const r of recent) {
      apiMessages.push({ role: r.role, content: r.content });
    }

    // Call main model
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: apiMessages,
    });

    const assistantMessage = completion.choices?.[0]?.message?.content || '';
    const usage = completion.usage || {};

    // Log assistant reply
    await sql`
      INSERT INTO messages (session_id, student_id, role, content, tokens_prompt, tokens_completion, model)
      VALUES (${sessionId}, ${studentId}, 'assistant', ${assistantMessage},
              ${usage.prompt_tokens || null}, ${usage.completion_tokens || null}, ${MODEL});
    `;

    return res.status(200).json({
      reply: assistantMessage,
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
      },
      memory: {
        compressed: summaryText !== null,
        verbatim_messages: recent.length,
      },
    });
  } catch (err) {
    console.error('Chat error:', err);
    return res.status(500).json({
      error: 'Something went wrong. Please try again.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
}
