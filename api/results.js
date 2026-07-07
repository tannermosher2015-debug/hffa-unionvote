// Vercel serverless function — HFFA PAC Board vote results (Neon Postgres).
// Results are intentionally OPEN (no password): the tally and voter list are
// viewable by anyone with the link. The page is noindex/nofollow so it is not
// crawled, but it is not access-controlled. This was a deliberate choice.
const { neon } = require("@neondatabase/serverless");

const DB_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  "";
const sql = DB_URL ? neon(DB_URL) : null;

async function ensureTable() {
  await sql`CREATE TABLE IF NOT EXISTS ballots (
    id BIGSERIAL PRIMARY KEY,
    voter_name TEXT NOT NULL,
    votes JSONB NOT NULL,
    ip_hash TEXT,
    ts TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
}

// Aggregate every ballot's per-candidate votes into one Approve/Deny tally per
// candidate, preserving first-seen order within each division.
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
    await ensureTable();
    const rows = await sql`
      SELECT voter_name, votes, ts FROM ballots ORDER BY ts DESC`;
    const ballots = rows.map((r) => ({
      voterName: r.voter_name,
      votes: r.votes || [],
      ts: r.ts,
    }));

    return res.status(200).json({
      total: ballots.length,
      candidates: tallyCandidates(ballots),
      voters: ballots.map((b) => ({ name: b.voterName, ts: b.ts })),
    });
  } catch (err) {
    console.error("Results error:", err);
    return res.status(500).json({ error: "Could not load results. Please try again." });
  }
};
