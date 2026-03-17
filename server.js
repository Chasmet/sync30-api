import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import Replicate from "replicate";
import { createClient } from "@supabase/supabase-js";

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

const VEED_MODEL_ID = "sync/lipsync-2";
const SUPABASE_BUCKET = "videos";
const ENGINE_FOLDER = "veed";
const MAX_VEED_VIDEOS = 5;

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

function safeDelete(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileToDataUrl(filePath, mimeType) {
  const base64 = fs.readFileSync(filePath, { encoding: "base64" });
  return `data:${mimeType};base64,${base64}`;
}

function convertVideoForVeed(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec("libx264")
      .noAudio()
      .outputOptions([
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-r 25",
        "-movflags +faststart"
      ])
      .videoFilters("scale='min(720,iw)':-2,setsar=1")
      .format("mp4")
      .save(outputPath)
      .on("end", resolve)
      .on("error", reject);
  });
}

function convertAudioForVeed(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("pcm_s16le")
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .save(outputPath)
      .on("end", resolve)
      .on("error", reject);
  });
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Téléchargement sortie impossible: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
}

function sanitizeFileName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

function normalizeEngineFolder(engine) {
  return engine === "veed" ? "veed" : engine;
}

async function uploadResultToSupabase(filePath, originalName, engine = ENGINE_FOLDER) {
  const fileBuffer = fs.readFileSync(filePath);
  const cleanName = sanitizeFileName(
    originalName?.replace(/\.[^/.]+$/, "") || `${engine}-result`
  );

  const finalPath = `${engine}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}-${cleanName}.mp4`;

  const { error: uploadError } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(finalPath, fileBuffer, {
      contentType: "video/mp4",
      upsert: false,
      cacheControl: "3600"
    });

  if (uploadError) {
    throw new Error(`Upload Supabase impossible: ${uploadError.message}`);
  }

  const { data } = supabase.storage
    .from(SUPABASE_BUCKET)
    .getPublicUrl(finalPath);

  return {
    path: finalPath,
    publicUrl: data?.publicUrl || null
  };
}

async function listEngineVideos(engine = ENGINE_FOLDER) {
  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .list(engine, {
      limit: 100,
      offset: 0,
      sortBy: { column: "created_at", order: "desc" }
    });

  if (error) {
    throw new Error(`Liste vidéos impossible: ${error.message}`);
  }

  return data || [];
}

async function deleteStoragePaths(storagePaths = []) {
  if (!Array.isArray(storagePaths) || storagePaths.length === 0) return;

  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .remove(storagePaths);

  if (error) {
    throw new Error(`Suppression Supabase impossible: ${error.message}`);
  }

  return data || [];
}

async function downloadFromSupabase(storagePath) {
  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .download(storagePath);

  if (error) {
    throw new Error(`Lecture Supabase impossible: ${error.message}`);
  }

  if (!data) {
    throw new Error("Fichier Supabase introuvable");
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function enforceVideoLimit(engine = ENGINE_FOLDER, maxVideos = MAX_VEED_VIDEOS) {
  const items = await listEngineVideos(engine);

  if (items.length <= maxVideos) {
    return { deleted: [] };
  }

  const sortedOldestFirst = [...items].sort((a, b) => {
    const dateA = new Date(a.created_at || 0).getTime();
    const dateB = new Date(b.created_at || 0).getTime();
    return dateA - dateB;
  });

  const toDelete = sortedOldestFirst.slice(0, items.length - maxVideos);
  const storagePaths = toDelete.map((item) => `${engine}/${item.name}`);

  await deleteStoragePaths(storagePaths);

  return { deleted: storagePaths };
}

app.get("/", (req, res) => {
  res.json({
    status: "Sync30 API active",
    engines: ["veed"],
    modeInfo: {
      veed: `test ${VEED_MODEL_ID} via Replicate`
    },
    storageLimit: MAX_VEED_VIDEOS
  });
});

app.get("/video/:engine/:name", async (req, res) => {
  try {
    const engine = normalizeEngineFolder(req.params.engine);
    const name = decodeURIComponent(req.params.name || "");

    if (!name) {
      return res.status(400).json({
        error: "missing_name",
        details: "Nom de fichier manquant"
      });
    }

    const storagePath = `${engine}/${name}`;
    const fileBuffer = await downloadFromSupabase(storagePath);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", fileBuffer.length);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Disposition", `inline; filename="${name}"`);

    return res.send(fileBuffer);
  } catch (err) {
    return res.status(404).json({
      error: "video_read_error",
      details: err.message || "Lecture impossible"
    });
  }
});

app.get("/download/:engine/:name", async (req, res) => {
  try {
    const engine = normalizeEngineFolder(req.params.engine);
    const name = decodeURIComponent(req.params.name || "");

    if (!name) {
      return res.status(400).json({
        error: "missing_name",
        details: "Nom de fichier manquant"
      });
    }

    const storagePath = `${engine}/${name}`;
    const fileBuffer = await downloadFromSupabase(storagePath);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", fileBuffer.length);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);

    return res.send(fileBuffer);
  } catch (err) {
    return res.status(404).json({
      error: "video_download_error",
      details: err.message || "Téléchargement impossible"
    });
  }
});

app.get("/videos", async (req, res) => {
  try {
    const items = await listEngineVideos(ENGINE_FOLDER);
    const baseUrl = getBaseUrl(req);

    const videos = items.map((item) => {
      const encodedName = encodeURIComponent(item.name);

      return {
        name: item.name,
        created_at: item.created_at,
        updated_at: item.updated_at,
        metadata: item.metadata,
        path: `${ENGINE_FOLDER}/${item.name}`,
        playUrl: `${baseUrl}/video/${ENGINE_FOLDER}/${encodedName}`,
        downloadUrl: `${baseUrl}/download/${ENGINE_FOLDER}/${encodedName}`
      };
    });

    return res.json({
      ok: true,
      limit: MAX_VEED_VIDEOS,
      count: videos.length,
      videos
    });
  } catch (err) {
    return res.status(500).json({
      error: "videos_list_error",
      details: err.message || "Erreur inconnue"
    });
  }
});

app.post("/delete-video", async (req, res) => {
  try {
    const engine = normalizeEngineFolder(req.body?.engine || ENGINE_FOLDER);
    const name = String(req.body?.name || "").trim();

    if (!name) {
      return res.status(400).json({
        error: "missing_name",
        details: "Nom de fichier manquant"
      });
    }

    const storagePath = `${engine}/${name}`;
    await deleteStoragePaths([storagePath]);

    return res.json({
      ok: true,
      deleted: storagePath
    });
  } catch (err) {
    return res.status(500).json({
      error: "video_delete_error",
      details: err.message || "Suppression impossible"
    });
  }
});

app.post(
  "/lipsync",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "audio", maxCount: 1 }
  ]),
  async (req, res) => {
    const videoFile = req.files?.video?.[0];
    const audioFile = req.files?.audio?.[0];

    let normalizedVideoPath = null;
    let normalizedAudioPath = null;
    let outputPath = null;

    try {
      if (!process.env.REPLICATE_API_TOKEN) {
        return res.status(500).json({
          error: "REPLICATE_API_TOKEN manquant sur Render"
        });
      }

      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({
          error: "Variables Supabase manquantes sur Render"
        });
      }

      if (!videoFile || !audioFile) {
        return res.status(400).json({
          error: "Vidéo ou audio manquant"
        });
      }

      normalizedVideoPath = path.join("uploads", `veed_video_${Date.now()}.mp4`);
      normalizedAudioPath = path.join("uploads", `veed_audio_${Date.now()}.wav`);

      console.log("VEED START");
      console.log("Model:", VEED_MODEL_ID);
      console.log("Original video:", videoFile.originalname);
      console.log("Original audio:", audioFile.originalname);

      await convertVideoForVeed(videoFile.path, normalizedVideoPath);
      await convertAudioForVeed(audioFile.path, normalizedAudioPath);

      const videoDataUrl = fileToDataUrl(normalizedVideoPath, "video/mp4");
      const audioDataUrl = fileToDataUrl(normalizedAudioPath, "audio/wav");

      const prediction = await replicate.predictions.create({
        model: VEED_MODEL_ID,
        input: {
          video: videoDataUrl,
          audio: audioDataUrl
        }
      });

      console.log("VEED prediction created:", prediction.id);

      let result = prediction;

      while (
        result.status !== "succeeded" &&
        result.status !== "failed" &&
        result.status !== "canceled"
      ) {
        await wait(2000);
        result = await replicate.predictions.get(prediction.id);
        console.log("VEED prediction status:", result.status);
      }

      if (result.status !== "succeeded") {
        console.error("VEED FAILED RESULT:", result);
        throw new Error(result.error || `Replicate status: ${result.status}`);
      }

      let videoUrl = null;

      if (typeof result.output === "string") {
        videoUrl = result.output;
      } else if (Array.isArray(result.output) && result.output.length > 0) {
        videoUrl = String(result.output[0]);
      } else if (result.output && typeof result.output.url === "function") {
        videoUrl = result.output.url();
      } else if (result.output && result.output.toString) {
        videoUrl = result.output.toString();
      }

      console.log("VEED OUTPUT URL:", videoUrl);

      if (!videoUrl) {
        throw new Error("Sortie VEED invalide");
      }

      outputPath = path.join("uploads", `veed_output_${Date.now()}.mp4`);
      await downloadFile(videoUrl, outputPath);

      const savedVideo = await uploadResultToSupabase(
        outputPath,
        videoFile.originalname,
        ENGINE_FOLDER
      );

      const cleanupResult = await enforceVideoLimit(
        ENGINE_FOLDER,
        MAX_VEED_VIDEOS
      );

      safeDelete(videoFile.path);
      safeDelete(audioFile.path);
      safeDelete(normalizedVideoPath);
      safeDelete(normalizedAudioPath);

      res.setHeader("x-video-url", savedVideo.publicUrl || "");
      res.setHeader(
        "x-auto-deleted-count",
        String(cleanupResult.deleted.length)
      );

      return res.json({
        ok: true,
        mode: "veed-premium",
        videoUrl: savedVideo.publicUrl
      });
    } catch (err) {
      console.error("VEED ERROR:", err);

      safeDelete(videoFile?.path);
      safeDelete(audioFile?.path);
      safeDelete(normalizedVideoPath);
      safeDelete(normalizedAudioPath);
      safeDelete(outputPath);

      return res.status(500).json({
        error: "Erreur VEED",
        details: err.message || "Erreur inconnue"
      });
    } finally {
      safeDelete(outputPath);
    }
  }
);

app.listen(PORT, async () => {
  await sleep(200);
  console.log(`Sync30 server running on port ${PORT}`);
});
