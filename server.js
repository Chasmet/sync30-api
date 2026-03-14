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

app.get("/", (req, res) => {
  res.json({
    status: "Sync30 API active",
    maxVideo: "32 sec support / 30 sec limite",
    maxAudio: "32 sec support / 30 sec limite",
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

      return res.json({
        ok: true,
        message: `Fichiers reçus avec succès. Moteur sélectionné : ${engine.toUpperCase()}`,
        engine,
        videoName: video.originalname,
        audioName: audio.originalname,
        nextStep: "Brancher le vrai moteur lipsync"
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
