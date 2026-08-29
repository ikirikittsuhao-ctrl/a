import "dotenv/config";
import express from "express";
import http from "http";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import QRCode from "qrcode";
import { Server } from "socket.io";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const ORIGIN = process.env.FRONTEND_ORIGIN || `http://localhost:${PORT}`;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const io = new Server(server, {
  cors: { origin: ORIGIN, methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e6
});

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net"
      ],
      styleSrc: ["'self'", "https://cdnjs.cloudflare.com", "'unsafe-inline'"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "data:"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: [
        "'self'",
        ORIGIN,
        "https://*.supabase.co",
        "wss://*.supabase.co",
        "wss:",
        "https:"
      ],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(cors({
  origin: ORIGIN,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  credentials: true
}));
app.use(compression());
app.use(express.json({ limit: "32kb" }));
app.use(morgan("combined"));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/api", limiter);

function cleanText(value, max = 2000) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, max);
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: "Invalid token" });

    req.user = data.user;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized" });
  }
}

async function isMember(userId, chatId) {
  const { data } = await admin.from("chat_members")
    .select("chat_id,role")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

app.get("/api/health", (_, res) => res.json({ ok: true, service: "schat" }));

app.get("/api/config", (_, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
});

app.get("/api/me", auth, async (req, res) => {
  const { data, error } = await admin.from("profiles").select("*").eq("id", req.user.id).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ profile: data });
});

app.patch("/api/me", auth, async (req, res) => {
  const display_name = cleanText(req.body.display_name, 50);
  if (!display_name) return res.status(400).json({ error: "Invalid display name" });
  const { data, error } = await admin.from("profiles")
    .update({ display_name }).eq("id", req.user.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ profile: data });
});

app.get("/api/users/search", auth, async (req, res) => {
  const q = cleanText(req.query.q, 32);
  if (q.length < 2) return res.json({ users: [] });
  const { data, error } = await admin.from("profiles")
    .select("id,username,display_name,avatar_url")
    .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
    .neq("id", req.user.id)
    .limit(20);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ users: data || [] });
});

app.get("/api/friends", auth, async (req, res) => {
  const { data, error } = await admin.from("friendships")
    .select("id,friend_id,status,created_at,profiles:friend_id(id,username,display_name,avatar_url)")
    .eq("user_id", req.user.id)
    .eq("status", "accepted")
    .order("created_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ friends: data || [] });
});

app.post("/api/friends/add", auth, async (req, res) => {
  const friendId = cleanText(req.body.friend_id, 80);
  if (!/^[0-9a-f-]{36}$/i.test(friendId) || friendId === req.user.id)
    return res.status(400).json({ error: "Invalid friend" });

  const { data: friend } = await admin.from("profiles").select("id").eq("id", friendId).maybeSingle();
  if (!friend) return res.status(404).json({ error: "User not found" });

  const { error } = await admin.from("friendships").upsert(
    { user_id: req.user.id, friend_id: friendId, status: "accepted" },
    { onConflict: "user_id,friend_id" }
  );
  if (error) return res.status(400).json({ error: error.message });

  await admin.from("friendships").upsert(
    { user_id: friendId, friend_id: req.user.id, status: "accepted" },
    { onConflict: "user_id,friend_id" }
  );

  res.json({ ok: true });
});

app.post("/api/qr/create", auth, async (req, res) => {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { error } = await admin.from("qr_tokens").insert({
    owner_id: req.user.id, token_hash: hash, expires_at: expires
  });
  if (error) return res.status(500).json({ error: error.message });

  const payload = `schat://friend/${raw}`;
  const dataUrl = await QRCode.toDataURL(payload, { width: 320, margin: 2 });
  res.json({ payload, qr: dataUrl, expires_at: expires });
});

app.post("/api/qr/redeem", auth, async (req, res) => {
  const token = cleanText(req.body.token, 128);
  if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ error: "Invalid QR token" });

  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const { data: row } = await admin.from("qr_tokens")
    .select("id,owner_id,expires_at,used_at")
    .eq("token_hash", hash)
    .maybeSingle();

  if (!row || row.used_at || new Date(row.expires_at) < new Date() || row.owner_id === req.user.id)
    return res.status(400).json({ error: "QR token expired or invalid" });

  const { error: markError } = await admin.from("qr_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("id", row.id).is("used_at", null);
  if (markError) return res.status(400).json({ error: markError.message });

  await admin.from("friendships").upsert(
    { user_id: req.user.id, friend_id: row.owner_id, status: "accepted" },
    { onConflict: "user_id,friend_id" }
  );
  await admin.from("friendships").upsert(
    { user_id: row.owner_id, friend_id: req.user.id, status: "accepted" },
    { onConflict: "user_id,friend_id" }
  );

  res.json({ ok: true });
});

app.get("/api/chats", auth, async (req, res) => {
  const { data, error } = await admin.from("chat_members")
    .select("chat_id,role,chats(id,type,name,created_by,created_at)")
    .eq("user_id", req.user.id)
    .order("joined_at", { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ chats: (data || []).map(x => ({ ...x.chats, role: x.role })) });
});

app.post("/api/chats/direct", auth, async (req, res) => {
  const otherId = cleanText(req.body.user_id, 80);
  if (!/^[0-9a-f-]{36}$/i.test(otherId) || otherId === req.user.id)
    return res.status(400).json({ error: "Invalid user" });

  const { data: existingMembers } = await admin.from("chat_members")
    .select("chat_id")
    .eq("user_id", req.user.id);

  for (const m of existingMembers || []) {
    const { data: other } = await admin.from("chat_members")
      .select("chat_id")
      .eq("chat_id", m.chat_id).eq("user_id", otherId).maybeSingle();
    if (other) {
      const { data: chat } = await admin.from("chats").select("*").eq("id", m.chat_id).eq("type","direct").maybeSingle();
      if (chat) return res.json({ chat });
    }
  }

  const { data: chat, error } = await admin.from("chats")
    .insert({ type: "direct", created_by: req.user.id }).select().single();
  if (error) return res.status(400).json({ error: error.message });

  const { error: memberError } = await admin.from("chat_members").insert([
    { chat_id: chat.id, user_id: req.user.id, role: "owner" },
    { chat_id: chat.id, user_id: otherId, role: "member" }
  ]);
  if (memberError) return res.status(400).json({ error: memberError.message });

  res.json({ chat });
});

app.post("/api/chats/group", auth, async (req, res) => {
  const name = cleanText(req.body.name, 80);
  const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids : [];
  const uniqueIds = [...new Set([req.user.id, ...ids.filter(x => typeof x === "string")])].slice(0, 50);
  if (!name || uniqueIds.length < 2) return res.status(400).json({ error: "Invalid group" });

  const { data: chat, error } = await admin.from("chats")
    .insert({ type: "group", name, created_by: req.user.id }).select().single();
  if (error) return res.status(400).json({ error: error.message });

  const rows = uniqueIds.map(id => ({ chat_id: chat.id, user_id: id, role: id === req.user.id ? "owner" : "member" }));
  const { error: memberError } = await admin.from("chat_members").insert(rows);
  if (memberError) return res.status(400).json({ error: memberError.message });

  res.json({ chat });
});

app.get("/api/chats/:chatId/messages", auth, async (req, res) => {
  const chatId = req.params.chatId;
  if (!(await isMember(req.user.id, chatId))) return res.status(403).json({ error: "Forbidden" });

  const { data, error } = await admin.from("messages")
    .select("id,chat_id,sender_id,body,created_at,profiles:sender_id(id,username,display_name)")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ messages: data || [] });
});

app.post("/api/chats/:chatId/messages", auth, async (req, res) => {
  const chatId = req.params.chatId;
  const body = cleanText(req.body.body, 2000);
  if (!(await isMember(req.user.id, chatId))) return res.status(403).json({ error: "Forbidden" });
  if (!body) return res.status(400).json({ error: "Message is empty" });

  const { data, error } = await admin.from("messages")
    .insert({ chat_id: chatId, sender_id: req.user.id, body })
    .select("id,chat_id,sender_id,body,created_at,profiles:sender_id(id,username,display_name)")
    .single();

  if (error) return res.status(400).json({ error: error.message });
  io.to(`chat:${chatId}`).emit("message", data);
  res.json({ message: data });
});

app.use(express.static(path.join(__dirname, "../public"), {
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));

app.get("*splat", (_, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.access_token;
    if (!token) return next(new Error("Unauthorized"));
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return next(new Error("Unauthorized"));
    socket.user = data.user;
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", socket => {
  socket.on("join_chat", async chatId => {
    if (typeof chatId !== "string") return;
    if (await isMember(socket.user.id, chatId)) socket.join(`chat:${chatId}`);
  });
});

server.listen(PORT, () => console.log(`schat listening on ${PORT}`));
