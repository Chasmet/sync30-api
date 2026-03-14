import express from "express"
import cors from "cors"
import multer from "multer"

const app = express()
app.use(cors())
app.use(express.json())

const storage = multer.memoryStorage()
const upload = multer({ storage: storage })

app.get("/", (req, res) => {
  res.json({
    status: "Sync30 API active",
    maxVideo: "32 sec support / 30 sec limite",
    maxAudio: "32 sec support / 30 sec limite"
  })
})

app.post("/upload", upload.fields([
  { name: "video", maxCount: 1 },
  { name: "audio", maxCount: 1 }
]), async (req, res) => {

  if (!req.files.video || !req.files.audio) {
    return res.status(400).json({ error: "Video ou audio manquant" })
  }

  const video = req.files.video[0]
  const audio = req.files.audio[0]

  console.log("Video reçue:", video.originalname)
  console.log("Audio reçu:", audio.originalname)

  res.json({
    status: "fichiers reçus",
    video: video.originalname,
    audio: audio.originalname,
    next: "sync lipsync IA"
  })
})

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log("Sync30 API running on port", PORT)
})
