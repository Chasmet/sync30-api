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

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

app.get("/", (req, res) => {
  res.json({
    status: "Sync30 API active",
    engines: ["kling", "veed"],
    modeInfo: {
      kling: "remplacement audio simple",
      veed: "test Wav2Lip via Replicate"
    }
  });
});

function safeDelete(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

function convertVideoForWav2Lip(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions([
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-r 25",
        "-movflags +faststart"
      ])
      .videoFilters("scale='min(720,iw)':-2")
      .save(outputPath)
      .on("end", resolve)
      .on("error", reject);
  });
}

function convertAudioForWav2Lip(inputPath, outputPath) {
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

app.post(
  "/sync",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "audio", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const videoFile = req.files?.video?.[0];
      const audioFile = req.files?.audio?.[0];

      if (!videoFile || !audioFile) {
        return res.status(400).json({ error: "Vidéo ou audio manquant" });
      }

      const videoPath = videoFile.path;
      const audioPath = audioFile.path;
      const outputPath = `output_${Date.now()}.mp4`;

      ffmpeg(videoPath)
        .input(audioPath)
        .outputOptions([
          "-map 0:v:0",
          "-map 1:a:0",
          "-c:v copy",
          "-shortest"
        ])
        .save(outputPath)
        .on("end", () => {
          res.download(outputPath, "sync30-video.mp4", () => {
            safeDelete(videoPath);
            safeDelete(audioPath);
            safeDelete(outputPath);
          });
        })
        .on("error", (err) => {
          console.error("FFMPEG ERROR:", err);
          safeDelete(videoPath);
          safeDelete(audioPath);
          safeDelete(outputPath);
          return res.status(500).json({ error: "Erreur traitement vidéo" });
        });
    } catch (err) {
      console.error("SYNC ERROR:", err);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

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

      normalizedVideoPath = path.join("uploads", `video_norm_${Date.now()}.mp4`);
      normalizedAudioPath = path.join("uploads", `audio_norm_${Date.now()}.wav`);

      await convertVideoForWav2Lip(videoFile.path, normalizedVideoPath);
      await convertAudioForWav2Lip(audioFile.path, normalizedAudioPath);

      const videoBuffer = fs.readFileSync(normalizedVideoPath);
      const audioBuffer = fs.readFileSync(normalizedAudioPath);

      const predictionOutput = await replicate.run(
        "devxpy/cog-wav2lip:dd119ff7a14de737f58af04c8cc01d9d218cbf0fabc935d0aba86488bbfb0f8a",
        {
          input: {
            face: videoBuffer,
            audio: audioBuffer,
            smooth: true
          }
        }
      );

      let videoUrl = null;

      if (typeof predictionOutput === "string") {
        videoUrl = predictionOutput;
      } else if (Array.isArray(predictionOutput) && predictionOutput.length > 0) {
        videoUrl = String(predictionOutput[0]);
      } else if (predictionOutput && typeof predictionOutput.url === "function") {
        videoUrl = predictionOutput.url();
      } else if (predictionOutput && predictionOutput.toString) {
        videoUrl = predictionOutput.toString();
      }

      safeDelete(videoFile.path);
      safeDelete(audioFile.path);
      safeDelete(normalizedVideoPath);
      safeDelete(normalizedAudioPath);

      if (!videoUrl) {
        return res.status(500).json({
          error: "Sortie Wav2Lip invalide"
        });
      }

      return res.json({
        ok: true,
        mode: "wav2lip-test",
        videoUrl
      });
    } catch (err) {
      console.error("WAV2LIP ERROR:", err);
      safeDelete(videoFile?.path);
      safeDelete(audioFile?.path);
      safeDelete(normalizedVideoPath);
      safeDelete(normalizedAudioPath);

      return res.status(500).json({
        error: "Erreur Wav2Lip",
        details: err.message
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Sync30 server running on port ${PORT}`);
});
