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
// APS Token (Secure Proxy)
// --------------------
app.get("/api/auth/token", async (req, res) => {
  try {
    const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
    const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;

    if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
      return res
        .status(500)
        .json({ error: "Missing APS_CLIENT_ID or APS_CLIENT_SECRET" });
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
function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;

  // direct JSON
  try {
    const direct = JSON.parse(text);
    if (direct && typeof direct === "object") return direct;
  } catch {}

  // try first {...} block
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

      // Read error body once for debugging
      const errText = await res.text().catch(() => "");
      lastErrText = `HTTP ${res.status}: ${errText || res.statusText}`;

      // Retry on 429/5xx
      if (!(res.status === 429 || (res.status >= 500 && res.status <= 599))) {
        throw new Error(lastErrText);
      }
    } catch (e) {
      if (i === retries - 1) {
        throw new Error(lastErrText || String(e));
      }
    }

    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }

  throw new Error(lastErrText || "Request failed");
}

// --------------------
// Gemini AI / BIM Endpoint
// --------------------
app.post("/api/ai", async (req, res) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // ✅ set this in Render/host env
    const GEMINI_MODEL =
      process.env.GEMINI_MODEL || "gemini-2.5-flash-preview-09-2025";

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY in environment" });
    }

    const { text, modelData } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing text" });
    }
    if (!Array.isArray(modelData)) {
      return res.json({ answer: "BIM data not available.", dbIds: [] });
    }

    // Slim & cap data to avoid huge prompts.
    // If your model is big, keep this lower (e.g. 1500-3000).
    const MAX_ITEMS = Number(process.env.MAX_BIM_ITEMS || 3000);

    const slimData = modelData.slice(0, MAX_ITEMS).map((e) => ({
      dbId: e.dbId,
      category: e.category ?? null,
      level: e.level ?? null,
      volume: e.volume ?? null,
      area: e.area ?? null,
      material: e.material ?? null,
      name: e.name ?? null,
      familyType: e.familyType ?? null,
    }));

    const systemPrompt = `
You are a BIM Intelligence Agent.

You MUST answer using ONLY the provided modelData JSON (no guessing).

Return ONLY valid JSON with this schema:
{
  "answer": "string",
  "dbIds": [123, 456]
}

Rules:
- If user asks "show/find/display <category>" -> return dbIds of matching items.
- If user asks "how many/count/number of <category>" -> return count + dbIds.
- If user asks "total area/volume" optionally with category/material/level filters -> compute accurate sum from data.
- If level comparison requested -> group by level and compute counts/sums.

Here is modelData (array of elements):
${JSON.stringify(slimData)}
`.trim();

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      GEMINI_MODEL
    )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    const aiResponse = await fetchWithRetry(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 800,
          // Ask for JSON, but still parse safely in case Gemini adds extra text.
          responseMimeType: "application/json",
        },
      }),
    });

    const result = await aiResponse.json();

    const rawText =
      result?.candidates?.[0]?.content?.parts?.[0]?.text ??
      result?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("\n") ??
      "";

    const parsed = extractJsonObject(rawText);

    if (!parsed) {
      return res.json({
        answer: rawText || "No response from AI.",
        dbIds: [],
        raw: rawText,
        model: GEMINI_MODEL,
      });
    }

    const answer = typeof parsed.answer === "string" ? parsed.answer : "OK";
    const dbIds = Array.isArray(parsed.dbIds) ? parsed.dbIds : [];

    res.json({ answer, dbIds, model: GEMINI_MODEL });
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
