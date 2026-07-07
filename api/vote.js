// Vercel serverless function — HFFA PAC Board vote submission.
// Replaces the old Netlify Forms backend; votes are stored in Upstash Redis
// under the `pac:` key prefix (same Upstash instance as mauifirepulse is fine).
const crypto = require("crypto");

// Flood cap per network (hashed IP) per window. Set generously ON PURPOSE:
// firefighters vote from shared station Wi-Fi, so many legitimate ballots arrive
// from ONE public IP. A low cap silently locked out real voters (the 6th person
// on a station got a 429). This still stops a runaway script hammering the
// endpoint. ponytail: bump higher, or move to a per-member token, if a large
// shared network ever legitimately exceeds it.
const RL_LIMIT = 100; // max submissions per network (hashed IP) per window
const RL_WINDOW = 3600; // seconds

// Atomic increment-with-expiry: INCR the key and, only on first creation, set its
// TTL — all in one server-side script so a failed EXPIRE can't leave the counter
// without expiry (which would block that network forever). Returns the new count.
const RL_SCRIPT =
  "local c = redis.call('INCR', KEYS[1]); if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return c";

// Shared member access gate. Read ONLY from env — no hardcoded fallback. If the
// env var is not set, voting is refused (fail-closed) rather than accepting votes
// against a guessable default. Tanner sets VOTE_PASSWORD in the Vercel env vars.
const VOTE_PASSWORD = process.env.VOTE_PASSWORD || "";

const redis = async (...args) => {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  return data.result;
};

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

  // Member access gate. The form sends the password as a header both when
  // unlocking (GET ?check=1) and on the actual vote submit. Fail-closed if the
  // gate password was never configured — refuse rather than accept any vote.
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

  if (
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN
  ) {
    return res
      .status(500)
      .json({ error: "Storage not configured. Add Upstash env vars in Vercel." });
  }

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

  // One Approve/Deny per candidate. Bound the array so a single request can't
  // be used to dump arbitrary data into storage.
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

  // Generous per-network flood cap. FAIL-CLOSED — if the limiter can't be checked
  // (Redis error) we reject the vote rather than accept an unthrottled one.
  // INCR + EXPIRE run in ONE atomic Lua script so a dropped EXPIRE can never leave a
  // counter without a TTL (which would permanently block that network).
  try {
    const rlKey = `pac:rl:${ipHash(clientIp(req))}`;
    const count = await redis("EVAL", RL_SCRIPT, "1", rlKey, String(RL_WINDOW));
    if (typeof count === "number" && count > RL_LIMIT) {
      return res.status(429).json({
        error: "Too many submissions from this network. Please try again later.",
      });
    }
  } catch (e) {
    console.error("Rate-limit check failed (rejecting vote):", e);
    return res.status(503).json({ error: "Service temporarily unavailable. Please try again shortly." });
  }

  try {
    const key = `pac:vote:${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    await redis(
      "SET",
      key,
      JSON.stringify({
        voterName,
        votes: votes.map((v) => ({
          division: v.division || "",
          name: v.name,
          district: v.district || "",
          vote: v.vote,
        })),
        ts: new Date().toISOString(),
      }),
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Vote submit error:", err);
    return res.status(500).json({ error: "Could not record your vote. Please try again." });
  }
};
