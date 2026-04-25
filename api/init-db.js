// api/init-db.js — One-time database setup. Call once after deploy.
// curl -X POST https://YOUR-APP.vercel.app/api/init-db -H "x-admin-password: YOUR_PASSWORD"

import { initDatabase } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminPassword = req.headers['x-admin-password'];
  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await initDatabase();
    return res.status(200).json(result);
  } catch (err) {
    console.error('DB init error:', err);
    return res.status(500).json({ error: err.message });
  }
}
