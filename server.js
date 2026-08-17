import express from "express";
import cors from "cors";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";

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
const BALANCE_TYPE = "premium";
const MAX_VIDEOS_PER_USER = 3;
const MAX_VIDEO_AGE_HOURS = 24;
const MAX_VEED_SECONDS = 32;

// TEMPORAIRE : benchmark LatentSync, appelé uniquement par GitHub Actions.
const LATENTSYNC_BENCHMARK_AUDIENCE = "sync30-latentsync-benchmark";
const LATENTSYNC_BENCHMARK_SUBJECT =
  "repo:Chasmet/sync30-api:ref:refs/heads/main";
const LATENTSYNC_REPLICATE_VERSION =
  "637ce1919f807ca20da3a448ddc2743535d2853649574cd52a933120e9b9e293";
const LATENTSYNC_DEMO_VIDEO =
  "https://raw.githubusercontent.com/bytedance/LatentSync/main/assets/demo1_video.mp4";
const LATENTSYNC_DEMO_AUDIO =
  "https://raw.githubusercontent.com/bytedance/LatentSync/main/assets/demo1_audio.wav";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS = createRemoteJWKSet(
  new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`)
);
let latentSyncBenchmarkPredictionId = null;

// UTILS
function getUserId(req) {
  return req.headers["x-user-id"] || "public";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requireBenchmarkOidc(req, res, next) {
  try {
    const authorization = String(req.headers.authorization || "");
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";

    if (!token) {
      return res.status(401).json({ ok: false, error: "Jeton manquant" });
    }

    const { payload } = await jwtVerify(token, GITHUB_OIDC_JWKS, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: LATENTSYNC_BENCHMARK_AUDIENCE,
      subject: LATENTSYNC_BENCHMARK_SUBJECT
    });

    if (
      payload.repository !== "Chasmet/sync30-api" ||
      payload.ref !== "refs/heads/main" ||
      payload.event_name !== "push"
    ) {
      return res.status(403).json({ ok: false, error: "Workflow non autorisé" });
    }

    return next();
  } catch (error) {
    console.error("LATENTSYNC BENCHMARK AUTH ERROR:", safeMessage(error));
    return res.status(401).json({ ok: false, error: "Jeton invalide" });
  }
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

function parseDurationSeconds(rawValue, maxSeconds) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return null;
  }

  const normalized = String(rawValue).replace(",", ".");
  const value = Number(normalized);

  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  if (value > maxSeconds) {
    return null;
  }

  return value;
}

function roundSecondsForBilling(durationSeconds) {
  const value = Number(durationSeconds);

  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const lower = Math.floor(value);
  const decimal = value - lower;

  let billed = decimal <= 0.5 ? lower : lower + 1;

  if (billed < 1) {
    billed = 1;
  }

  return billed;
}

// STORAGE
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

// WALLET
async function ensureWallet(userId) {
  const { data, error } = await supabase
    .from("time_wallets")
    .select(
      "user_id, seconds_balance, standard_seconds_balance, premium_seconds_balance"
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (data) {
    return data;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("time_wallets")
    .insert({
      user_id: userId,
      seconds_balance: 0,
      standard_seconds_balance: 0,
      premium_seconds_balance: 0
    })
    .select(
      "user_id, seconds_balance, standard_seconds_balance, premium_seconds_balance"
    )
    .single();

  if (insertError) {
    throw insertError;
  }

  return inserted;
}

function getBalanceFieldByType(type) {
  if (type === "premium") return "premium_seconds_balance";
  return "standard_seconds_balance";
}

async function getWalletState(userId) {
  const wallet = await ensureWallet(userId);

  return {
    userId: wallet.user_id,
    secondsBalance: Number(wallet.standard_seconds_balance || 0),
    standardSecondsBalance: Number(wallet.standard_seconds_balance || 0),
    premiumSecondsBalance: Number(wallet.premium_seconds_balance || 0)
  };
}

async function getBalanceByType(userId, type) {
  const wallet = await ensureWallet(userId);
  const field = getBalanceFieldByType(type);
  return Number(wallet[field] || 0);
}

async function updateBalances(userId, updates) {
  const { error } = await supabase
    .from("time_wallets")
    .update(updates)
    .eq("user_id", userId);

  if (error) {
    throw error;
  }
}

async function debitBalanceByType(userId, type, billedSeconds) {
  const wallet = await ensureWallet(userId);
  const field = getBalanceFieldByType(type);

  const currentBalance = Number(wallet[field] || 0);

  if (currentBalance < billedSeconds) {
    throw new Error("Pas assez de temps disponible");
  }

  const newBalance = currentBalance - billedSeconds;

  const updates = {
    [field]: newBalance
  };

  if (type === "standard") {
    updates.seconds_balance = newBalance;
  }

  await updateBalances(userId, updates);

  return newBalance;
}

async function refundBalanceByType(userId, type, refundedSeconds) {
  const wallet = await ensureWallet(userId);
  const field = getBalanceFieldByType(type);

  const currentBalance = Number(wallet[field] || 0);
  const newBalance = currentBalance + refundedSeconds;

  const updates = {
    [field]: newBalance
  };

  if (type === "standard") {
    updates.seconds_balance = newBalance;
  }

  await updateBalances(userId, updates);

  return newBalance;
}

// ROOT
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    status: "Server VEED OK",
    bucket: BUCKET,
    engine: ENGINE_FOLDER,
    balanceType: BALANCE_TYPE,
    retention: {
      maxVideosPerUser: MAX_VIDEOS_PER_USER,
      maxAgeHours: MAX_VIDEO_AGE_HOURS
    },
    billing: {
      mode: "seconds",
      maxVeedSeconds: MAX_VEED_SECONDS
    }
  });
});

// TEMPORAIRE : un unique essai LatentSync avec les médias de démo officiels.
app.get(
  "/__latentsync-benchmark/ready",
  requireBenchmarkOidc,
  (_req, res) => {
    return res.json({ ok: true, model: "bytedance/latentsync" });
  }
);

app.post(
  "/__latentsync-benchmark/start",
  requireBenchmarkOidc,
  async (_req, res) => {
    try {
      if (latentSyncBenchmarkPredictionId) {
        return res.json({
          ok: true,
          reused: true,
          predictionId: latentSyncBenchmarkPredictionId
        });
      }

      const replicateResponse = await fetch(
        "https://api.replicate.com/v1/predictions",
        {
          method: "POST",
          headers: {
            Authorization: `Token ${REPLICATE_API_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            version: LATENTSYNC_REPLICATE_VERSION,
            input: {
              video: LATENTSYNC_DEMO_VIDEO,
              audio: LATENTSYNC_DEMO_AUDIO,
              guidance_scale: 2,
              inference_steps: 20,
              seed: 1247
            }
          })
        }
      );

      const prediction = await replicateResponse.json();

      if (!replicateResponse.ok || !prediction?.id) {
        throw new Error(
          prediction?.detail ||
            prediction?.error ||
            "Impossible de lancer LatentSync"
        );
      }

      latentSyncBenchmarkPredictionId = prediction.id;
      console.log("LATENTSYNC BENCHMARK STARTED:", prediction.id);

      return res.status(202).json({
        ok: true,
        predictionId: prediction.id
      });
    } catch (error) {
      console.error("LATENTSYNC BENCHMARK START ERROR:", error);
      return res.status(502).json({ ok: false, error: safeMessage(error) });
    }
  }
);

app.get(
  "/__latentsync-benchmark/status/:predictionId",
  requireBenchmarkOidc,
  async (req, res) => {
    try {
      const predictionId = String(req.params.predictionId || "");

      if (
        !latentSyncBenchmarkPredictionId ||
        predictionId !== latentSyncBenchmarkPredictionId
      ) {
        return res.status(404).json({ ok: false, error: "Test introuvable" });
      }

      const replicateResponse = await fetch(
        `https://api.replicate.com/v1/predictions/${encodeURIComponent(predictionId)}`,
        {
          headers: {
            Authorization: `Token ${REPLICATE_API_TOKEN}`
          }
        }
      );
      const prediction = await replicateResponse.json();

      if (!replicateResponse.ok) {
        throw new Error(
          prediction?.detail || prediction?.error || "Statut Replicate indisponible"
        );
      }

      return res.json({
        ok: true,
        id: prediction.id,
        status: prediction.status,
        output: prediction.output || null,
        error: prediction.error || null,
        metrics: prediction.metrics || null,
        createdAt: prediction.created_at || null,
        startedAt: prediction.started_at || null,
        completedAt: prediction.completed_at || null
      });
    } catch (error) {
      console.error("LATENTSYNC BENCHMARK STATUS ERROR:", error);
      return res.status(502).json({ ok: false, error: safeMessage(error) });
    }
  }
);

// WALLET STATUS
app.get("/wallet", async (req, res) => {
  try {
    const userId = getUserId(req);
    const wallet = await getWalletState(userId);

    return res.json({
      ok: true,
      userId: wallet.userId,
      secondsBalance: wallet.secondsBalance,
      standardSecondsBalance: wallet.standardSecondsBalance,
      premiumSecondsBalance: wallet.premiumSecondsBalance
    });
  } catch (error) {
    console.error("WALLET ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeMessage(error)
    });
  }
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

      const detectedDuration =
        parseDurationSeconds(req.body?.duration_seconds, MAX_VEED_SECONDS) ??
        null;

      const billedSeconds = detectedDuration
        ? roundSecondsForBilling(detectedDuration)
        : 0;

      let balanceBeforeDebit = null;
      let balanceAfterDebit = null;

      if (billedSeconds > 0) {
        balanceBeforeDebit = await getBalanceByType(userId, BALANCE_TYPE);

        if (balanceBeforeDebit < billedSeconds) {
          return res.status(403).json({
            ok: false,
            error: "Pas assez de temps qualité disponible",
            balanceType: BALANCE_TYPE,
            secondsBalance: balanceBeforeDebit,
            premiumSecondsBalance: balanceBeforeDebit,
            requiredSeconds: billedSeconds
          });
        }
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

      if (billedSeconds > 0) {
        balanceAfterDebit = await debitBalanceByType(userId, BALANCE_TYPE, billedSeconds);
      } else {
        balanceAfterDebit = await getBalanceByType(userId, BALANCE_TYPE);
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
          if ((billedSeconds || 0) > 0) {
            balanceAfterDebit = await refundBalanceByType(userId, BALANCE_TYPE, billedSeconds);
          }

          throw new Error(data?.error || "Replicate a échoué");
        }
      }

      if (!outputUrl) {
        if ((billedSeconds || 0) > 0) {
          balanceAfterDebit = await refundBalanceByType(userId, BALANCE_TYPE, billedSeconds);
        }

        throw new Error("Timeout Replicate");
      }

      // 3. Télécharger vidéo finale
      const videoFetch = await fetch(outputUrl);
      if (!videoFetch.ok) {
        if ((billedSeconds || 0) > 0) {
          balanceAfterDebit = await refundBalanceByType(userId, BALANCE_TYPE, billedSeconds);
        }

        throw new Error("Impossible de télécharger la vidéo finale");
      }

      const videoArrayBuffer = await videoFetch.arrayBuffer();
      const videoBuffer = Buffer.from(videoArrayBuffer);

      // 4. Stockage Supabase
      const fileName = `veed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
      const filePath = buildStoragePath(userId, fileName);

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(filePath, videoBuffer, {
          contentType: "video/mp4",
          upsert: false
        });

      if (uploadError) {
        if ((billedSeconds || 0) > 0) {
          balanceAfterDebit = await refundBalanceByType(userId, BALANCE_TYPE, billedSeconds);
        }

        throw uploadError;
      }

      await enforceVideoRetention(userId);

      return res.json({
        ok: true,
        fileName,
        videoUrl: buildPlayUrl(fileName),
        playUrl: buildPlayUrl(fileName),
        downloadUrl: buildDownloadUrl(fileName),
        balanceType: BALANCE_TYPE,
        billedSeconds,
        secondsBalance: balanceAfterDebit,
        premiumSecondsBalance: balanceAfterDebit
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
