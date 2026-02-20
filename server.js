import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "4mb" }));

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
// Health check
// --------------------
app.get("/", (req, res) => {
  res.send("Revit Viewer Backend is running");
});

// --------------------
// Debug route
// --------------------
app.get("/api/routes", (req, res) => {
  res.json({
    routes: ["GET /", "GET /api/auth/token", "POST /api/ai"],
  });
});

// --------------------
// APS Token endpoint
// --------------------
app.get("/api/auth/token", async (req, res) => {
  try {
    const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
    const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;

    if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
      return res.status(500).json({
        error: "Missing APS_CLIENT_ID or APS_CLIENT_SECRET",
      });
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
    res.status(500).json({ error: "Token request failed", details: String(err) });
  }
});

// --------------------
// Helper: safely extract JSON from LLM output
// --------------------
function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;

  // If model returns pure JSON
  try {
    const direct = JSON.parse(text);
    if (direct && typeof direct === "object") return direct;
  } catch {}

  // Otherwise try first {...} block
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

// --------------------
// Gemini AI endpoint (MAX Quantity Quick Check)
// --------------------
app.post("/api/ai", async (req, res) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }

    const { text, selection, context } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing text field" });
    }

    /**
     * IMPORTANT:
     * Backend does NOT compute BIM totals.
     * It returns action plans for the FRONTEND (APS Viewer) to execute.
     */
    const systemPrompt = `
You are a BIM Quantity Assistant for Autodesk APS Viewer.

Return ONLY valid JSON. No markdown. No extra text.

Schema:
{
  "answer": "short message for the user",
  "actions": [
    { "type": "...", "...": "..." }
  ]
}

Allowed action types (frontend will execute on the model):

1) count_by_category
   { "type":"count_by_category", "category":"Doors", "mode":"contains" }
   - Use when user asks: "how many", "count", "number of", "total doors", etc.
   - Frontend should search/filter by the element Category property.

2) sum_properties_all
   { "type":"sum_properties_all", "properties":["Length","Area","Volume"], "units":"model" }
   - Use when user asks totals for ALL elements:
     "total length and volume", "sum all volume", "total area", "all elements totals".

3) sum_properties_by_category
   { "type":"sum_properties_by_category", "category":"Walls", "properties":["Area","Volume"], "mode":"contains", "units":"model" }
   - Use when user asks totals for a specific category:
     "total wall volume", "total floor area", "sum columns length", etc.

4) search_and_isolate
   { "type":"search_and_isolate", "query":"Doors" }

5) search_and_select
   { "type":"search_and_select", "query":"Windows" }

6) clear_isolation
   { "type":"clear_isolation" }

7) fit_to_view
   { "type":"fit_to_view" }

8) help
   { "type":"help" }

Rules:
- If the user asks for COUNT -> use count_by_category.
- If the user asks for TOTAL LENGTH/AREA/VOLUME for ALL elements -> use sum_properties_all with requested properties.
- If the user asks for TOTAL LENGTH/AREA/VOLUME for a category -> use sum_properties_by_category.
- Use simple Revit categories: Doors, Windows, Walls, Floors, Columns, Roofs, Rooms, Beams.
- Use mode: "contains" (frontend will do case-insensitive contains match).
- Always output valid JSON only.
`.trim();

    const userPrompt = [
      "User request:",
      text,
      "",
      "Selection (JSON):",
      JSON.stringify(selection ?? null, null, 2),
      "",
      "Context (JSON):",
      JSON.stringify(context ?? null, null, 2),
    ].join("\n");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      GEMINI_MODEL
    )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: systemPrompt }] },
          { role: "user", parts: [{ text: userPrompt }] },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 600,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Gemini request failed",
        model: GEMINI_MODEL,
        details: data,
      });
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parsed = extractJsonObject(rawText);

    if (!parsed) {
      return res.json({
        answer: rawText || "No response from Gemini.",
        actions: [{ type: "help" }],
        model: GEMINI_MODEL,
        raw: rawText,
      });
    }

    const answer = typeof parsed.answer === "string" ? parsed.answer : "OK";
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [{ type: "help" }];

    res.json({ answer, actions, model: GEMINI_MODEL });
  } catch (err) {
    res.status(500).json({ error: "AI request failed", details: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
