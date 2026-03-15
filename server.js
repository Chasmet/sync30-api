import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import Replicate from "replicate";

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

const VEED_MODEL_ID = "sync/lipsync-2";

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

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

app.get("/", (req, res) => {
  res.json({
    status: "Sync30 API active",
    engines: ["veed"],
    modeInfo: {
      veed: `test ${VEED_MODEL_ID} via Replicate`
    }
  });
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

    try {
      if (!process.env.REPLICATE_API_TOKEN) {
        return res.status(500).json({
          error: "REPLICATE_API_TOKEN manquant sur Render"
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
        throw new Error(`Replicate status: ${result.status}`);
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

      safeDelete(videoFile.path);
      safeDelete(audioFile.path);
      safeDelete(normalizedVideoPath);
      safeDelete(normalizedAudioPath);

      if (!videoUrl) {
        return res.status(500).json({
          error: "Sortie VEED invalide"
        });
      }

      return res.json({
        ok: true,
        mode: "veed-premium",
        videoUrl
      });
    } catch (err) {
      console.error("VEED ERROR:", err);

      safeDelete(videoFile?.path);
      safeDelete(audioFile?.path);
      safeDelete(normalizedVideoPath);
      safeDelete(normalizedAudioPath);

      return res.status(500).json({
        error: "Erreur VEED",
        details: err.message
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Sync30 server running on port ${PORT}`);
});
