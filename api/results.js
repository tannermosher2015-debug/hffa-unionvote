// Vercel serverless function — HFFA PAC Board vote results (Neon Postgres).
// Results are intentionally OPEN (no password). SECRET BALLOT: turnout (who voted)
// comes from the `voters` table and the tally comes from the anonymous `choices`
// table — the two are never joined, so the response can show WHO voted and the
// aggregate Yes/No counts, but never HOW any individual voted.
const { neon } = require("@neondatabase/serverless");

const DB_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  "";
const sql = DB_URL ? neon(DB_URL) : null;

async function ensureSchema() {
  await sql`CREATE TABLE IF NOT EXISTS voters (
    id BIGSERIAL PRIMARY KEY,
    voter_name TEXT NOT NULL,
    ip_hash TEXT,
    ts TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS choices (
    id BIGSERIAL PRIMARY KEY,
    votes JSONB NOT NULL
  )`;
}

// Aggregate every anonymous ballot's per-candidate votes into one Approve/Deny
// tally per candidate, preserving first-seen order within each division.
const tallyCandidates = (ballots) => {
  const map = new Map();
  for (const b of ballots) {
    for (const v of b.votes || []) {
      const key = (v.division || "") + "||" + v.name;
      let c = map.get(key);
      if (!c) {
        c = { division: v.division || "", name: v.name, district: v.district || "", Approve: 0, Deny: 0 };
        map.set(key, c);
      }
      if (v.vote === "Approve") c.Approve++;
      else if (v.vote === "Deny") c.Deny++;
    }
  }
  return [...map.values()];
};

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!sql)
    return res.status(500).json({ error: "Storage not configured." });

  try {
    await ensureSchema();
    // Two independent reads, never joined.
    const voterRows = await sql`SELECT voter_name, ts FROM voters ORDER BY ts DESC`;
    const choiceRows = await sql`SELECT votes FROM choices`;

    const ballots = choiceRows.map((r) => ({ votes: r.votes || [] }));

    return res.status(200).json({
      total: choiceRows.length,
      candidates: tallyCandidates(ballots),
      voters: voterRows.map((v) => ({ name: v.voter_name, ts: v.ts })),
    });
  } catch (err) {
    console.error("Results error:", err);
    return res.status(500).json({ error: "Could not load results. Please try again." });
  }
};
