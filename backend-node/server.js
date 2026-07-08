import express from "express";
import cors from "cors";
import "dotenv/config";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ProxyAgent } from "undici";
import captionExtractor, { getSubtitles as namedGetSubtitles } from "youtube-caption-extractor";

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 8000);
const getSubtitles = namedGetSubtitles || captionExtractor.getSubtitles;

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const AI_BASE_URL = process.env.AI_BASE_URL || "https://api.cerebras.ai/v1";
const MAX_TRANSCRIPT_CHARS = Number(process.env.MAX_TRANSCRIPT_CHARS || 45000);
const GEMINI_API_KEY = (
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_GENAI_API_KEY ||
  ""
).trim();
const GEMINI_MODELS = (
  process.env.GEMINI_MODELS ||
  process.env.GEMINI_MODEL ||
  "gemini-2.0-flash,gemini-1.5-flash,gemini-2.5-flash"
)
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const PROXY_URL = (
  process.env.WEBSHARE_PROXY_URL ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  ""
).trim();
const proxyAgent = PROXY_URL ? new ProxyAgent(PROXY_URL) : null;

const defaultCorsOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://youtubesynopsis.vercel.app",
];
const corsEntries = [
  ...defaultCorsOrigins,
  "https://youtubesynopsis-*.vercel.app",
  ...(process.env.CORS_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean),
];
const exactOrigins = new Set(corsEntries.filter((origin) => !origin.includes("*")));
const originPatterns = corsEntries
  .filter((origin) => origin.includes("*"))
  .map((origin) => new RegExp(`^${origin.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, "[^/]*")}$`));

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || exactOrigins.has(origin) || originPatterns.some((pattern) => pattern.test(origin))) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS blocked origin: ${origin}`));
  },
}));
app.use(express.json({ limit: "6mb" }));
app.use(express.urlencoded({ extended: true }));

const rawDatabaseUrl = process.env.DATABASE_URL || "";
const pool = rawDatabaseUrl
  ? new Pool({
      connectionString: rawDatabaseUrl,
      ssl: rawDatabaseUrl.includes("localhost") || rawDatabaseUrl.includes("127.0.0.1")
        ? false
        : { rejectUnauthorized: false },
    })
  : null;

const cerebras = new OpenAI({
  apiKey: process.env.CEREBRAS_API_KEY || "missing-key",
  baseURL: AI_BASE_URL,
});
const gemini = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

function modelList() {
  return (process.env.CEREBRAS_MODELS || process.env.AI_MODEL || "gpt-oss-120b,llama-3.3-70b,llama3.1-8b")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

async function db(query, params = []) {
  if (!pool) {
    throw Object.assign(new Error("DATABASE_URL is not configured."), { statusCode: 503 });
  }
  return pool.query(query, params);
}

async function initDb() {
  if (!pool) return;
  await db(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR UNIQUE NOT NULL,
      password_hash VARCHAR NOT NULL,
      name VARCHAR,
      role VARCHAR DEFAULT 'User',
      location VARCHAR,
      bio TEXT
    );
    CREATE TABLE IF NOT EXISTS summaries (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      youtube_url VARCHAR NOT NULL,
      title VARCHAR,
      channel VARCHAR,
      duration INTEGER,
      thumbnail VARCHAR,
      transcript TEXT,
      caption_segments JSONB,
      caption_summaries JSONB,
      summary_text TEXT,
      keywords JSONB,
      chapters JSONB,
      key_points JSONB,
      questions JSONB,
      action_items JSONB,
      language VARCHAR,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS comparisons (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      youtube_url_1 VARCHAR NOT NULL,
      youtube_url_2 VARCHAR NOT NULL,
      goal TEXT,
      language VARCHAR,
      video_1 JSONB,
      video_2 JSONB,
      combined_summary TEXT,
      common_points JSONB,
      differences JSONB,
      best_takeaways JSONB,
      verdict JSONB,
      best_overall_video JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS presentations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      title VARCHAR NOT NULL,
      source_type VARCHAR,
      source_id INTEGER,
      slides_json JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const email = (process.env.ADMIN_EMAIL || "admin@synopsis.local").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "Admin@12345";
  const name = process.env.ADMIN_NAME || "Synopsis Admin";
  const existing = await db("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
  if (!existing.rows.length) {
    await db(
      "INSERT INTO users (email, password_hash, name, role, location, bio) VALUES ($1, $2, $3, 'Admin', '', 'Backend administrator account.')",
      [email, await bcrypt.hash(password, 12), name],
    );
  }
}

function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name || "",
    role: user.role || "User",
    location: user.location || "",
    bio: user.bio || "",
  };
}

function serializeSummary(row) {
  return {
    id: row.id,
    youtube_url: row.youtube_url,
    title: row.title || "YouTube Video",
    channel: row.channel || "",
    duration: row.duration,
    thumbnail: row.thumbnail || "",
    transcript: row.transcript || "",
    caption_segments: row.caption_segments || [],
    caption_summaries: row.caption_summaries || [],
    summary: row.summary_text || "",
    keywords: row.keywords || [],
    chapters: row.chapters || [],
    key_points: row.key_points || [],
    questions: row.questions || [],
    action_items: row.action_items || [],
    language: row.language || "English",
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function signToken(user) {
  return jwt.sign({ sub: user.email, user_id: user.id }, JWT_SECRET, { expiresIn: "7d" });
}

async function requireUser(req, res, next) {
  try {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ detail: "Not authenticated." });
    const payload = jwt.verify(token, JWT_SECRET);
    const result = await db("SELECT * FROM users WHERE lower(email) = lower($1)", [payload.sub]);
    if (!result.rows.length) return res.status(401).json({ detail: "User not found." });
    req.user = result.rows[0];
    next();
  } catch {
    return res.status(401).json({ detail: "Your session expired. Please sign in again." });
  }
}

function requireAdmin(req, res, next) {
  if ((req.user?.role || "User") !== "Admin") {
    return res.status(403).json({ detail: "Not authorized. Admins only." });
  }
  next();
}

function extractYouTubeId(input) {
  const value = String(input || "").trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=|youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function secondsToTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function cleanText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\[Music\]|\[Applause\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSegments(lines) {
  return (lines || [])
    .map((line) => {
      const start = Number(line.start || line.start_seconds || 0);
      const duration = Number(line.dur || line.duration || 0);
      const text = cleanText(line.text);
      if (!text) return null;
      return {
        time: secondsToTime(start),
        end_time: secondsToTime(start + duration),
        start_seconds: start,
        end_seconds: start + duration,
        text,
      };
    })
    .filter(Boolean);
}

function buildCaptionWindows(segments, windowSeconds = 30) {
  if (!segments.length) return [];
  const lastSecond = Math.ceil(Math.max(...segments.map((segment) => segment.end_seconds || 0))) + 1;
  const windows = [];
  for (let start = 0; start < Math.max(lastSecond, windowSeconds); start += windowSeconds) {
    const end = start + windowSeconds;
    const captions = segments.filter((segment) => segment.start_seconds >= start && segment.start_seconds < end);
    const text = captions.map((segment) => segment.text).join(" ").trim();
    if (!text) continue;
    windows.push({
      start_seconds: start,
      end_seconds: Math.min(end, lastSecond),
      start_time: secondsToTime(start),
      end_time: secondsToTime(Math.min(end, lastSecond)),
      captions,
      text,
      summary: "",
    });
  }
  return windows;
}

function parseJson3Captions(raw) {
  const payload = JSON.parse(raw);
  return (payload.events || [])
    .map((event) => {
      const text = cleanText((event.segs || []).map((seg) => seg.utf8 || "").join(""));
      if (!text) return null;
      const start = Number(event.tStartMs || 0) / 1000;
      const duration = Number(event.dDurationMs || 0) / 1000;
      return { start, dur: duration, text };
    })
    .filter(Boolean);
}

async function proxyFetch(url, init = {}) {
  return fetch(url, proxyAgent ? { ...init, dispatcher: proxyAgent } : init);
}

async function fetchTimedText(videoId, language) {
  const languageCodes = [...new Set([language, "en", "en-US", "en-GB"].filter(Boolean))];
  const endpoints = ["https://video.google.com/timedtext", "https://www.youtube.com/api/timedtext"];
  for (const endpoint of endpoints) {
    for (const lang of languageCodes) {
      for (const kind of ["", "asr"]) {
        const params = new URLSearchParams({ v: videoId, lang, fmt: "json3" });
        if (kind) params.set("kind", kind);
        try {
          const response = await proxyFetch(`${endpoint}?${params}`, {
            headers: {
              "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
              "accept-language": "en-US,en;q=0.9",
            },
          });
          if (!response.ok) continue;
          const raw = await response.text();
          if (!raw.trim()) continue;
          const captions = parseJson3Captions(raw);
          if (captions.length) return captions;
        } catch {
          continue;
        }
      }
    }
  }
  return [];
}

function outputLanguageToCaptionCodes(language) {
  const map = {
    English: ["en"],
    Hindi: ["hi", "en"],
    Telugu: ["te", "en"],
    Tamil: ["ta", "en"],
    Spanish: ["es", "en"],
    French: ["fr", "en"],
    German: ["de", "en"],
    Mandarin: ["zh-Hans", "zh-CN", "zh", "en"],
    Arabic: ["ar", "en"],
    Japanese: ["ja", "en"],
    Russian: ["ru", "en"],
    Portuguese: ["pt", "pt-BR", "en"],
  };
  return map[language] || ["en"];
}

async function fetchTranscript(youtubeUrl, outputLanguage = "English") {
  const videoId = extractYouTubeId(youtubeUrl);
  if (!videoId) {
    throw Object.assign(new Error("Invalid YouTube URL."), { statusCode: 400 });
  }

  let lines = [];
  for (const lang of outputLanguageToCaptionCodes(outputLanguage)) {
    lines = await fetchTimedText(videoId, lang);
    if (lines.length) break;
    try {
      lines = await getSubtitles({ videoID: videoId, lang });
      if (lines.length) break;
    } catch (error) {
      console.log(`[Transcript] getSubtitles failed lang=${lang}: ${error.message}`);
    }
  }

  const segments = normalizeSegments(lines);
  if (!segments.length) {
    throw Object.assign(
      new Error("Could not read this YouTube video. Please use a public video with captions enabled, or set WEBSHARE_PROXY_URL on Render."),
      { statusCode: 502 },
    );
  }

  const duration = Math.ceil(Math.max(...segments.map((segment) => segment.end_seconds || 0))) + 1;
  const transcript = segments.map((segment) => `[${segment.time}] ${segment.text}`).join("\n").slice(0, MAX_TRANSCRIPT_CHARS);
  return {
    title: "YouTube Video",
    channel: "",
    duration,
    thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    transcript,
    caption_segments: segments,
    caption_windows: buildCaptionWindows(segments),
  };
}

async function generateText(messages, { temperature = 0.15, maxTokens = 1800, json = false } = {}) {
  const errors = [];
  for (const model of modelList()) {
    try {
      const response = await cerebras.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: "json_object" } } : {}),
      });
      return response.choices?.[0]?.message?.content || "";
    } catch (error) {
      errors.push(`${model}: ${error.status || error.response?.status || "unknown"} ${error.message}`);
      console.error(`[Cerebras] ${errors[errors.length - 1]}`);
    }
  }
  throw Object.assign(new Error(`Cerebras request failed. ${errors.join(" | ")}`), { statusCode: 502 });
}

function jsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

async function generateSummaryFeatures(transcript, mode = "normal", customPrompt = "", outputLanguage = "English") {
  const guidance = customPrompt || mode || "normal";
  const content = await generateText([
    {
      role: "system",
      content: "Return only valid JSON for a YouTube summary app.",
    },
    {
      role: "user",
      content:
        `Write in ${outputLanguage}. Purpose/mode: ${guidance}.\n` +
        "Return JSON with keys: summary, keywords, chapters, key_points, questions, action_items.\n" +
        "summary: clear markdown summary. keywords: 6 strings. chapters: 4-8 objects with title,time,summary. " +
        "key_points: 6-10 strings. questions: 5 objects with type,question,answer,options,correct_answer. " +
        "action_items: 3-8 strings.\n\nTranscript:\n" +
        transcript.slice(0, MAX_TRANSCRIPT_CHARS),
    },
  ], { json: true, maxTokens: 2400 });

  const data = jsonFromText(content);
  return {
    summary: data.summary || "Summary generated, but the model returned a short response.",
    keywords: asArray(data.keywords),
    chapters: asArray(data.chapters),
    key_points: asArray(data.key_points),
    questions: asArray(data.questions),
    action_items: asArray(data.action_items),
  };
}

async function generateDirectYouTubeSummary(youtubeUrl, mode = "normal", customPrompt = "", outputLanguage = "English") {
  if (!gemini) {
    throw Object.assign(
      new Error("YouTube captions were blocked and GEMINI_API_KEY is not set for direct YouTube fallback."),
      { statusCode: 502 },
    );
  }

  const guidance = customPrompt || mode || "normal";
  const prompt =
    `Analyze this YouTube video directly and write in ${outputLanguage}. Purpose/mode: ${guidance}.\n` +
    "Return only valid JSON with keys: title, summary, keywords, chapters, caption_summaries, key_points, questions, action_items, transcript_notes.\n" +
    "summary: clear markdown summary. keywords: 6 strings. chapters: 4-8 objects with title,time,summary. " +
    "caption_summaries: 4-8 objects with start_time,end_time,summary,text for the most important moments. " +
    "key_points: 6-10 strings. questions: 5 objects with type,question,answer,options,correct_answer. " +
    "action_items: 3-8 strings. transcript_notes: concise detailed notes that can be shown when exact captions are unavailable. " +
    "If exact timestamps are unavailable, use approximate timestamp ranges like 00:00 - 00:30.";

  let response;
  const errors = [];
  for (const model of GEMINI_MODELS) {
    try {
      response = await gemini.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: {
                  mimeType: "video/mp4",
                  fileUri: youtubeUrl,
                },
              },
              { text: prompt },
            ],
          },
        ],
        config: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      });
      break;
    } catch (error) {
      const message = error?.message || String(error);
      errors.push(`${model}: ${message}`);
      console.error(`[Gemini fallback] ${model} failed: ${message}`);
    }
  }

  if (!response) {
    throw Object.assign(
      new Error(
        "Gemini direct YouTube fallback failed. Check that GEMINI_API_KEY is from Google AI Studio and that the Gemini API is enabled. " +
          errors.join(" | "),
      ),
      { statusCode: 502 },
    );
  }

  const data = jsonFromText(response.text || "");
  return {
    title: data.title || "YouTube Video",
    summary: data.summary || "Summary generated from the YouTube video.",
    keywords: asArray(data.keywords),
    chapters: asArray(data.chapters),
    caption_summaries: asArray(data.caption_summaries),
    key_points: asArray(data.key_points),
    questions: asArray(data.questions),
    action_items: asArray(data.action_items),
    transcript_notes: data.transcript_notes || "",
  };
}

function summarizeWindows(windows) {
  return windows.slice(0, 120).map((window) => ({
    ...window,
    summary: cleanText(window.text).split(/[.!?]/)[0]?.slice(0, 180) || cleanText(window.text).slice(0, 180),
  }));
}

function fallbackCaptionSummaries(generated) {
  const directCaptions = asArray(generated.caption_summaries)
    .map((item, index) => ({
      start_seconds: index * 30,
      end_seconds: index * 30 + 30,
      start_time: item.start_time || item.time || secondsToTime(index * 30),
      end_time: item.end_time || secondsToTime(index * 30 + 30),
      captions: [],
      text: item.text || item.summary || "",
      summary: item.summary || item.text || "",
    }))
    .filter((item) => item.summary || item.text);

  if (directCaptions.length) return directCaptions;

  const chapterCaptions = asArray(generated.chapters)
    .map((chapter, index) => ({
      start_seconds: index * 30,
      end_seconds: index * 30 + 30,
      start_time: chapter.time || secondsToTime(index * 30),
      end_time: secondsToTime(index * 30 + 30),
      captions: [],
      text: chapter.summary || chapter.title || "",
      summary: chapter.summary || chapter.title || "",
    }))
    .filter((item) => item.summary || item.text);

  if (chapterCaptions.length) return chapterCaptions;

  return asArray(generated.key_points).slice(0, 8).map((point, index) => ({
    start_seconds: index * 30,
    end_seconds: index * 30 + 30,
    start_time: secondsToTime(index * 30),
    end_time: secondsToTime(index * 30 + 30),
    captions: [],
    text: String(point),
    summary: String(point),
  }));
}

function fallbackTranscriptNotes(generated) {
  return [
    generated.summary,
    asArray(generated.key_points).length ? `Key points:\n${asArray(generated.key_points).map((item) => `- ${item}`).join("\n")}` : "",
    asArray(generated.action_items).length ? `Actions:\n${asArray(generated.action_items).map((item) => `- ${item}`).join("\n")}` : "",
    generated.transcript_notes,
  ]
    .filter(Boolean)
    .join("\n\n");
}

app.get("/api/health", async (_req, res) => {
  let database = "not_configured";
  try {
    if (pool) {
      await db("SELECT 1");
      database = "ok";
    }
  } catch {
    database = "error";
  }
  res.json({
    status: "ok",
    runtime: "node",
    database,
    proxy_enabled: Boolean(PROXY_URL),
    gemini_fallback_enabled: Boolean(GEMINI_API_KEY),
  });
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const name = String(req.body.name || "").trim();
    if (!email || !password || !name) return res.status(400).json({ detail: "Name, email, and password are required." });
    const existing = await db("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
    if (existing.rows.length) return res.status(400).json({ detail: "Email is already registered." });
    const result = await db(
      "INSERT INTO users (email, password_hash, name, role, location, bio) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [email, await bcrypt.hash(password, 12), name, req.body.role || "User", req.body.location || "", req.body.bio || ""],
    );
    res.json({ message: "User registered successfully", user: serializeUser(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const email = String(req.body.username || req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const result = await db("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ detail: "Invalid email or password." });
    }
    res.json({ access_token: signToken(user), token_type: "bearer", user: serializeUser(user) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/users/me", requireUser, (req, res) => {
  res.json(serializeUser(req.user));
});

app.put("/api/users/profile", requireUser, async (req, res, next) => {
  try {
    const result = await db(
      "UPDATE users SET name = $1, role = $2, location = $3, bio = $4 WHERE id = $5 RETURNING *",
      [req.body.name || req.user.name, req.body.role || req.user.role, req.body.location || "", req.body.bio || "", req.user.id],
    );
    res.json(serializeUser(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.post("/api/summarize", requireUser, async (req, res, next) => {
  try {
    const youtubeUrl = req.body.youtube_url;
    const language = req.body.output_language || "English";
    const videoId = extractYouTubeId(youtubeUrl);
    let video;
    let captionSummaries = [];
    let generated;

    try {
      video = await fetchTranscript(youtubeUrl, language);
      captionSummaries = summarizeWindows(video.caption_windows || []);
      generated = await generateSummaryFeatures(video.transcript, req.body.mode, req.body.custom_prompt, language);
    } catch (transcriptError) {
      console.warn(`[Summarize] Caption path failed, trying Gemini direct fallback: ${transcriptError.message}`);
      generated = await generateDirectYouTubeSummary(youtubeUrl, req.body.mode, req.body.custom_prompt, language);
      video = {
        title: generated.title || "YouTube Video",
        channel: "",
        duration: null,
        thumbnail: videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : "",
        transcript: fallbackTranscriptNotes(generated),
        caption_segments: [],
        caption_windows: [],
      };
      captionSummaries = fallbackCaptionSummaries(generated);
    }

    const result = await db(
      `INSERT INTO summaries
       (user_id, youtube_url, title, channel, duration, thumbnail, transcript, caption_segments, caption_summaries,
        summary_text, keywords, chapters, key_points, questions, action_items, language)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        req.user.id,
        youtubeUrl,
        video.title,
        video.channel,
        video.duration,
        video.thumbnail,
        video.transcript,
        JSON.stringify(video.caption_segments),
        JSON.stringify(captionSummaries),
        generated.summary,
        JSON.stringify(generated.keywords),
        JSON.stringify(generated.chapters),
        JSON.stringify(generated.key_points),
        JSON.stringify(generated.questions),
        JSON.stringify(generated.action_items),
        language,
      ],
    );
    res.json({ message: "Video successfully summarized", data: serializeSummary(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/summaries/recent", requireUser, async (req, res, next) => {
  try {
    const result = await db("SELECT * FROM summaries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25", [req.user.id]);
    res.json(result.rows.map(serializeSummary));
  } catch (error) {
    next(error);
  }
});

app.post("/api/summaries/:summaryId/hydrate", requireUser, async (req, res, next) => {
  try {
    const result = await db("SELECT * FROM summaries WHERE id = $1 AND user_id = $2", [req.params.summaryId, req.user.id]);
    if (!result.rows.length) return res.status(404).json({ detail: "Summary not found." });
    res.json({ data: serializeSummary(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/summary/chat", requireUser, async (req, res, next) => {
  try {
    const answer = await generateText([
      { role: "system", content: "Answer only from the provided summary/transcript context. Be concise." },
      { role: "user", content: `Question: ${req.body.question}\n\nSummary:\n${req.body.summary || ""}\n\nTranscript:\n${String(req.body.transcript || "").slice(0, 12000)}` },
    ], { maxTokens: 600, temperature: 0.3 });
    res.json({ answer });
  } catch (error) {
    next(error);
  }
});

app.post("/api/summary/translate", requireUser, async (req, res, next) => {
  try {
    const translated = await generateText([
      { role: "system", content: "Return only valid JSON. Preserve the input structure." },
      { role: "user", content: `Translate this summary data to ${req.body.language}:\n${JSON.stringify(req.body.data).slice(0, 30000)}` },
    ], { json: true, maxTokens: 2200 });
    res.json({ data: { ...req.body.data, ...jsonFromText(translated), language: req.body.language } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/video/features", requireUser, async (req, res, next) => {
  try {
    const transcript = req.body.transcript || (await fetchTranscript(req.body.youtube_url)).transcript;
    const generated = await generateSummaryFeatures(transcript);
    res.json({ data: { transcript, ...generated } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/compare-videos", requireUser, async (req, res, next) => {
  try {
    const language = req.body.output_language || "English";
    const video1 = await fetchTranscript(req.body.youtube_url_1, language);
    const video2 = await fetchTranscript(req.body.youtube_url_2, language);
    const raw = await generateText([
      { role: "system", content: "Return only valid JSON for a two-video comparison." },
      {
        role: "user",
        content:
          `Write in ${language}. Goal: ${req.body.comparison_goal || "Compare these videos"}.\n` +
          "Return JSON keys: combined_summary, common_points, differences, best_takeaways, verdict, best_overall_video.\n\n" +
          `Video 1:\n${video1.transcript.slice(0, 18000)}\n\nVideo 2:\n${video2.transcript.slice(0, 18000)}`,
      },
    ], { json: true, maxTokens: 2400 });
    const data = jsonFromText(raw);
    const payload = {
      video_1: { ...video1, transcript: video1.transcript },
      video_2: { ...video2, transcript: video2.transcript },
      combined_summary: data.combined_summary || "",
      common_points: asArray(data.common_points),
      differences: asArray(data.differences),
      best_takeaways: asArray(data.best_takeaways),
      verdict: data.verdict || {},
      best_overall_video: data.best_overall_video || {},
      language,
    };
    res.json({ message: "Videos successfully compared", data: payload });
  } catch (error) {
    next(error);
  }
});

app.get("/api/comparisons/recent", requireUser, (_req, res) => {
  res.json([]);
});

app.post("/api/presentations", requireUser, async (req, res, next) => {
  try {
    const result = await db(
      "INSERT INTO presentations (user_id, title, source_type, source_id, slides_json) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [req.user.id, req.body.title || "Presentation", req.body.source_type || null, req.body.source_id || null, JSON.stringify(req.body.slides || [])],
    );
    res.json({ data: { id: result.rows[0].id, ...req.body } });
  } catch (error) {
    next(error);
  }
});

app.post("/api/presentations/improve-slide", requireUser, async (req, res) => {
  res.json({ slide: req.body.slide });
});

app.get("/api/admin/users", requireUser, requireAdmin, async (_req, res, next) => {
  try {
    const users = await db("SELECT * FROM users ORDER BY id DESC");
    res.json(users.rows.map((user) => ({ ...serializeUser(user), usage: { summaries: 0, comparisons: 0, presentations: 0, total_requests: 0 } })));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/usage", requireUser, requireAdmin, async (_req, res, next) => {
  try {
    const users = await db("SELECT * FROM users ORDER BY id DESC");
    const summaries = await db("SELECT count(*)::int AS count FROM summaries");
    res.json({
      totals: { users: users.rows.length, summaries: summaries.rows[0].count, comparisons: 0, presentations: 0, total_requests: summaries.rows[0].count },
      users: users.rows.map((user) => ({ ...serializeUser(user), usage: { summaries: 0, comparisons: 0, presentations: 0, total_requests: 0 } })),
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error("[API Error]", error);
  const status = error.statusCode || error.status || 500;
  res.status(status).json({ detail: error.message || "Server processing issue." });
});

initDb()
  .then(() => {
    app.listen(port, "0.0.0.0", () => {
      console.log(`Node AI video backend online on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Backend startup failed", error);
    process.exit(1);
  });
