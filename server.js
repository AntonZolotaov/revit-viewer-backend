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
const norm = (s) => String(s ?? "").toLowerCase().trim();
const contains = (a, b) => norm(a).includes(norm(b));

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

// --------------------
// AI PLANNER (Gemini optional)
// --------------------
async function llmMakePlan(text) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

  if (!GEMINI_API_KEY) {
    return fallbackPlan(text);
  }

  const systemPrompt = `
You are a BIM query planner.
Return ONLY JSON.

{
  "intent": "show|count|sum|breakdown|compare|help",
  "category": "Doors|Windows|Walls|Floors|Columns|Roofs|Rooms|Beams|Any",
  "property": "area|volume",
  "material": "string",
  "level": "string",
  "groupBy": "level",
  "compareLevels": ["Level 1","Level 2"]
}
`.trim();

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text }] }],
          systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
        }),
      }
    );

    const data = await resp.json();
    const raw =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") || "";

    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      return JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    }
  } catch (e) {
    console.log("Gemini fallback:", e.message);
  }

  return fallbackPlan(text);
}

// --------------------
// Smart fallback planner
// --------------------
function fallbackPlan(text) {
  const t = norm(text);

  const plan = { intent: "help", category: "Any" };

  if (t.includes("how many") || t.includes("count")) plan.intent = "count";
  if (t.includes("total") || t.includes("sum")) plan.intent = "sum";
  if (t.includes("per level") || t.includes("by level")) {
    plan.intent = "breakdown";
    plan.groupBy = "level";
  }
  if (t.includes("compare")) plan.intent = "compare";
  if (t.includes("show")) plan.intent = "show";

  if (t.includes("door")) plan.category = "Doors";
  if (t.includes("window")) plan.category = "Windows";
  if (t.includes("wall")) plan.category = "Walls";
  if (t.includes("floor")) plan.category = "Floors";
  if (t.includes("roof")) plan.category = "Roofs";
  if (t.includes("column")) plan.category = "Columns";
  if (t.includes("beam")) plan.category = "Beams";
  if (t.includes("room")) plan.category = "Rooms";

  if (t.includes("volume")) plan.property = "volume";
  if (t.includes("area")) plan.property = "area";

  if (t.includes("concrete")) plan.material = "concrete";

  return plan;
}

// --------------------
// Filter
// --------------------
function filterElements(modelData, plan) {
  let arr = modelData;

  if (plan.category && plan.category !== "Any") {
    const c = norm(plan.category);
    arr = arr.filter(
      (e) =>
        contains(e.category, c) ||
        contains(e.category, c.replace(/s$/, ""))
    );
  }

  if (plan.material) {
    arr = arr.filter((e) => contains(e.material, plan.material));
  }

  if (plan.level) {
    arr = arr.filter((e) => contains(e.level, plan.level));
  }

  return arr;
}

// --------------------
// Execute Plan
// --------------------
function runPlan(modelData, plan) {
  const intent = norm(plan.intent);
  const working = filterElements(modelData, plan);

  if (intent === "show") {
    return { answer: `Showing ${working.length} elements.`, dbIds: working.map(e => e.dbId) };
  }

  if (intent === "count") {
    return { answer: `Count: ${working.length}`, dbIds: working.map(e => e.dbId) };
  }

  if (intent === "sum") {
    const field = plan.property;
    if (!field) return { answer: "Specify area or volume.", dbIds: [] };

    const total = working.reduce((s, e) => s + safeNumber(e[field]), 0);
    return {
      answer: `Total ${field}: ${total.toFixed(2)}`,
      dbIds: working.map(e => e.dbId)
    };
  }

  if (intent === "breakdown") {
    const g = groupBy(working, e => e.level || "Unknown");
    const lines = [...g.entries()]
      .map(([lvl, items]) => `${lvl}: ${items.length}`)
      .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));

    return {
      answer: lines.length ? `Per level:\n${lines.join("\n")}` : "No matching elements.",
      dbIds: working.map(e => e.dbId)
    };
  }

  if (intent === "compare") {
    const levels = plan.compareLevels || [];
    if (levels.length < 2) {
      return { answer: "Specify two levels to compare.", dbIds: [] };
    }

    const a = working.filter(e => contains(e.level, levels[0]));
    const b = working.filter(e => contains(e.level, levels[1]));

    return {
      answer: `${levels[0]}: ${a.length}\n${levels[1]}: ${b.length}`,
      dbIds: [...new Set([...a, ...b].map(e => e.dbId))]
    };
  }

  return {
    answer: "Try: 'How many windows?', 'Total concrete volume', 'Windows per level'.",
    dbIds: []
  };
}

// --------------------
// /api/ai
// --------------------
app.post("/api/ai", async (req, res) => {
  try {
    const { text, modelData } = req.body;

    if (!text) return res.status(400).json({ error: "Missing text" });
    if (!Array.isArray(modelData))
      return res.json({ answer: "Model data missing.", dbIds: [] });

    const plan = await llmMakePlan(text);
    const result = runPlan(modelData, plan);

    res.json({ ...result, plan });
  } catch (err) {
    res.status(500).json({
      error: "AI reasoning failed",
      details: String(err),
      dbIds: []
    });
  }
});

app.listen(PORT, () => {
  console.log(`BIM Backend active on port ${PORT}`);
});
