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
    routes: ["GET /", "GET /api/auth/token", "POST /api/ai"]
  });
});

// APS Token endpoint
app.get("/api/auth/token", async (req, res) => {
  try {
    const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
    const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;

    if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
      return res.status(500).json({
        error: "Missing APS_CLIENT_ID or APS_CLIENT_SECRET"
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
          scope: "data:read data:write data:create bucket:create bucket:read"
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Token request failed", details: String(err) });
  }
});

// =============================
// GEMINI AI ENDPOINT (FIXED)
// =============================
app.post("/api/ai", async (req, res) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }

    const { text, selection } = req.body || {};

    if (!text) {
      return res.status(400).json({ error: "Missing text field" });
    }

    const prompt = `
You are a BIM assistant integrated into Autodesk APS Viewer.

User question:
${text}

Selected element data (JSON):
${JSON.stringify(selection || null, null, 2)}

Respond clearly, concisely, and professionally.
`;

    // ✅ FIXED ENDPOINT + MODEL
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }]
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Gemini request failed",
        details: data
      });
    }

    const answer =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No response from Gemini.";

    res.json({ answer });

  } catch (err) {
    res.status(500).json({
      error: "AI request failed",
      details: String(err)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
