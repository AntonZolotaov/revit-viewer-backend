import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" })); // ✅ ADD THIS

// ✅ Manual CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); // ✅ CHANGE
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health check
app.get("/", (req, res) => {
  res.send("Revit Viewer Backend is running");
});

// Token endpoint
app.get("/api/auth/token", async (req, res) => {
  // ... your existing code unchanged ...
});

// ✅ ADD THIS: Gemini endpoint
app.post("/api/ai", async (req, res) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY in Render env vars" });
    }

    const { text, selection } = req.body || {};
    if (!text) {
      return res.status(400).json({ error: "Missing 'text' in request body" });
    }

    const prompt = [
      "You are a BIM assistant for an Autodesk APS Viewer.",
      "Use the selected element data if provided.",
      "",
      "User question:",
      text,
      "",
      "Selected elements (JSON):",
      JSON.stringify(selection || null, null, 2),
      "",
      "Reply with a clear, concise answer."
    ].join("\n");

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: "Gemini request failed", details: data });
    }

    const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response from Gemini.";
    res.json({ answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI request failed", details: String(err) });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
