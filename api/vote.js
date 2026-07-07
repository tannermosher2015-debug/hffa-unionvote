// Vercel serverless function — HFFA PAC Board vote submission (Neon Postgres).
// Ballots are stored one row per submission in the `ballots` table.
const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

// Flood cap per network (hashed IP) per window. Set generously ON PURPOSE:
// firefighters vote from shared station Wi-Fi, so many legitimate ballots arrive
// from ONE public IP. A low cap silently locked out real voters. This still stops
// a runaway script. ponytail: raise, or move to a per-member token, if a large
// shared network ever legitimately exceeds it.
const RL_LIMIT = 100;      // max ballots per network (hashed IP) per window
const RL_WINDOW_MIN = 60;  // minutes

// Shared member access gate. Read ONLY from env — fail-closed if unset so we never
// accept votes against a guessable default. Set VOTE_PASSWORD in the Vercel env.
const VOTE_PASSWORD = process.env.VOTE_PASSWORD || "";

// Neon connection string is injected by the Vercel–Neon integration.
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

const clientIp = (req) => {
  const h = req.headers;
  return (
    (h["x-forwarded-for"] || "").split(",")[0].trim() ||
    h["x-real-ip"] ||
    "unknown"
  );
};
const ipHash = (ip) =>
  crypto.createHash("sha256").update("pac:" + ip).digest("hex").slice(0, 16);

const VOTES = ["Approve", "Deny"];

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();

  // Member access gate. Fail-closed if the gate password was never configured.
  if (!VOTE_PASSWORD)
    return res.status(500).json({ error: "Voting is not configured yet." });
  const provided = req.headers["x-vote-pass"] || "";
  if (provided !== VOTE_PASSWORD)
    return res.status(401).json({ error: "Incorrect access password." });

  // Lightweight unlock check for the gate screen — no vote payload to store.
  if (req.query && req.query.check)
    return res.status(200).json({ ok: true });

  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  if (!sql)
    return res.status(500).json({ error: "Storage not configured. Add a Neon database in Vercel." });

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
  }
  body = body || {};

  // Honeypot: a filled bot-field means a bot. Pretend success, store nothing.
  if (body.botField) return res.status(200).json({ success: true });

  const voterName =
    typeof body.voterName === "string" ? body.voterName.trim() : "";
  if (!voterName || voterName.length > 120) {
    return res.status(400).json({ error: "A valid name is required" });
  }

  // One Approve/Deny per candidate. Bound the array so a single request can't be
  // used to dump arbitrary data into storage.
  const votes = Array.isArray(body.votes) ? body.votes : null;
  if (!votes || votes.length < 1 || votes.length > 100) {
    return res.status(400).json({ error: "A vote on every candidate is required" });
  }
  for (const v of votes) {
    const okStr = (s, max) => typeof s === "string" && s.length > 0 && s.length <= max;
    if (
      !v ||
      !okStr(v.name, 120) ||
      !VOTES.includes(v.vote) ||
      (v.division != null && (typeof v.division !== "string" || v.division.length > 60)) ||
      (v.district != null && (typeof v.district !== "string" || v.district.length > 120))
    ) {
      return res.status(400).json({ error: "Invalid ballot" });
    }
  }

  const clean = votes.map((v) => ({
    division: v.division || "",
    name: v.name,
    district: v.district || "",
    vote: v.vote,
  }));
  const h = ipHash(clientIp(req));

  try {
    await ensureTable();

    // Generous per-network flood cap. ponytail: count-then-insert has a tiny race
    // under heavy concurrency; acceptable for a members-only ballot.
    const rl = await sql`
      SELECT count(*)::int AS n FROM ballots
      WHERE ip_hash = ${h} AND ts > now() - make_interval(mins => ${RL_WINDOW_MIN})`;
    if (rl[0] && rl[0].n >= RL_LIMIT) {
      return res.status(429).json({
        error: "Too many submissions from this network. Please try again later.",
      });
    }

    await sql`
      INSERT INTO ballots (voter_name, votes, ip_hash)
      VALUES (${voterName}, ${JSON.stringify(clean)}::jsonb, ${h})`;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Vote submit error:", err);
    return res.status(500).json({ error: "Could not record your vote. Please try again." });
  }
};
