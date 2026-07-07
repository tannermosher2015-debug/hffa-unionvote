// Vercel serverless function — returns total ballot count (member-visible).
// Authenticated with the member vote password so only logged-in members can see
// how many ballots have been cast. Does NOT expose per-candidate tallies.
const { neon } = require("@neondatabase/serverless");

const VOTE_PASSWORD = process.env.VOTE_PASSWORD || "";
const DB_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  "";
const sql = DB_URL ? neon(DB_URL) : null;

async function ensureSchema() {
  await sql`CREATE TABLE IF NOT EXISTS choices (
    id BIGSERIAL PRIMARY KEY,
    votes JSONB NOT NULL
  )`;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!VOTE_PASSWORD)
    return res.status(500).json({ error: "Not configured." });

  const provided = req.headers["x-vote-pass"] || "";
  if (provided !== VOTE_PASSWORD)
    return res.status(401).json({ error: "Unauthorized." });

  if (!sql)
    return res.status(500).json({ error: "Storage not configured." });

  try {
    await ensureSchema();
    const r = await sql`SELECT count(*)::int AS n FROM choices`;
    return res.status(200).json({ count: r[0] ? r[0].n : 0 });
  } catch (err) {
    console.error("Count error:", err);
    return res.status(500).json({ error: "Could not load count." });
  }
};
