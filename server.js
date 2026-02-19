import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health check
app.get("/", (req, res) => {
  res.send("Revit Viewer Backend is running");
});

// Debug route
app.get("/api/routes", (req, res) => {
  res.json({
    routes: ["GET /", "GET /api/auth/token", "POST /api/ai"],
  });
});

// APS Token endpoint
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

// Helper: try to extract JSON from model text safely
function extractJsonObject(text) {
  if (!text || typeof text !== "string") return null;

  // If Gemini returns pure JSON
  try {
    const direct = JSON.parse(text);
    if (direct && typeof direct === "object") return direct;
  } catch {}

  // Otherwise try to find first {...} block
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

// Gemini AI endpoint
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

    // IMPORTANT: we force Gemini to output an "actions" JSON plan the frontend can execute.
    const systemPrompt = `
You are a BIM assistant for Autodesk APS Viewer (Forge Viewer).
Your job: convert the user's request into a JSON response the frontend can execute.

Return ONLY valid JSON (no markdown, no extra text).

Schema:
{
  "answer": "short helpful text to show the user",
  "actions": [
    {
      "type": "search_and_isolate",
      "query": "Windows"
    }
  ]
}

Allowed action types:
- "search_and_isolate"   (search viewer for query, then isolate + fit + select)
- "search_and_select"    (search viewer then select + fit, no isolate)
- "clear_isolation"      (show all)
- "fit_to_view"          (fit to current selection/scene)
- "help"                 (no viewer action)

Rules:
- If user says "show me windows", use: {type:"search_and_isolate", query:"Windows"}.
- Use simple queries: "Windows", "Doors", "Walls", "Floors", "Columns", etc.
- If unsure, use type "help" and explain what you can do.

Context you may receive:
- selection: selected dbIds or element info (optional)
- context: viewer info (optional)

Now respond with ONLY JSON.
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
          temperature: 0.2,
          maxOutputTokens: 400,
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

    const rawText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    const parsed = extractJsonObject(rawText);

    if (!parsed) {
      // fallback: return raw text as answer
      return res.json({
        answer: rawText || "No response from Gemini.",
        actions: [{ type: "help" }],
        model: GEMINI_MODEL,
        raw: rawText,
      });
    }

    // Normalize
    const answer = typeof parsed.answer === "string" ? parsed.answer : "";
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [{ type: "help" }];

    res.json({ answer, actions, model: GEMINI_MODEL });
  } catch (err) {
    res.status(500).json({ error: "AI request failed", details: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
