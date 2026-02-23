import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20mb" }));

// --------------------
// CORS
// --------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --------------------
// Health
// --------------------
app.get("/", (req, res) => {
  res.send("BIM Auth & Intelligence Backend Running");
});

// --------------------
// APS Token
// --------------------
app.get("/api/auth/token", async (req, res) => {
  try {
    const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
    const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;

    if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
      return res.status(500).json({ error: "Missing APS_CLIENT_ID or APS_CLIENT_SECRET" });
    }

    const response = await fetch(
      "https://developer.api.autodesk.com/authentication/v2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: APS_CLIENT_ID,
          client_secret: APS_CLIENT_SECRET,
          scope: "data:read data:write data:create bucket:create bucket:read",
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Token generation failed", details: String(err) });
  }
});

// --------------------
// Helpers
// --------------------
function norm(s) {
  return String(s ?? "").toLowerCase().trim();
}

function contains(hay, needle) {
  return norm(hay).includes(norm(needle));
}

function safeNumber(v) {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x) ?? "Unknown";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;

  try {
    const direct = JSON.parse(text);
    if (direct && typeof direct === "object") return direct;
  } catch {}

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

async function fetchWithRetry(url, options, retries = 5) {
  let delay = 800;
  let lastErrText = "";

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;

      const errText = await res.text().catch(() => "");
      lastErrText = `HTTP ${res.status}: ${errText || res.statusText}`;

      if (!(res.status === 429 || (res.status >= 500 && res.status <= 599))) {
        throw new Error(lastErrText);
      }
    } catch (e) {
      if (i === retries - 1) throw new Error(lastErrText || String(e));
    }
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
  throw new Error(lastErrText || "Request failed");
}

// --------------------
// AI: convert text -> query plan (NO model data in prompt)
// --------------------
async function llmMakePlan(text) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-preview-09-2025";

  if (!GEMINI_API_KEY) {
    // no AI key -> fallback simple plan
    return { intent: "help" };
  }

  const systemPrompt = `
You are a BIM query planner.

Return ONLY valid JSON (no markdown) in this schema:

{
  "intent": "show|count|sum|breakdown|compare|help",
  "category": "Doors|Windows|Walls|Floors|Columns|Roofs|Rooms|Beams|Any" (optional),
  "property": "area|volume" (optional, for sum),
  "material": "string" (optional),
  "level": "string" (optional),
  "groupBy": "level" (optional, for breakdown),
  "compareLevels": ["Level 1","Level 2"] (optional, for compare)
}

Rules:
- If user says "show/find/display" -> intent "show"
- If user says "how many/count/number of" -> intent "count"
- If user says "total/sum" + "area/volume" -> intent "sum" with property
- If user says "per level/by level" -> intent "breakdown" with groupBy "level"
- If user says "compare X vs Y" -> intent "compare" with compareLevels
- category should be a simple Revit category when possible.
- If unclear -> intent "help"
`.trim();

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const resp = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text }] }],
      systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 400,
        responseMimeType: "application/json",
      },
    }),
  });

  const data = await resp.json();
  const rawText =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ??
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") ??
    "";

  const plan = extractJsonObject(rawText);
  return plan || { intent: "help" };
}

// --------------------
// Execute plan on FULL modelData (accurate)
// --------------------
function filterElements(modelData, plan) {
  let arr = modelData;

  if (plan?.category && plan.category !== "Any") {
    const c = norm(plan.category);
    // match "Doors" with "Door" etc
    arr = arr.filter((e) => contains(e.category, c) || contains(e.category, c.replace(/s$/, "")));
  }

  if (plan?.material) {
    const m = norm(plan.material);
    arr = arr.filter((e) => contains(e.material, m));
  }

  if (plan?.level) {
    const lv = norm(plan.level);
    arr = arr.filter((e) => contains(e.level, lv));
  }

  return arr;
}

function runPlan(modelData, plan) {
  const intent = norm(plan?.intent);

  if (!intent || intent === "help") {
    return {
      answer:
        "Try: 'Show me doors', 'How many windows?', 'Total wall volume', 'Windows per level', 'Compare window count Level 1 vs Level 2', 'Total concrete volume'.",
      dbIds: [],
    };
  }

  // breakdown / compare often imply category even if missing
  const working = filterElements(modelData, plan);

  if (intent === "show") {
    return {
      answer: `Showing ${working.length} elements.`,
      dbIds: working.map((e) => e.dbId),
    };
  }

  if (intent === "count") {
    return {
      answer: `Count: ${working.length}`,
      dbIds: working.map((e) => e.dbId),
    };
  }

  if (intent === "sum") {
    const prop = norm(plan?.property);
    const field = prop === "area" ? "area" : prop === "volume" ? "volume" : null;
    if (!field) {
      return { answer: "Specify 'area' or 'volume' (e.g. 'total wall volume').", dbIds: [] };
    }

    const total = working.reduce((s, e) => s + safeNumber(e[field]), 0);
    return {
      answer: `Total ${field}: ${total.toFixed(2)}`,
      dbIds: working.map((e) => e.dbId),
    };
  }

  if (intent === "breakdown") {
    const groupByKey = norm(plan?.groupBy);
    if (groupByKey !== "level") {
      return { answer: "I can breakdown by level (try 'windows per level').", dbIds: [] };
    }

    const g = groupBy(working, (e) => e.level || "Unknown");
    const lines = [];
    for (const [lvl, items] of g.entries()) {
      lines.push(`${lvl}: ${items.length}`);
    }
    lines.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    return {
      answer: lines.length ? `Per level:\n${lines.join("\n")}` : "No matching elements.",
      dbIds: working.map((e) => e.dbId),
    };
  }

  if (intent === "compare") {
    const levels = Array.isArray(plan?.compareLevels) ? plan.compareLevels : [];
    if (levels.length < 2) {
      // fallback: pick top 2 levels by count
      const g = groupBy(working, (e) => e.level || "Unknown");
      const sorted = [...g.entries()].sort((a, b) => b[1].length - a[1].length);
      if (sorted.length < 2) return { answer: "Not enough levels to compare.", dbIds: [] };
      const l1 = sorted[0][0], l2 = sorted[1][0];
      return {
        answer: `${l1}: ${sorted[0][1].length}\n${l2}: ${sorted[1][1].length}`,
        dbIds: working.map((e) => e.dbId),
      };
    }

    const l1 = levels[0], l2 = levels[1];
    const a = working.filter((e) => contains(e.level, l1));
    const b = working.filter((e) => contains(e.level, l2));
    return {
      answer: `${l1}: ${a.length}\n${l2}: ${b.length}`,
      dbIds: [...new Set([...a, ...b].map((e) => e.dbId))],
    };
  }

  return { answer: "Unsupported request. Try 'how many doors' or 'total wall volume'.", dbIds: [] };
}

// --------------------
// /api/ai
// --------------------
app.post("/api/ai", async (req, res) => {
  try {
    const { text, modelData } = req.body || {};
    if (!text || typeof text !== "string") return res.status(400).json({ error: "Missing text" });
    if (!Array.isArray(modelData)) return res.json({ answer: "BIM data not available.", dbIds: [] });

    // 1) LLM makes a small plan
    const plan = await llmMakePlan(text);

    // 2) Backend executes on FULL modelData (accurate)
    const result = runPlan(modelData, plan);

    // helpful debugging (optional)
    res.json({
      ...result,
      plan,
    });
  } catch (err) {
    res.status(500).json({
      error: "AI reasoning failed",
      details: String(err),
      answer: "I encountered an error analyzing the model data.",
      dbIds: [],
    });
  }
});

app.listen(PORT, () => {
  console.log(`BIM Backend active on port ${PORT}`);
});
