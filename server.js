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

// Modèle lipsync testé via Replicate
const MODEL_ID = "ddvinh1/audio-lip";

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

function convertVideoForLipSync(inputPath, outputPath) {
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
      .videoFilters("scale='min(720,iw)':-2")
      .save(outputPath)
      .on("end", resolve)
      .on("error", reject);
  });
}

function convertAudioForLipSync(inputPath, outputPath) {
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

function mergeVideoAndAudio(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .input(audioPath)
      .outputOptions([
        "-map 0:v:0",
        "-map 1:a:0",
        "-c:v copy",
        "-shortest"
      ])
      .save(outputPath)
      .on("end", resolve)
      .on("error", reject);
  });
}

app.get("/", (req, res) => {
  res.json({
    status: "Sync30 API active",
    engines: ["kling", "veed"],
    modeInfo: {
      kling: "remplacement audio simple",
      veed: `test ${MODEL_ID} via Replicate`
    }
  });
});

/*
  Mode Kling = remplacement audio simple
*/
app.post(
  "/sync",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "audio", maxCount: 1 }
  ]),
  async (req, res) => {
    const videoFile = req.files?.video?.[0];
    const audioFile = req.files?.audio?.[0];
    let outputPath = null;

    try {
      if (!videoFile || !audioFile) {
        return res.status(400).json({ error: "Vidéo ou audio manquant" });
      }

      outputPath = `output_${Date.now()}.mp4`;

      await mergeVideoAndAudio(videoFile.path, audioFile.path, outputPath);

      return res.download(outputPath, "sync30-video.mp4", () => {
        safeDelete(videoFile.path);
        safeDelete(audioFile.path);
        safeDelete(outputPath);
      });
    } catch (err) {
      console.error("SYNC ERROR:", err);
      safeDelete(videoFile?.path);
      safeDelete(audioFile?.path);
      safeDelete(outputPath);
      return res.status(500).json({
        error: "Erreur traitement vidéo",
        details: err.message
      });
    }
  }
);

/*
  Mode VEED = test lipsync IA via Replicate
*/
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

      normalizedVideoPath = path.join(
        "uploads",
        `video_norm_${Date.now()}.mp4`
      );
      normalizedAudioPath = path.join(
        "uploads",
        `audio_norm_${Date.now()}.wav`
      );

      console.log("LIPSYNC START");
      console.log("Model:", MODEL_ID);
      console.log("Original video:", videoFile.originalname);
      console.log("Original audio:", audioFile.originalname);

      await convertVideoForLipSync(videoFile.path, normalizedVideoPath);
      await convertAudioForLipSync(audioFile.path, normalizedAudioPath);

      const videoBuffer = fs.readFileSync(normalizedVideoPath);
      const audioBuffer = fs.readFileSync(normalizedAudioPath);

      const predictionOutput = await replicate.run(MODEL_ID, {
        input: {
          face: videoBuffer,
          audio: audioBuffer
        }
      });

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

      console.log("LIPSYNC OUTPUT:", videoUrl);

      safeDelete(videoFile.path);
      safeDelete(audioFile.path);
      safeDelete(normalizedVideoPath);
      safeDelete(normalizedAudioPath);

      if (!videoUrl) {
        return res.status(500).json({
          error: "Sortie lipsync invalide"
        });
      }

      return res.json({
        ok: true,
        mode: "audio-lip-test",
        videoUrl
      });
    } catch (err) {
      console.error("LIPSYNC ERROR:", err);
      safeDelete(videoFile?.path);
      safeDelete(audioFile?.path);
      safeDelete(normalizedVideoPath);
      safeDelete(normalizedAudioPath);

      return res.status(500).json({
        error: "Erreur lipsync",
        details: err.message
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Sync30 server running on port ${PORT}`);
});
