const express = require("express");
const { ProxyAgent } = require("undici");
const { getVideoDetails } = require("youtube-caption-extractor");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3001);
const SERVICE_SECRET = (process.env.CAPTION_SERVICE_SECRET || "").trim();
const PROXY_URL = (
  process.env.WEBSHARE_PROXY_URL ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  ""
).trim();

const proxyAgent = PROXY_URL ? new ProxyAgent(PROXY_URL) : null;
const YOUTUBE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
};

function proxyFetch(url, init = {}) {
  if (!proxyAgent) {
    return fetch(url, init);
  }
  return fetch(url, { ...init, dispatcher: proxyAgent });
}

function extractVideoId(input) {
  const value = String(input || "").trim();
  if (!value) {
    return null;
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return value;
  }

  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=|youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/live\/([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

function requireServiceAuth(req, res, next) {
  if (!SERVICE_SECRET) {
    return next();
  }

  const token = req.get("x-service-token") || "";
  if (token !== SERVICE_SECRET) {
    return res.status(401).json({ error: "Unauthorized caption service request." });
  }

  return next();
}

function mapErrorStatus(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("429") || text.includes("rate limit") || text.includes("too many")) {
    return 429;
  }
  if (text.includes("bot") || text.includes("sign in") || text.includes("confirm")) {
    return 429;
  }
  if (text.includes("no caption") || text.includes("no subtitle") || text.includes("transcript")) {
    return 422;
  }
  return 502;
}

function cleanCaptionText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJson3Captions(raw) {
  const payload = JSON.parse(raw);
  const events = Array.isArray(payload?.events) ? payload.events : [];
  return events
    .map((event) => {
      const text = cleanCaptionText(
        Array.isArray(event?.segs) ? event.segs.map((seg) => seg?.utf8 || "").join("") : "",
      );
      if (!text) {
        return null;
      }
      return {
        start: Number(event.tStartMs || 0) / 1000,
        dur: Number(event.dDurationMs || 0) / 1000,
        text,
      };
    })
    .filter(Boolean);
}

async function fetchTimedTextCaptions(videoId, lang) {
  const languages = [...new Set([lang, "en", "en-US", "en-GB"])];
  const endpoints = ["https://video.google.com/timedtext", "https://www.youtube.com/api/timedtext"];

  for (const endpoint of endpoints) {
    for (const language of languages) {
      for (const kind of ["", "asr"]) {
        const params = new URLSearchParams({
          v: videoId,
          lang: language,
          fmt: "json3",
        });
        if (kind) {
          params.set("kind", kind);
        }

        const response = await proxyFetch(`${endpoint}?${params}`, {
          headers: YOUTUBE_HEADERS,
        });
        if (!response.ok) {
          continue;
        }

        const raw = await response.text();
        if (!raw.trim()) {
          continue;
        }

        try {
          const subtitles = parseJson3Captions(raw);
          if (subtitles.length) {
            return subtitles;
          }
        } catch {
          continue;
        }
      }
    }
  }

  return [];
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    proxy_enabled: Boolean(PROXY_URL),
    auth_enabled: Boolean(SERVICE_SECRET),
  });
});

app.post("/transcript", requireServiceAuth, async (req, res) => {
  const youtubeUrl = req.body?.youtube_url || req.body?.url || "";
  const lang = (req.body?.lang || "en").trim() || "en";
  const videoId = extractVideoId(youtubeUrl);

  if (!videoId) {
    return res.status(400).json({ error: "Invalid YouTube URL or video ID." });
  }

  try {
    const directSubtitles = await fetchTimedTextCaptions(videoId, lang);
    if (directSubtitles.length) {
      const last = directSubtitles[directSubtitles.length - 1];
      const duration = last
        ? Math.ceil(Number(last.start || 0) + Number(last.dur || 0))
        : null;

      return res.json({
        video_id: videoId,
        title: "YouTube Video",
        channel: "",
        description: "",
        duration,
        thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
        subtitles: directSubtitles,
        source: "youtube-timedtext",
      });
    }

    const details = await getVideoDetails({
      videoID: videoId,
      lang,
      fetch: proxyFetch,
    });

    const subtitles = Array.isArray(details?.subtitles) ? details.subtitles : [];
    if (!subtitles.length) {
      return res.status(422).json({
        error: "No captions were found for this video.",
        video_id: videoId,
      });
    }

    const last = subtitles[subtitles.length - 1];
    const duration = last
      ? Math.ceil(Number(last.start || 0) + Number(last.dur || 0))
      : null;

    return res.json({
      video_id: videoId,
      title: details?.title || "YouTube Video",
      channel: details?.channel || details?.author || "",
      description: details?.description || "",
      duration,
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      subtitles,
      source: "youtube-caption-extractor",
    });
  } catch (error) {
    const message = error?.message || "Could not fetch captions for this video.";
    const status = mapErrorStatus(message);
    return res.status(status).json({
      error: message,
      video_id: videoId,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Caption service listening on port ${PORT}`);
  if (PROXY_URL) {
    console.log("Proxy enabled for YouTube requests.");
  }
});
