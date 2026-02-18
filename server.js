import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));

// ✅ Manual CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ✅ Health check
app.get("/", (req, res) => {
  res.send("Revit Viewer Backend is running");
});

// ✅ Debug route (temporary)
app.get("/api/routes", (req, res) => {
  res.json({
    routes: ["GET /", "GET /api/auth/token", "POST /api/ai"],
  });
});

// ✅ APS Token endpoint
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

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Token request failed", details: String(err) });
  }
});

// ✅ Gemini AI endpoint (FIXED model + endpoint)
app.post(["/api/ai", "/api/ai/"], async (req, res) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }

    const { text, selection } = req.body || {};
    if (!text) {
      return res.status(400).json({ error: "Missing 'text' in request body" });
    }

    const prompt = [
      "You are a BIM assistant for Autodesk APS Viewer.",
      "",
      "User question:",
      text,
      "",
      "Selected elements (JSON):",
      JSON.stringify(selection ?? null, null, 2),
      "",
      "Reply clearly and concisely.",
    ].join("\n");

    // ✅ Use a model that works with v1 generateContent
    // You can override in Render env vars: GEMINI_MODEL
    const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";

    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Gemini request failed",
        usedModel: model,
        details: data,
      });
    }

    const answer =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No response from Gemini.";

    res.json({ answer, usedModel: model });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI request failed", details: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
