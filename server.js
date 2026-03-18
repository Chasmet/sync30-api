import express from "express";
import cors from "cors";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// CONFIG
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL manquante");
}
if (!SUPABASE_KEY) {
  throw new Error("SUPABASE_SERVICE_KEY ou SUPABASE_SERVICE_ROLE_KEY manquante");
}
if (!REPLICATE_API_TOKEN) {
  throw new Error("REPLICATE_API_TOKEN manquante");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BUCKET = "videos";
const ENGINE_FOLDER = "veed";
const MAX_VIDEOS_PER_USER = 3;
const MAX_VIDEO_AGE_HOURS = 24;

// UTIL
function getUserId(req) {
  return req.headers["x-user-id"] || "public";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStoragePath(userId, fileName) {
  return `${userId}/${ENGINE_FOLDER}/${fileName}`;
}

function buildFolderPath(userId) {
  return `${userId}/${ENGINE_FOLDER}`;
}

function buildPlayUrl(fileName) {
  return `/open-video/${encodeURIComponent(fileName)}`;
}

function buildDownloadUrl(fileName) {
  return `/download-video/${encodeURIComponent(fileName)}`;
}

function safeMessage(error) {
  return error?.message || "Erreur inconnue";
}

function safeDate(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function sortByCreatedAtAsc(files = []) {
  return [...files].sort((a, b) => {
    return safeDate(a.created_at).getTime() - safeDate(b.created_at).getTime();
  });
}

function getExpiredFiles(files = []) {
  const now = Date.now();
  const maxAgeMs = MAX_VIDEO_AGE_HOURS * 60 * 60 * 1000;

  return files.filter((file) => {
    const createdAt = safeDate(file.created_at).getTime();
    return now - createdAt > maxAgeMs;
  });
}

function getOverflowFiles(files = []) {
  const sorted = sortByCreatedAtAsc(files);

  if (sorted.length <= MAX_VIDEOS_PER_USER) {
    return [];
  }

  return sorted.slice(0, sorted.length - MAX_VIDEOS_PER_USER);
}

async function listRawVideos(userId) {
  const folder = buildFolderPath(userId);

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(folder, {
      limit: 100,
      sortBy: { column: "created_at", order: "desc" }
    });

  if (error) {
    throw error;
  }

  return data || [];
}

async function deleteStoredVideo(userId, fileName) {
  const filePath = buildStoragePath(userId, fileName);

  const { error } = await supabase.storage
    .from(BUCKET)
    .remove([filePath]);

  if (error) {
    throw error;
  }
}

async function enforceVideoRetention(userId) {
  if (!userId) return;

  const rawFiles = await listRawVideos(userId);

  const expiredFiles = getExpiredFiles(rawFiles);
  const expiredNames = new Set(expiredFiles.map((file) => file.name));

  const freshFiles = rawFiles.filter((file) => !expiredNames.has(file.name));
  const overflowFiles = getOverflowFiles(freshFiles);

  const filesToDelete = [
    ...expiredFiles,
    ...overflowFiles.filter((file) => !expiredNames.has(file.name))
  ];

  for (const file of filesToDelete) {
    try {
      await deleteStoredVideo(userId, file.name);
    } catch (error) {
      console.error("RETENTION DELETE ERROR:", file.name, error.message);
    }
  }
}

async function getUserVideos(userId) {
  await enforceVideoRetention(userId);

  const data = await listRawVideos(userId);

  return data.map((file) => ({
    name: file.name,
    playUrl: buildPlayUrl(file.name),
    downloadUrl: buildDownloadUrl(file.name),
    created_at: file.created_at,
    metadata: file.metadata
  }));
}

// WAKE
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    status: "Server VEED OK",
    bucket: BUCKET,
    engine: ENGINE_FOLDER,
    retention: {
      maxVideosPerUser: MAX_VIDEOS_PER_USER,
      maxAgeHours: MAX_VIDEO_AGE_HOURS
    }
  });
});

// LIPSYNC VEED
app.post(
  "/lipsync",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "audio", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const userId = getUserId(req);

      const videoFile = req.files?.video?.[0];
      const audioFile = req.files?.audio?.[0];

      if (!videoFile || !audioFile) {
        return res.status(400).json({
          ok: false,
          error: "Fichiers manquants"
        });
      }

      // 1. Envoi à Replicate
      const replicateResponse = await fetch(
        "https://api.replicate.com/v1/models/sync/lipsync-2/predictions",
        {
          method: "POST",
          headers: {
            Authorization: `Token ${REPLICATE_API_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            input: {
              video: `data:${videoFile.mimetype};base64,${videoFile.buffer.toString("base64")}`,
              audio: `data:${audioFile.mimetype};base64,${audioFile.buffer.toString("base64")}`,
              sync_mode: "loop",
              temperature: 0.5
            }
          })
        }
      );

      const prediction = await replicateResponse.json();

      if (!replicateResponse.ok || !prediction?.urls?.get) {
        throw new Error(
          prediction?.detail ||
            prediction?.error ||
            "Erreur lancement Replicate"
        );
      }

      // 2. Polling
      let outputUrl = null;

      for (let i = 0; i < 120; i += 1) {
        await sleep(5000);

        const poll = await fetch(prediction.urls.get, {
          headers: {
            Authorization: `Token ${REPLICATE_API_TOKEN}`
          }
        });

        const data = await poll.json();

        console.log("VEED prediction status:", data.status);

        if (data.status === "succeeded") {
          outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
          break;
        }

        if (data.status === "failed" || data.status === "canceled") {
          throw new Error(data?.error || "Replicate a échoué");
        }
      }

      if (!outputUrl) {
        throw new Error("Timeout Replicate");
      }

      // 3. Télécharger vidéo finale
      const videoFetch = await fetch(outputUrl);
      if (!videoFetch.ok) {
        throw new Error("Impossible de télécharger la vidéo finale");
      }

      const videoArrayBuffer = await videoFetch.arrayBuffer();
      const videoBuffer = Buffer.from(videoArrayBuffer);

      // 4. Stockage Supabase par utilisateur et moteur
      const fileName = `veed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
      const filePath = buildStoragePath(userId, fileName);

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(filePath, videoBuffer, {
          contentType: "video/mp4",
          upsert: false
        });

      if (uploadError) {
        throw uploadError;
      }

      // 5. Rétention : max 3 vidéos + suppression > 24h
      await enforceVideoRetention(userId);

      return res.json({
        ok: true,
        fileName,
        videoUrl: buildPlayUrl(fileName),
        playUrl: buildPlayUrl(fileName),
        downloadUrl: buildDownloadUrl(fileName)
      });
    } catch (err) {
      console.error("VEED ERROR:", err);
      return res.status(500).json({
        ok: false,
        error: safeMessage(err)
      });
    }
  }
);

// LISTE VIDÉOS VEED DU COMPTE
app.get("/videos", async (req, res) => {
  try {
    const userId = getUserId(req);
    const videos = await getUserVideos(userId);

    return res.json({
      ok: true,
      videos
    });
  } catch (err) {
    console.error("VEED VIDEOS ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: safeMessage(err)
    });
  }
});

// OUVRIR VIDÉO VIA RENDER
app.get("/open-video/:name", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { name } = req.params;

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: "Nom de fichier manquant"
      });
    }

    const filePath = buildStoragePath(userId, name);

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(filePath);

    if (error || !data) {
      return res.status(404).json({
        ok: false,
        error: "Vidéo introuvable"
      });
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-store");
    return res.send(buffer);
  } catch (err) {
    console.error("VEED OPEN ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: safeMessage(err)
    });
  }
});

// TÉLÉCHARGER VIDÉO VIA RENDER
app.get("/download-video/:name", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { name } = req.params;

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: "Nom de fichier manquant"
      });
    }

    const filePath = buildStoragePath(userId, name);

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(filePath);

    if (error || !data) {
      return res.status(404).json({
        ok: false,
        error: "Vidéo introuvable"
      });
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.send(buffer);
  } catch (err) {
    console.error("VEED DOWNLOAD ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: safeMessage(err)
    });
  }
});

// DELETE
app.post("/delete-video", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: "Nom manquant"
      });
    }

    await deleteStoredVideo(userId, name);

    return res.json({ ok: true });
  } catch (err) {
    console.error("VEED DELETE ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: safeMessage(err)
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VEED server running on ${PORT}`);
});
