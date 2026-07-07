// Vercel serverless function — returns total ballot count (member-visible).
// Authenticated with the member vote password so only logged-in members can
// see how many ballots have been cast. Does NOT expose per-candidate tallies.
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

const VOTE_PASSWORD = process.env.VOTE_PASSWORD || "";

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!VOTE_PASSWORD)
    return res.status(500).json({ error: "Not configured." });

  const provided = req.headers["x-vote-pass"] || "";
  if (provided !== VOTE_PASSWORD)
    return res.status(401).json({ error: "Unauthorized." });

  if (
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN
  )
    return res.status(500).json({ error: "Storage not configured." });

  try {
    const keys = await redis("KEYS", "pac:vote:*");
    return res.status(200).json({ count: keys ? keys.length : 0 });
  } catch (err) {
    console.error("Count error:", err);
    return res.status(500).json({ error: "Could not load count." });
  }
};
