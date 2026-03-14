import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

const ALLOWED_ENGINES = ["kling", "veed"];
const KLING_MAX_SECONDS = 9;
const VEED_DISPLAY_SECONDS = 30;
const VEED_TOLERANCE_SECONDS = 32;

app.get("/", (req, res) => {
  res.json({
    status: "Sync30 API active",
    maxVideo: "Kling 9 sec max / VEED 30 sec affichées, 32 sec tolérées",
    maxAudio: "Kling 9 sec max / VEED 30 sec affichées, 32 sec tolérées",
    engines: ALLOWED_ENGINES
  });
});

app.post(
  "/upload",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "audio", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const video = req.files?.video?.[0];
      const audio = req.files?.audio?.[0];
      const engine = (req.body?.engine || "kling").toLowerCase();

      if (!video || !audio) {
        return res.status(400).json({
          ok: false,
          error: "Vidéo ou audio manquant"
        });
      }

      if (!ALLOWED_ENGINES.includes(engine)) {
        return res.status(400).json({
          ok: false,
          error: "Moteur lipsync non supporté"
        });
      }

      const limits =
        engine === "kling"
          ? {
              displayMaxSeconds: KLING_MAX_SECONDS,
              toleratedMaxSeconds: KLING_MAX_SECONDS
            }
          : {
              displayMaxSeconds: VEED_DISPLAY_SECONDS,
              toleratedMaxSeconds: VEED_TOLERANCE_SECONDS
            };

      return res.json({
        ok: true,
        message: `Fichiers reçus avec succès. Moteur sélectionné : ${engine.toUpperCase()}`,
        engine,
        limits,
        videoName: video.originalname,
        audioName: audio.originalname,
        uploadedAudioNotice:
          "À cette étape, le serveur reçoit bien le nouvel audio, mais ne remplace pas encore la piste audio de la vidéo."
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: "Erreur serveur",
        details: error.message
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Sync30 API running on port ${PORT}`);
});
