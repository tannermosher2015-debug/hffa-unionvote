// Vercel serverless function — HFFA PAC Board vote results (password-gated).
// Replaces the Netlify Forms dashboard: returns every vote plus running tallies.
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

  if (
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN
  ) {
    return res.status(500).json({ error: "Storage not configured." });
  }

  // Password gate (FAIL-CLOSED). If RESULTS_PASSWORD is not configured, refuse to
  // serve the tally rather than exposing every vote publicly. Once set, the caller
  // must present the matching x-results-pass header.
  const required = process.env.RESULTS_PASSWORD;
  if (!required) {
    return res.status(500).json({ error: "Results are not configured yet." });
  }
  const provided =
    req.headers["x-results-pass"] || req.headers["X-Results-Pass"] || "";
  if (provided !== required) {
    return res
      .status(401)
      .json({ error: "Enter the results password to view the tally." });
  }

  // Lightweight credential check for the login screen (no payload).
  if (req.query && req.query.check) {
    return res.status(200).json({ ok: true });
  }

  try {
    const keys = await redis("KEYS", "pac:vote:*");
    const ballots =
      keys && keys.length
        ? (await redis("MGET", ...keys))
            .filter(Boolean)
            .map((v) => {
              try {
                return JSON.parse(v);
              } catch {
                return null;
              }
            })
            .filter(Boolean)
            .sort((a, b) => (a.ts < b.ts ? 1 : -1))
        : [];

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
