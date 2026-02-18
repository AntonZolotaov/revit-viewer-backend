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
      "Reply clearly and concisely."
    ].join("\n");

    // ✅ Use a model that works with v1 generateContent
    // Set GEMINI_MODEL in Render if you want, otherwise default to gemini-1.5-flash
    const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";

    const url =
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Gemini request failed",
        details: data,
        usedModel: model
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
