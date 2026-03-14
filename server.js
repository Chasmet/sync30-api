import express from "express";
import cors from "cors";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";

const app = express();
app.use(cors());

const upload = multer({ dest: "uploads/" });

app.get("/", (req, res) => {
  res.json({
    status: "Sync30 API active",
    engines: ["kling", "veed"],
    maxVideo: "kling 9 sec / veed 30 sec",
    tolerance: "32 sec tolérées"
  });
});

app.post("/sync", upload.fields([
  { name: "video", maxCount: 1 },
  { name: "audio", maxCount: 1 }
]), async (req, res) => {

  try {

    const videoPath = req.files.video[0].path;
    const audioPath = req.files.audio[0].path;

    const output = "output_" + Date.now() + ".mp4";

    ffmpeg(videoPath)
      .outputOptions("-map 0:v:0")
      .outputOptions("-map 1:a:0")
      .input(audioPath)
      .outputOptions("-shortest")
      .save(output)
      .on("end", () => {

        res.download(output, () => {

          fs.unlinkSync(videoPath);
          fs.unlinkSync(audioPath);
          fs.unlinkSync(output);

        });

      });

  } catch (err) {

    res.status(500).json({ error: "processing error" });

  }

});

const port = process.env.PORT || 10000;

app.listen(port, () => {
  console.log("Sync30 server running");
});
