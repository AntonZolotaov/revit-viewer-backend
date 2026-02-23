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
  res.send("BIM AI Backend Running");
});

// --------------------
// APS Token
// --------------------
app.get("/api/auth/token", async (req, res) => {
  try {
    const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
    const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;

    const response = await fetch(
      "https://developer.api.autodesk.com/authentication/v2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: APS_CLIENT_ID,
          client_secret: APS_CLIENT_SECRET,
          scope:
            "data:read data:write data:create bucket:create bucket:read",
        }),
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Token failed", details: String(err) });
  }
});

// --------------------
// Helpers
// --------------------
function normalize(text) {
  return String(text || "").toLowerCase();
}

function contains(a, b) {
  return normalize(a).includes(normalize(b));
}

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key] || "Unknown";
    if (!acc[k]) acc[k] = [];
    acc[k].push(item);
    return acc;
  }, {});
}

// --------------------
// AI / BIM Endpoint
// --------------------
app.post("/api/ai", async (req, res) => {
  try {
    const { text, modelData } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Missing text" });
    }

    if (!Array.isArray(modelData)) {
      return res.json({
        answer: "Model data not loaded.",
        dbIds: []
      });
    }

    const q = normalize(text);

    const categories = [
      "door",
      "window",
      "wall",
      "floor",
      "column",
      "roof",
      "room",
      "beam"
    ];

    const foundCategory = categories.find(c => q.includes(c));

    // -------------------------
    // SHOW CATEGORY
    // -------------------------
    if (q.includes("show") || q.includes("display") || q.includes("find")) {
      if (foundCategory) {
        const filtered = modelData.filter(e =>
          contains(e.category, foundCategory)
        );

        return res.json({
          answer: `Showing ${filtered.length} ${foundCategory}s.`,
          dbIds: filtered.map(e => e.dbId)
        });
      }
    }

    // -------------------------
    // COUNT
    // -------------------------
    if (
      q.includes("how many") ||
      q.includes("count") ||
      q.includes("number of")
    ) {
      if (foundCategory) {
        const filtered = modelData.filter(e =>
          contains(e.category, foundCategory)
        );

        return res.json({
          answer: `Total ${foundCategory}s: ${filtered.length}`,
          dbIds: filtered.map(e => e.dbId)
        });
      }
    }

    // -------------------------
    // TOTAL VOLUME
    // -------------------------
    if (q.includes("total") && q.includes("volume")) {
      let filtered = modelData;

      if (foundCategory) {
        filtered = modelData.filter(e =>
          contains(e.category, foundCategory)
        );
      }

      const total = filtered.reduce(
        (sum, e) => sum + (e.volume || 0),
        0
      );

      return res.json({
        answer: `Total volume: ${total.toFixed(2)}`,
        dbIds: filtered.map(e => e.dbId)
      });
    }

    // -------------------------
    // TOTAL AREA
    // -------------------------
    if (q.includes("total") && q.includes("area")) {
      let filtered = modelData;

      if (foundCategory) {
        filtered = modelData.filter(e =>
          contains(e.category, foundCategory)
        );
      }

      const total = filtered.reduce(
        (sum, e) => sum + (e.area || 0),
        0
      );

      return res.json({
        answer: `Total area: ${total.toFixed(2)}`,
        dbIds: filtered.map(e => e.dbId)
      });
    }

    // -------------------------
    // WINDOWS PER LEVEL
    // -------------------------
    if (q.includes("windows per level")) {
      const windows = modelData.filter(e =>
        contains(e.category, "window")
      );

      const grouped = groupBy(windows, "level");

      let message = "Windows per level:\n";
      Object.keys(grouped).forEach(level => {
        message += `${level}: ${grouped[level].length}\n`;
      });

      return res.json({
        answer: message,
        dbIds: windows.map(e => e.dbId)
      });
    }

    // -------------------------
    // COMPARE WINDOWS BETWEEN LEVELS
    // -------------------------
    if (q.includes("compare") && q.includes("window")) {
      const windows = modelData.filter(e =>
        contains(e.category, "window")
      );

      const grouped = groupBy(windows, "level");
      const levels = Object.keys(grouped);

      if (levels.length >= 2) {
        const l1 = levels[0];
        const l2 = levels[1];

        return res.json({
          answer:
            `${l1}: ${grouped[l1].length} windows\n` +
            `${l2}: ${grouped[l2].length} windows`,
          dbIds: windows.map(e => e.dbId)
        });
      }
    }

    // -------------------------
    // MATERIAL FILTER (Concrete)
    // -------------------------
    if (q.includes("concrete")) {
      const filtered = modelData.filter(e =>
        contains(e.material, "concrete")
      );

      const totalVolume = filtered.reduce(
        (s, e) => s + (e.volume || 0),
        0
      );

      return res.json({
        answer:
          `Concrete elements: ${filtered.length}\n` +
          `Total volume: ${totalVolume.toFixed(2)}`,
        dbIds: filtered.map(e => e.dbId)
      });
    }

    // -------------------------
    // FALLBACK
    // -------------------------
    return res.json({
      answer:
        "I can calculate counts, totals, per-level breakdowns, show categories, and material quantities.",
      dbIds: []
    });

  } catch (err) {
    res.status(500).json({
      error: "AI processing failed",
      details: String(err)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
