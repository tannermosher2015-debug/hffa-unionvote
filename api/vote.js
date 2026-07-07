// Vercel serverless function — HFFA PAC Board vote submission (Neon Postgres).
// SECRET BALLOT: WHO voted and HOW they voted are stored in two separate tables
// with NO column linking them:
//   voters  — voter_name + ip_hash + ts   (turnout: confirms everyone voted)
//   choices — votes jsonb                  (anonymous ballot: no name, no time)
// Nothing in the app, the API, or the schema ties a name to a set of choices.
const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

// Flood cap per network (hashed IP) per window. Set generously ON PURPOSE:
// firefighters vote from shared station Wi-Fi, so many legitimate ballots arrive
// from ONE public IP. A low cap silently locked out real voters. This still stops
// a runaway script. ponytail: raise, or move to a per-member token, if a large
// shared network ever legitimately exceeds it.
const RL_LIMIT = 100;      // max ballots per network (hashed IP) per window
const RL_WINDOW_MIN = 60;  // minutes

const VOTE_PASSWORD = process.env.VOTE_PASSWORD || "";

// Voting deadline: 10:00 AM HST, Thursday, July 9, 2026 (HST = UTC-10, no DST).
// Also shown/enforced client-side in index.html — keep the two in sync.
const DEADLINE_MS = Date.UTC(2026, 6, 9, 20, 0, 0);

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
  // One-time cleanup: the old `ballots` table stored voter_name + votes in the same
  // row (pre-secret-ballot). Nothing writes to it now, so DROP IF EXISTS is a safe
  // no-op after the first request and removes the last name↔vote linkage.
  await sql`DROP TABLE IF EXISTS ballots`;
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

  if (!VOTE_PASSWORD)
    return res.status(500).json({ error: "Voting is not configured yet." });
  const provided = req.headers["x-vote-pass"] || "";
  if (provided !== VOTE_PASSWORD)
    return res.status(401).json({ error: "Incorrect access password." });

  if (req.query && req.query.check)
    return res.status(200).json({ ok: true });

  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  if (Date.now() >= DEADLINE_MS)
    return res.status(403).json({ error: "Voting closed at 10:00 AM HST on Thursday, July 9." });

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
    await ensureSchema();

    // Generous per-network flood cap (turnout table carries the ip_hash).
    const rl = await sql`
      SELECT count(*)::int AS n FROM voters
      WHERE ip_hash = ${h} AND ts > now() - make_interval(mins => ${RL_WINDOW_MIN})`;
    if (rl[0] && rl[0].n >= RL_LIMIT) {
      return res.status(429).json({
        error: "Too many submissions from this network. Please try again later.",
      });
    }

    // Record turnout and the anonymous ballot atomically (both-or-neither, so the
    // turnout list and the tally can't drift). The two rows share no key, name, or
    // timestamp — the choices row carries only the votes.
    await sql.transaction([
      sql`INSERT INTO voters (voter_name, ip_hash) VALUES (${voterName}, ${h})`,
      sql`INSERT INTO choices (votes) VALUES (${JSON.stringify(clean)}::jsonb)`,
    ]);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Vote submit error:", err);
    return res.status(500).json({ error: "Could not record your vote. Please try again." });
  }
};
