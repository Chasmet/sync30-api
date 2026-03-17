import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// 🔥 CONFIG
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BUCKET = "videos";

// 🧠 UTIL USER
function getUserId(req) {
  return req.headers["x-user-id"] || "public";
}

// 🚀 WAKE
app.get("/", (req, res) => {
  res.send("Server VEED OK");
});

// 🎬 LIPSYNC
app.post("/lipsync", upload.fields([
  { name: "video", maxCount: 1 },
  { name: "audio", maxCount: 1 }
]), async (req, res) => {
  try {
    const userId = getUserId(req);

    const videoFile = req.files.video?.[0];
    const audioFile = req.files.audio?.[0];

    if (!videoFile || !audioFile) {
      return res.status(400).json({ error: "Fichiers manquants" });
    }

    // 1. Envoi à Replicate
    const replicateResponse = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        version: "YOUR_MODEL_ID",
        input: {
          video: videoFile.buffer.toString("base64"),
          audio: audioFile.buffer.toString("base64")
        }
      })
    });

    const prediction = await replicateResponse.json();

    if (!prediction?.urls?.get) {
      throw new Error("Erreur lancement Replicate");
    }

    // 2. Polling
    let outputUrl = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));

      const poll = await fetch(prediction.urls.get, {
        headers: {
          "Authorization": `Token ${REPLICATE_API_TOKEN}`
        }
      });

      const data = await poll.json();

      if (data.status === "succeeded") {
        outputUrl = data.output;
        break;
      }

      if (data.status === "failed") {
        throw new Error("Replicate a échoué");
      }
    }

    if (!outputUrl) {
      throw new Error("Timeout Replicate");
    }

    // 3. Télécharger vidéo
    const videoFetch = await fetch(outputUrl);
    const videoBuffer = await videoFetch.arrayBuffer();

    // 4. Stockage Supabase (IMPORTANT: userId)
    const fileName = `${userId}/veed-${Date.now()}.mp4`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(fileName, Buffer.from(videoBuffer), {
        contentType: "video/mp4",
        upsert: false
      });

    if (error) throw error;

    const { data: publicUrl } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(fileName);

    res.json({
      videoUrl: publicUrl.publicUrl,
      playUrl: publicUrl.publicUrl,
      downloadUrl: publicUrl.publicUrl
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 📁 LISTE VIDÉOS
app.get("/videos", async (req, res) => {
  try {
    const userId = getUserId(req);

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(userId, {
        limit: 100,
        sortBy: { column: "created_at", order: "desc" }
      });

    if (error) throw error;

    const videos = data.map(file => {
      const path = `${userId}/${file.name}`;
      const { data: url } = supabase.storage
        .from(BUCKET)
        .getPublicUrl(path);

      return {
        name: file.name,
        playUrl: url.publicUrl,
        downloadUrl: url.publicUrl,
        created_at: file.created_at,
        metadata: file.metadata
      };
    });

    res.json({ ok: true, videos });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ❌ DELETE
app.post("/delete-video", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { name } = req.body;

    const path = `${userId}/${name}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .remove([path]);

    if (error) throw error;

    res.json({ ok: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
