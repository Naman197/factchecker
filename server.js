const express = require("express");
const multer = require("multer");
const unzipper = require("unzipper");
const xml2js = require("xml2js");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");

const app = express();
const PORT = 7002;

const GEMINI_API_KEY = 'AIzaSyDSnR_pRyH7lZ1A0TmCJIIhGgLxDO89sDo';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`;
const ASSEMBLYAI_API_KEY = '3b7f8a7080da48c194734ca08ef56d18';

app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

async function extractPptxContent(pptxPath) {
  const directory = await unzipper.Open.file(pptxPath);
  const texts = [];
  const images = [];

  const slideFiles = directory.files.filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f.path));
  for (const file of slideFiles) {
    const content = await file.buffer();
    const parsed = await xml2js.parseStringPromise(content);
    const shapes = parsed["p:sld"]["p:cSld"][0]["p:spTree"][0]["p:sp"] || [];

    for (const shape of shapes) {
      const paragraphs = shape["p:txBody"]?.[0]?.["a:p"] || [];
      for (const paragraph of paragraphs) {
        const runs = paragraph["a:r"] || [];
        for (const run of runs) {
          const text = run["a:t"]?.[0];
          if (text) texts.push(text);
        }
      }
    }
  }

  const mediaFiles = directory.files.filter(f => /^ppt\/media\/image\d+\.(png|jpeg|jpg|gif)$/.test(f.path));
  for (const file of mediaFiles) {
    const buffer = await file.buffer();
    const ext = path.extname(file.path);
    const base64 = buffer.toString("base64");
    images.push({
      filename: path.basename(file.path),
      base64: `data:image/${ext.slice(1)};base64,${base64}`
    });
  }

  return { texts, images };
}

async function convertToFlac(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat("flac")
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .save(outputPath);
  });
}

async function transcribeAudio(audioPath) {
  console.log("Starting transcription process...");

  const flacPath = `${audioPath}.flac`;
  await convertToFlac(audioPath, flacPath);

  const audioBuffer = fs.readFileSync(flacPath);

  const uploadResponse = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
    headers: {
      authorization: ASSEMBLYAI_API_KEY,
      'content-type': 'application/octet-stream',
    },
  });

  const uploadUrl = uploadResponse.data.upload_url;
  console.log("Audio uploaded. Starting transcription...");

  const transcriptionRequest = await axios.post('https://api.assemblyai.com/v2/transcript', {
    audio_url: uploadUrl
  }, {
    headers: {
      authorization: ASSEMBLYAI_API_KEY
    }
  });

  const transcriptId = transcriptionRequest.data.id;

  let transcript = "";
  let isDone = false;

  while (!isDone) {
    const statusRes = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
      headers: { authorization: ASSEMBLYAI_API_KEY }
    });

    if (statusRes.data.status === 'completed') {
      transcript = statusRes.data.text;
      isDone = true;
    } else if (statusRes.data.status === 'failed') {
      throw new Error("Transcription failed");
    }

    await new Promise(r => setTimeout(r, 5000)); // Polling delay
  }

  fs.unlinkSync(flacPath);
  return transcript || "No transcription available.";
}

function generateFactCheckPrompt({ texts, transcript }) {
  return `
You are an expert fact checker. Here's a slide deck with optional spoken narration. 

**Slide Content:**
${texts.join("\n")}

**Narration Transcript:**
${transcript}

Please:
- Extract factual claims
- Classify each as Correct / Misleading / Incorrect
- Provide short explanations

Return result in clear bullet-point format.
`;
}

app.post("/factcheck", upload.fields([{ name: "pptx" }, { name: "audio" }]), async (req, res) => {
  try {
    const pptxPath = req.files["pptx"]?.[0]?.path;
    const audioPath = req.files["audio"]?.[0]?.path;

    if (!pptxPath) return res.status(400).json({ error: "Missing PPTX file" });

    const { texts, images } = await extractPptxContent(pptxPath);
    const transcript = audioPath ? await transcribeAudio(audioPath) : "No audio provided.";

    const prompt = generateFactCheckPrompt({ texts, transcript });

    const requestData = {
      contents: [{ parts: [{ text: prompt }] }],
    };

    const geminiResponse = await axios.post(GEMINI_API_URL, requestData, {
      headers: { "Content-Type": "application/json" },
    });

    const factCheck = geminiResponse?.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No Gemini response.";

    fs.unlinkSync(pptxPath);
    if (audioPath) fs.unlinkSync(audioPath);

    res.json({ factCheck, texts, images, transcript });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Processing error", details: err.message });
  }
});

app.post("/extract-pptx", upload.single("pptx"), async (req, res) => {
  try {
    const pptxPath = req.file?.path;
    if (!pptxPath) return res.status(400).json({ error: "Missing PPTX file" });

    const { texts, images } = await extractPptxContent(pptxPath);
    fs.unlinkSync(pptxPath);

    res.json({ texts, images });
  } catch (err) {
    console.error("Error extracting PPTX:", err);
    res.status(500).json({ error: "Failed to extract PPTX", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
