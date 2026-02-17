import express from "express";
import fetch from "node-fetch";

const app = express();

// Read APS credentials from environment variables
const APS_CLIENT_ID = process.env.APS_CLIENT_ID;
const APS_CLIENT_SECRET = process.env.APS_CLIENT_SECRET;

// Health check
app.get("/", (req, res) => {
  res.send("Revit Viewer Backend is running");
});

// Token endpoint for APS Viewer
app.get("/api/auth/token", async (req, res) => {
  try {
    if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
      return res.status(500).json({
        error: "Missing APS_CLIENT_ID or APS_CLIENT_SECRET in environment variables",
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

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).send(text);
    }

    const data = await response.json();

    // Viewer expects: { access_token, expires_in }
    res.json({ access_token: data.access_token, expires_in: data.expires_in });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
