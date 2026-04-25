// api/export.js — Admin-only endpoint to download chat logs as .txt
// Usage examples:
//   /api/export?password=YOUR_PASSWORD                       (all logs, all students)
//   /api/export?password=YOUR_PASSWORD&studentId=STU001      (one student)
//   /api/export?password=YOUR_PASSWORD&format=csv            (CSV instead of TXT)
//   /api/export?password=YOUR_PASSWORD&since=2026-06-01      (only after this date)

import { sql } from '@vercel/postgres';

function escapeCsv(s) {
  if (s == null) return '';
  const str = String(s);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export default async function handler(req, res) {
  const password = req.query.password || req.headers['x-admin-password'];
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { studentId, format = 'txt', since } = req.query;

  try {
    let rows;
    if (studentId && since) {
      ({ rows } = await sql`
        SELECT m.id, m.student_id, m.session_id, m.role, m.content,
               m.tokens_prompt, m.tokens_completion, m.model, m.created_at
        FROM messages m
        WHERE m.student_id = ${studentId} AND m.created_at >= ${since}
        ORDER BY m.student_id, m.session_id, m.created_at ASC;
      `);
    } else if (studentId) {
      ({ rows } = await sql`
        SELECT m.id, m.student_id, m.session_id, m.role, m.content,
               m.tokens_prompt, m.tokens_completion, m.model, m.created_at
        FROM messages m
        WHERE m.student_id = ${studentId}
        ORDER BY m.session_id, m.created_at ASC;
      `);
    } else if (since) {
      ({ rows } = await sql`
        SELECT m.id, m.student_id, m.session_id, m.role, m.content,
               m.tokens_prompt, m.tokens_completion, m.model, m.created_at
        FROM messages m
        WHERE m.created_at >= ${since}
        ORDER BY m.student_id, m.session_id, m.created_at ASC;
      `);
    } else {
      ({ rows } = await sql`
        SELECT m.id, m.student_id, m.session_id, m.role, m.content,
               m.tokens_prompt, m.tokens_completion, m.model, m.created_at
        FROM messages m
        ORDER BY m.student_id, m.session_id, m.created_at ASC;
      `);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (format === 'csv') {
      const header = 'message_id,student_id,session_id,role,timestamp,model,tokens_prompt,tokens_completion,content\n';
      const body = rows
        .map((r) =>
          [
            r.id,
            escapeCsv(r.student_id),
            escapeCsv(r.session_id),
            r.role,
            new Date(r.created_at).toISOString(),
            escapeCsv(r.model || ''),
            r.tokens_prompt ?? '',
            r.tokens_completion ?? '',
            escapeCsv(r.content),
          ].join(',')
        )
        .join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="chatlogs-${stamp}.csv"`);
      return res.status(200).send(header + body);
    }

    // TXT format — human-readable, grouped by student then session
    let out = `# The Solitary Learner? — Chat Log Export\n`;
    out += `# Generated: ${new Date().toISOString()}\n`;
    out += `# Total messages: ${rows.length}\n`;
    if (studentId) out += `# Filter: studentId = ${studentId}\n`;
    if (since) out += `# Filter: since = ${since}\n`;
    out += `# Format: [timestamp] STUDENT_ID | SESSION_ID | ROLE: content\n`;
    out += `# Note: full raw messages below; bot context summaries (if any) appended at end of each session.\n`;
    out += `# ============================================================\n\n`;

    // Pre-fetch all summaries for the sessions we're exporting (for context appendix)
    const sessionIdsInExport = [...new Set(rows.map((r) => r.session_id))];
    let summariesBySession = {};
    if (sessionIdsInExport.length > 0) {
      const { rows: summaryRows } = await sql`
        SELECT session_id, summary_text, last_summarized_message_id, compression_count, updated_at
        FROM summaries
        WHERE session_id = ANY(${sessionIdsInExport});
      `;
      summariesBySession = Object.fromEntries(summaryRows.map((s) => [s.session_id, s]));
    }

    let lastStudent = null;
    let lastSession = null;
    for (const r of rows) {
      if (r.student_id !== lastStudent) {
        out += `\n\n========== STUDENT: ${r.student_id} ==========\n`;
        lastStudent = r.student_id;
        lastSession = null;
      }
      if (r.session_id !== lastSession) {
        // Close out previous session with its summary if applicable
        if (lastSession && summariesBySession[lastSession]) {
          const s = summariesBySession[lastSession];
          out += `\n\n--- BOT MEMORY SUMMARY for session ${lastSession} ---\n`;
          out += `(compressed ${s.compression_count} time(s), last updated ${new Date(s.updated_at).toISOString()})\n`;
          out += `${s.summary_text}\n`;
        }
        out += `\n--- SESSION: ${r.session_id} ---\n`;
        lastSession = r.session_id;
      }
      const ts = new Date(r.created_at).toISOString();
      const tokenInfo =
        r.role === 'assistant' && (r.tokens_prompt || r.tokens_completion)
          ? ` (prompt=${r.tokens_prompt}, completion=${r.tokens_completion})`
          : '';
      out += `\n[${ts}] ${r.role.toUpperCase()}${tokenInfo}:\n${r.content}\n`;
    }
    // Final session's summary
    if (lastSession && summariesBySession[lastSession]) {
      const s = summariesBySession[lastSession];
      out += `\n\n--- BOT MEMORY SUMMARY for session ${lastSession} ---\n`;
      out += `(compressed ${s.compression_count} time(s), last updated ${new Date(s.updated_at).toISOString()})\n`;
      out += `${s.summary_text}\n`;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chatlogs-${stamp}.txt"`);
    return res.status(200).send(out);
  } catch (err) {
    console.error('Export error:', err);
    return res.status(500).json({ error: err.message });
  }
}
