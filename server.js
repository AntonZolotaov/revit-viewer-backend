import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ FIX CORS (this fixes your "Failed to fetch")
app.use(cors({
  origin: "*", // allow all origins (safe for public token endpoint)
  methods: ["GET", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());

// Health check
app.get("/", (req, res) => {
  res.send("Revit Viewer Backend is running");
});

// Autodesk Token Endpoint
app.get("/api/auth/token", async (req, res) => {
  try {
    const response = await fetch(
      "https://developer.api.autodesk.com/authentication/v2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: process.env.APS_CLIENT_ID,
          client_secret: process.env.APS_CLIENT_SECRET,
          scope: "data:read data:write data:create bucket:create bucket:read"
        })
      }
    );

    const data = await response.json();

    res.json({
      access_token: data.access_token,
      expires_in: data.expires_in
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get token" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
