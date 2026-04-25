// api/stats.js — Quick stats endpoint for monitoring usage during fieldwork
// /api/stats?password=YOUR_PASSWORD

import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  const password = req.query.password || req.headers['x-admin-password'];
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [{ rows: totals }, { rows: byStudent }, { rows: tokens }, { rows: compression }] = await Promise.all([
      sql`SELECT
            (SELECT COUNT(DISTINCT student_id) FROM sessions) AS unique_students,
            (SELECT COUNT(*) FROM sessions) AS total_sessions,
            (SELECT COUNT(*) FROM messages) AS total_messages,
            (SELECT COUNT(*) FROM messages WHERE role='user') AS user_messages,
            (SELECT COUNT(*) FROM messages WHERE role='assistant') AS assistant_messages;`,
      sql`SELECT student_id, COUNT(*) AS message_count, MIN(created_at) AS first_msg, MAX(created_at) AS last_msg
          FROM messages
          GROUP BY student_id
          ORDER BY message_count DESC
          LIMIT 50;`,
      sql`SELECT
            COALESCE(SUM(tokens_prompt), 0)::bigint AS total_prompt_tokens,
            COALESCE(SUM(tokens_completion), 0)::bigint AS total_completion_tokens
          FROM messages;`,
      sql`SELECT
            COUNT(*)::int AS sessions_compressed,
            COALESCE(SUM(compression_count), 0)::int AS total_compressions,
            COALESCE(SUM(tokens_used), 0)::bigint AS summarizer_tokens_used
          FROM summaries;`,
    ]);

    const t = tokens[0];
    const c = compression[0];
    // gpt-5.4-mini pricing (April 2026): $0.75/M input, $4.50/M output
    // gpt-5.4-nano pricing: $0.20/M input, $1.25/M output (used for summarizer)
    // Note: tokens in `messages` are mini calls; summarizer tokens are separate.
    const miniCost =
      (Number(t.total_prompt_tokens) / 1_000_000) * 0.75 +
      (Number(t.total_completion_tokens) / 1_000_000) * 4.5;
    // Rough estimate for nano: assume 80/20 input/output split
    const nanoTokens = Number(c.summarizer_tokens_used);
    const nanoCost = (nanoTokens * 0.8 / 1_000_000) * 0.20 + (nanoTokens * 0.2 / 1_000_000) * 1.25;
    const estCost = miniCost + nanoCost;

    return res.status(200).json({
      totals: totals[0],
      tokens: {
        prompt: Number(t.total_prompt_tokens),
        completion: Number(t.total_completion_tokens),
        summarizer: nanoTokens,
        estimated_cost_usd: Number(estCost.toFixed(4)),
        breakdown: {
          mini_cost_usd: Number(miniCost.toFixed(4)),
          nano_cost_usd: Number(nanoCost.toFixed(4)),
        },
      },
      compression: {
        sessions_compressed: c.sessions_compressed,
        total_compression_events: c.total_compressions,
      },
      top_students: byStudent,
    });
  } catch (err) {
    console.error('Stats error:', err);
    return res.status(500).json({ error: err.message });
  }
}
