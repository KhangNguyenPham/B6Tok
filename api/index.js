import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COMICS_DIR = path.join(__dirname, "../public/comics");

if (!fs.existsSync(COMICS_DIR)) {
    fs.mkdirSync(COMICS_DIR, { recursive: true });
}

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(key) {
    const item = cache.get(key);
        if (!item) return null;
        if (Date.now() > item.expiry) {
        cache.delete(key);
        
        return null;
    }

    return item.data;
}

function setCache(key, data) {
    cache.set(key, {
        data,
        expiry: Date.now() + CACHE_TTL
    });
}

// Đọc cây thư mục truyện để render UI dạng tree
function readComicsTree(dir, baseUrl, relPath = "") {
    const absDir = relPath ? path.join(dir, relPath) : dir;
    let entries = [];

    try {
        const names = fs.readdirSync(absDir);
        entries = names
            .filter(name => !name.startsWith("."))
            .map(name => {
                const rel = relPath ? path.join(relPath, name) : name;
                const full = path.join(dir, rel);
                const stat = fs.statSync(full);

                if (stat.isDirectory()) {
                    return {
                        type: "dir",
                        name,
                        path: rel.replace(/\\/g, "/"),
                        children: readComicsTree(dir, baseUrl, rel)
                    };
                }

                return {
                    type: "file",
                    name,
                    path: rel.replace(/\\/g, "/"),
                    size: stat.size,
                    modified: stat.mtime,
                    url: `${baseUrl}/${rel.replace(/\\/g, "/")}`
                };
            })
            .sort((a, b) => {
                // Thư mục lên trước, sau đó sort theo tên
                if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
                return a.name.localeCompare(b.name, "vi");
            });
    } catch (err) {
        console.error("readComicsTree error:", err.message);
    }

    return entries;
}

// API trả về cây thư mục truyện
app.get("/api/library", (_req, res) => {
    const baseUrl = "/comics";
    const tree = readComicsTree(COMICS_DIR, baseUrl);

    res.json({
        baseUrl,
        items: tree
    });
});

app.get("/api/health", (req, res) => {
    res.json({
        status: 200,
        cache_size: cache.size,
        timestamp: new Date().toISOString(),
        message: "OK",
        comics_dir: "/comics"
    });
});

app.get("/api/search", async (req, res) => {
    try {
        const { q, quality = "low" } = req.query;

        if (!q) {
            return res.status(400).json({
                error: "Missing query parameter: q",
                example: "/api/search?q=spider+man"
            });
        }

        if (q.length > 100) {
            return res.status(400).json({
                error: "Query too long (max 100 characters)",
            });
        }

        const cacheKey = `search:${q}:${quality}`;
        const cached = getCached(cacheKey);

        if (cached) return res.json({ ...cached, cached: true });

        const apiUrl = "https://www.tikwm.com/api/feed/search";
        const response = await axios.get(apiUrl, {
            params: {
                keywords: q,
                count: 20,
                hd: quality === "high" ? 1 : 0
            },
            timeout: 8000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });

        const data = response.data;

        if (!data?.data || !data.data.videos) {
            return res.json({
                videos: [],
                count: 0,
                query: q,
                message: "No videos found"
            });
        }

        const videos = data.data.videos
            .map(v => ({
                id: v.video_id || v.aweme_id,
                video_url: v.play,
                video_url_no_wm: v.wmplay,
                caption: v.title || "",
                author: {
                    username: v.author?.unique_id || "unknown",
                    nickname: v.author?.nickname || "Unknown User",
                    avatar: v.author?.avatar || ""
                },
                cover: v.cover || v.origin_cover,
                duration: v.duration || 0,
                stats: {
                    likes: v.digg_count || 0,
                    comments: v.comment_count || 0,
                    shares: v.share_count || 0,
                    plays: v.play_count || 0
                },
                create_time: v.create_time
            }))
            .filter(v => v.video_url);

        const result = {
            videos,
            count: videos.length,
            query: q,
            cached: false
        };

        setCache(cacheKey, result);

        res.json(result);
    } catch (err) {
        console.error("Error:", err.message);

        if (err.code === "ECONNABORTED") {
            return res.status(504).json({
                error: "Request timeout",
                message: "TikTok API is slow or unavailable"
            });
        }

    if (err.response?.status === 429) {
        return res.status(429).json({
            error: "Rate limited",
            message: "Too many requests. Please try again later."
        });
    }

    res.status(500).json({
        error: "Failed to fetch TikTok data",
        message: process.env.NODE_ENV === "development" ? err.message : "Internal server error"
    });
    }
});

app.get("/api/trending", async (req, res) => {
    try {
        const cacheKey = "trending";
        const cached = getCached(cacheKey);
        
        if (cached) return res.json({ ...cached, cached: true });

        const response = await axios.get("https://www.tikwm.com/api/feed/list", {
            timeout: 8000,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });

        const data = response.data;

        if (!data?.data || !data.data.videos) {
            return res.json({
                videos: [],
                count: 0,
                message: "No trending videos found"
            });
        }

    const videos = data.data.videos
        .map(v => ({
            id: v.video_id || v.aweme_id,
            video_url: v.play,
            video_url_no_wm: v.wmplay,
            caption: v.title || "",
            author: {
                username: v.author?.unique_id || "unknown",
                nickname: v.author?.nickname || "Unknown User",
                avatar: v.author?.avatar || ""
            },
            cover: v.cover || v.origin_cover,
            duration: v.duration || 0,
            stats: {
                likes: v.digg_count || 0,
                comments: v.comment_count || 0,
                shares: v.share_count || 0,
                plays: v.play_count || 0
            }
        }))
        .filter(v => v.video_url);

    const result = {
        videos,
        count: videos.length,
        cached: false
    };

    setCache(cacheKey, result);
    res.json(result);
    } catch (err) {
        console.error("Error:", err.message);
        res.status(500).json({
            error: "Failed to fetch trending videos"
        });
    }
});

export default app;

if (process.env.NODE_ENV !== "production") {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
        console.log(`API endpoints:`);
        console.log(`   - GET /api/health`);
        console.log(`   - GET /api/search?q=keyword`);
        console.log(`   - GET /api/trending`);
    });
}
