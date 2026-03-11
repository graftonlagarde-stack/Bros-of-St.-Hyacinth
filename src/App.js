import { useState, useEffect, useRef, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";

const RAILWAY_URL = "https://bros-of-st-hyacinth-production.up.railway.app";

// ─── ASSET PRELOADER ──────────────────────────────────────────────────────────
// Fetch all 3D assets as ArrayBuffers at startup so backdrop mounts are instant
const assetCache = new Map();
const PRELOAD_ASSETS = [
  "/Talking_On_A_Cell_Phone.fbx",
  "/Warming_Up.fbx",
  "/Praying.fbx",
  "/Idle_To_Push_Up.fbx",
  "/Push_Up.fbx",
  `${RAILWAY_URL}/Hyacinth_Sphere.glb`,
];
// Preload in priority order — workout first (default tab), then others
(async () => {
  for (const url of PRELOAD_ASSETS) {
    try {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      assetCache.set(url, buf);
    } catch (e) {
      console.warn("Preload failed:", url, e);
    }
  }
})();


// ─── STORAGE HELPERS ──────────────────────────────────────────────────────────
const store = {
  async get(key, shared = false) {
    try {
      const r = await window.storage.get(key, shared);
      if (r) return JSON.parse(r.value);
    } catch {}
    if (!shared) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch {}
    }
    return null;
  },
  async set(key, value, shared = false) {
    const json = JSON.stringify(value);
    try { await window.storage.set(key, json, shared); } catch {}
    try { localStorage.setItem(key, json); } catch {}
  }
};

// ─── API LAYER ────────────────────────────────────────────────────────────────
// Change this to match wherever your server.js is running.
const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:4000";

const api = {
  // Read/write JWT token from localStorage so the user stays logged in across sessions
  getToken: ()         => localStorage.getItem("auth_token"),
  setToken: (t)        => localStorage.setItem("auth_token", t),
  clearToken: ()       => localStorage.removeItem("auth_token"),

  async request(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    const token = api.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  get:    (path)        => api.request("GET",    path, null),
  post:   (path, body)  => api.request("POST",   path, body),
  delete: (path, body)  => api.request("DELETE", path, body),

  // Auth
  register: (body) => api.post("/api/auth/register", body),
  login:    (body) => api.post("/api/auth/login",    body),
  me:       ()     => api.get("/api/auth/me"),
  deleteAccount: (body) => api.delete("/api/auth/account", body),

  // Lift logs
  getLogs:    ()     => api.get("/api/logs"),
  addLog:     (body) => api.post("/api/logs", body),
  deleteLog:  (id)   => api.delete(`/api/logs/${id}`),
  getCommunityUsers: () => api.get("/api/community/users"),

  // Board
  getMessages:   ()     => api.get("/api/board/messages"),
  postMessage:   (body) => api.post("/api/board/messages", body),
  postReaction:  (body) => api.post("/api/board/reactions", body),

  // Admin
  getAdminUsers:  ()          => api.get("/api/admin/users"),
  adminDeleteUser:(id)         => api.delete(`/api/admin/users/${id}`),
  adminSetRole:   (id, role)   => api.post(`/api/admin/users/${id}/role`, { role }),
};

// ─── SEED DATA ────────────────────────────────────────────────────────────────
const EMOJI_REACTIONS = ["👍","💪","🔥","❤️","😂","🎯","👏","🤯"];

// ─── BACKEND DATA HOOKS ───────────────────────────────────────────────────────
//
// These hooks are the single integration points for the backend.
// When the backend is ready, replace the TODO block inside each hook
// with a real fetch call — the rest of the app needs no changes.
//
// COMMUNITY LIFT DATA
// Expected shape from GET /api/community/users:
// [
//   {
//     name: "BrotherName",           // display name / username
//     logs: {
//       "Bench Press": { 1: [{weight:225,ts:1700000000000}, ...],
//                        5: [...], 10: [...], 15: [...] },
//       "Squat":       { ... },
//       "Deadlift":    { ... },
//       // ...one key per exercise in EXERCISE_LIST
//     }
//   },
//   ...
// ]
function useCommunityUsers(currentUsername) {
  const [communityUsers, setCommunityUsers] = useState([]);
  const [loading, setLoading]               = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getCommunityUsers()
      .then(data => { if (!cancelled) setCommunityUsers(data); })
      .catch(err => console.warn("useCommunityUsers:", err))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentUsername]);

  return { communityUsers, loading };
}

function useBoardMessages() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading]   = useState(false);

  const fetchMessages = () => {
    setLoading(true);
    api.getMessages()
      .then(data => setMessages(data))
      .catch(err => console.warn("useBoardMessages:", err))
      .finally(() => setLoading(false));
  };

  // Posts a new message to the backend; optimistically prepends it to state
  const saveMessage = async (msg) => {
    try {
      const saved = await api.postMessage({
        text:  msg.text,
        media: msg.media,
      });
      setMessages(prev => [...prev, saved]);
    } catch (err) {
      console.warn("saveMessage failed:", err);
    }
  };

  // Toggles a reaction; updates state from server response
  const saveReaction = async (messageId, emoji) => {
    try {
      const { reactions } = await api.postReaction({ messageId, emoji });
      setMessages(prev => prev.map(m =>
        m.id === messageId ? { ...m, reactions } : m
      ));
    } catch (err) {
      console.warn("saveReaction failed:", err);
    }
  };

  return { messages, loading, fetchMessages, saveMessage, saveReaction };
}

const SEED_MESSAGES = []; // removed — real messages come from useBoardMessages()

// ─── COMMUNITY USER SHAPE (for reference) ─────────────────────────────────────
// { name: string, logs: { [exercise]: { [repCat]: [{weight,ts}] } } }
const OTHER_USERS_REPS = []; // removed — real data comes from useCommunityUsers()

const fmtChatTime = (ts) => {
  const diff = Date.now() - ts;
  if (diff < 60000)    return "just now";
  if (diff < 3600000)  return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return new Date(ts).toLocaleDateString("en-US", { month:"short", day:"numeric" });
};

// ─── VIDEO PLAYER ─────────────────────────────────────────────────────────────
function VideoPlayer({ src, mt }) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    // Cloudinary or other http URLs — use directly
    if (src.startsWith("http") || src.startsWith("blob:")) {
      video.src = src;
      return;
    }

    // Legacy base64 dataURL — convert to blob for smooth playback
    try {
      const [header, data] = src.split(",");
      const mime = header.split(":")[1].split(";")[0];
      const bytes = atob(data);
      const ab = new ArrayBuffer(bytes.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < bytes.length; i++) ia[i] = bytes.charCodeAt(i);
      const blobUrl = URL.createObjectURL(new Blob([ab], { type: mime }));
      video.src = blobUrl;
      return () => URL.revokeObjectURL(blobUrl);
    } catch {
      video.src = src;
    }
  }, [src]);

  return (
    <video ref={videoRef} controls playsInline
      style={{ maxWidth:280, borderRadius:10, marginTop: mt || 0, display:"block", background:"#000" }} />
  );
}

// ─── CLOUDINARY CONFIG ────────────────────────────────────────────────────────
const CLOUDINARY_CLOUD = "djoqczzyj";
const CLOUDINARY_PRESET = "bros-of-st-hyacinth";

// ─── CLOUDINARY QUOTA MANAGEMENT ─────────────────────────────────────────────
const CHAT_MAX_FILE_BYTES  = 100 * 1024 * 1024;          // 100 MB per upload
const CHAT_STORAGE_CEILING = 20 * 1024 * 1024 * 1024;    // 20 GB — prune before hitting 25 GB free limit

// ─── BOARD PAGE ───────────────────────────────────────────────────────────────
function BoardPage({ username }) {
  const { messages, fetchMessages, saveMessage, saveReaction } = useBoardMessages();
  const [text, setText]                 = useState("");
  const [mediaFiles, setMediaFiles]     = useState([]);  // up to 3 attachments
  const [attachWarning, setAttachWarning] = useState(false);
  const [uploading, setUploading]       = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [emojiPickerFor, setEmojiPickerFor] = useState(null);
  const [inputTop, setInputTop]         = useState(null);
  const bottomRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const fileRef   = useRef(null);

  // Measure user-badge top so input bar can align with it
  useEffect(() => {
    const badge = document.querySelector(".user-badge");
    if (badge) {
      const { top } = badge.getBoundingClientRect();
      setInputTop(top);
    }
  }, []);

  useEffect(() => { fetchMessages(); }, []);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const uploadToCloudinary = (file) => new Promise((resolve, reject) => {
    const isVideo = file.type.startsWith("video/");
    const isAudio = file.type.startsWith("audio/");
    const endpoint = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/${(isVideo || isAudio) ? "video" : "image"}/upload`;
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", CLOUDINARY_PRESET);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", endpoint);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) setUploadProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        const r = JSON.parse(xhr.responseText);
        resolve({ url: r.secure_url, bytes: r.bytes ?? 0, publicId: r.public_id ?? "" });
      } else {
        let errDetail = xhr.responseText;
        try { errDetail = JSON.parse(xhr.responseText)?.error?.message || xhr.responseText; } catch {}
        reject(new Error(`HTTP ${xhr.status}: ${errDetail}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error — request blocked by sandbox"));
    xhr.send(formData);
  });

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";

    if (mediaFiles.length >= 3) {
      setAttachWarning(true);
      setTimeout(() => setAttachWarning(false), 3000);
      return;
    }
    if (file.size > CHAT_MAX_FILE_BYTES) {
      alert(`File too large — the maximum upload size is 100 MB.\nYour file is ${(file.size / 1024 / 1024).toFixed(1)} MB.`);
      return;
    }

    const id = Date.now() + Math.random();
    const blobUrl = URL.createObjectURL(file);
    setMediaFiles(prev => [...prev, { id, blobUrl, type: file.type, cloudUrl: null, uploading: true, progress: 0 }]);
    setUploading(true);
    try {
      const { url: cloudUrl, bytes, publicId } = await uploadToCloudinary(file);
      setMediaFiles(prev => prev.map(f => f.id === id ? { ...f, cloudUrl, bytes, publicId, uploading: false } : f));
    } catch (err) {
      alert(`Upload failed: ${err.message}`);
      setMediaFiles(prev => prev.filter(f => f.id !== id));
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const sendMessage = async () => {
    if (!text.trim() && mediaFiles.length === 0) return;
    if (uploading) return;
    const allMedia = mediaFiles.map(f => ({
      dataUrl:  f.cloudUrl,
      type:     f.type,
      bytes:    f.bytes ?? 0,
      publicId: f.publicId ?? "",
      isVideo:  f.type?.startsWith("video/"),
    }));
    const msg = {
      text:  text.trim(),
      media: allMedia.length > 0 ? allMedia[0] : null,
    };
    await saveMessage(msg);
    setText("");
    setMediaFiles([]);
  };

  const toggleReaction = (msgId, emoji) => {
    // Determine if user already has this emoji (to toggle off by sending null)
    const msg = messages.find(m => m.id === msgId);
    const alreadyHas = msg?.reactions[emoji]?.includes(username);
    saveReaction(msgId, alreadyHas ? null : emoji);
    setEmojiPickerFor(null);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"calc(100vh - 0px)", overflow:"hidden", position:"relative" }}>

      {/* Messages */}
      <div ref={scrollContainerRef} style={{ flex:1, overflowY:"scroll", overscrollBehavior:"none", WebkitOverflowScrolling:"auto", padding:"120px 28px 150px", display:"flex", flexDirection:"column", gap:4 }}>
        <div style={{ flex: "1 0 0" }} />
        {messages.map((msg, i) => {
          const isMe = msg.author === username;
          const prevMsg = messages[i - 1];
          const grouped = prevMsg && prevMsg.author === msg.author && (msg.ts - prevMsg.ts) < 300000;
          const reactionEntries = Object.entries(msg.reactions).filter(([,users]) => users.length > 0);

          // ── System notices (pruning alerts) ─────────────────────────────
          if (msg.isSystem) return (
            <div key={msg.id} style={{ textAlign:"center", margin:"12px 0", padding:"7px 18px",
              background:"rgba(255,51,68,0.08)", border:"1px solid rgba(255,51,68,0.25)",
              borderRadius:4, fontSize:11, color:"var(--muted)", letterSpacing:0.3 }}>
              {msg.text}
            </div>
          );

          return (
            <div key={msg.id}
              style={{ display:"flex", flexDirection: isMe ? "row-reverse" : "row", gap:8, alignItems:"flex-end", marginTop: grouped ? 2 : 14, position:"relative" }}
              onMouseLeave={() => setEmojiPickerFor(null)}>

              <div style={{ width:32, flexShrink:0 }}>
                {!grouped && (
                  <div className="avatar sm" style={{ background: isMe ? "linear-gradient(135deg,#003322,#006644)" : "linear-gradient(135deg,#001a10,#002e1a)", color: isMe ? "#88ff00" : "#88ff00" }}>
                    {msg.author.slice(0,2).toUpperCase()}
                  </div>
                )}
              </div>

              <div style={{ maxWidth:"70%", display:"flex", flexDirection:"column", alignItems: isMe ? "flex-end" : "flex-start" }}>
                {!grouped && (
                  <div style={{ fontSize:11, color:"var(--muted)", marginBottom:3, paddingLeft: isMe ? 0 : 2, paddingRight: isMe ? 2 : 0, fontFamily:"'Orbitron',sans-serif", letterSpacing:0.5 }}>
                    <span style={{ fontWeight:700, color: isMe ? "var(--accent)" : "var(--chrome)" }}>{msg.author}</span>
                    <span style={{ marginLeft:8 }}>{fmtChatTime(msg.ts)}</span>
                  </div>
                )}

                <div style={{
                  background: isMe
                    ? "linear-gradient(135deg,rgba(0,102,170,0.65),rgba(0,51,102,0.65))"
                    : "linear-gradient(135deg,rgba(0,14,6,0.65),rgba(0,8,3,0.65))",
                  border: `1px solid ${isMe ? "rgba(140,255,0,0.3)" : "var(--border)"}`,
                  borderRadius: isMe ? "8px 2px 8px 8px" : "2px 8px 8px 8px",
                  padding: msg.text ? "10px 14px" : "4px",
                  fontSize:14, lineHeight:1.5, wordBreak:"break-word",
                  boxShadow: isMe ? "0 2px 12px rgba(0,100,200,0.3)" : "0 2px 8px rgba(0,0,0,0.4)",
                  color: "#ffffff",
                }}>
                  {msg.text && <div style={{whiteSpace:"pre-wrap"}}>{msg.text}</div>}
                  {[msg.media, ...(msg.mediaExtra||[])].filter(Boolean).map((m, mi) => (
                    <div key={mi} style={{ marginTop: (mi === 0 && msg.text) ? 8 : mi > 0 ? 6 : 0 }}>
                      {m.type?.startsWith("image/") && (
                        <img src={m.dataUrl} alt="attachment"
                          style={{ maxWidth:280, maxHeight:280, borderRadius:4, display:"block", border:"1px solid var(--border)" }} />
                      )}
                      {m.type?.startsWith("video/") && <VideoPlayer src={m.dataUrl} mt={0} />}
                      {m.type?.startsWith("audio/") && (
                        <div style={{ display:"flex", alignItems:"center", gap:8,
                          background:"rgba(0,255,204,0.06)", border:"1px solid var(--border)", borderRadius:4, padding:"8px 12px", minWidth:220 }}>
                          <span style={{ fontSize:16 }}>🎵</span>
                          <audio controls src={m.dataUrl} style={{ flex:1, height:28, minWidth:0, accentColor:"var(--accent)" }} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {reactionEntries.length > 0 && (
                  <div style={{ display:"flex", gap:4, marginTop:4, flexWrap:"wrap", justifyContent: isMe ? "flex-end" : "flex-start" }}>
                    {reactionEntries.map(([emoji, users]) => (
                      <div key={emoji} onClick={() => toggleReaction(msg.id, emoji)}
                        style={{ display:"flex", alignItems:"center", gap:3,
                          background: users.includes(username) ? "rgba(140,255,0,0.12)" : "rgba(0,20,50,0.8)",
                          border:`1px solid ${users.includes(username) ? "var(--accent)" : "var(--border)"}`,
                          borderRadius:2, padding:"2px 8px", cursor:"pointer", fontSize:12, fontWeight:700,
                          color: users.includes(username) ? "var(--accent)" : "var(--muted)",
                          fontFamily:"'Orbitron',sans-serif", letterSpacing:1,
                          boxShadow: users.includes(username) ? "var(--glow-sm)" : "none",
                          transition:"all 0.15s" }}>
                        {emoji} {users.length}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ position:"relative" }}>
                  <button onClick={() => setEmojiPickerFor(emojiPickerFor === msg.id ? null : msg.id)}
                    style={{ background:"none", border:"none", cursor:"pointer", color:"var(--muted)", fontSize:12, padding:"3px 6px", opacity:0.5, marginTop:2 }}>
                    😊 +
                  </button>
                  {emojiPickerFor === msg.id && (
                    <div style={{ position:"absolute", bottom:"100%", [isMe?"right":"left"]:0,
                      background:"var(--surface)", border:"1px solid var(--border)",
                      borderTop:"1px solid rgba(140,255,0,0.3)",
                      borderRadius:4, padding:8, display:"flex", gap:4, flexWrap:"wrap",
                      width:196, zIndex:10, boxShadow:"0 4px 20px rgba(0,0,0,0.6), 0 0 20px rgba(140,255,0,0.1)" }}>
                      {EMOJI_REACTIONS.map(e => (
                        <button key={e} onClick={() => toggleReaction(msg.id, e)}
                          style={{ background: (msg.reactions[e]||[]).includes(username) ? "rgba(140,255,0,0.15)" : "none",
                            border:"none", cursor:"pointer", fontSize:20, borderRadius:2, padding:4, transition:"background 0.1s" }}>
                          {e}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Attach warning */}
      {attachWarning && (
        <div style={{
          position: "fixed", left: 224, right: 0, zIndex: 12,
          bottom: inputTop ? (window.innerHeight - inputTop + (mediaFiles.length > 0 ? 96 : 8)) : 150,
          margin: "0 28px",
          padding: "10px 16px",
          background: "rgba(255,60,60,0.15)",
          border: "1px solid rgba(255,60,60,0.4)",
          borderRadius: 4,
          color: "#ff6060",
          fontSize: 13,
          fontFamily: "'Orbitron',sans-serif",
          letterSpacing: 0.5,
        }}>
          You cannot attach more than three files to a message.
        </div>
      )}

      {/* File previews — fixed above input bar */}
      {mediaFiles.length > 0 && (
        <div style={{
          position: "fixed",
          bottom: inputTop ? (window.innerHeight - inputTop + 8) : 78,
          left: 224, right: 0,
          padding: "8px 28px",
          display: "flex", gap: 10, zIndex: 11,
        }}>
          {mediaFiles.map(f => (
            <div key={f.id} style={{ position:"relative", height:72, borderRadius:4, overflow:"hidden", background:"#000", minWidth:64, flexShrink:0 }}>
              {f.type?.startsWith("video/")
                ? <video src={f.blobUrl} style={{ height:72, objectFit:"cover" }} muted />
                : f.type?.startsWith("audio/")
                ? <div style={{ height:72, width:100, display:"flex", alignItems:"center", justifyContent:"center", background:"var(--surface2)", border:"1px solid var(--border)" }}>
                    <span style={{ fontSize:24 }}>🎵</span>
                  </div>
                : <img src={f.blobUrl} alt="preview" style={{ height:72, objectFit:"cover" }} />
              }
              {f.uploading && (
                <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.7)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:4 }}>
                  <div style={{ fontSize:10, color:"#fff", fontWeight:700, fontFamily:"'Orbitron',sans-serif" }}>{f.progress ?? 0}%</div>
                </div>
              )}
              {!f.uploading && f.cloudUrl && (
                <div style={{ position:"absolute", bottom:3, right:5, fontSize:10, color:"var(--accent)", fontWeight:700 }}>✓</div>
              )}
              <button onClick={() => setMediaFiles(prev => prev.filter(x => x.id !== f.id))}
                style={{ position:"absolute", top:3, right:3, background:"rgba(0,0,0,0.75)", border:"none", borderRadius:"50%", width:18, height:18, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", color:"#fff", fontSize:10, lineHeight:1, padding:0 }}>✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Input bar */}
      <div style={{
        position: "fixed",
        top: inputTop ?? "auto",
        bottom: 70,
        left: 224,
        right: 0,
        padding: "12px 28px",
        borderTop: "1px solid var(--border)",
        background: "rgba(0,8,4,0.45)",
        display: "flex",
        gap: 10,
        alignItems: "stretch",
        zIndex: 10,
      }}>
        <input ref={fileRef} type="file" accept="image/*,video/*,audio/*" style={{ display:"none" }} onChange={handleFile} />
        <button onClick={() => { if (mediaFiles.length >= 3) { setAttachWarning(true); setTimeout(() => setAttachWarning(false), 3000); } else fileRef.current?.click(); }}
          style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:2, padding:"0 12px",
            cursor:"pointer", color: uploading ? "var(--accent)" : "var(--muted)", fontSize:16, flexShrink:0, transition:"all 0.15s" }}
          title="Attach photo, video, or audio">📎</button>
        <textarea
          placeholder="Send a message..."
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          rows={1}
          style={{ flex:1, resize:"none", borderRadius:2, padding:"10px 14px", fontSize:14, minHeight:42, maxHeight:120, overflowY:"auto", lineHeight:1.5, opacity:1 }}
        />
        <button onClick={sendMessage} className="btn btn-primary"
          style={{ flexShrink:0, padding:"0 20px", borderRadius:2, opacity: uploading ? 0.5 : 1 }}
          disabled={(!text.trim() && mediaFiles.length === 0) || uploading}>
          {uploading ? "UPLOADING…" : "SEND"}
        </button>
      </div>
    </div>
  );
}



const EXERCISE_LIST = ["Bench Press", "Squat", "Deadlift", "Hex-Bar Deadlift", "Curls", "Overhead Press", "Pull-up", "Push-up", "Row"];

// ─── STYLES ───────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@400;500;600;700&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:        #020800;
    --surface:   #030a00;
    --surface2:  #061200;
    --border:    #0d2200;
    --accent:    #88ff00;
    --accent2:   #66cc00;
    --lime:      #88ff00;
    --teal:      #44cc00;
    --cyan:      #aaff44;
    --chrome:    #f4ffe8;
    --text:      #d8f5c0;
    --muted:     #5a8a30;
    --danger:    #ff3344;
    --radius:    2px;
    --glow:      0 0 20px #88ff00bb, 0 0 60px #88ff0044, 0 0 100px #88ff0011;
    --glow-sm:   0 0 8px #88ff0099, 0 0 24px #88ff0033;
    --glow-lime: 0 0 10px #88ff0099, 0 0 28px #88ff0033;
    --glow-cyan: 0 0 10px #aaff4499, 0 0 28px #aaff4433;
    --chrome-grad: linear-gradient(155deg, #ffffff 0%, #eeffcc 30%, #aaff44 60%, #66dd00 85%, #338800 100%);
    --energy-grad: linear-gradient(135deg, #88ff00 0%, #aaff44 40%, #ccff88 80%, #88ff00 100%);
    --depth-grad:  linear-gradient(135deg, #88ff00 0%, #66cc00 50%, #aaff44 100%);
  }

  /* ── KEYFRAMES ── */
  @keyframes gridBreath {
    0%,100% { opacity: 1; }
    50%     { opacity: 0.7; }
  }
  @keyframes scanline {
    0%   { background-position: 0 0; }
    100% { background-position: 0 8px; }
  }
  @keyframes logoBeam {
    0%   { letter-spacing: 32px; opacity: 0; filter: blur(12px) brightness(3); }
    55%  { letter-spacing: 9px;  opacity: 0.9; filter: blur(2px) brightness(1.5); }
    100% { letter-spacing: 6px;  opacity: 1;   filter: blur(0) brightness(1); }
  }
  @keyframes trace {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @keyframes edgePulse {
    0%,100% { opacity: 0.5; }
    50%     { opacity: 1; }
  }
  @keyframes energyBeat {
    0%,100% { box-shadow: 0 0 20px rgba(136,255,0,0.2), inset 0 0 40px rgba(0,255,180,0.03); }
    50%     { box-shadow: 0 0 40px rgba(0,255,180,0.45), inset 0 0 60px rgba(0,255,180,0.07); }
  }
  @keyframes float {
    0%,100% { transform: translateY(0px); }
    50%     { transform: translateY(-4px); }
  }
  @keyframes sheen {
    0%   { background-position: 0% 50%; }
    50%  { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  @keyframes voidPulse {
    0%,100% { opacity: 1; }
    50%     { opacity: 0.6; }
  }
  @keyframes depthSweep {
    0%   { background-position: 50% 0%; }
    100% { background-position: 50% 100%; }
  }
  @keyframes rankGlow {
    0%,100% { box-shadow: 0 0 20px rgba(136,255,0,0.2), inset 0 0 40px rgba(136,255,0,0.03); }
    50%     { box-shadow: 0 0 40px rgba(136,255,0,0.45), inset 0 0 60px rgba(136,255,0,0.07); }
  }
  @keyframes rankGlow {
    0%,100% { box-shadow: 0 0 20px rgba(136,255,0,0.2), inset 0 0 40px rgba(136,255,0,0.03); }
    50%     { box-shadow: 0 0 40px rgba(136,255,0,0.45), inset 0 0 60px rgba(136,255,0,0.07); }
  }

  /* ── BASE ── */
  body {
    background: var(--bg); color: var(--text);
    font-family: 'Rajdhani', sans-serif; font-size: 15px; line-height: 1.5;
    min-height: 100vh; overflow-x: hidden; overscroll-behavior: none;
  }

  /* CRT scanlines */
  body::before {
    content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 9999;
    background: repeating-linear-gradient(
      0deg,
      rgba(0,0,0,0.07) 0px, rgba(0,0,0,0.07) 1px,
      transparent 1px, transparent 5px
    );
    animation: scanline 0.08s steps(1) infinite;
  }

  /* ── 3D PERSPECTIVE GRID ── */
  /* The whole trick: two pseudo-elements stacked.
     .grid-floor  = the receding floor plane (perspective-transformed flat grid)
     .grid-fog    = depth fog that fades out the far end
     .app-bg      = the atmospheric color wash + stars */

  .app-bg {
    position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background:
      radial-gradient(ellipse 60% 55% at 50% 100%, rgba(20,60,0,0.55)  0%, transparent 65%),
      radial-gradient(ellipse 40% 35% at 50%  60%, rgba(10,40,0,0.4)   0%, transparent 60%),
      radial-gradient(ellipse 80% 30% at 50%   0%, rgba(8,30,0,0.5)    0%, transparent 80%),
      radial-gradient(ellipse 30% 60% at  0%  50%, rgba(0,10,20,0.15)  0%, transparent 55%),
      radial-gradient(ellipse 30% 60% at 100% 50%, rgba(0,5,15,0.15)   0%, transparent 55%),
      #020800;
    overflow: hidden;
  }

  /* Perspective grid floor */
  .app-bg::before {
    content: ''; position: absolute;
    left: -50%; right: -50%;
    top: 0%; bottom: -5%;
    background-image:
      linear-gradient(rgba(136,255,0,0.38) 1px, transparent 1px),
      linear-gradient(90deg, rgba(136,255,0,0.38) 1px, transparent 1px);
    background-size: 80px 80px;
    background-position: 50% 0%;
    transform: perspective(600px) rotateX(82deg) translateY(35%);
    transform-origin: 50% 50%;
    animation: depthSweep 3.6s linear infinite;
    mask-image: linear-gradient(180deg, transparent 0%, black 15%, black 100%);
  }

  /* Depth fog */
  .app-bg::after {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(180deg,
      #020800 0%,
      rgba(2,8,0,0.0) 28%,
      rgba(2,8,0,0.0) 100%
    );
  }

  /* Star-field */
  .grid-stars {
    position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background-image:
      radial-gradient(1px 1px at  8%  12%, rgba(136,255,0,0.5) 0%, transparent 100%),
      radial-gradient(1px 1px at 22%  78%, rgba(170,255,50,0.4) 0%, transparent 100%),
      radial-gradient(1px 1px at 37%  31%, rgba(180,255,50,0.4) 0%, transparent 100%),
      radial-gradient(1px 1px at 55%  88%, rgba(136,255,0,0.5) 0%, transparent 100%),
      radial-gradient(1px 1px at 67%  19%, rgba(160,255,30,0.4) 0%, transparent 100%),
      radial-gradient(1px 1px at 80%  54%, rgba(150,255,30,0.4) 0%, transparent 100%),
      radial-gradient(1px 1px at 91%  7%,  rgba(136,255,0,0.5) 0%, transparent 100%),
      radial-gradient(1px 1px at 14%  44%, rgba(120,230,0,0.3) 0%, transparent 100%),
      radial-gradient(1px 1px at 46%  66%, rgba(140,255,20,0.3) 0%, transparent 100%),
      radial-gradient(1px 1px at 73%  92%, rgba(136,255,0,0.4) 0%, transparent 100%),
      radial-gradient(1.5px 1.5px at 30% 5%,  rgba(136,255,0,0.6) 0%, transparent 100%),
      radial-gradient(1.5px 1.5px at 85% 38%, rgba(160,255,20,0.6) 0%, transparent 100%),
      radial-gradient(1.5px 1.5px at 60% 55%, rgba(180,255,30,0.5) 0%, transparent 100%);
    animation: gridBreath 6s ease-in-out infinite;
  }

  .app { display: flex; min-height: 100vh; position: relative; z-index: 1; overflow: visible; }

  /* ── SIDEBAR — orb + blade nav ── */
  .sidebar {
    width: 280px; min-width: 280px;
    background: transparent;
    display: flex; flex-direction: column;
    padding: 0; position: sticky; top: 0; height: 100vh;
    overflow: visible; justify-content: center;
    align-items: flex-start;
    transition: width 0.4s cubic-bezier(0.4,0,0.2,1), min-width 0.4s cubic-bezier(0.4,0,0.2,1);
  }
  .sidebar.nav-collapsed {
    width: 90px; min-width: 90px;
  }
  .sidebar::after { display: none; }

  /* Orb container */
  .xbox-orb-wrap {
    position: absolute;
    left: -60px;
    top: 50%;
    transform: translateY(-50%);
    width: 220px; height: 220px;
    pointer-events: all;
    cursor: pointer;
    z-index: 4;
  }
  .xbox-orb {
    position: absolute; inset: 0; border-radius: 50%;
    background: radial-gradient(circle at 38% 35%,
      #eeff88 0%, #aaff00 15%, #66dd00 35%, #009900 60%, #001a00 100%
    );
    box-shadow:
      0 0 30px #aaff00cc,
      0 0 60px #88ff0099,
      0 0 100px #44cc0066,
      0 0 160px #22880033,
      inset 0 0 40px rgba(255,255,255,0.25),
      inset -15px -15px 50px rgba(0,0,0,0.4);
    animation: orbPulse 3s ease-in-out infinite;
  }
  .xbox-orb::after {
    content: '✕';
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 72px; font-weight: 900;
    color: rgba(0,0,0,0.35);
    text-shadow: 0 0 20px rgba(0,255,0,0.3);
    font-family: 'Orbitron', sans-serif;
  }
  .xbox-bubble {
    position: absolute; border-radius: 50%;
    z-index: 4;
    background: radial-gradient(circle at 35% 30%, rgba(180,255,80,0.7), rgba(0,180,0,0.3) 60%, transparent);
    border: 1px solid rgba(136,255,0,0.4);
    box-shadow: 0 0 12px rgba(136,255,0,0.3);
    animation: bubbleFloat 4s ease-in-out infinite;
  }
  .xbox-bubble:nth-child(2) { width:38px; height:38px; top:8%;  left:62%; animation-delay:0s;    animation-duration:3.8s; z-index:5; }
  .xbox-bubble:nth-child(3) { width:24px; height:24px; top:22%; left:80%; animation-delay:0.7s;  animation-duration:4.5s; }
  .xbox-bubble:nth-child(4) { width:18px; height:18px; top:55%; left:84%; animation-delay:1.4s;  animation-duration:3.2s; }
  .xbox-bubble:nth-child(5) { width:30px; height:30px; top:72%; left:68%; animation-delay:0.3s;  animation-duration:5s;   }
  .xbox-bubble:nth-child(6) { width:14px; height:14px; top:80%; left:82%; animation-delay:1.9s;  animation-duration:4.1s; }
  @keyframes orbPulse {
    0%,100% { box-shadow: 0 0 30px #aaff00cc, 0 0 60px #88ff0099, 0 0 100px #44cc0066, 0 0 160px #22880033, inset 0 0 40px rgba(255,255,255,0.25), inset -15px -15px 50px rgba(0,0,0,0.4); }
    50%      { box-shadow: 0 0 50px #ccff00ee, 0 0 90px #aaff00bb, 0 0 140px #66ee0088, 0 0 200px #33990044, inset 0 0 55px rgba(255,255,255,0.35), inset -15px -15px 50px rgba(0,0,0,0.4); }
  }
  @keyframes bubbleFloat {
    0%,100% { transform: translateY(0) scale(1); opacity: 0.8; }
    50%      { transform: translateY(-6px) scale(1.06); opacity: 1; }
  }

  /* Nav wrap — retractable blade container */
  .nav-wrap {
    position: absolute;
    left: 150px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    gap: 5px;
    z-index: 3;
    transition: opacity 0.35s ease, transform 0.35s cubic-bezier(0.4,0,0.2,1);
  }
  .nav-wrap.retracted {
    opacity: 0;
    pointer-events: none;
    transform: translateY(-50%) translateX(-55px);
  }

  /* Xbox blade nav items */
  .nav-item {
    position: relative;
    width: 220px;
    height: 46px;
    padding: 0 20px;
    cursor: pointer;
    font-family: 'Orbitron', sans-serif;
    font-size: 11px; font-weight: 900;
    letter-spacing: 3px; text-transform: uppercase;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    border: 1px solid rgba(136,255,0,0.15);
    background: rgba(0,20,0,0.55);
    color: rgba(136,255,120,0.55);
    backdrop-filter: blur(4px);
    display: flex; align-items: center;
    clip-path: polygon(
      0.00% 84.00%,
      1.58% 100.00%,
      9.47% 100.00%,
      10.69% 84.00%,
      100.00% 84.00%,
      100.00% 20.00%,
      97.37%  0.00%,
      1.58%   0.00%,
      0.00%  12.29%
    );
    animation: navIdle 8s ease-in-out infinite;
  }
  .nav-item:nth-child(1) { animation-delay:  0.0s; }
  .nav-item:nth-child(2) { animation-delay: -1.6s; }
  .nav-item:nth-child(3) { animation-delay: -3.2s; }
  .nav-item:nth-child(4) { animation-delay: -4.8s; }
  .nav-item:nth-child(5) { animation-delay: -5.6s; }
  .nav-item:nth-child(6) { animation-delay: -2.4s; }
  @keyframes navIdle {
    0%,100% { transform: translate( 0.0px,  0.0px); }
    33%      { transform: translate( 1.2px, -1.8px); }
    66%      { transform: translate(-0.8px,  1.2px); }
  }
  .nav-item-wrap {
    position: relative;
    width: 220px;
    height: 46px;
    cursor: pointer;
    flex-shrink: 0;
    transition: width 0.15s ease;
  }
  .nav-item-wrap.active-wrap {
    width: 270px;
  }
  .nav-item-wrap.active-wrap .nav-item {
    background: linear-gradient(90deg, #aaee00 0%, #88cc00 60%, #669900 100%);
    color: #001a00;
    border-color: #ccff00;
    box-shadow: 0 0 18px #88ff0088, 0 0 40px #44cc0044, inset 0 1px 0 rgba(255,255,255,0.3);
    text-shadow: none;
    transform: translateX(6px) scaleY(1.06);
    font-size: 12px;
    width: 100%;
  }
  .nav-item-wrap .nav-item {
    pointer-events: none;
    width: 100%;
    height: 100%;
    position: absolute;
    inset: 0;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease,
                box-shadow 0.15s ease, transform 0.15s ease, font-size 0.15s ease, width 0.15s ease;
  }
  .nav-item-wrap:hover .nav-item {
    background: rgba(0,60,0,0.7);
    color: rgba(200,255,150,0.85);
    border-color: rgba(136,255,0,0.4);
  }
  .nav-item-wrap:nth-child(1) .nav-item { animation-delay:  0.0s; }
  .nav-item-wrap:nth-child(2) .nav-item { animation-delay: -1.6s; }
  .nav-item-wrap:nth-child(3) .nav-item { animation-delay: -3.2s; }
  .nav-item-wrap:nth-child(4) .nav-item { animation-delay: -4.8s; }
  .nav-item-wrap:nth-child(5) .nav-item { animation-delay: -5.6s; }
  .nav-item-wrap:nth-child(6) .nav-item { animation-delay: -2.4s; }
  .nav-item::before { display: none; }
  .nav-item:hover {
    background: rgba(0,60,0,0.7);
    color: rgba(200,255,150,0.85);
    border-color: rgba(136,255,0,0.4);
  }
  .nav-item.active::before { display: none; }
  .nav-icon { display: none; }
  .xbox-orb-wrap { z-index: 4 !important; }

  /* Logo */
  .logo {
    position: absolute;
    top: 22px; left: 22px;
    font-family: 'Orbitron', sans-serif; font-weight: 900;
    text-transform: uppercase;
    background: var(--chrome-grad);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
    filter: drop-shadow(0 0 14px rgba(136,255,0,0.5));
    animation: logoBeam 1.4s cubic-bezier(0.16,1,0.3,1) both;
    line-height: 1.15;
    pointer-events: none;
    transition: font-size 0.4s cubic-bezier(0.4,0,0.2,1);
    white-space: nowrap;
  }
  .logo-l1 {
    display: block; font-size: inherit; letter-spacing: 5px;
    transition: letter-spacing 0.4s cubic-bezier(0.4,0,0.2,1);
  }
  .logo-l2 {
    display: block; font-size: inherit; letter-spacing: 10.5px;
    transition: letter-spacing 0.4s cubic-bezier(0.4,0,0.2,1);
  }
  .logo span { -webkit-text-fill-color: transparent; }

  .user-badge {
    margin-top: auto; padding: 16px 22px;
    display: flex; align-items: center; gap: 10px;
    position: relative;
  }
  .user-badge::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
    background: var(--energy-grad); background-size: 200% 100%;
    animation: trace 4s linear infinite;
    opacity: 0.5;
  }

  .avatar {
    width: 36px; height: 36px; border-radius: 2px;
    background: linear-gradient(135deg, #001a0e, #002d18);
    color: var(--accent); display: flex; align-items: center; justify-content: center;
    font-weight: 900; font-size: 11px; font-family: 'Orbitron', sans-serif;
    flex-shrink: 0;
    border: 1px solid rgba(136,255,0,0.2);
    box-shadow: inset 0 0 16px rgba(136,255,0,0.06), 0 0 10px rgba(136,255,0,0.12);
    animation: energyBeat 5s ease-in-out infinite;
  }
  .avatar.sm { width: 30px; height: 30px; font-size: 9px; }
  .avatar.lg { width: 48px; height: 48px; font-size: 14px; }
  .user-name {
    font-weight: 700; font-size: 11px; letter-spacing: 2px; text-transform: uppercase;
    background: var(--chrome-grad);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  }
  .user-sub { font-size: 11px; color: var(--muted); letter-spacing: 0.5px; text-transform: uppercase; margin-top: 2px; }

  /* ── MAIN ── */
  .main { flex: 1; overflow-y: auto; position: relative; padding-bottom: 80px; }
  .page { padding: 40px 48px; max-width: 1000px; margin: 0 auto; }
  .app { display: flex; min-height: 100vh; position: relative; z-index: 1; overflow: visible; }
  .page > *:not(:first-child) { position: relative; z-index: 1; }
  .page-title { position: relative; z-index: 1; }

  .page-title {
    font-family: 'Orbitron', sans-serif; font-size: 28px; font-weight: 900;
    letter-spacing: 6px; margin-bottom: 6px; text-transform: uppercase;
    background: var(--chrome-grad);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    filter: drop-shadow(0 0 20px rgba(136,255,0,0.7)) drop-shadow(0 0 60px rgba(136,255,0,0.2));
    animation: float 7s ease-in-out infinite;
  }
  .page-sub {
    color: var(--muted); font-size: 12px; margin-bottom: 36px;
    letter-spacing: 2px; text-transform: uppercase; font-family: 'Orbitron', sans-serif;
  }
  .accentText {
    background: var(--energy-grad); background-size: 300% 300%;
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    animation: sheen 3s ease-in-out infinite;
  }

  /* ── CARDS ── */
  .card {
    background: linear-gradient(160deg, rgba(0,22,13,0.55) 0%, rgba(0,7,4,0.38) 50%, rgba(0,3,2,0.45) 100%);
    border: 1px solid rgba(6,51,34,0.9);
    border-top: 1px solid rgba(136,255,0,0.18);
    border-left: 1px solid rgba(136,255,0,0.10);
    border-radius: var(--radius); padding: 24px; margin-bottom: 16px;
    position: relative; overflow: hidden; z-index: 1;
    box-shadow:
      0 2px 0 rgba(136,255,0,0.08),
      0 8px 24px rgba(0,0,0,0.55),
      0 24px 64px rgba(0,0,0,0.5),
      0 48px 80px rgba(0,0,0,0.3),
      inset 0 1px 0 rgba(136,255,0,0.12),
      inset 0 0 60px rgba(136,255,0,0.02);
  }
  /* Animated cyan trace across top */
  .card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
    background: linear-gradient(90deg,
      transparent 0%, transparent 30%,
      rgba(136,255,0,0.0) 38%,
      rgba(136,255,0,0.95) 47%,
      rgba(170,255,30,0.95) 53%,
      rgba(136,255,0,0.0) 62%,
      transparent 70%, transparent 100%
    );
    background-size: 300% 100%;
    animation: trace 3.5s linear infinite;
  }
  /* Corner bracket — top-left in lime */
  .card::after {
    content: ''; position: absolute; top: 0; left: 0;
    width: 14px; height: 14px;
    border-top: 1px solid rgba(136,255,0,0.6);
    border-left: 1px solid rgba(136,255,0,0.6);
  }
  .card-title {
    font-family: 'Orbitron', sans-serif; font-weight: 700; font-size: 11px;
    margin-bottom: 20px; display: flex; align-items: center; gap: 10px;
    letter-spacing: 2px; text-transform: uppercase; color: var(--accent);
    text-shadow: 0 0 12px #88ff00aa, 0 0 30px #88ff0033;
  }
  .card-title::before {
    content: '◆'; font-size: 8px; color: var(--lime);
    filter: drop-shadow(0 0 6px #88ff00cc);
    animation: voidPulse 3s ease-in-out infinite;
  }

  /* ── BUTTONS ── */
  .btn {
    display: inline-flex; align-items: center; gap: 8px; padding: 10px 24px;
    border-radius: var(--radius);
    font-family: 'Orbitron', sans-serif; font-weight: 700;
    font-size: 11px; letter-spacing: 2px; text-transform: uppercase;
    cursor: pointer; border: none; transition: all 0.2s;
    position: relative; overflow: hidden;
  }
  .btn::after {
    content: ''; position: absolute; top: 0; left: -120%; width: 80%; height: 100%;
    background: linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.12) 50%, rgba(255,255,255,0.06) 60%, transparent 70%);
    transition: left 0.5s cubic-bezier(0.4,0,0.2,1);
    pointer-events: none;
  }
  .btn:hover::after { left: 140%; }
  .btn-primary {
    background: linear-gradient(180deg,
      rgba(0,160,110,0.95) 0%,
      rgba(0,90,65,0.98)  45%,
      rgba(0,40,30,1)     100%
    );
    color: #fff;
    border: 1px solid rgba(0,255,180,0.35);
    box-shadow: var(--glow-sm),
                inset 0 1px 0 rgba(255,255,255,0.18),
                inset 0 0 30px rgba(136,255,0,0.06);
  }
  .btn-primary:hover {
    background: linear-gradient(180deg, #00ddaa 0%, #008866 45%, #004433 100%);
    box-shadow: var(--glow), inset 0 1px 0 rgba(255,255,255,0.25);
    transform: translateY(-1px);
  }
  .btn-ghost {
    background: transparent; color: var(--muted);
    border: 1px solid rgba(13,34,0,0.9);
  }
  .btn-ghost:hover {
    color: var(--accent); border-color: rgba(136,255,0,0.4);
    box-shadow: var(--glow-sm); transform: translateY(-1px);
  }
  .btn-sm { padding: 5px 14px; font-size: 10px; letter-spacing: 1.5px; }

  /* ── INPUTS ── */
  input, textarea, select {
    background: rgba(0,10,6,0.92);
    border: 1px solid rgba(6,51,34,0.9);
    border-radius: var(--radius); color: var(--text);
    font-family: 'Rajdhani', sans-serif; font-size: 15px; font-weight: 500; line-height: 1.4;
    padding: 10px 14px; width: 100%; outline: none; transition: all 0.25s;
    box-shadow: inset 0 0 30px rgba(0,0,0,0.6);
  }
  input:focus, textarea:focus, select:focus {
    border-color: rgba(136,255,0,0.5);
    box-shadow: var(--glow-sm), inset 0 0 30px rgba(136,255,0,0.03);
    background: rgba(0,16,9,0.96);
  }
  textarea { resize: vertical; min-height: 80px; }
  .form-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  .form-label {
    font-size: 11px; color: var(--muted); margin-bottom: 6px;
    font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;
    font-family: 'Orbitron', sans-serif;
  }

  /* ── TABLE ── */
  .log-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .log-table th {
    text-align: left; color: var(--accent); font-weight: 700; font-size: 11px;
    text-transform: uppercase; letter-spacing: 1.5px; padding: 8px 12px;
    border-bottom: 1px solid rgba(6,51,34,0.9);
    font-family: 'Orbitron', sans-serif;
  }
  .log-table td { padding: 10px 12px; border-bottom: 1px solid rgba(6,51,34,0.4); line-height: 1.4; }
  .log-table tr:last-child td { border-bottom: none; }
  .log-table tr:hover td { background: rgba(136,255,0,0.02); }

  .badge {
    display: inline-block; padding: 2px 10px; border-radius: 1px; font-size: 11px;
    font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
    background: rgba(136,255,0,0.06); color: var(--accent);
    border: 1px solid rgba(136,255,0,0.2); font-family: 'Orbitron', sans-serif;
  }

  /* ── TABS ── */
  .chart-wrap { height: 260px; margin-top: 8px; }
  .tab-row { display: flex; gap: 5px; margin-bottom: 20px; flex-wrap: wrap; }
  .tab {
    padding: 6px 14px; border-radius: var(--radius); font-size: 11px; font-weight: 700;
    cursor: pointer; border: 1px solid rgba(6,51,34,0.9); color: var(--muted);
    transition: all 0.2s; letter-spacing: 1px; text-transform: uppercase;
    font-family: 'Orbitron', sans-serif;
  }
  .tab:hover { border-color: rgba(136,255,0,0.35); color: var(--chrome); }
  .tab.active {
    background: linear-gradient(180deg, rgba(0,100,70,0.85), rgba(0,50,35,0.95));
    color: #fff; border-color: rgba(136,255,0,0.45);
    box-shadow: var(--glow-sm);
    text-shadow: 0 0 10px rgba(136,255,0,0.7);
  }

  /* ── COMPARE ── */
  .compare-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 20px; }
  .compare-card {
    background: linear-gradient(160deg, rgba(0,22,13,0.52) 0%, rgba(0,10,5,0.32) 50%, rgba(0,3,2,0.40) 100%);
    border: 1px solid rgba(6,51,34,0.9);
    border-top: 1px solid rgba(136,255,0,0.15);
    border-left: 1px solid rgba(136,255,0,0.08);
    border-radius: var(--radius); padding: 14px; cursor: pointer; transition: all 0.25s;
    position: relative; overflow: hidden;
    box-shadow:
      0 2px 0 rgba(136,255,0,0.06),
      0 6px 18px rgba(0,0,0,0.5),
      0 16px 40px rgba(0,0,0,0.4),
      inset 0 1px 0 rgba(136,255,0,0.10);
  }
  .compare-card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
    background: linear-gradient(90deg,
      transparent 0%, transparent 35%,
      rgba(136,255,0,0.7) 47%,
      rgba(136,255,0,0.7) 53%,
      transparent 65%, transparent 100%
    );
    background-size: 300% 100%;
    animation: trace 5s linear infinite;
  }
  .compare-card:hover { border-color: rgba(136,255,0,0.25); box-shadow: var(--glow-sm); transform: translateY(-2px); }
  .compare-card.sel { border-color: rgba(136,255,0,0.5); box-shadow: var(--glow), inset 0 0 30px rgba(136,255,0,0.025); }
  .compare-card .cname {
    font-weight: 700; font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase;
    background: var(--chrome-grad);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    font-family: 'Orbitron', sans-serif;
  }
  .compare-card .csub { font-size: 12px; color: var(--muted); margin-top: 4px; letter-spacing: 0.5px; }

  /* ── AUDIO PLAYER ── */
  .player-bar {
    position: fixed; bottom: 0; left: 0; right: 0; z-index: 1000;
    background: linear-gradient(180deg, rgba(0,8,4,0.98) 0%, rgba(0,4,2,1) 100%);
    border-top: 1px solid rgba(6,51,34,0.8);
    padding: 13px 24px; display: flex; align-items: center; gap: 14px;
    overflow: hidden;
  }
  /* Cyan→lime top edge */
  .player-bar::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
    background: var(--energy-grad); background-size: 300% 300%;
    animation: sheen 3s ease-in-out infinite;
    opacity: 0.8;
  }
  .player-bar::after {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(ellipse 70% 120% at 50% 100%, rgba(0,255,180,0.025), transparent);
  }

  .track-info { min-width: 150px; max-width: 200px; position: relative; z-index: 1; overflow: hidden; }
  .track-title {
    font-weight: 700; font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase;
    font-family: 'Orbitron', sans-serif;
    background: var(--chrome-grad);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
  }
  .track-artist { font-size: 12px; color: var(--muted); letter-spacing: 0.5px; margin-top: 3px; }
  .player-controls { display: flex; align-items: center; gap: 14px; position: relative; z-index: 1; }
  .ctrl-btn {
    background: none; border: none; color: var(--muted); cursor: pointer;
    font-size: 15px; padding: 4px; transition: all 0.15s;
  }
  .ctrl-btn:hover { color: var(--accent); text-shadow: var(--glow-sm); transform: scale(1.2); }
  .play-btn {
    background: linear-gradient(145deg, #008866 0%, #004433 55%, #001a15 100%);
    color: #fff; border: 1px solid rgba(0,255,180,0.3);
    border-radius: 50%; width: 44px; height: 44px; font-size: 14px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    box-shadow: var(--glow),
                inset 0 1px 0 rgba(255,255,255,0.2),
                inset 0 0 24px rgba(136,255,0,0.12);
    transition: all 0.2s;
    animation: energyBeat 3.5s ease-in-out infinite;
    position: relative; z-index: 1;
  }
  .play-btn:hover {
    box-shadow: 0 0 40px #88ff00, 0 0 80px #88ff0055, inset 0 0 30px rgba(136,255,0,0.2);
    transform: scale(1.1);
  }

  .progress-wrap {
    flex: 1; display: flex; align-items: center; gap: 10px; font-size: 11px;
    color: var(--muted); font-family: 'Orbitron', sans-serif; letter-spacing: 0.5px;
    position: relative; z-index: 1;
  }
  .progress-bar {
    flex: 1; height: 2px; background: rgba(0,40,25,0.8);
    cursor: pointer; position: relative;
  }
  .progress-fill {
    height: 100%;
    background: var(--energy-grad); background-size: 300% 300%;
    animation: sheen 2s ease-in-out infinite;
    box-shadow: 0 0 12px #88ff00, 0 0 4px #88ff00;
    transition: width 0.25s linear;
  }
  .volume-wrap {
    display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--muted);
    position: relative; z-index: 1;
  }
  .vol-slider { width: 72px; height: 2px; accent-color: var(--accent); }

  /* ── TRACK LIST ── */
  .track-row {
    display: flex; align-items: center; gap: 14px; padding: 11px 14px;
    border-radius: var(--radius); cursor: pointer; transition: all 0.2s;
    border: 1px solid transparent; position: relative; overflow: hidden;
  }
  .track-row::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 0;
    background: linear-gradient(90deg, rgba(136,255,0,0.07), rgba(170,255,30,0.04), transparent);
    transition: width 0.25s;
  }
  .track-row:hover::before { width: 100%; }
  .track-row:hover { border-color: rgba(136,255,0,0.08); }
  .track-row.playing { border-color: rgba(136,255,0,0.18); background: rgba(136,255,0,0.025); }
  .track-row.playing .track-title {
    color: var(--accent) !important;
    -webkit-text-fill-color: var(--accent) !important;
    text-shadow: 0 0 12px #88ff00aa !important;
  }
  .track-num { width: 22px; text-align: center; font-size: 12px; color: var(--muted); font-family: 'Orbitron', sans-serif; }
  .track-dur { font-size: 12px; color: var(--muted); margin-left: auto; font-family: 'Orbitron', sans-serif; letter-spacing: 0.5px; }

  /* ── STAT TILES ── */
  .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 28px; }
  .stat-tile {
    background: linear-gradient(160deg, rgba(0,22,13,0.55) 0%, rgba(0,10,5,0.35) 50%, rgba(0,3,2,0.42) 100%);
    border: 1px solid rgba(6,51,34,0.9);
    border-top: 1px solid rgba(136,255,0,0.18);
    border-left: 1px solid rgba(136,255,0,0.10);
    border-radius: var(--radius); padding: 22px; position: relative; overflow: hidden;
    animation: float 7s ease-in-out infinite;
    box-shadow:
      0 2px 0 rgba(136,255,0,0.08),
      0 8px 20px rgba(0,0,0,0.55),
      0 20px 48px rgba(0,0,0,0.45),
      inset 0 1px 0 rgba(136,255,0,0.12),
      inset 0 0 40px rgba(136,255,0,0.02);
  }
  .stat-tile:nth-child(2) { animation-delay: -2.3s; }
  .stat-tile:nth-child(3) { animation-delay: -4.6s; }
  .stat-tile::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
    background: linear-gradient(90deg,
      transparent 0%, transparent 35%,
      rgba(136,255,0,0.85) 47%,
      rgba(136,255,0,0.85)  53%,
      transparent 65%, transparent 100%
    );
    background-size: 300% 100%;
    animation: trace 4.5s linear infinite;
  }
  /* Corner bracket — bottom-right in cyan */
  .stat-tile::after {
    content: ''; position: absolute; bottom: 0; right: 0;
    width: 10px; height: 10px;
    border-bottom: 1px solid rgba(170,255,30,0.5);
    border-right: 1px solid rgba(170,255,30,0.5);
  }
  .stat-num {
    font-family: 'Orbitron', sans-serif; font-size: 28px; font-weight: 900;
    line-height: 1; letter-spacing: 2px;
    background: linear-gradient(135deg, #ffffff 0%, #aaffee 30%, #88ff00 60%, #88ff00 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    filter: drop-shadow(0 0 16px rgba(136,255,0,0.8));
  }
  .stat-label {
    font-size: 11px; color: var(--muted); margin-top: 10px;
    letter-spacing: 2px; text-transform: uppercase; font-family: 'Orbitron', sans-serif;
  }

  /* ── MODAL ── */
  .modal-bg {
    position: fixed; inset: 0; z-index: 100;
    background: rgba(0,4,2,0.90);
    backdrop-filter: blur(12px) saturate(1.8);
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    background: linear-gradient(155deg, rgba(0,12,7,0.99) 0%, rgba(0,5,3,1) 100%);
    border: 1px solid rgba(6,51,34,0.9);
    border-radius: var(--radius); padding: 32px; width: 500px; max-width: 95vw;
    box-shadow: 0 0 100px rgba(0,0,0,0.95), var(--glow), var(--glow-lime);
    position: relative; overflow: hidden;
  }
  .modal::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
    background: var(--energy-grad); background-size: 300% 300%;
    animation: sheen 2.5s ease-in-out infinite;
  }
  .modal::after {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background:
      radial-gradient(ellipse 50% 40% at 0%   0%,   rgba(170,255,30,0.06),  transparent),
      radial-gradient(ellipse 50% 40% at 100% 100%, rgba(136,255,0,0.05),  transparent),
      radial-gradient(ellipse 40% 30% at 100%  0%,   rgba(136,255,0,0.04),  transparent);
  }
  .modal-title {
    font-family: 'Orbitron', sans-serif; font-size: 19px; font-weight: 900;
    letter-spacing: 5px; margin-bottom: 24px; text-transform: uppercase;
    background: var(--chrome-grad);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    filter: drop-shadow(0 0 12px rgba(136,255,0,0.6));
    position: relative; z-index: 1;
  }
  .divider {
    border: none; height: 1px; margin: 20px 0;
    background: var(--energy-grad); background-size: 300% 300%;
    animation: sheen 5s ease-in-out infinite;
    opacity: 0.3;
  }
  .flex-end { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }

  /* ── ONBOARDING ── */
  .onboard-wrap {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background:
      radial-gradient(ellipse 70% 80% at 50% 50%, rgba(0,60,35,0.6)  0%, transparent 60%),
      radial-gradient(ellipse 40% 50% at 15% 85%, rgba(0,30,50,0.5)  0%, transparent 60%),
      radial-gradient(ellipse 40% 50% at 85% 15%, rgba(0,50,30,0.5)  0%, transparent 60%),
      #000a04;
    position: relative; overflow: hidden;
  }
  .onboard-wrap::before {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background-image:
      repeating-linear-gradient( 45deg, transparent, transparent 55px, rgba(136,255,0,0.018) 55px, rgba(136,255,0,0.018) 56px),
      repeating-linear-gradient(-45deg, transparent, transparent 55px, rgba(170,255,30,0.018) 55px, rgba(170,255,30,0.018) 56px);
    animation: gridBreath 10s ease-in-out infinite;
  }
  .onboard-wrap::after {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(ellipse 60% 40% at 50% 50%, rgba(136,255,0,0.04), transparent);
    animation: voidPulse 5s ease-in-out infinite;
  }

  /* ── MISC ── */
  .action-btn {
    display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted);
    cursor: pointer; padding: 4px 9px; border-radius: var(--radius); transition: all 0.15s;
    font-family: 'Orbitron', sans-serif; letter-spacing: 1px; text-transform: uppercase;
  }
  .action-btn:hover { color: var(--accent); text-shadow: var(--glow-sm); }

  ::-webkit-scrollbar { width: 3px; height: 3px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb {
    background: linear-gradient(180deg, #aaff44, #88ff00, #88ff00);
    border-radius: 0;
  }

  ::selection { background: rgba(136,255,0,0.3); color: #fff; }

  * { cursor: crosshair; }
  button, a, [role="button"], .nav-item, .tab, .track-row, .compare-card, select { cursor: pointer; }
`;

// ─── UTILS ────────────────────────────────────────────────────────────────────
const fmtTime = (s) => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;

// ─── FIGURE BACKDROP ──────────────────────────────────────────────────────────
// Place the FBX file in /public/ of the CRA project.
const BACKDROP_MODELS = {
  boards:    "/Talking_On_A_Cell_Phone.fbx",
  workout:   null,
  audio:     "/Talking_On_A_Cell_Phone.fbx",
  topcharts: "/Warming_Up.fbx",
};

function FigureBackdrop({ variant = "workout", fading = false }) {
  const mountRef = useRef(null);
  const fbxFile  = BACKDROP_MODELS[variant];

  const [opacity, setOpacity] = useState(0);

  useEffect(() => {
    if (fading) { setOpacity(0); return; }
    const t = setTimeout(() => setOpacity(0.85), 250);
    return () => clearTimeout(t);
  }, [fading]);

  useEffect(() => {
    if (!fbxFile || !mountRef.current) return;
    const el = mountRef.current;
    let animId = null;
    let rendererInst = null;
    let cancelled = false;

    Promise.all([
      import("three"),
      import("three/examples/jsm/loaders/FBXLoader"),
    ]).then(([THREE, { FBXLoader }]) => {
      if (cancelled) return;
      const w = window.innerWidth - 224;
      const h = window.innerHeight - 70;

      const scene  = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 2000);
      // Far enough back to see full figure; x offset shifts figure to 2/3 right of screen
      camera.position.set(-w * 0.32, 160, 660);
      camera.lookAt(0, 160, 0);

      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(w, h);
      renderer.setClearColor(0x000000, 0);
      el.appendChild(renderer.domElement);
      rendererInst = renderer;

      const wireMat = new THREE.MeshBasicMaterial({
        color: 0x00ffcc, wireframe: true,
        transparent: true, opacity: 0.32,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });

      let mixer = null;
      const clock = new THREE.Clock();

      const _loadFigObj = (obj) => {
        if (cancelled) return;
        obj.traverse(c => {
          if (c.isMesh) { c.material = wireMat; c.castShadow = c.receiveShadow = false; }
        });
        const box    = new THREE.Box3().setFromObject(obj);
        const size   = box.getSize(new THREE.Vector3());
        const fovRad = (40 * Math.PI) / 180;
        const worldH = 2 * Math.tan(fovRad / 2) * 600;
        const scale  = (worldH * 0.65) / size.y;
        const newScale = scale * 1.495;
        obj.scale.setScalar(newScale);
        const box2   = new THREE.Box3().setFromObject(obj);
        const extraH = size.y * (newScale - scale);
        obj.position.set(110, -box2.min.y - extraH + 70, 0);
        obj.rotation.y = -Math.PI / 6;  // 30° clockwise
        scene.add(obj);
        if (obj.animations?.length) {
          mixer = new THREE.AnimationMixer(obj);
          const a = mixer.clipAction(obj.animations[0]);
          a.setLoop(THREE.LoopRepeat, Infinity);
          a.play();
        }
      };
      if (assetCache.has(fbxFile)) {
        _loadFigObj(new FBXLoader().parse(assetCache.get(fbxFile).slice(0), ""));
      } else {
        new FBXLoader().load(fbxFile, _loadFigObj, undefined, e => console.warn("FBX load error:", e));
      }

      const animate = () => {
        animId = requestAnimationFrame(animate);
        if (mixer) mixer.update(clock.getDelta());
        renderer.render(scene, camera);
      };
      animate();
    }).catch(e => console.warn("Three.js import error:", e));

    return () => {
      cancelled = true;
      cancelAnimationFrame(animId);
      if (rendererInst) {
        rendererInst.dispose();
        if (el.contains(rendererInst.domElement)) el.removeChild(rendererInst.domElement);
      }
    };
  }, [fbxFile]);

  return (
    <div ref={mountRef} style={{
      position: "fixed",
      left: 224,
      top: 0,
      right: 0,
      bottom: 70,
      pointerEvents: "none",
      zIndex: -1,
      opacity: fbxFile ? opacity : 0,
      transition: "opacity 0.5s ease",
      filter: "drop-shadow(0 0 6px #00ffcc88) drop-shadow(0 0 18px #00ffcc44)",
      willChange: "opacity",
    }} />
  );
}


// ─── AUDIO FIGURE BACKDROP ────────────────────────────────────────────────────
function AudioFigureBackdrop({ fading = false }) {
  const mountRef = useRef(null);
  const [opacity, setOpacity] = useState(0);

  useEffect(() => {
    if (fading) { setOpacity(0); return; }
    const t = setTimeout(() => setOpacity(0.85), 250);
    return () => clearTimeout(t);
  }, [fading]);

  useEffect(() => {
    if (!mountRef.current) return;
    const el = mountRef.current;
    let animId = null;
    let rendererInst = null;
    let cancelled = false;

    Promise.all([
      import("three"),
      import("three/examples/jsm/loaders/FBXLoader"),
    ]).then(([THREE, { FBXLoader }]) => {
      if (cancelled) return;
      const w = window.innerWidth - 224;
      const h = window.innerHeight - 70;

      const scene  = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 5000);
      camera.position.set(-w * 0.32, 160, 660);
      camera.lookAt(0, 160, 0);

      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(w, h);
      renderer.setClearColor(0x000000, 0);
      el.appendChild(renderer.domElement);
      rendererInst = renderer;

      // ── Cross ──────────────────────────────────────────────────────────────


      // Dynamic silver-white glitter texture — regenerated each frame
      const glitterCanvas = document.createElement("canvas");
      glitterCanvas.width = glitterCanvas.height = 128;
      const gCtx = glitterCanvas.getContext("2d");
      const glitterTex = new THREE.CanvasTexture(glitterCanvas);

      const updateGlitter = (time) => {
        gCtx.clearRect(0, 0, 128, 128);
        // Silver-white base gradient
        const grd = gCtx.createLinearGradient(0, 0, 128, 128);
        grd.addColorStop(0,   "#e8eef2");
        grd.addColorStop(0.4, "#ffffff");
        grd.addColorStop(0.7, "#d4e4f0");
        grd.addColorStop(1,   "#f0f4f8");
        gCtx.fillStyle = grd;
        gCtx.fillRect(0, 0, 128, 128);
        // Animated sparkles
        const rng = (s) => { let x = Math.sin(s) * 43758.5453; return x - Math.floor(x); };
        for (let i = 0; i < 180; i++) {
          const tx = time * 0.7 + i * 1.3;
          const x  = rng(tx) * 128;
          const y  = rng(tx + 99) * 128;
          const r  = rng(tx + 17) * 3 + 0.5;
          const br = Math.sin(time * (2 + rng(i) * 4) + i) * 0.5 + 0.5;
          const a  = br * 0.9 + 0.1;
          const spark = gCtx.createRadialGradient(x, y, 0, x, y, r * 4);
          spark.addColorStop(0,   `rgba(255,255,255,${a})`);
          spark.addColorStop(0.3, `rgba(210,230,245,${a * 0.5})`);
          spark.addColorStop(1,   "rgba(255,255,255,0)");
          gCtx.fillStyle = spark;
          gCtx.beginPath(); gCtx.arc(x, y, r * 4, 0, Math.PI * 2); gCtx.fill();
        }
        glitterTex.needsUpdate = true;
      };

      const crossMat = new THREE.MeshBasicMaterial({
        map: glitterTex, transparent: true, opacity: 1.0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });

      const crossGroup = new THREE.Group();
      const crossH = 230, crossW = 125, barThick = 23;
      const vBar = new THREE.Mesh(new THREE.BoxGeometry(barThick, crossH, barThick), crossMat);
      vBar.position.y = crossH / 2;
      const hBar = new THREE.Mesh(new THREE.BoxGeometry(crossW, barThick, barThick), crossMat.clone());
      hBar.position.y = crossH * 0.70;
      crossGroup.add(vBar, hBar);
      // Center cross in full browser window (canvas starts at left:224, so canvas center ≠ screen center)
      const crossCamDist = 660;
      const crossFovRad = (40 * Math.PI) / 180;
      const crossWorldPerPx = 2 * Math.tan(crossFovRad / 2) * crossCamDist / w;
      const crossCenterX = -160 * crossWorldPerPx;
      crossGroup.position.set(crossCenterX, 0, 0);
      scene.add(crossGroup);

      const wireMat = new THREE.MeshBasicMaterial({
        color: 0x00ffcc, wireframe: true,
        transparent: true, opacity: 0.32,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });

      let mixer = null;
      const clock = new THREE.Clock();

      const _loadPraying = (obj) => {
        if (cancelled) return;
        obj.traverse(c => {
          if (c.isMesh) { c.material = wireMat; c.castShadow = c.receiveShadow = false; }
        });
        const box    = new THREE.Box3().setFromObject(obj);
        const size   = box.getSize(new THREE.Vector3());
        const fovRad = (40 * Math.PI) / 180;
        const worldH = 2 * Math.tan(fovRad / 2) * 600;
        const scale  = (worldH * 0.65) / size.y;
        const newScale = scale * 1.495;
        obj.scale.setScalar(newScale);
        const box2   = new THREE.Box3().setFromObject(obj);
        const extraH = size.y * (newScale - scale);
        obj.position.set(110, -box2.min.y - extraH + 70, 0);
        // 195° clockwise rotation (135 + 60)
        obj.rotation.y = -(Math.PI * 195) / 180;
        scene.add(obj);

        // Align cross base to figure's ground level (vBar.position.y = crossH/2 already lifts it)
        crossGroup.position.y = -box2.min.y - extraH + 70 + 180;

        if (obj.animations?.length) {
          const clip = obj.animations[0];
          const fps  = 30;
          mixer = new THREE.AnimationMixer(obj);

          // Intro: play frames 0–45 once at 0.4x speed
          const intro = THREE.AnimationUtils.subclip(clip, "intro", 0, 45, fps);
          const introAction = mixer.clipAction(intro);
          introAction.setLoop(THREE.LoopOnce, 1);
          introAction.clampWhenFinished = true;
          introAction.timeScale = 0.5;
          introAction.play();

          // Phase tracking: "intro" → "bounce" → "breathing"
          let phase = "intro";
          let breathTime = 0;
          let bounceTime = 0;

          // Physics bounce — upward kick, 1.5x faster than before
          const restY     = obj.position.y;
          let   vel       = 0;
          let   disp      = 0;
          const stiffness = 90;
          const damping   = 18.0;
          const kickVel   = 44;   // upward, modest

          // Collect foot bones
          const footBones = [];
          obj.traverse(c => {
            if (c.isBone && (c.name.toLowerCase().includes("foot") ||
                             c.name.toLowerCase().includes("toe") ||
                             c.name.toLowerCase().includes("ankle"))) {
              footBones.push({ bone: c, worldPos: new THREE.Vector3() });
            }
          });
          let footPositionsLocked = false;

          // Collect torso/thigh bones for forward lean
          const leanBones = [];
          obj.traverse(c => {
            if (c.isBone && (c.name.toLowerCase().includes("spine") ||
                             c.name.toLowerCase().includes("chest") ||
                             c.name.toLowerCase().includes("thigh") ||
                             c.name.toLowerCase().includes("upleg"))) {
              leanBones.push({ bone: c, baseRot: c.quaternion.clone() });
            }
          });

          // Collect arm bones for ragdoll
          const armBones = [];
          obj.traverse(c => {
            if (c.isBone && (c.name.toLowerCase().includes("arm") ||
                             c.name.toLowerCase().includes("forearm") ||
                             c.name.toLowerCase().includes("shoulder") ||
                             c.name.toLowerCase().includes("elbow") ||
                             c.name.toLowerCase().includes("hand"))) {
              armBones.push({ bone: c, baseRot: null, dispX: 0, dispY: 0, velX: 0, velY: 0 });
            }
          });

          // Estimate bounce duration for normalizing t (stiffness/damping gives ~settle time)
          const bounceDuration = 1.2; // seconds estimate

          mixer.addEventListener("finished", () => {
            if (phase === "intro") {
              phase = "bounce";
              vel   = kickVel;
              disp  = 0;
              bounceTime = 0;
              footBones.forEach(fb => {
                fb.bone.updateWorldMatrix(true, false);
                fb.worldPos = new THREE.Vector3();
                fb.bone.getWorldPosition(fb.worldPos);
              });
              footPositionsLocked = true;
              // Snapshot base rotations at frame 45
              leanBones.forEach(lb => { lb.baseRot = lb.bone.quaternion.clone(); });
              armBones.forEach(ab => {
                ab.baseRot = ab.bone.quaternion.clone();
                ab.dispX = 0; ab.dispY = 0; ab.velX = 0; ab.velY = 0;
              });
            }
          });

          const breathBones = [];
          obj.traverse(c => {
            if (c.isBone && (c.name.toLowerCase().includes("spine") ||
                             c.name.toLowerCase().includes("chest") ||
                             c.name.toLowerCase().includes("neck"))) {
              breathBones.push({ bone: c, baseScale: c.scale.clone() });
            }
          });

          // Idle sway — upper body bones only (no knees/feet/ankles/toes)
          const idleBones = [];
          obj.traverse(c => {
            if (!c.isBone) return;
            const n = c.name.toLowerCase();
            const isUpper = n.includes("spine") || n.includes("chest") ||
                            n.includes("neck")  || n.includes("head")  ||
                            n.includes("shoulder") || n.includes("arm") ||
                            n.includes("forearm")  || n.includes("hand") ||
                            n.includes("clavicle");
            if (isUpper) {
              // Each bone gets unique phase offsets for organic, non-repeating feel
              idleBones.push({
                bone:   c,
                baseRot: null, // snapshotted when breathing starts
                // Sway frequencies and phases — all slightly irrational for aperiodic motion
                phX1: Math.random() * Math.PI * 2, frX1: 0.31 + Math.random() * 0.18,
                phX2: Math.random() * Math.PI * 2, frX2: 0.71 + Math.random() * 0.22,
                phZ1: Math.random() * Math.PI * 2, frZ1: 0.27 + Math.random() * 0.15,
                phZ2: Math.random() * Math.PI * 2, frZ2: 0.63 + Math.random() * 0.19,
                ampX: 0.008 + Math.random() * 0.006,
                ampZ: 0.006 + Math.random() * 0.005,
              });
            }
          });

          // Lower leg / foot bones to keep locked during idle
          const lowerLockBones = [];
          obj.traverse(c => {
            if (!c.isBone) return;
            const n = c.name.toLowerCase();
            if (n.includes("knee") || n.includes("foot") ||
                n.includes("toe")  || n.includes("ankle")) {
              lowerLockBones.push({ bone: c, worldPos: null });
            }
          });

          const tmpQ  = new THREE.Quaternion();
          const leanQ = new THREE.Quaternion();

          const animateWithBreath = () => {
            animId = requestAnimationFrame(animateWithBreath);
            const dt = Math.min(clock.getDelta(), 0.05);
            if (mixer) mixer.update(dt);

            const toCamX = camera.position.x - crossGroup.position.x;
            const toCamZ = camera.position.z - crossGroup.position.z;
            const camAngle = Math.atan2(toCamX, toCamZ);
            crossGroup.rotation.set(0, camAngle, 0);
            updateGlitter(clock.elapsedTime);
            crossMat.opacity = 0.88 + Math.sin(clock.elapsedTime * 4.1) * 0.08 + Math.sin(clock.elapsedTime * 11.3) * 0.04;

            // Project crux world position → normalized screen coords for fog canvas
            const cruxWorld = new THREE.Vector3(crossGroup.position.x, crossGroup.position.y + crossH * 0.70, crossGroup.position.z);
            cruxWorld.project(camera);
            cruxScreenPos.current = {
              x: (cruxWorld.x + 1) / 2,
              y: (1 - cruxWorld.y) / 2,
            };

            if (phase === "bounce") {
              bounceTime += dt;
              const force = -stiffness * disp - damping * vel;
              vel  += force * dt;
              disp += vel   * dt;
              obj.position.y = restY + disp;

              // t: 0→1 over bounce duration, clamped, used to blend back to base
              const t = Math.min(bounceTime / bounceDuration, 1.0);

              // Torso/thigh: slight forward lean peaking at bounce apex, fades with t
              // Max lean ~4° forward (positive x rotation in local space)
              const leanAmt = (disp / kickVel) * 0.07 * (1 - t * t);
              leanBones.forEach(lb => {
                leanQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), leanAmt);
                lb.bone.quaternion.copy(lb.baseRot).multiply(leanQ);
              });

              // Arm ragdoll: each arm bone driven by figure's vertical acceleration
              const armStiff = 8, armDamp = 2.5;
              const accel = force; // reuse spring force as proxy for acceleration
              armBones.forEach(ab => {
                if (!ab.baseRot) return;
                const extForce = accel * 0.004;
                const fx = -armStiff * ab.dispX - armDamp * ab.velX + extForce;
                const fy = -armStiff * ab.dispY - armDamp * ab.velY + extForce * 0.5;
                ab.velX += fx * dt; ab.dispX += ab.velX * dt;
                ab.velY += fy * dt; ab.dispY += ab.velY * dt;
                const blend = 1 - t;
                const rx = ab.dispX * blend * 0.35;
                const ry = ab.dispY * blend * 0.20;
                tmpQ.setFromEuler(new THREE.Euler(rx, ry, 0));
                ab.bone.quaternion.copy(ab.baseRot).multiply(tmpQ);
              });

              // Foot locking
              if (footPositionsLocked) {
                footBones.forEach(fb => {
                  if (!fb.worldPos) return;
                  const parent = fb.bone.parent;
                  if (parent) {
                    parent.updateWorldMatrix(true, false);
                    const invParent = new THREE.Matrix4().copy(parent.matrixWorld).invert();
                    const localTarget = fb.worldPos.clone().applyMatrix4(invParent);
                    fb.bone.position.copy(localTarget);
                  }
                });
              }

              if (Math.abs(disp) < 0.8 && Math.abs(vel) < 0.8) {
                obj.position.y = restY;

                // Snapshot every idle bone's current world quaternion BEFORE any resets
                // so idle starts exactly where bounce left off
                idleBones.forEach(ib => {
                  ib.bone.updateWorldMatrix(true, false);
                  // Store world-space quat; we'll apply relative to parent each frame
                  const worldQ = new THREE.Quaternion();
                  ib.bone.getWorldQuaternion(worldQ);
                  ib.worldBaseQ = worldQ;
                  // Also store local quat as-is right now
                  ib.baseRot = ib.bone.quaternion.clone();
                });

                // Snapshot lower-leg world positions before any movement
                lowerLockBones.forEach(lb => {
                  lb.bone.updateWorldMatrix(true, false);
                  lb.worldPos = new THREE.Vector3();
                  lb.bone.getWorldPosition(lb.worldPos);
                });

                leanBones.forEach(lb => { lb.bone.quaternion.copy(lb.baseRot); });
                // Arms stay where they landed — no reset
                disp = 0; vel = 0;
                breathTime = 0;
                phase = "breathing";
              }
            }

            if (phase === "breathing") {
              breathTime += dt;

              // Subtle upper-body idle sway — aperiodic, zero displacement at t=0
              const eq = new THREE.Euler();
              const qq = new THREE.Quaternion();
              idleBones.forEach(ib => {
                if (!ib.baseRot) return;
                // Subtract the t=0 value so displacement starts exactly at zero
                const rx = (Math.sin(breathTime * ib.frX1 * Math.PI * 2 + ib.phX1) - Math.sin(ib.phX1)) * ib.ampX
                         + (Math.sin(breathTime * ib.frX2 * Math.PI * 2 + ib.phX2) - Math.sin(ib.phX2)) * ib.ampX * 0.5;
                const rz = (Math.sin(breathTime * ib.frZ1 * Math.PI * 2 + ib.phZ1) - Math.sin(ib.phZ1)) * ib.ampZ
                         + (Math.sin(breathTime * ib.frZ2 * Math.PI * 2 + ib.phZ2) - Math.sin(ib.phZ2)) * ib.ampZ * 0.5;
                eq.set(rx, 0, rz);
                qq.setFromEuler(eq);
                // Apply on top of snapshotted pose — starts exactly where bounce ended
                ib.bone.quaternion.copy(ib.baseRot).multiply(qq);
              });

              // Keep knees and feet world-locked
              lowerLockBones.forEach(lb => {
                if (!lb.worldPos) return;
                const parent = lb.bone.parent;
                if (parent) {
                  parent.updateWorldMatrix(true, false);
                  const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
                  lb.bone.position.copy(lb.worldPos.clone().applyMatrix4(inv));
                }
              });
            }

            renderer.render(scene, camera);
          };
          animId = requestAnimationFrame(animateWithBreath);
          return;
        }
      };
      if (assetCache.has("/Praying.fbx")) {
        _loadPraying(new FBXLoader().parse(assetCache.get("/Praying.fbx").slice(0), ""));
      } else {
        new FBXLoader().load("/Praying.fbx", _loadPraying, undefined, e => console.warn("Audio FBX load error:", e));
      }

      // Default fallback animate — only runs if FBX fails to load
      setTimeout(() => {
        if (!animId) {
          const animate = () => {
            animId = requestAnimationFrame(animate);
            renderer.render(scene, camera);
          };
          animate();
        }
      }, 3000);
    }).catch(e => console.warn("Three.js import error:", e));

    return () => {
      cancelled = true;
      cancelAnimationFrame(animId);
      if (rendererInst) {
        rendererInst.dispose();
        if (el.contains(rendererInst.domElement)) el.removeChild(rendererInst.domElement);
      }
    };
  }, []);

  const fogCanvasRef  = useRef(null);
  const cruxScreenPos = useRef({ x: 0.38, y: 0.28 }); // normalized 0-1

  // 2D flickering fog glow around cross
  useEffect(() => {
    const canvas = fogCanvasRef.current;
    if (!canvas) return;
    let rafId;
    const startTime = performance.now();

    // Crux screen position read from projected Three.js coords each frame via cruxScreenPos ref

    // Fog layers — all centered tightly on crux, varied radii
    const NUM_BLOBS = 10;
    const blobs = Array.from({ length: NUM_BLOBS }, (_, i) => ({
      offX:      (Math.random() - 0.5) * 0.04,  // tight cluster around crux
      offY:      (Math.random() - 0.5) * 0.04,
      radius:    0.05 + Math.random() * 0.12,
      // Rapid flicker: high-frequency primary + slower secondary
      speed1:    8  + Math.random() * 18,
      speed2:    3  + Math.random() * 7,
      phase1:    Math.random() * Math.PI * 2,
      phase2:    Math.random() * Math.PI * 2,
      baseAlpha: 0.18 + Math.random() * 0.22,
      r: 200 + Math.floor(Math.random() * 55),
      g: 215 + Math.floor(Math.random() * 40),
      b: 255,
    }));

    let lastFog = 0;
    const draw = (ts) => {
      rafId = requestAnimationFrame(draw);
      if (ts - lastFog < 33) return; // throttle to ~30fps
      lastFog = ts;
      const t  = (performance.now() - startTime) / 1000;
      const cw = canvas.offsetWidth;
      const ch = canvas.offsetHeight;
      if (cw === 0 || ch === 0) return;
      canvas.width  = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, cw, ch);

      const ox = cw * cruxScreenPos.current.x;
      const oy = ch * cruxScreenPos.current.y;

      blobs.forEach(b => {
        const f1 = Math.abs(Math.sin(t * b.speed1 + b.phase1));
        const f2 = Math.sin(t * b.speed2 + b.phase2) * 0.5 + 0.5;
        const alpha = b.baseAlpha * f1 * (0.4 + f2 * 0.6);
        if (alpha < 0.005) return;
        const bx = ox + b.offX * cw;
        const by = oy + b.offY * ch;
        const r  = b.radius * Math.min(cw, ch) * (0.8 + f2 * 0.4);

        const grad = ctx.createRadialGradient(bx, by, 0, bx, by, r);
        grad.addColorStop(0,    `rgba(${b.r},${b.g},${b.b},${alpha})`);
        grad.addColorStop(0.35, `rgba(${b.r},${b.g},${b.b},${alpha * 0.5})`);
        grad.addColorStop(1,    `rgba(${b.r},${b.g},${b.b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fill();
      });
    };
    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div style={{
      position: "fixed", left: 224, top: 0, right: 0, bottom: 70,
      pointerEvents: "none", zIndex: -1, opacity,
      transition: "opacity 0.5s ease",
      willChange: "opacity",
    }}>
      <div ref={mountRef} style={{ position: "absolute", inset: 0, filter: "drop-shadow(0 0 6px #00ffcc88) drop-shadow(0 0 18px #00ffcc44)" }} />
      <canvas ref={fogCanvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
    </div>
  );
}


// ─── WORKOUT FIGURE BACKDROP ──────────────────────────────────────────────────
function WorkoutFigureBackdrop({ fading = false }) {
  const mountRef = useRef(null);
  const [opacity, setOpacity] = useState(0);

  useEffect(() => {
    if (fading) { setOpacity(0); return; }
    const t = setTimeout(() => setOpacity(0.85), 250);
    return () => clearTimeout(t);
  }, [fading]);

  useEffect(() => {
    if (!mountRef.current) return;
    const el = mountRef.current;
    let animId = null;
    let rendererInst = null;
    let cancelled = false;

    Promise.all([
      import("three"),
      import("three/examples/jsm/loaders/FBXLoader"),
    ]).then(([THREE, { FBXLoader }]) => {
      if (cancelled) return;
      const w = window.innerWidth - 224;
      const h = window.innerHeight - 70;

      const scene  = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 2000);
      camera.position.set(-w * 0.32, 160, 660);
      camera.lookAt(0, 160, 0);

      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(w, h);
      renderer.setClearColor(0x000000, 0);
      el.appendChild(renderer.domElement);
      rendererInst = renderer;

      const wireMat = new THREE.MeshBasicMaterial({
        color: 0x00ffcc, wireframe: true,
        transparent: true, opacity: 0.32,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });

      const clock = new THREE.Clock();
      const ROTATION_Y = -(Math.PI / 6) - (20 * Math.PI / 180);

      const applyTransform = (THREE, obj) => {
        obj.traverse(c => {
          if (c.isMesh) { c.material = wireMat; c.castShadow = c.receiveShadow = false; }
        });
        const box    = new THREE.Box3().setFromObject(obj);
        const size   = box.getSize(new THREE.Vector3());
        const fovRad = (40 * Math.PI) / 180;
        const worldH = 2 * Math.tan(fovRad / 2) * 600;
        const scale  = (worldH * 0.65) / size.y;
        const newScale = scale * 1.495;
        obj.scale.setScalar(newScale);
        const box2   = new THREE.Box3().setFromObject(obj);
        const extraH = size.y * (newScale - scale);
        obj.position.set(110, -box2.min.y - extraH + 70, 0);
        obj.rotation.y = ROTATION_Y;
        return { savedScale: obj.scale.clone(), savedPos: obj.position.clone() };
      };

      // Preload both FBX files simultaneously so loop is ready instantly
      Promise.all([
        assetCache.has("/Idle_To_Push_Up.fbx")
          ? Promise.resolve(new FBXLoader().parse(assetCache.get("/Idle_To_Push_Up.fbx").slice(0), ""))
          : new Promise((res, rej) => new FBXLoader().load("/Idle_To_Push_Up.fbx", res, undefined, rej)),
        assetCache.has("/Push_Up.fbx")
          ? Promise.resolve(new FBXLoader().parse(assetCache.get("/Push_Up.fbx").slice(0), ""))
          : new Promise((res, rej) => new FBXLoader().load("/Push_Up.fbx", res, undefined, rej)),
      ]).then(([introObj, loopObj]) => {
        if (cancelled) return;

        const { savedScale, savedPos } = applyTransform(THREE, introObj);
        applyTransform(THREE, loopObj);

        // Keep loop hidden until needed
        loopObj.visible = false;
        scene.add(introObj);
        scene.add(loopObj);

        let activeMixer = new THREE.AnimationMixer(introObj);
        let loopMixer   = null;

        // Pre-build loop mixer so it's ready with no load delay
        if (loopObj.animations?.length) {
          loopMixer = new THREE.AnimationMixer(loopObj);
          const loopAction = loopMixer.clipAction(loopObj.animations[0]);
          loopAction.setLoop(THREE.LoopRepeat, Infinity);
          loopAction.play();
          loopMixer.update(0); // prime first frame
        }

        if (introObj.animations?.length) {
          const introAction = activeMixer.clipAction(introObj.animations[0]);
          introAction.setLoop(THREE.LoopOnce, 1);
          introAction.clampWhenFinished = true;
          introAction.play();
        }

        let swapped = false;
        activeMixer.addEventListener("finished", () => {
          if (cancelled || swapped) return;
          swapped = true;

          // Reset loop to frame 0 first so bone positions are at start pose
          if (loopMixer && loopObj.animations?.length) {
            loopMixer.stopAllAction();
            const loopAction = loopMixer.clipAction(loopObj.animations[0]);
            loopAction.setLoop(THREE.LoopRepeat, Infinity);
            loopAction.time = 0;
            loopAction.play();
            loopMixer.update(0);
          }

          // Find the root/hips bone in each skeleton
          let introBone = null, loopBone = null;
          const rootNames = ["hips", "pelvis", "root", "spine"];
          introObj.traverse(c => {
            if (!introBone && c.isBone) {
              const n = c.name.toLowerCase();
              if (rootNames.some(r => n.includes(r))) introBone = c;
            }
          });
          loopObj.traverse(c => {
            if (!loopBone && c.isBone) {
              const n = c.name.toLowerCase();
              if (rootNames.some(r => n.includes(r))) loopBone = c;
            }
          });
          // Fallback: use first bone found
          if (!introBone) introObj.traverse(c => { if (!introBone && c.isBone) introBone = c; });
          if (!loopBone)  loopObj.traverse(c  => { if (!loopBone  && c.isBone) loopBone  = c; });

          if (introBone && loopBone) {
            // Get world positions of both root bones
            introBone.updateWorldMatrix(true, false);
            loopBone.updateWorldMatrix(true, false);
            const introWorldPos = new THREE.Vector3();
            const loopWorldPos  = new THREE.Vector3();
            introBone.getWorldPosition(introWorldPos);
            loopBone.getWorldPosition(loopWorldPos);

            // Shift loop object so its root bone lands exactly where intro's root bone is
            loopObj.position.x += introWorldPos.x - loopWorldPos.x;
            loopObj.position.y += introWorldPos.y - loopWorldPos.y;
            loopObj.position.z += introWorldPos.z - loopWorldPos.z;
          } else {
            // Fallback: match bounding box bottoms
            const introBox = new THREE.Box3().setFromObject(introObj);
            const loopBox  = new THREE.Box3().setFromObject(loopObj);
            loopObj.position.y += introBox.min.y - loopBox.min.y;
          }

          // Swap visibility
          introObj.visible = false;
          loopObj.visible  = true;
          activeMixer      = loopMixer;
        });

        const animate = () => {
          animId = requestAnimationFrame(animate);
          const dt = Math.min(clock.getDelta(), 0.05);
          if (activeMixer) activeMixer.update(dt);
          renderer.render(scene, camera);
        };
        animate();
      }).catch(e => console.warn("Workout FBX load error:", e));
    }).catch(e => console.warn("Three.js import error:", e));

    return () => {
      cancelled = true;
      cancelAnimationFrame(animId);
      if (rendererInst) {
        rendererInst.dispose();
        if (el.contains(rendererInst.domElement)) el.removeChild(rendererInst.domElement);
      }
    };
  }, []);

  return (
    <div ref={mountRef} style={{
      position: "fixed",
      left: 224, top: 0, right: 0, bottom: 70,
      pointerEvents: "none", zIndex: -1,
      opacity, transition: "opacity 0.5s ease",
      filter: "drop-shadow(0 0 6px #00ffcc88) drop-shadow(0 0 18px #00ffcc44)",
      willChange: "opacity",
    }} />
  );
}


const REP_CATS = [1, 5, 10, 15];
const REP_COLORS = { 1: "#b5f03c", 5: "#60a5fa", 10: "#f97316", 15: "#a78bfa" };


// ─── MY RANK CARD ─────────────────────────────────────────────────────────────
function BodyweightRankCard({ username, exercise, userLogs, communityUsers = [] }) {
  const leaderboard = useMemo(() => {
    const entries = [];
    const myBest = Math.max(0, ...userLogs.filter(l => l.exercise === exercise).map(l => l.weight));
    if (myBest > 0) entries.push({ name: username, weight: myBest, isMe: true });
    communityUsers.forEach(u => {
      const series = u.logs[exercise]?.[0];
      if (series?.length) entries.push({ name: u.name, weight: Math.max(...series.map(e => e.weight)), isMe: false });
    });
    return entries.sort((a, b) => b.weight - a.weight);
  }, [username, exercise, userLogs, communityUsers]);

  const myEntry  = leaderboard.find(e => e.isMe);
  const rank     = myEntry ? leaderboard.findIndex(e => e.isMe) + 1 : null;
  const total    = leaderboard.length;
  const ordinal  = n => { const s = ["th","st","nd","rd"], v = n % 100; return n + (s[(v-20)%10] || s[v] || s[0]); };
  const percentile = rank && total > 1 ? Math.round(((total - rank) / (total - 1)) * 100) : rank === 1 && total === 1 ? 100 : null;
  const MEDALS = [
    { color: "#ffdd00", label: "GOLD",   shadow: "0 0 16px #ffdd0099" },
    { color: "#c8d4de", label: "SILVER", shadow: "0 0 12px #c8d4de55" },
    { color: "#ff9944", label: "BRONZE", shadow: "0 0 12px #ff994455" },
  ];
  const medal  = rank && rank <= 3 ? MEDALS[rank - 1] : null;
  const barPct = percentile !== null ? Math.max(2, percentile) : 0;
  const numSize = !rank ? 68 : rank >= 100 ? 46 : rank >= 10 ? 56 : 68;

  return (
    <div style={{
      background: "linear-gradient(160deg,rgba(0,22,13,.55),rgba(0,12,7,.38) 50%,rgba(0,4,2,.45))",
      border: "1px solid rgba(136,255,0,.28)", borderTop: "1px solid rgba(136,255,0,.30)",
      borderLeft: "1px solid rgba(136,255,0,.18)",
      boxShadow: "0 2px 0 rgba(136,255,0,0.10), 0 8px 24px rgba(0,0,0,0.6), 0 28px 64px rgba(0,0,0,0.5), inset 0 1px 0 rgba(136,255,0,0.15), inset 0 0 60px rgba(136,255,0,0.025)",
      borderRadius: "var(--radius)", padding: "26px 30px 24px", marginBottom: 24,
      position: "relative", overflow: "hidden", animation: "rankGlow 4s ease-in-out infinite",
    }}>
      <div style={{ position:"absolute", top:0, left:0, width:18, height:18, borderTop:"2px solid var(--lime)", borderLeft:"2px solid var(--lime)" }} />
      <div style={{ position:"absolute", bottom:0, right:0, width:18, height:18, borderBottom:"2px solid var(--cyan)", borderRight:"2px solid var(--cyan)" }} />
      <div style={{ position:"absolute", top:0, left:0, right:0, height:1, background:"var(--energy-grad)", backgroundSize:"300% 300%", animation:"sheen 2s ease-in-out infinite" }} />
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:22 }}>
        <div style={{ fontFamily:"'Orbitron',sans-serif", fontWeight:700, fontSize:11, letterSpacing:2, textTransform:"uppercase", color:"var(--accent)", display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ color:"var(--lime)" }}>◆</span> Your Rank
        </div>
        <div style={{ fontFamily:"'Orbitron',sans-serif", fontSize:10, color:"var(--muted)", letterSpacing:1.5, textTransform:"uppercase", background:"rgba(136,255,0,.05)", border:"1px solid var(--border)", padding:"3px 10px", borderRadius:2 }}>
          {exercise} · Rep Count
        </div>
      </div>
      {!myEntry ? (
        <div style={{ textAlign:"center", padding:"28px 0", color:"var(--muted)", fontSize:12, fontFamily:"'Orbitron',sans-serif", letterSpacing:2, textTransform:"uppercase" }}>
          Log a {exercise} entry to see your rank
        </div>
      ) : (
        <div style={{ display:"flex", alignItems:"center", gap:28, flexWrap:"wrap" }}>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6, flexShrink:0 }}>
            <div style={{ fontFamily:"'Orbitron',sans-serif", fontWeight:900, fontSize:numSize, lineHeight:1, letterSpacing:-2, background:"var(--chrome-grad)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", backgroundClip:"text", filter: medal ? "drop-shadow(0 0 28px "+medal.color+"cc)" : "drop-shadow(0 0 22px rgba(136,255,0,.9))" }}>
              {ordinal(rank)}
            </div>
            <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"'Orbitron',sans-serif", letterSpacing:1.5, textTransform:"uppercase" }}>of {total} athlete{total !== 1 ? "s" : ""}</div>
            {medal && <div style={{ fontSize:10, fontFamily:"'Orbitron',sans-serif", fontWeight:700, letterSpacing:2, textTransform:"uppercase", padding:"3px 10px", borderRadius:2, color:medal.color, border:"1px solid "+medal.color+"55", background:medal.color+"10", boxShadow:medal.shadow }}>{medal.label}</div>}
          </div>
          <div style={{ width:1, height:64, flexShrink:0, background:"linear-gradient(180deg,transparent,rgba(136,255,0,.25),transparent)" }} />
          <div style={{ display:"flex", flexDirection:"column", gap:16, flex:1, minWidth:190 }}>
            <div>
              <div style={{ fontSize:10, color:"var(--muted)", fontFamily:"'Orbitron',sans-serif", letterSpacing:2, textTransform:"uppercase", marginBottom:4 }}>Your best</div>
              <div style={{ fontFamily:"'Orbitron',sans-serif", fontWeight:700, fontSize:16, color:"var(--accent)", textShadow:"var(--glow-sm)" }}>
                {myEntry.weight} <span style={{ fontSize:11, color:"var(--muted)", fontWeight:400, fontFamily:"'Rajdhani',sans-serif" }}>reps</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize:10, color:"var(--muted)", fontFamily:"'Orbitron',sans-serif", letterSpacing:2, textTransform:"uppercase", marginBottom:4 }}>Percentile rank</div>
              <div style={{ display:"flex", alignItems:"baseline", gap:8, marginBottom:6 }}>
                <span style={{ fontFamily:"'Orbitron',sans-serif", fontWeight:900, fontSize:22, color: percentile >= 90 ? "var(--lime)" : percentile >= 50 ? "var(--accent)" : "var(--muted)", textShadow: percentile >= 90 ? "var(--glow-lime)" : percentile >= 50 ? "var(--glow-sm)" : "none" }}>
                  {percentile !== null ? percentile+"th" : "—"}
                </span>
                <span style={{ fontSize:11, color:"var(--muted)", fontFamily:"'Orbitron',sans-serif", letterSpacing:1 }}>percentile</span>
              </div>
              <div style={{ height:5, background:"rgba(136,255,0,.06)", border:"1px solid rgba(136,255,0,.1)", overflow:"hidden", marginBottom:4 }}>
                <div style={{ height:"100%", width:barPct+"%", background:"var(--energy-grad)", backgroundSize:"300% 300%", animation:"sheen 2s ease-in-out infinite", boxShadow:"0 0 10px #88ff0077", transition:"width 1s cubic-bezier(.16,1,.3,1)" }} />
              </div>
              <div style={{ fontSize:11, color:"var(--muted)" }}>{percentile !== null ? "Does more than "+percentile+"% of logged athletes" : ""}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MyRankCard({ username, exercise, repCat, userLogs, communityUsers = [] }) {
  const leaderboard = useMemo(() => {
    const entries = [];
    const myBest = Math.max(0, ...userLogs
      .filter(l => l.exercise === exercise && l.repCat === repCat)
      .map(l => l.weight));
    if (myBest > 0) entries.push({ name: username, weight: myBest, isMe: true });
    communityUsers.forEach(u => {
      const series = u.logs[exercise]?.[repCat];
      if (series?.length) entries.push({ name: u.name, weight: Math.max(...series.map(e => e.weight)), isMe: false });
    });
    return entries.sort((a, b) => b.weight - a.weight);
  }, [username, exercise, repCat, userLogs, communityUsers]);

  const myEntry  = leaderboard.find(e => e.isMe);
  const rank     = myEntry ? leaderboard.findIndex(e => e.isMe) + 1 : null;
  const total    = leaderboard.length;
  const ordinal  = n => { const s = ["th","st","nd","rd"], v = n % 100; return n + (s[(v-20)%10] || s[v] || s[0]); };
  const percentile = rank && total > 1
    ? Math.round(((total - rank) / (total - 1)) * 100)
    : rank === 1 && total === 1 ? 100 : null;
  const MEDALS = [
    { color: "#ffdd00", label: "GOLD",   shadow: "0 0 16px #ffdd0099" },
    { color: "#c8d4de", label: "SILVER", shadow: "0 0 12px #c8d4de55" },
    { color: "#ff9944", label: "BRONZE", shadow: "0 0 12px #ff994455" },
  ];
  const medal   = rank && rank <= 3 ? MEDALS[rank - 1] : null;
  const barPct  = percentile !== null ? Math.max(2, percentile) : 0;
  const numSize = !rank ? 68 : rank >= 100 ? 46 : rank >= 10 ? 56 : 68;

  return (
    <div style={{
      background: "linear-gradient(160deg,rgba(0,22,13,.55),rgba(0,12,7,.38) 50%,rgba(0,4,2,.45))",
      border: "1px solid rgba(136,255,0,.28)",
      borderTop: "1px solid rgba(136,255,0,.30)",
      borderLeft: "1px solid rgba(136,255,0,.18)",
      boxShadow: "0 2px 0 rgba(136,255,0,0.10), 0 8px 24px rgba(0,0,0,0.6), 0 28px 64px rgba(0,0,0,0.5), inset 0 1px 0 rgba(136,255,0,0.15), inset 0 0 60px rgba(136,255,0,0.025)", borderRadius: "var(--radius)",
      padding: "26px 30px 24px", marginBottom: 24, position: "relative",
      overflow: "hidden", animation: "rankGlow 4s ease-in-out infinite",
    }}>
      <div style={{ position:"absolute", top:0, left:0, width:18, height:18, borderTop:"2px solid var(--lime)", borderLeft:"2px solid var(--lime)" }} />
      <div style={{ position:"absolute", bottom:0, right:0, width:18, height:18, borderBottom:"2px solid var(--cyan)", borderRight:"2px solid var(--cyan)" }} />
      <div style={{ position:"absolute", top:0, left:0, right:0, height:1, background:"var(--energy-grad)", backgroundSize:"300% 300%", animation:"sheen 2s ease-in-out infinite" }} />
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:22 }}>
        <div style={{ fontFamily:"'Orbitron',sans-serif", fontWeight:700, fontSize:11, letterSpacing:2, textTransform:"uppercase", color:"var(--accent)", display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ color:"var(--lime)" }}>◆</span> Your Rank
        </div>
        <div style={{ fontFamily:"'Orbitron',sans-serif", fontSize:10, color:"var(--muted)", letterSpacing:1.5, textTransform:"uppercase", background:"rgba(136,255,0,.05)", border:"1px solid var(--border)", padding:"3px 10px", borderRadius:2 }}>
          {exercise} · {repCat} Rep{repCat > 1 ? "s" : ""}
        </div>
      </div>
      {!myEntry ? (
        <div style={{ textAlign:"center", padding:"28px 0", color:"var(--muted)", fontSize:12, fontFamily:"'Orbitron',sans-serif", letterSpacing:2, textTransform:"uppercase" }}>
          Log a {exercise} {repCat}-rep set to see your rank
        </div>
      ) : (
        <div style={{ display:"flex", alignItems:"center", gap:28, flexWrap:"wrap" }}>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6, flexShrink:0 }}>
            <div style={{ fontFamily:"'Orbitron',sans-serif", fontWeight:900, fontSize:numSize, lineHeight:1, letterSpacing:-2, background:"var(--chrome-grad)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", backgroundClip:"text", filter: medal ? "drop-shadow(0 0 28px "+medal.color+"cc)" : "drop-shadow(0 0 22px rgba(136,255,0,.9))" }}>
              {ordinal(rank)}
            </div>
            <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"'Orbitron',sans-serif", letterSpacing:1.5, textTransform:"uppercase" }}>
              of {total} athlete{total !== 1 ? "s" : ""}
            </div>
            {medal && (
              <div style={{ fontSize:10, fontFamily:"'Orbitron',sans-serif", fontWeight:700, letterSpacing:2, textTransform:"uppercase", padding:"3px 10px", borderRadius:2, color:medal.color, border:"1px solid "+medal.color+"55", background:medal.color+"10", boxShadow:medal.shadow }}>
                {medal.label}
              </div>
            )}
          </div>
          <div style={{ width:1, height:64, flexShrink:0, background:"linear-gradient(180deg,transparent,rgba(136,255,0,.25),transparent)" }} />
          <div style={{ display:"flex", flexDirection:"column", gap:16, flex:1, minWidth:190 }}>
            <div>
              <div style={{ fontSize:10, color:"var(--muted)", fontFamily:"'Orbitron',sans-serif", letterSpacing:2, textTransform:"uppercase", marginBottom:4 }}>Your best lift</div>
              <div style={{ fontFamily:"'Orbitron',sans-serif", fontWeight:700, fontSize:16, color:"var(--accent)", textShadow:"var(--glow-sm)" }}>
                {myEntry.weight} <span style={{ fontSize:11, color:"var(--muted)", fontWeight:400, fontFamily:"'Rajdhani',sans-serif" }}>lbs</span>
              </div>
            </div>
            <div>
              <div style={{ fontSize:10, color:"var(--muted)", fontFamily:"'Orbitron',sans-serif", letterSpacing:2, textTransform:"uppercase", marginBottom:4 }}>Percentile rank</div>
              <div style={{ display:"flex", alignItems:"baseline", gap:8, marginBottom:6 }}>
                <span style={{ fontFamily:"'Orbitron',sans-serif", fontWeight:900, fontSize:22, color: percentile >= 90 ? "var(--lime)" : percentile >= 50 ? "var(--accent)" : "var(--muted)", textShadow: percentile >= 90 ? "var(--glow-lime)" : percentile >= 50 ? "var(--glow-sm)" : "none" }}>
                  {percentile !== null ? percentile+"th" : "—"}
                </span>
                <span style={{ fontSize:11, color:"var(--muted)", fontFamily:"'Orbitron',sans-serif", letterSpacing:1 }}>percentile</span>
              </div>
              <div style={{ height:5, background:"rgba(136,255,0,.06)", border:"1px solid rgba(136,255,0,.1)", overflow:"hidden", marginBottom:4 }}>
                <div style={{ height:"100%", width:barPct+"%", background:"var(--energy-grad)", backgroundSize:"300% 300%", animation:"sheen 2s ease-in-out infinite", boxShadow:"0 0 10px #88ff0077", transition:"width 1s cubic-bezier(.16,1,.3,1)" }} />
              </div>
              <div style={{ fontSize:11, color:"var(--muted)" }}>
                {percentile !== null ? "Lifts more than "+percentile+"% of logged athletes" : ""}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── WORKOUT PAGE ─────────────────────────────────────────────────────────────
function WorkoutPage({ username }) {
  const [logs, setLogs] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ exercise: "Bench Press", repCat: 1, weight: "" });

  // When switching to/from Pull-up, reset the weight field
  const setExercise = (ex) => setForm(f => ({ ...f, exercise: ex, repCat: (ex === "Pull-up" || ex === "Push-up") ? null : (f.repCat === null ? 1 : f.repCat), weight: "" }));

  const isPullup = form.exercise === "Pull-up";
  const isPushup = form.exercise === "Push-up";
  const isBodyweight = isPullup || isPushup;
  const [chartEx, setChartEx] = useState("Bench Press");
  const [compareUser, setCompareUser] = useState(null);
  const [dupError, setDupError] = useState(null);
  const { communityUsers } = useCommunityUsers(username);

  useEffect(() => {
    api.getLogs()
      .then(data => setLogs(data))
      .catch(err => console.warn("getLogs:", err));
  }, [username]);

  useEffect(() => { setDupError(null); }, [form.exercise, form.repCat, isBodyweight]);

  const addLog = async () => {
    if (!form.weight) return;
    const today = new Date();
    const todayStr = today.toLocaleDateString("en-US", { month:"short", day:"numeric" });
    const duplicate = logs.find(l => l.exercise === form.exercise && (isBodyweight ? l.exercise === form.exercise : l.repCat === Number(form.repCat)) && l.date === todayStr);
    if (duplicate) {
      setDupError(isBodyweight
        ? `You already logged ${form.exercise} today — come back tomorrow!`
        : `You already logged ${form.exercise} at ${Number(form.repCat)} rep${Number(form.repCat)>1?"s":""} today — come back tomorrow!`);
      return;
    }
    setDupError(null);
    const ts = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0, 0).getTime();
    const entry = {
      exercise: form.exercise,
      repCat: isBodyweight ? 0 : Number(form.repCat),
      weight:   Number(form.weight),
      date:     todayStr,
      ts,
    };
    try {
      const { id } = await api.addLog(entry);
      setLogs(prev => [...prev, { ...entry, id }]);
      setForm({ exercise: "Bench Press", repCat: 1, weight: "" });
      setShowForm(false);
    } catch (err) {
      alert(`Could not save log: ${err.message}`);
    }
  };

  const delLog = async (id) => {
    try {
      await api.deleteLog(id);
      setLogs(prev => prev.filter(l => l.id !== id));
    } catch (err) {
      console.warn("delLog:", err);
    }
  };

  // Build chart data for selected exercise: 4 lines, one per rep category
  const buildChartData = () => {
    const byRep = {};
    REP_CATS.forEach(r => {
      byRep[r] = logs.filter(l => l.exercise === chartEx && l.repCat === r).map((l, i) => ({ session: i+1, weight: l.weight, date: l.date }));
    });
    const maxLen = Math.max(...REP_CATS.map(r => byRep[r].length), 0);
    if (!maxLen) return [];
    return Array.from({ length: maxLen }, (_, i) => {
      const pt = { session: i + 1 };
      REP_CATS.forEach(r => { if (byRep[r][i]) pt[`${r} Rep`] = byRep[r][i].weight; });
      return pt;
    });
  };

  // Build compare chart data for a specific rep cat overlay
  const buildCompareData = (repCat) => {
    // My entries — keep real timestamps for the x-axis
    const myEntries = logs
      .filter(l => l.exercise === chartEx && l.repCat === repCat)
      .map(l => ({ ts: l.ts || Date.now(), [username]: l.weight }));

    // Other user's entries — synthesise evenly-spaced timestamps so they
    // plot on the same time-scale axis (spaced 7 days apart ending today)
    const otherWeights = compareUser
      ? (communityUsers.find(u => u.name === compareUser)?.logs[chartEx]?.[repCat] || []).map(e => e.weight)
      : [];
    const now = Date.now();
    const otherEntries = otherWeights.map((w, i) => ({
      ts: now - (otherWeights.length - 1 - i) * 7 * 86400000,
      [compareUser]: w,
    }));

    // Merge into a single sorted array keyed by ts
    const merged = {};
    myEntries.forEach(e => { merged[e.ts] = { ...merged[e.ts], ts: e.ts, [username]: e[username] }; });
    otherEntries.forEach(e => { merged[e.ts] = { ...merged[e.ts], ts: e.ts, [compareUser]: e[compareUser] }; });
    return Object.values(merged).sort((a, b) => a.ts - b.ts);
  };

  const totalSessions = new Set(logs.map(l => l.date)).size;
  const totalEntries = logs.length;
  const exercisesTracked = new Set(logs.map(l => l.exercise)).size;

  const chartData = buildChartData();
  // Show charts if the user has their own data OR a compare user is selected
  const hasAnyData = chartData.length > 0 || !!compareUser;

  return (
    <div className="page">
      <div className="page-title">WORKOUT <span className="accentText">TRACKER</span></div>
      <div className="page-sub">&ldquo;The Lord is my strength and my praise: and he is become my salvation.&rdquo; &mdash; Psalms 117:14</div>

      <div className="stat-grid">
        <div className="stat-tile"><div className="stat-num">{totalEntries}</div><div className="stat-label">Total Entries</div></div>
        <div className="stat-tile"><div className="stat-num">{totalSessions}</div><div className="stat-label">Training Days</div></div>
        <div className="stat-tile"><div className="stat-num">{exercisesTracked}</div><div className="stat-label">Exercises Tracked</div></div>
      </div>

      {showForm && (
        <div className="modal-bg" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">LOG A <span className="accentText">LIFT</span></div>
            <div className="form-label" style={{marginBottom:6}}>Exercise</div>
            <select value={form.exercise} onChange={e => setExercise(e.target.value)} style={{marginBottom:14}}>
              {EXERCISE_LIST.map(ex => <option key={ex}>{ex}</option>)}
            </select>
            {!isBodyweight && (<>
            <div className="form-label" style={{marginBottom:8}}>Rep Category</div>
            <div style={{display:"flex",gap:8,marginBottom:14}}>
              {REP_CATS.map(r => (
                <div key={r}
                  onClick={() => setForm({...form, repCat: r})}
                  style={{
                    flex:1, textAlign:"center", padding:"10px 0", borderRadius:8, cursor:"pointer",
                    border:`2px solid ${form.repCat===r ? REP_COLORS[r] : "var(--border)"}`,
                    background: form.repCat===r ? `${REP_COLORS[r]}18` : "var(--surface2)",
                    color: form.repCat===r ? REP_COLORS[r] : "var(--muted)",
                    fontWeight:700, fontSize:14, transition:"all 0.15s"
                  }}>
                  {r} Rep{r > 1 ? "s" : ""}
                </div>
              ))}
            </div>
            <div className="form-label" style={{marginBottom:6}}>Weight (lbs)</div>
            <input type="number" placeholder="e.g. 225" value={form.weight} onChange={e=>setForm({...form,weight:e.target.value})}
              onKeyDown={e => e.key==="Enter" && addLog()} style={{marginBottom:4}} />
            <div style={{fontSize:11,color:"var(--muted)",marginBottom:16}}>Enter the max weight you lifted for {form.repCat} rep{form.repCat>1?"s":""}.</div>
            </>)}
            {isBodyweight && (<>
            <div className="form-label" style={{marginBottom:6}}>Number of {form.exercise}s</div>
            <input type="number" placeholder="e.g. 12" min="1" value={form.weight} onChange={e=>setForm({...form,weight:e.target.value})}
              onKeyDown={e => e.key==="Enter" && addLog()} style={{marginBottom:4}} />
            <div style={{fontSize:11,color:"var(--muted)",marginBottom:16}}>Enter the total number of {form.exercise.toLowerCase()}s you did.</div>
            </>)}
            {dupError && (
              <div style={{background:"rgba(255,60,60,0.12)",border:"1px solid rgba(255,60,60,0.4)",borderRadius:4,padding:"9px 12px",marginBottom:12,fontSize:12,color:"#ff6666",fontFamily:"'Rajdhani',sans-serif",letterSpacing:0.5}}>
                ⚠ {dupError}
              </div>
            )}
            <div className="flex-end">
              <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={addLog}>Save Entry</button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
          <div className="card-title" style={{marginBottom:0}}>Recent Entries</div>
          <button className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>+ Log Lift</button>
        </div>
        {logs.length === 0 ? (
          <div style={{textAlign:"center",padding:"32px 0",color:"var(--muted)"}}>No entries yet \u2014 hit "Log Lift" to record your first lift!</div>
        ) : (
          <table className="log-table">
            <thead><tr><th>Exercise</th><th>Rep Category</th><th>Weight</th><th>Date</th><th></th></tr></thead>
            <tbody>
              {[...logs].reverse().slice(0,4).map(l => (
                <tr key={l.id}>
                  <td><span className="badge">{l.exercise}</span></td>
                  <td style={{color: l.exercise === "Pull-up" ? "var(--accent)" : REP_COLORS[l.repCat], fontWeight:700}}>
                    {(l.exercise === "Pull-up" || l.exercise === "Push-up") ? l.exercise+"s" : `${l.repCat} Rep${l.repCat>1?"s":""}`}
                  </td>
                  <td style={{fontWeight:600}}>
                    {(l.exercise === "Pull-up" || l.exercise === "Push-up") ? <>{l.weight} <span style={{fontSize:11,color:"var(--muted)",fontWeight:400}}>reps</span></> : <>{l.weight} <span style={{fontSize:11,color:"var(--muted)",fontWeight:400}}>lbs</span></>}
                  </td>
                  <td style={{color:"var(--muted)"}}>{l.date}</td>
                  <td><button className="action-btn" onClick={() => delLog(l.id)} title="Delete" style={{fontSize:16, lineHeight:1, padding:"2px 6px", background:"none", border:"none", color:"var(--muted)", cursor:"pointer"}}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-title">Progress by Exercise</div>
        <div style={{fontSize:13,color:"var(--muted)",marginBottom:12}}>{chartEx === "Pull-up" ? "Your pull-up count over time." : "Select an exercise to see all 4 rep-range charts."}</div>
        <div className="tab-row">
          {EXERCISE_LIST.map(ex => <div key={ex} className={`tab ${chartEx===ex?"active":""}`} onClick={()=>setChartEx(ex)}>{ex}</div>)}
        </div>

        {chartEx === "Pull-up" ? (() => {
          const pullData = logs.filter(l => l.exercise === "Pull-up").map(l => ({ label: l.date, [username]: l.weight }));
          return pullData.length > 0 ? (
            <div style={{background:"linear-gradient(160deg,rgba(0,22,13,0.52),rgba(0,8,4,0.38))",boxShadow:"0 4px 16px rgba(0,0,0,0.5),0 12px 32px rgba(0,0,0,0.4),inset 0 1px 0 rgba(136,255,0,0.10)",borderTop:"1px solid rgba(136,255,0,0.14)",borderLeft:"1px solid rgba(136,255,0,0.08)",borderRadius:10,padding:"16px 12px",marginTop:16}}>
              <div style={{fontWeight:700,fontSize:13,marginBottom:12,color:"var(--accent)"}}>Pull-up Count</div>
              <div style={{height:220}}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={pullData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a32" />
                    <XAxis dataKey="label" stroke="#7a7a8a" tick={{fontSize:9}} angle={-30} textAnchor="end" height={36} />
                    <YAxis stroke="#7a7a8a" tick={{fontSize:10}} width={38} />
                    <Tooltip contentStyle={{background:"#141417",border:"1px solid #2a2a32",borderRadius:8,fontSize:11}} formatter={(v) => [`${v} reps`]} />
                    <Line type="monotone" dataKey={username} stroke="var(--accent)" strokeWidth={2.5} dot={{fill:"var(--accent)",r:3}} name={username} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : (
            <div style={{textAlign:"center",padding:"32px 0",color:"var(--muted)",fontSize:13}}>Log some Pull-up entries to see your progress!</div>
          );
        })() : hasAnyData ? (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
            {REP_CATS.map(repCat => {
              const data = compareUser ? buildCompareData(repCat) : (() => {
                const entries = logs.filter(l => l.exercise === chartEx && l.repCat === repCat);
                return entries.map(l => ({ label: l.date, [username]: l.weight }));
              })();
              const color = REP_COLORS[repCat];
              return (
                <div key={repCat} style={{background:"linear-gradient(160deg,rgba(0,22,13,0.52),rgba(0,8,4,0.38))",boxShadow:"0 4px 16px rgba(0,0,0,0.5),0 12px 32px rgba(0,0,0,0.4),inset 0 1px 0 rgba(136,255,0,0.10)",borderTop:"1px solid rgba(136,255,0,0.14)",borderLeft:"1px solid rgba(136,255,0,0.08)",borderRadius:10,padding:"16px 12px"}}>
                  <div style={{fontWeight:700,fontSize:13,marginBottom:12,color}}>
                    {repCat} Rep{repCat>1?"s":""}
                  </div>
                  <div style={{height:180}}>
                    {data.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={data}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a32" />
                          <XAxis dataKey={compareUser ? "ts" : "label"} type={compareUser ? "number" : "category"} scale={compareUser ? "time" : "auto"} domain={compareUser ? ["auto","auto"] : undefined} stroke="#7a7a8a" tick={{fontSize:9}} angle={-30} textAnchor="end" height={36} tickFormatter={compareUser ? ((v) => new Date(v).toLocaleDateString("en-US",{month:"short",day:"numeric"})) : undefined} />
                          <YAxis stroke="#7a7a8a" tick={{fontSize:10}} width={38} />
                          <Tooltip contentStyle={{background:"#141417",border:"1px solid #2a2a32",borderRadius:8,fontSize:11}} formatter={(v) => [`${v} lbs`]} />
                          <Line type="monotone" dataKey={username} stroke={color} strokeWidth={2.5} dot={{fill:color,r:3}} name={username} />
                          {compareUser && <Line type="monotone" dataKey={compareUser} stroke="#60a5fa" strokeWidth={2} dot={{fill:"#60a5fa",r:2}} strokeDasharray="4 4" name={compareUser} />}
                          {compareUser && <Legend wrapperStyle={{fontSize:10,fontFamily:"'Orbitron',sans-serif",paddingTop:6}} />}
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"var(--muted)",fontSize:12}}>
                        No {repCat}-rep data yet
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{textAlign:"center",padding:"32px 0",color:"var(--muted)",fontSize:13}}>
            Log some {chartEx} entries to see your progress charts!
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title"><span style={{fontFamily:"'Orbitron',sans-serif",fontSize:10,color:"var(--accent)",letterSpacing:2,marginRight:8}}>◈◈</span>Compare with Others</div>
        <div className="compare-grid">
          {communityUsers.length === 0 ? (
            <div style={{color:"var(--muted)",fontSize:13,padding:"8px 0"}}>
              No other brothers have logged data yet.
            </div>
          ) : communityUsers.map(u => (
            <div key={u.name} className={`compare-card ${compareUser===u.name?"sel":""}`} onClick={() => setCompareUser(compareUser===u.name?null:u.name)}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div className="avatar sm">{u.name.slice(0,2).toUpperCase()}</div>
                <div><div className="cname">{u.name}</div><div className="csub">{Object.keys(u.logs).length} exercises tracked</div></div>
              </div>
            </div>
          ))}
        </div>
        {compareUser && <div style={{fontSize:13,color:"var(--muted)",marginTop:4}}>Showing <span style={{color:"#60a5fa"}}>{compareUser}</span> as dashed lines on each chart above.</div>}
      </div>
    </div>
  );
}

// ─── PERMANENT TRACK LIST ─────────────────────────────────────────────────────
// Audio files are served from /public/audio/.
// To add a track: drop the .mp3 into public/audio/ and add an entry here.
const PERMANENT_TRACKS = [
  { id: 1,  title: "Genesis",               artist: "Holy Bible", src: "/audio/Genesis.mp3" },
  { id: 2,  title: "Exodus",                artist: "Holy Bible", src: "/audio/Exodus.mp3" },
  { id: 3,  title: "Leviticus",             artist: "Holy Bible", src: "/audio/Leviticus.mp3" },
  { id: 4,  title: "Numbers",               artist: "Holy Bible", src: "/audio/Numbers.mp3" },
  { id: 5,  title: "Deuteronomy",           artist: "Holy Bible", src: "/audio/Deuteronomy.mp3" },
  { id: 6,  title: "Josue",                 artist: "Holy Bible", src: "/audio/Josue.mp3" },
  { id: 7,  title: "Judges",                artist: "Holy Bible", src: "/audio/Judges.mp3" },
  { id: 8,  title: "Ruth",                  artist: "Holy Bible", src: "/audio/Ruth.mp3" },
  { id: 9,  title: "I Kings",               artist: "Holy Bible", src: "/audio/I-Kings.mp3" },
  { id: 10, title: "II Kings",              artist: "Holy Bible", src: "/audio/II-Kings.mp3" },
  { id: 11, title: "III Kings",             artist: "Holy Bible", src: "/audio/III-Kings.mp3" },
  { id: 12, title: "IV Kings",              artist: "Holy Bible", src: "/audio/IV-Kings.mp3" },
  { id: 13, title: "I Paralipomenon",       artist: "Holy Bible", src: "/audio/I-Paralipomenon.mp3" },
  { id: 14, title: "II Paralipomenon",      artist: "Holy Bible", src: "/audio/II-Paralipomenon.mp3" },
  { id: 15, title: "I Esdras",              artist: "Holy Bible", src: "/audio/I-Esdras.mp3" },
  { id: 16, title: "II Esdras",             artist: "Holy Bible", src: "/audio/II-Esdras.mp3" },
  { id: 17, title: "Tobias",                artist: "Holy Bible", src: "/audio/Tobias.mp3" },
  { id: 18, title: "Judith",                artist: "Holy Bible", src: "/audio/Judith.mp3" },
  { id: 19, title: "Esther",                artist: "Holy Bible", src: "/audio/Esther.mp3" },
  { id: 20, title: "Job",                   artist: "Holy Bible", src: "/audio/Job.mp3" },
  { id: 21, title: "Psalms",                artist: "Holy Bible", src: "/audio/Psalms.mp3" },
  { id: 22, title: "Proverbs",              artist: "Holy Bible", src: "/audio/Proverbs.mp3" },
  { id: 23, title: "Ecclesiastes",          artist: "Holy Bible", src: "/audio/Ecclesiastes.mp3" },
  { id: 24, title: "Canticle of Canticles", artist: "Holy Bible", src: "/audio/Canticle-of-Canticles.mp3" },
  { id: 25, title: "Wisdom",                artist: "Holy Bible", src: "/audio/Wisdom.mp3" },
  { id: 26, title: "Ecclesiasticus",        artist: "Holy Bible", src: "/audio/Ecclesiasticus.mp3" },
  { id: 27, title: "Isaias",                artist: "Holy Bible", src: "/audio/Isaias.mp3" },
  { id: 28, title: "Jeremias",              artist: "Holy Bible", src: "/audio/Jeremias.mp3" },
  { id: 29, title: "Lamentations",          artist: "Holy Bible", src: "/audio/Lamentations.mp3" },
  { id: 30, title: "Baruch",                artist: "Holy Bible", src: "/audio/Baruch.mp3" },
  { id: 31, title: "Ezekiel",               artist: "Holy Bible", src: "/audio/Ezekiel.mp3" },
  { id: 32, title: "Daniel",                artist: "Holy Bible", src: "/audio/Daniel.mp3" },
  { id: 33, title: "Osee",                  artist: "Holy Bible", src: "/audio/Osee.mp3" },
  { id: 34, title: "Joel",                  artist: "Holy Bible", src: "/audio/Joel.mp3" },
  { id: 35, title: "Amos",                  artist: "Holy Bible", src: "/audio/Amos.mp3" },
  { id: 36, title: "Abdias",                artist: "Holy Bible", src: "/audio/Abdias.mp3" },
  { id: 37, title: "Jonas",                 artist: "Holy Bible", src: "/audio/Jonas.mp3" },
  { id: 38, title: "Micheas",               artist: "Holy Bible", src: "/audio/Micheas.mp3" },
  { id: 39, title: "Nahum",                 artist: "Holy Bible", src: "/audio/Nahum.mp3" },
  { id: 40, title: "Habacuc",               artist: "Holy Bible", src: "/audio/Habacuc.mp3" },
  { id: 41, title: "Sophonias",             artist: "Holy Bible", src: "/audio/Sophonias.mp3" },
  { id: 42, title: "Aggeus",                artist: "Holy Bible", src: "/audio/Aggeus.mp3" },
  { id: 43, title: "Zacharias",             artist: "Holy Bible", src: "/audio/Zacharias.mp3" },
  { id: 44, title: "Malachias",             artist: "Holy Bible", src: "/audio/Malachias.mp3" },
  { id: 45, title: "I Machabees",           artist: "Holy Bible", src: "/audio/I-Machabees.mp3" },
  { id: 46, title: "II Machabees",          artist: "Holy Bible", src: "/audio/II-Machabees.mp3" },
  { id: 47, title: "Matthew",               artist: "Holy Bible", src: "/audio/Matthew.mp3" },
  { id: 48, title: "Mark",                  artist: "Holy Bible", src: "/audio/Mark.mp3" },
  { id: 49, title: "Luke",                  artist: "Holy Bible", src: "/audio/Luke.mp3" },
  { id: 50, title: "John",                  artist: "Holy Bible", src: "/audio/John.mp3" },
  { id: 51, title: "Acts",                  artist: "Holy Bible", src: "/audio/Acts.mp3" },
  { id: 52, title: "Romans",                artist: "Holy Bible", src: "/audio/Romans.mp3" },
  { id: 53, title: "I Corinthians",         artist: "Holy Bible", src: "/audio/I-Corinthians.mp3" },
  { id: 54, title: "II Corinthians",        artist: "Holy Bible", src: "/audio/II-Corinthians.mp3" },
  { id: 55, title: "Galatians",             artist: "Holy Bible", src: "/audio/Galatians.mp3" },
  { id: 56, title: "Ephesians",             artist: "Holy Bible", src: "/audio/Ephesians.mp3" },
  { id: 57, title: "Philippians",           artist: "Holy Bible", src: "/audio/Philippians.mp3" },
  { id: 58, title: "Colossians",            artist: "Holy Bible", src: "/audio/Colossians.mp3" },
  { id: 59, title: "I Thessalonians",       artist: "Holy Bible", src: "/audio/I-Thessalonians.mp3" },
  { id: 60, title: "II Thessalonians",      artist: "Holy Bible", src: "/audio/II-Thessalonians.mp3" },
  { id: 61, title: "I Timothy",             artist: "Holy Bible", src: "/audio/I-Timothy.mp3" },
  { id: 62, title: "II Timothy",            artist: "Holy Bible", src: "/audio/II-Timothy.mp3" },
  { id: 63, title: "Titus",                 artist: "Holy Bible", src: "/audio/Titus.mp3" },
  { id: 64, title: "Philemon",              artist: "Holy Bible", src: "/audio/Philemon.mp3" },
  { id: 65, title: "Hebrews",               artist: "Holy Bible", src: "/audio/Hebrews.mp3" },
  { id: 66, title: "James",                 artist: "Holy Bible", src: "/audio/James.mp3" },
  { id: 67, title: "I Peter",               artist: "Holy Bible", src: "/audio/I-Peter.mp3" },
  { id: 68, title: "II Peter",              artist: "Holy Bible", src: "/audio/II-Peter.mp3" },
  { id: 69, title: "I John",                artist: "Holy Bible", src: "/audio/I-John.mp3" },
  { id: 70, title: "II John",               artist: "Holy Bible", src: "/audio/II-John.mp3" },
  { id: 71, title: "III John",              artist: "Holy Bible", src: "/audio/III-John.mp3" },
  { id: 72, title: "Jude",                  artist: "Holy Bible", src: "/audio/Jude.mp3" },
  { id: 73, title: "Apocalypse",            artist: "Holy Bible", src: "/audio/Apocalypse.mp3" },
];

// ─── AUDIO PAGE ───────────────────────────────────────────────────────────────
function AudioPage({ currentTrack, setCurrentTrack, isPlaying, setIsPlaying }) {
  const tracks = PERMANENT_TRACKS;

  const play = (track) => {
    if (currentTrack?.id === track.id) setIsPlaying(!isPlaying);
    else { setCurrentTrack(track); setIsPlaying(true); }
  };

  return (
    <div className="page" style={{position:"relative"}}>
      <div className="page-title">AUDIO <span className="accentText">LIBRARY</span></div>
      <div className="page-sub">&ldquo;Ignorance of Scripture is ignorance of Christ.&rdquo; &mdash; St. Jerome</div>

      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:20}}>

        <div className="card" style={{background:"linear-gradient(160deg,rgba(0,22,13,0.55) 0%,rgba(0,7,4,0.35) 50%,rgba(0,3,2,0.42) 100%)"}}>
          <div style={{marginBottom:12}}>
            <div className="card-title" style={{marginBottom:0}}>Old Testament</div>
          </div>
          {tracks.filter(t => t.id <= 46).map((t, i) => {
            const active = currentTrack?.id === t.id;
            return (
              <div key={t.id} className={`track-row ${active ? "playing" : ""}`}
                style={{display:"flex", alignItems:"center", cursor:"pointer"}}
                onClick={() => play(t)}>
                <div className="track-num" style={{color: active && isPlaying ? "var(--accent)" : "var(--muted)"}}>
                  {active && isPlaying ? "▶" : i + 1}
                </div>
                <div style={{flex:1}}>
                  <div className="track-title" style={{fontSize:14, fontWeight:600}}>{t.title}</div>
                </div>
                {active && (
                  <div style={{fontSize:11, color:"var(--accent)", fontWeight:600, marginRight:8}}>
                    {isPlaying ? "NOW PLAYING" : "PAUSED"}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="card" style={{background:"linear-gradient(160deg,rgba(0,22,13,0.55) 0%,rgba(0,7,4,0.35) 50%,rgba(0,3,2,0.42) 100%)"}}>
          <div style={{marginBottom:12}}>
            <div className="card-title" style={{marginBottom:0}}>New Testament</div>
          </div>
          {tracks.filter(t => t.id >= 47).map((t, i) => {
            const active = currentTrack?.id === t.id;
            return (
              <div key={t.id} className={`track-row ${active ? "playing" : ""}`}
                style={{display:"flex", alignItems:"center", cursor:"pointer"}}
                onClick={() => play(t)}>
                <div className="track-num" style={{color: active && isPlaying ? "var(--accent)" : "var(--muted)"}}>
                  {active && isPlaying ? "▶" : i + 47}
                </div>
                <div style={{flex:1}}>
                  <div className="track-title" style={{fontSize:14, fontWeight:600}}>{t.title}</div>
                </div>
                {active && (
                  <div style={{fontSize:11, color:"var(--accent)", fontWeight:600, marginRight:8}}>
                    {isPlaying ? "NOW PLAYING" : "PAUSED"}
                  </div>
                )}
              </div>
            );
          })}
        </div>

      </div>

      {/* Attribution footnote */}
      <div style={{
        marginTop:32, paddingTop:16, borderTop:"1px solid rgba(136,255,0,0.07)",
        color:"var(--muted)", fontSize:10, lineHeight:1.7, letterSpacing:0.3,
      }}>
        <div style={{marginBottom:6, fontFamily:"'Orbitron',sans-serif", fontSize:9, letterSpacing:2, textTransform:"uppercase"}}>
          Attributions
        </div>
        <div><span style={{color:"var(--text)"}}>Audio recordings:</span>{" "}
          <a href="https://www.youtube.com/@TraditionalCatholicAudiobooks" target="_blank" rel="noreferrer"
            style={{color:"var(--muted)",textDecoration:"underline"}}>Traditional Catholic Audiobooks</a>
          {" · "}
          <a href="https://www.youtube.com/@MultiBurtons" target="_blank" rel="noreferrer"
            style={{color:"var(--muted)",textDecoration:"underline"}}>MultiBurtons</a>
          {" · "}
          <a href="https://www.youtube.com/@alfredus_magnus" target="_blank" rel="noreferrer"
            style={{color:"var(--muted)",textDecoration:"underline"}}>alfredus magnus</a>
        </div>
        <div><span style={{color:"var(--text)"}}>3D models:</span>{" "}
          <a href="https://free3d.com/3d-model/male-base-mesh-arshlevon-sizes-22492.html" target="_blank" rel="noreferrer"
            style={{color:"var(--muted)",textDecoration:"underline"}}>Male Base Mesh by arshlevon — free3d.com</a>
        </div>
      </div>

    </div>
  );
}
function PlayerBar({ track, isPlaying, setIsPlaying, tracks, setTrack }) {
  const audioRef     = useRef(null);
  const scrubbing    = useRef(false);
  const [elapsed, setElapsed]   = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume]     = useState(1);
  const [speed, setSpeed]       = useState(1);
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  // Load track + wire events
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setElapsed(0);
    setDuration(0);
    if (!track?.src) { audio.src = ""; return; }

    // Restore saved position after metadata loads
    const onMeta = async () => {
      setDuration(isFinite(audio.duration) ? audio.duration : 0);
      try {
        const saved = await store.get(`progress:${track.id}`);
        if (saved && parseFloat(saved) > 0 && parseFloat(saved) < audio.duration - 5) {
          audio.currentTime = parseFloat(saved);
        }
      } catch {}
    };

    const onCanPlay = () => { if (isPlayingRef.current) audio.play().catch(() => setIsPlaying(false)); };

    // Save position every 5 seconds while playing
    const onTime = () => {
      if (!scrubbing.current) {
        setElapsed(audio.currentTime);
        if (Math.round(audio.currentTime) % 5 === 0 && audio.currentTime > 0) {
          store.set(`progress:${track.id}`, String(audio.currentTime));
        }
      }
    };

    const onEnded = () => {
      // Clear saved position when track finishes
      store.set(`progress:${track.id}`, "0");
      if (!tracks.length) return;
      const idx  = tracks.findIndex(t => t.id === track.id);
      const next = tracks[(idx + 1) % tracks.length];
      setTrack(next); setIsPlaying(true);
    };

    audio.src = track.src;
    audio.load();
    audio.addEventListener("canplay",        onCanPlay);
    audio.addEventListener("timeupdate",     onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("ended",          onEnded);
    return () => {
      // Save position when unmounting / switching tracks
      if (audio.currentTime > 0) {
        store.set(`progress:${track.id}`, String(audio.currentTime));
      }
      audio.removeEventListener("canplay",        onCanPlay);
      audio.removeEventListener("timeupdate",     onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("ended",          onEnded);
    };
  }, [track]);

  // Play/pause
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track?.src) return;
    if (isPlaying) audio.play().catch(() => setIsPlaying(false));
    else           audio.pause();
  }, [isPlaying]); // eslint-disable-line react-hooks/exhaustive-deps

  // Volume
  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);

  // Playback speed
  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = speed; }, [speed]);

  // Skip to track prev/next
  const skipTrack = (dir) => {
    if (!tracks.length) return;
    const idx = tracks.findIndex(t => t.id === track?.id);
    setTrack(tracks[(idx + dir + tracks.length) % tracks.length]);
    setIsPlaying(true);
  };

  // Skip ±15 seconds within current track
  const nudge = (secs) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + secs));
    setElapsed(audio.currentTime);
  };

  // Progress bar: click to seek + drag to scrub
  const barRef = useRef(null);
  const seekTo = (clientX) => {
    const audio = audioRef.current;
    if (!audio || !duration || !barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const t    = pct * duration;
    audio.currentTime = t;
    setElapsed(t);
  };
  const onBarMouseDown = (e) => {
    scrubbing.current = true;
    seekTo(e.clientX);
    const onMove = (ev) => seekTo(ev.clientX);
    const onUp   = ()   => { scrubbing.current = false; window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  };

  const progress = duration > 0 ? (elapsed / duration) * 100 : 0;
  const noSrc    = !track?.src;
  const SPEEDS   = [1, 1.25, 1.5, 1.75, 2];

  return (
    <div className="player-bar">
      <audio ref={audioRef} preload="auto" />

      {/* Track info */}
      <div className="track-info">
        <div className="track-title">{track?.title ?? "—"}</div>
        <div className="track-artist" style={{color: noSrc ? "var(--danger)" : "var(--muted)"}}>
          {noSrc ? "No audio file linked" : track?.artist}
        </div>
      </div>

      {/* Controls */}
      <div className="player-controls">
        <button className="ctrl-btn" onClick={() => skipTrack(-1)} disabled={noSrc} title="Previous track">⏮</button>
        <button className="ctrl-btn" onClick={() => nudge(-15)}    disabled={noSrc} title="Back 15s"
          style={{fontSize:11, fontFamily:"'Orbitron',sans-serif", letterSpacing:0, padding:"0 7px"}}>−15</button>
        <button className="play-btn" onClick={() => setIsPlaying(!isPlaying)} disabled={noSrc}
          style={{opacity: noSrc ? 0.4 : 1}}>
          {isPlaying ? "⏸" : "▶"}
        </button>
        <button className="ctrl-btn" onClick={() => nudge(15)}     disabled={noSrc} title="Forward 15s"
          style={{fontSize:11, fontFamily:"'Orbitron',sans-serif", letterSpacing:0, padding:"0 7px"}}>+15</button>
        <button className="ctrl-btn" onClick={() => skipTrack(1)}  disabled={noSrc} title="Next track">⏭</button>
      </div>

      {/* Scrubable progress bar */}
      <div className="progress-wrap">
        <span>{fmtTime(elapsed)}</span>
        <div ref={barRef} className="progress-bar"
          onMouseDown={onBarMouseDown}
          style={{cursor: noSrc ? "default" : "pointer", userSelect:"none"}}>
          <div className="progress-fill" style={{width:`${progress}%`, transition: scrubbing.current ? "none" : "width 0.25s linear"}} />
          {!noSrc && (
            <div style={{
              position:"absolute", top:"50%", left:`${progress}%`,
              transform:"translate(-50%,-50%)",
              width:12, height:12, borderRadius:"50%",
              background:"var(--accent)", boxShadow:"0 0 6px var(--accent)",
              pointerEvents:"none",
            }} />
          )}
        </div>
        <span>{fmtTime(duration)}</span>
      </div>

      {/* Speed + Volume */}
      <div style={{display:"flex", alignItems:"center", gap:10, flexShrink:0}}>
        {/* Speed selector */}
        <div style={{display:"flex", gap:3, alignItems:"center"}}>
          {SPEEDS.map(s => (
            <button key={s} onClick={() => setSpeed(s)} disabled={noSrc}
              style={{
                background: speed === s ? "var(--accent)" : "var(--surface2)",
                color:       speed === s ? "#000"         : "var(--muted)",
                border:      speed === s ? "none"         : "1px solid var(--border)",
                borderRadius:2, padding:"3px 6px",
                fontSize:10, fontFamily:"'Orbitron',sans-serif", fontWeight:700,
                cursor: noSrc ? "default" : "pointer", letterSpacing:0,
                transition:"all 0.12s",
              }}>
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── TOP CHARTS PAGE ──────────────────────────────────────────────────────────
function TopChartsPage({ username }) {
  const [userLogs, setUserLogs] = useState([]);
  const [chartEx, setChartEx] = useState("Bench Press");
  const [chartRep, setChartRep] = useState(1);
  const { communityUsers } = useCommunityUsers(username);
  const isPullup = chartEx === "Pull-up";
  const isPushup = chartEx === "Push-up";
  const isBodyweightChart = isPullup || isPushup;

  useEffect(() => {
    api.getLogs()
      .then(data => setUserLogs(data))
      .catch(err => console.warn("TopCharts getLogs:", err));
  }, [username]);

  // Build leaderboard for selected exercise + rep category
  const buildLeaderboard = (exercise, repCat) => {
    const entries = [];
    const myBest = Math.max(0, ...userLogs.filter(l => l.exercise === exercise && l.repCat === repCat).map(l => l.weight));
    if (myBest > 0) entries.push({ name: username, weight: myBest, isMe: true });
    communityUsers.forEach(u => {
      const series = u.logs[exercise]?.[repCat];
      if (series && series.length) {
        const best = Math.max(...series.map(e => e.weight));
        entries.push({ name: u.name, weight: best, isMe: false });
      }
    });
    return entries.sort((a, b) => b.weight - a.weight);
  };

  // Bodyweight leaderboard (pull-up or push-up)
  const buildBodyweightLeaderboard = (exercise) => {
    const entries = [];
    const myBest = Math.max(0, ...userLogs.filter(l => l.exercise === exercise).map(l => l.weight));
    if (myBest > 0) entries.push({ name: username, weight: myBest, isMe: true });
    communityUsers.forEach(u => {
      const series = u.logs[exercise]?.[0];
      if (series && series.length) {
        const best = Math.max(...series.map(e => e.weight));
        entries.push({ name: u.name, weight: best, isMe: false });
      }
    });
    return entries.sort((a, b) => b.weight - a.weight);
  };

  const leaders = isBodyweightChart ? buildBodyweightLeaderboard(chartEx) : buildLeaderboard(chartEx, chartRep);
  const topWeight = leaders[0]?.weight || 0;

  const medalColors = ["#ffdd00", "#c0c8d4", "#ff9944"];
  const medalLabels = ["#1", "#2", "#3"];

  return (
    <div className="page" style={{position:"relative"}}>
      <div className="page-title">TOP <span className="accentText">CHARTS</span></div>
      <div className="page-sub">&ldquo;Non nobis, Domine, non nobis, sed nomini Tuo da gloriam.&rdquo;</div>

      <div style={{display:"flex",gap:20,marginBottom:24,flexWrap:"wrap"}}>
        <div style={{flex:1,minWidth:220}}>
          <div className="form-label" style={{marginBottom:8}}>Exercise</div>
          <div className="tab-row" style={{flexWrap:"wrap"}}>
            {EXERCISE_LIST.map(ex => (
              <div key={ex} className={`tab ${chartEx===ex?"active":""}`} onClick={()=>setChartEx(ex)}>{ex}</div>
            ))}
          </div>
        </div>
        {!isBodyweightChart && (
        <div>
          <div className="form-label" style={{marginBottom:8}}>Rep Category</div>
          <div style={{display:"flex",gap:8}}>
            {REP_CATS.map(r => (
              <div key={r}
                onClick={() => setChartRep(r)}
                style={{
                  padding:"8px 16px", borderRadius:8, cursor:"pointer", fontWeight:700, fontSize:13,
                  border:`2px solid ${chartRep===r ? REP_COLORS[r] : "var(--border)"}`,
                  background: chartRep===r ? `${REP_COLORS[r]}18` : "var(--surface2)",
                  color: chartRep===r ? REP_COLORS[r] : "var(--muted)",
                  transition:"all 0.15s"
                }}>
                {r} Rep{r>1?"s":""}
              </div>
            ))}
          </div>
        </div>
        )}
      </div>

      {/* ── YOUR RANK CARD ── */}
      {isBodyweightChart ? <BodyweightRankCard username={username} exercise={chartEx} userLogs={userLogs} communityUsers={communityUsers} /> : <MyRankCard username={username} exercise={chartEx} repCat={chartRep} userLogs={userLogs} communityUsers={communityUsers} />}

      <div className="card">
        <div className="card-title">
          <span style={{fontFamily:"'Orbitron',sans-serif",fontSize:11,color:"var(--accent)",letterSpacing:2,marginRight:8}}>▲▲▲</span>
          {isBodyweightChart ? `${chartEx} Count Leaderboard` : `${chartEx} — ${chartRep} Rep${chartRep>1?"s":""} Leaderboard`}
        </div>
        {leaders.length === 0 ? (
          <div style={{textAlign:"center",padding:"32px 0",color:"var(--muted)"}}>No data yet for this exercise.</div>
        ) : (
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {leaders.map((entry, i) => {
              const barPct = topWeight > 0 ? (entry.weight / topWeight) * 100 : 0;
              const isTop = i === 0;
              return (
                <div key={entry.name} style={{
                  background: entry.isMe ? "rgba(181,240,60,0.06)" : "var(--surface2)",
                  border: `1px solid ${entry.isMe ? "var(--accent)" : "var(--border)"}`,
                  borderRadius:10, padding:"14px 18px",
                  position:"relative", overflow:"hidden"
                }}>
                  {/* background bar */}
                  <div style={{
                    position:"absolute", left:0, top:0, bottom:0,
                    width:`${barPct}%`,
                    background: isTop ? "rgba(181,240,60,0.08)" : "rgba(255,255,255,0.02)",
                    borderRadius:10, transition:"width 0.6s ease", pointerEvents:"none"
                  }} />
                  <div style={{position:"relative",display:"flex",alignItems:"center",gap:14}}>
                    <div style={{fontSize:22,width:30,textAlign:"center"}}>
                      {i < 3 ? <span style={{fontFamily:"'Orbitron',sans-serif",fontWeight:900,fontSize:13,color:medalColors[i],textShadow:`0 0 8px ${medalColors[i]}99`,letterSpacing:1}}>{medalLabels[i]}</span> : <span style={{color:"var(--muted)",fontWeight:700,fontSize:13,fontFamily:"'Orbitron',sans-serif"}}>#{i+1}</span>}
                    </div>
                    <div className="avatar sm" style={{background: entry.isMe ? "var(--accent)" : "var(--surface)"}}>
                      {entry.name.slice(0,2).toUpperCase()}
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:14,color: entry.isMe ? "var(--accent)" : "var(--text)"}}>
                        {entry.name}{entry.isMe ? " (You)" : ""}
                      </div>
                      <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>
                        {barPct < 100 ? `${Math.round(barPct)}% of top ${isBodyweightChart ? "count" : "lift"}` : "◈ CURRENT LEADER"}
                      </div>
                    </div>
                    <div style={{fontFamily:"'Orbitron',sans-serif",fontSize:22,fontWeight:900,color: isTop ? "var(--accent)" : "var(--chrome)",letterSpacing:2,textShadow: isTop ? "var(--glow-sm)" : "none"}}>
                      {entry.weight} <span style={{fontSize:11,color:"var(--muted)",fontFamily:"'Rajdhani',sans-serif",fontWeight:400}}>{isBodyweightChart ? "reps" : "lbs"}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title"><span style={{fontFamily:"'Orbitron',sans-serif",fontSize:10,color:"var(--accent)",letterSpacing:2,marginRight:8}}>▐▌</span>All Exercises Snapshot — {chartRep} Rep{chartRep>1?"s":""}</div>
        <div style={{fontSize:12,color:"var(--muted)",marginBottom:16}}>Top lift across the community for each exercise.</div>
        <table className="log-table">
          <thead><tr><th>Exercise</th><th>Leader</th><th>Top</th></tr></thead>
          <tbody>
            {EXERCISE_LIST.map(ex => {
              const board = (ex === "Pull-up" || ex === "Push-up") ? buildBodyweightLeaderboard(ex) : buildLeaderboard(ex, chartRep);
              const top = board[0];
              return (
                <tr key={ex}>
                  <td><span className="badge">{ex}</span></td>
                  <td>
                    {top ? (
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <div className="avatar sm" style={{background: top.isMe ? "var(--accent)" : "var(--surface2)"}}>
                          {top.name.slice(0,2).toUpperCase()}
                        </div>
                        <span style={{fontWeight:600,color: top.isMe ? "var(--accent)" : "var(--text)"}}>{top.name}{top.isMe?" (You)":""}</span>
                      </div>
                    ) : <span style={{color:"var(--muted)"}}>—</span>}
                  </td>
                  <td style={{fontWeight:700,color:"var(--accent)"}}>{top ? `${top.weight} ${ex === "Pull-up" ? "reps" : "lbs"}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── ONBOARDING ───────────────────────────────────────────────────────────────
// ─── AUTH SCREEN ──────────────────────────────────────────────────────────────
// Defined outside AuthScreen so React doesn't recreate these as new component
// types on every render (which would unmount/remount inputs and lose focus).
const AuthCard = ({ children }) => (
  <div style={{
    width: 420, position:"relative", zIndex:1,
    background:"linear-gradient(155deg,rgba(0,14,8,0.98),rgba(0,5,3,1))",
    border:"1px solid rgba(6,51,34,0.9)", borderRadius:2, padding:34, overflow:"hidden",
  }}>
    <div style={{position:"absolute",top:0,left:0,right:0,height:1,
      background:"linear-gradient(90deg,#88ff00,#aaff44,#88ff00,#88ff00)",
      backgroundSize:"300% 100%",opacity:0.8,animation:"sheen 2.5s ease-in-out infinite"}} />
    <div style={{position:"absolute",top:0,left:0,width:16,height:16,borderTop:"1px solid rgba(136,255,0,0.6)",borderLeft:"1px solid rgba(136,255,0,0.6)"}} />
    <div style={{position:"absolute",bottom:0,right:0,width:16,height:16,borderBottom:"1px solid rgba(170,255,30,0.5)",borderRight:"1px solid rgba(170,255,30,0.5)"}} />
    {children}
  </div>
);

const AuthTitle = ({ text }) => (
  <div style={{
    fontFamily:"'Orbitron',sans-serif", fontSize:15, fontWeight:900,
    letterSpacing:5, marginBottom:6, textTransform:"uppercase",
    background:"linear-gradient(155deg,#ffffff,#aaffee,#88ff00)",
    WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent",
    filter:"drop-shadow(0 0 10px rgba(136,255,0,0.6))"
  }}>{text}</div>
);

const AuthField = ({ label, type, value, onChange, onEnter }) => (
  <div style={{marginBottom:12}}>
    <div className="form-label" style={{marginBottom:5}}>{label}</div>
    <input
      type={type || "text"} value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => e.key === "Enter" && onEnter && onEnter()}
      style={{width:"100%", boxSizing:"border-box"}}
    />
  </div>
);

// ─── ADMIN PANEL ─────────────────────────────────────────────────────────────
function AdminPanel({ currentUser, onClose }) {
  const [users, setUsers]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");
  const [confirm, setConfirm] = useState(null);

  const isArchAdmin = currentUser.role === "arch_admin";

  const load = () => {
    setLoading(true);
    api.getAdminUsers()
      .then(data => setUsers(data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (userId) => {
    try {
      await api.adminDeleteUser(userId);
      setUsers(prev => prev.filter(u => u.id !== userId));
      setConfirm(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSetRole = async (userId, role) => {
    try {
      const { user: updated } = await api.adminSetRole(userId, role);
      setUsers(prev => prev.map(u => u.id === updated.id ? updated : u));
    } catch (err) {
      setError(err.message);
    }
  };

  const roleBadge = (role) => {
    if (role === "arch_admin") return { label: "ARCH-ADMIN", color: "#ffcc00" };
    if (role === "admin")      return { label: "ADMIN",      color: "#88ff00" };
    return                            { label: "MEMBER",     color: "#556655" };
  };

  const canDelete = (u) => {
    if (u.id === currentUser.id) return false;
    if (u.role === "arch_admin") return false;
    if (currentUser.role === "admin" && u.role === "admin") return false;
    return true;
  };

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:1001,
      background:"rgba(0,0,0,0.8)", backdropFilter:"blur(4px)",
      display:"flex", alignItems:"center", justifyContent:"center",
    }} onClick={onClose}>
      <div style={{
        width:520, maxHeight:"80vh", display:"flex", flexDirection:"column",
        background:"linear-gradient(155deg,rgba(0,14,8,0.99),rgba(0,5,3,1))",
        border:"1px solid rgba(255,204,0,0.25)", borderRadius:4,
        position:"relative", overflow:"hidden",
      }} onClick={e => e.stopPropagation()}>
        <div style={{position:"absolute",top:0,left:0,right:0,height:1,
          background:"linear-gradient(90deg,#ffcc00,#88ff00,#ffcc00)",
          backgroundSize:"300% 100%", opacity:0.8, animation:"sheen 2.5s ease-in-out infinite"}} />

        {/* Header */}
        <div style={{padding:"24px 28px 16px", borderBottom:"1px solid rgba(136,255,0,0.08)", flexShrink:0}}>
          <div style={{display:"flex", justifyContent:"space-between", alignItems:"center"}}>
            <div>
              <div style={{
                fontFamily:"'Orbitron',sans-serif", fontSize:13, fontWeight:900, letterSpacing:4,
                background:"linear-gradient(155deg,#ffcc00,#ffe066,#ffcc00)",
                WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent",
              }}>
                {isArchAdmin ? "ARCH-ADMIN PANEL" : "ADMIN PANEL"}
              </div>
              <div style={{color:"var(--muted)",fontSize:11,marginTop:3,fontFamily:"'Orbitron',sans-serif",letterSpacing:1}}>
                {users.length} {users.length === 1 ? "MEMBER" : "MEMBERS"}
              </div>
            </div>
            <button onClick={onClose} style={{background:"none",border:"none",color:"var(--muted)",
              fontSize:18,cursor:"pointer",lineHeight:1,padding:0}}>✕</button>
          </div>
          {error && <div style={{color:"#ff4455",fontSize:12,marginTop:10,fontWeight:600}}>{error}</div>}
        </div>

        {/* User list */}
        <div style={{overflowY:"auto", flex:1, padding:"8px 0"}}>
          {loading ? (
            <div style={{color:"var(--muted)",fontSize:12,padding:28,textAlign:"center",
              fontFamily:"'Orbitron',sans-serif",letterSpacing:2}}>LOADING…</div>
          ) : users.map(u => {
            const badge = roleBadge(u.role);
            const isMe = u.id === currentUser.id;
            return (
              <div key={u.id} style={{
                display:"flex", alignItems:"center", gap:12, padding:"12px 28px",
                borderBottom:"1px solid rgba(136,255,0,0.05)",
                background: isMe ? "rgba(136,255,0,0.03)" : "transparent",
              }}>
                <div className="avatar sm" style={{
                  flexShrink:0,
                  background: u.role === "arch_admin" ? "linear-gradient(135deg,#332200,#664400)"
                            : u.role === "admin"      ? "linear-gradient(135deg,#003322,#006644)"
                            : "linear-gradient(135deg,#001a10,#002e1a)",
                  color: badge.color,
                }}>
                  {u.displayName.slice(0,2).toUpperCase()}
                </div>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{display:"flex", alignItems:"center", gap:8}}>
                    <span style={{fontWeight:700, fontSize:13, color:"var(--text)"}}>{u.displayName}</span>
                    {isMe && <span style={{fontSize:9,color:"var(--muted)",fontFamily:"'Orbitron',sans-serif",letterSpacing:1}}>YOU</span>}
                  </div>
                  <div style={{color:"var(--muted)",fontSize:11,marginTop:1}}>{u.email}</div>
                </div>
                <div style={{display:"flex", alignItems:"center", gap:8, flexShrink:0}}>
                  <div style={{
                    fontSize:9, fontWeight:700, letterSpacing:1.5, padding:"3px 8px",
                    border:`1px solid ${badge.color}44`, borderRadius:2,
                    color:badge.color, fontFamily:"'Orbitron',sans-serif",
                  }}>{badge.label}</div>
                  {isArchAdmin && u.role !== "arch_admin" && !isMe && (
                    <button onClick={() => handleSetRole(u.id, u.role === "admin" ? "user" : "admin")}
                      style={{
                        fontSize:9, padding:"3px 8px", cursor:"pointer", borderRadius:2,
                        background:"rgba(136,255,0,0.06)", border:"1px solid rgba(136,255,0,0.2)",
                        color:"var(--accent)", fontFamily:"'Orbitron',sans-serif", letterSpacing:1,
                      }}>
                      {u.role === "admin" ? "DEMOTE" : "MAKE ADMIN"}
                    </button>
                  )}
                  {canDelete(u) && (
                    <button onClick={() => setConfirm({ userId: u.id, name: u.displayName })}
                      style={{
                        fontSize:9, padding:"3px 8px", cursor:"pointer", borderRadius:2,
                        background:"rgba(255,68,85,0.06)", border:"1px solid rgba(255,68,85,0.25)",
                        color:"#ff4455", fontFamily:"'Orbitron',sans-serif", letterSpacing:1,
                      }}>
                      DELETE
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Delete confirmation */}
      {confirm && (
        <div style={{
          position:"fixed", inset:0, zIndex:1002,
          background:"rgba(0,0,0,0.6)", backdropFilter:"blur(2px)",
          display:"flex", alignItems:"center", justifyContent:"center",
        }} onClick={() => setConfirm(null)}>
          <div style={{
            width:340, background:"linear-gradient(155deg,rgba(0,14,8,0.99),rgba(0,5,3,1))",
            border:"1px solid rgba(255,68,85,0.3)", borderRadius:4, padding:28,
          }} onClick={e => e.stopPropagation()}>
            <div style={{color:"#ff4455",fontSize:12,fontWeight:700,marginBottom:10,
              fontFamily:"'Orbitron',sans-serif",letterSpacing:1,textTransform:"uppercase"}}>
              ⚠ Confirm Deletion
            </div>
            <div style={{color:"var(--text)",fontSize:13,marginBottom:20}}>
              Delete <strong>{confirm.name}</strong>? This will permanently remove their account, all lift logs, and all chat messages.
            </div>
            <div style={{display:"flex",gap:8}}>
              <button className="btn btn-ghost" style={{flex:1,justifyContent:"center",fontSize:10}}
                onClick={() => setConfirm(null)}>CANCEL</button>
              <button className="btn" style={{flex:1,justifyContent:"center",fontSize:10,
                color:"#ff4455",borderColor:"rgba(255,68,85,0.4)"}}
                onClick={() => handleDelete(confirm.userId)}>CONFIRM DELETE</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AuthScreen({ onAuth }) {
  const [mode, setMode]           = useState("welcome"); // welcome | login | register
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName]   = useState("");
  const [email, setEmail]         = useState("");
  const [password, setPassword]   = useState("");
  const [confirm, setConfirm]     = useState("");
  const [robotCheck, setRobotCheck] = useState(false);
  const [error, setError]         = useState("");
  const [loading, setLoading]     = useState(false);

  const reset = () => {
    setFirstName(""); setLastName(""); setEmail("");
    setPassword(""); setConfirm(""); setRobotCheck(false); setError("");
  };

  const switchMode = (m) => { reset(); setMode(m); };

  const handleLogin = async () => {
    setError("");
    if (!email.trim() || !password) { setError("Please enter your email and password."); return; }
    setLoading(true);
    try {
      const { token, user } = await api.login({ email, password });
      api.setToken(token);
      onAuth(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    setError("");
    if (!firstName.trim() || !lastName.trim()) { setError("Please enter your first and last name."); return; }
    if (!email.trim()) { setError("Please enter your email address."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("Passwords do not match."); return; }
    if (!robotCheck) { setError("Please confirm you are not a robot."); return; }
    setLoading(true);
    try {
      const { token, user } = await api.register({ firstName, lastName, email, password });
      api.setToken(token);
      onAuth(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="onboard-wrap">
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:24}}>
        {/* Logo */}
        <div style={{textAlign:"center"}}>
          <div style={{
            fontFamily:"'Orbitron',sans-serif", fontSize:26, fontWeight:900, letterSpacing:4,
            background:"linear-gradient(155deg,#ffffff 0%,#ccfff0 20%,#55ffcc 50%,#00bb99 75%,#005544 100%)",
            WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent",
            filter:"drop-shadow(0 0 24px rgba(136,255,0,0.9)) drop-shadow(0 0 60px rgba(136,255,0,0.3))",
            marginBottom:4, animation:"chromaShift 5s ease-in-out infinite"
          }}>Brothers of Saint Hyacinth</div>
          <div style={{color:"var(--muted)",fontSize:11,letterSpacing:3,textTransform:"uppercase",fontFamily:"'Orbitron',sans-serif"}}>
            Your Fitness Community
          </div>
        </div>

        {/* WELCOME */}
        {mode === "welcome" && (
          <AuthCard>
            <AuthTitle text="Welcome" />
            <div style={{color:"var(--muted)",fontSize:12,marginBottom:28,letterSpacing:1,fontFamily:"'Orbitron',sans-serif",textTransform:"uppercase"}}>
              Choose an option to continue
            </div>
            <button className="btn btn-primary" style={{width:"100%",justifyContent:"center",padding:"13px 20px",marginBottom:10}}
              onClick={() => switchMode("login")}>
              LOG IN ›
            </button>
            <button className="btn btn-ghost" style={{width:"100%",justifyContent:"center",padding:"13px 20px"}}
              onClick={() => switchMode("register")}>
              CREATE ACCOUNT ›
            </button>
          </AuthCard>
        )}

        {/* LOGIN */}
        {mode === "login" && (
          <AuthCard>
            <AuthTitle text="Log In" />
            <div style={{color:"var(--muted)",fontSize:11,marginBottom:22,letterSpacing:1,fontFamily:"'Orbitron',sans-serif",textTransform:"uppercase"}}>
              Enter your credentials
            </div>
            <AuthField label="Email" type="email" value={email} onChange={setEmail} />
            <AuthField label="Password" type="password" value={password} onChange={setPassword} onEnter={handleLogin} />
            {error && <div style={{color:"#ff4455",fontSize:12,marginBottom:12,fontWeight:600}}>{error}</div>}
            <button className="btn btn-primary" style={{width:"100%",justifyContent:"center",padding:"13px 20px",marginBottom:10}}
              disabled={loading} onClick={handleLogin}>
              {loading ? "LOGGING IN…" : "LOG IN ›"}
            </button>
            <button className="btn btn-ghost" style={{width:"100%",justifyContent:"center",padding:"10px 20px",fontSize:10}}
              onClick={() => switchMode("welcome")}>← BACK</button>
          </AuthCard>
        )}

        {/* REGISTER */}
        {mode === "register" && (
          <AuthCard>
            <AuthTitle text="Create Account" />
            <div style={{color:"var(--muted)",fontSize:11,marginBottom:22,letterSpacing:1,fontFamily:"'Orbitron',sans-serif",textTransform:"uppercase"}}>
              Join the brotherhood
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:0}}>
              <AuthField label="First Name" value={firstName} onChange={setFirstName} />
              <AuthField label="Last Name" value={lastName} onChange={setLastName} />
            </div>
            <AuthField label="Email" type="email" value={email} onChange={setEmail} />
            <AuthField label="Password (min. 8 characters)" type="password" value={password} onChange={setPassword} />
            <AuthField label="Confirm Password" type="password" value={confirm} onChange={setConfirm} />

            {/* I am not a robot */}
            <div style={{
              display:"flex", alignItems:"center", gap:12, marginBottom:18,
              background:"rgba(136,255,0,0.04)", border:"1px solid rgba(136,255,0,0.15)",
              borderRadius:4, padding:"12px 16px", cursor:"pointer",
            }} onClick={() => setRobotCheck(v => !v)}>
              <div style={{
                width:22, height:22, borderRadius:4, flexShrink:0,
                border:`2px solid ${robotCheck ? "var(--accent)" : "var(--border)"}`,
                background: robotCheck ? "rgba(136,255,0,0.15)" : "transparent",
                display:"flex", alignItems:"center", justifyContent:"center",
                transition:"all 0.15s",
              }}>
                {robotCheck && <span style={{color:"var(--accent)",fontSize:14,lineHeight:1}}>✓</span>}
              </div>
              <div style={{fontSize:13, color:"var(--text)"}}>I am not a robot</div>
            </div>

            {error && <div style={{color:"#ff4455",fontSize:12,marginBottom:12,fontWeight:600}}>{error}</div>}
            <button className="btn btn-primary" style={{width:"100%",justifyContent:"center",padding:"13px 20px",marginBottom:10}}
              disabled={loading} onClick={handleRegister}>
              {loading ? "CREATING ACCOUNT…" : "CREATE ACCOUNT ›"}
            </button>
            <button className="btn btn-ghost" style={{width:"100%",justifyContent:"center",padding:"10px 20px",fontSize:10}}
              onClick={() => switchMode("welcome")}>← BACK</button>
          </AuthCard>
        )}
      </div>
    </div>
  );
}

// ─── USER PROFILE MODAL ───────────────────────────────────────────────────────
function UserProfileModal({ user, onClose, onDeleted }) {
  const [deleteStep, setDeleteStep] = useState(false); // show confirm form
  const [pw1, setPw1]   = useState("");
  const [pw2, setPw2]   = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleDelete = async () => {
    setError("");
    if (!pw1 || !pw2) { setError("Please enter your password twice to confirm."); return; }
    if (pw1 !== pw2)  { setError("Passwords do not match."); return; }
    setLoading(true);
    try {
      await api.deleteAccount({ password: pw1, passwordConfirm: pw2 });
      api.clearToken();
      onDeleted();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position:"fixed", inset:0, zIndex:1000,
      background:"rgba(0,0,0,0.7)", backdropFilter:"blur(4px)",
      display:"flex", alignItems:"center", justifyContent:"center",
    }} onClick={onClose}>
      <div style={{
        width:380, background:"linear-gradient(155deg,rgba(0,14,8,0.99),rgba(0,5,3,1))",
        border:"1px solid rgba(136,255,0,0.2)", borderRadius:4, padding:32,
        position:"relative", overflow:"hidden",
      }} onClick={e => e.stopPropagation()}>
        {/* Top accent line */}
        <div style={{position:"absolute",top:0,left:0,right:0,height:1,
          background:"linear-gradient(90deg,#88ff00,#aaff44,#88ff00,#88ff00)",
          backgroundSize:"300% 100%", opacity:0.6, animation:"sheen 2.5s ease-in-out infinite"}} />

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24}}>
          <div style={{
            fontFamily:"'Orbitron',sans-serif", fontSize:13, fontWeight:900, letterSpacing:4,
            background:"linear-gradient(155deg,#ffffff,#aaffee,#88ff00)",
            WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent",
          }}>MY PROFILE</div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"var(--muted)",
            fontSize:18,cursor:"pointer",lineHeight:1,padding:0}}>✕</button>
        </div>

        {/* Avatar + name */}
        <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:24}}>
          <div className="avatar" style={{width:52,height:52,fontSize:18}}>
            {user.displayName.slice(0,2).toUpperCase()}
          </div>
          <div>
            <div style={{fontWeight:700,fontSize:16,marginBottom:2}}>{user.displayName}</div>
            <div style={{color:"var(--muted)",fontSize:12}}>{user.email}</div>
          </div>
        </div>

        {/* Info rows */}
        {[
          ["First Name", user.firstName],
          ["Last Name",  user.lastName],
          ["Email",      user.email],
          ["Role",         user.role === "arch_admin" ? "Arch-Admin" : user.role === "admin" ? "Admin" : "Member"],
          ["Member Since", new Date().toLocaleDateString("en-US", { month:"long", year:"numeric" })],
        ].map(([label, val]) => (
          <div key={label} style={{display:"flex",justifyContent:"space-between",
            padding:"10px 0",borderBottom:"1px solid rgba(136,255,0,0.06)",fontSize:13}}>
            <span style={{color:"var(--muted)",fontFamily:"'Orbitron',sans-serif",fontSize:10,letterSpacing:1,textTransform:"uppercase"}}>{label}</span>
            <span style={{color:"var(--text)",fontWeight:600}}>{val}</span>
          </div>
        ))}

        {/* Delete section */}
        <div style={{marginTop:28}}>
          {!deleteStep ? (
            <button className="btn" style={{
              width:"100%",justifyContent:"center",padding:"10px 20px",
              color:"#ff4455",borderColor:"rgba(255,68,85,0.3)",fontSize:11,letterSpacing:2,
            }} onClick={() => setDeleteStep(true)}>
              DELETE ACCOUNT
            </button>
          ) : (
            <div style={{
              background:"rgba(255,68,85,0.06)", border:"1px solid rgba(255,68,85,0.25)",
              borderRadius:4, padding:18,
            }}>
              <div style={{color:"#ff4455",fontSize:12,fontWeight:700,marginBottom:12,
                fontFamily:"'Orbitron',sans-serif",letterSpacing:1,textTransform:"uppercase"}}>
                ⚠ Confirm Account Deletion
              </div>
              <div style={{color:"var(--muted)",fontSize:12,marginBottom:14}}>
                This is permanent and cannot be undone. Enter your password twice to confirm.
              </div>
              <div style={{marginBottom:10}}>
                <div className="form-label" style={{marginBottom:5}}>Password</div>
                <input type="password" value={pw1} onChange={e => setPw1(e.target.value)}
                  style={{width:"100%",boxSizing:"border-box"}} />
              </div>
              <div style={{marginBottom:14}}>
                <div className="form-label" style={{marginBottom:5}}>Confirm Password</div>
                <input type="password" value={pw2} onChange={e => setPw2(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleDelete()}
                  style={{width:"100%",boxSizing:"border-box"}} />
              </div>
              {error && <div style={{color:"#ff4455",fontSize:12,marginBottom:12,fontWeight:600}}>{error}</div>}
              <div style={{display:"flex",gap:8}}>
                <button className="btn btn-ghost" style={{flex:1,justifyContent:"center",fontSize:10}}
                  onClick={() => { setDeleteStep(false); setPw1(""); setPw2(""); setError(""); }}>
                  CANCEL
                </button>
                <button className="btn" disabled={loading}
                  style={{flex:1,justifyContent:"center",fontSize:10,
                    color:"#ff4455",borderColor:"rgba(255,68,85,0.4)"}}
                  onClick={handleDelete}>
                  {loading ? "DELETING…" : "CONFIRM DELETE"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser]                         = useState(null);   // { id, firstName, lastName, email, displayName }
  const [showProfile, setShowProfile]           = useState(false);
  const [showAdmin, setShowAdmin]               = useState(false);
  const [page, setPage]                         = useState("workout");
  const [showBoards, setShowBoards]             = useState(false);
  const [boardsFading, setBoardsFading]         = useState(false);
  const [showAudio, setShowAudio]               = useState(false);
  const [audioFading, setAudioFading]           = useState(false);
  const [showTopCharts, setShowTopCharts]       = useState(false);
  const [topChartsFading, setTopChartsFading]   = useState(false);
  const [showWorkout, setShowWorkout]           = useState(true);
  const [workoutFading, setWorkoutFading]       = useState(false);
  const [navExpanded, setNavExpanded]           = useState(true);
  const [loaded, setLoaded]                     = useState(false);
  const mainRef = useRef(null);
  const glbCanvasRef = useRef(null);

  const [currentTrack, setCurrentTrack] = useState(PERMANENT_TRACKS[0] ?? null);
  const [isPlaying, setIsPlaying]       = useState(false);

  // On mount: try to restore session from stored JWT
  useEffect(() => {
    const token = api.getToken();
    if (!token) { setLoaded(true); return; }
    api.me()
      .then(({ user: u }) => setUser(u))
      .catch(() => api.clearToken())          // token expired/invalid — clear it
      .finally(() => setLoaded(true));

    store.get("player:lastTrackId").then(saved => {
      if (saved) {
        const track = PERMANENT_TRACKS.find(t => t.id === parseInt(saved));
        if (track) setCurrentTrack(track);
      }
    });
  }, []);

  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [page]);

  // ── GLB orb renderer ──────────────────────────────────────────────
  useEffect(() => {
    const GLB_URL = `${RAILWAY_URL}/Hyacinth_Sphere.glb`;

    let animId;
    let renderer;

    function init() {
      const canvas = glbCanvasRef.current;
      if (!canvas) { setTimeout(init, 150); return; }

      const W = canvas.offsetWidth  || 220;
      const H = canvas.offsetHeight || 220;
      if (W < 10) { setTimeout(init, 150); return; }

      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(W, H);
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 3.5;

      const scene = new THREE.Scene();
      const cam = new THREE.PerspectiveCamera(42, W / H, 0.1, 1000);
      cam.position.set(0, 0, 3.2);

      // Ambient — warm yellow-green tint
      const ambLight = new THREE.AmbientLight(0xccff44, 0.12);
      scene.add(ambLight);
      // Key — bright yellow-lime from top-front-right
      const keyLight = new THREE.PointLight(0xeeff44, 10.0, 20);
      keyLight.position.set(2, 3, 4);
      scene.add(keyLight);
      // Fill — deep green
      const fillLight = new THREE.PointLight(0x44cc00, 1.2, 20);
      fillLight.position.set(-2, -1, 2);
      scene.add(fillLight);
      // Rim — yellow-green from behind for edge shine
      const rimLight = new THREE.PointLight(0x88cc00, 1.5, 20);
      rimLight.position.set(0, -3, -3);
      scene.add(rimLight);
      // Top highlight — bright specular for Xbox orb top-left shine
      const topLight = new THREE.PointLight(0xffffff, 2.0, 10);
      topLight.position.set(-1, 4, 3);
      scene.add(topLight);

      const clock = new THREE.Clock();
      const loader = new GLTFLoader();
      const _loadGLB = (gltf) => {
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const centre = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        model.position.sub(centre);
        model.scale.setScalar(2.0 / maxDim);
        model.rotation.set(0, -Math.PI / 2, 0);

        model.traverse(child => {
          if (!child.isMesh) return;
          const orig = child.material;
          const isTrans = orig && orig.name === 'Material.002';

          if (isTrans) {
            // Outer shell — increased opacity, still transparent
            child.material = new THREE.MeshStandardMaterial({
              color:             new THREE.Color(0.55, 0.95, 0.05),
              emissive:          new THREE.Color(0.18, 0.45, 0.0),
              emissiveIntensity: 0.6,
              metalness:         0.1,
              roughness:         0.02,
              transparent:       true,
              opacity:           0.35,
              side:              THREE.DoubleSide,
              depthWrite:        false,
            });
            // EdgesGeometry — hard edges only (cross contours), blurred via CSS
            const edgesGeo = new THREE.EdgesGeometry(child.geometry, 15);
            const edgesMat = new THREE.LineBasicMaterial({
              color:       0xccff00,
              transparent: true,
              opacity:     0.75,
              blending:    THREE.AdditiveBlending,
              depthWrite:  false,
              linewidth:   2,
            });
            const edgesMesh = new THREE.LineSegments(edgesGeo, edgesMat);
            child.add(edgesMesh);
          } else {
            // Inner orb — restored to reference values
            child.material = new THREE.MeshStandardMaterial({
              color:             new THREE.Color(0.30, 0.80, 0.0),
              emissive:          new THREE.Color(0.05, 0.20, 0.0),
              emissiveIntensity: 0.3,
              metalness:         0.1,
              roughness:         0.02,
              transparent:       false,
              opacity:           1.0,
              side:              THREE.DoubleSide,
            });
          }
        });

        scene.add(model);

        let mixer = null;
        if (gltf.animations && gltf.animations.length) {
          mixer = new THREE.AnimationMixer(model);
          gltf.animations.forEach(clip => mixer.clipAction(clip).play());
        }

        function animate() {
          animId = requestAnimationFrame(animate);
          const dt = clock.getDelta();
          if (mixer) mixer.update(dt);
          model.position.y = Math.sin(clock.elapsedTime * 0.9) * 0.06;
          renderer.render(scene, cam);
        }
        animate();
      };
      if (assetCache.has(GLB_URL)) {
        loader.parse(assetCache.get(GLB_URL).slice(0), "", _loadGLB, err => console.warn("GLB parse error:", err));
      } else {
        loader.load(GLB_URL, _loadGLB, undefined, err => console.warn("GLB load error:", err));
      }
    }

    const t = setTimeout(init, 100);
    return () => {
      clearTimeout(t);
      if (animId) cancelAnimationFrame(animId);
      if (renderer) renderer.dispose();
    };
  }, []);

  useEffect(() => {
    if (currentTrack?.id) store.set("player:lastTrackId", String(currentTrack.id));
  }, [currentTrack]);

  const handleAuth = (u) => setUser(u);

  const handleLogout = () => {
    api.clearToken();
    setUser(null);
  };

  const handleDeleted = () => {
    setShowProfile(false);
    setUser(null);
  };

  const handleSetPage = (id) => {
    if (id === page) return;
    if (page === "boards")    { setBoardsFading(true);    setTimeout(() => { setShowBoards(false);    setBoardsFading(false);    }, 500); }
    if (page === "audio")     { setAudioFading(true);     setTimeout(() => { setShowAudio(false);     setAudioFading(false);     }, 500); }
    if (page === "topcharts") { setTopChartsFading(true); setTimeout(() => { setShowTopCharts(false); setTopChartsFading(false); }, 500); }
    if (page === "workout")   { setWorkoutFading(true);   setTimeout(() => { setShowWorkout(false);   setWorkoutFading(false);   }, 500); }
    if (id === "boards")    setShowBoards(true);
    if (id === "audio")     setShowAudio(true);
    if (id === "topcharts") setShowTopCharts(true);
    if (id === "workout")   setShowWorkout(true);
    setPage(id);
  };

  if (!loaded) return null;

  if (!user) return (
    <>
      <style>{css}</style>
      <AuthScreen onAuth={handleAuth} />
    </>
  );

  const username = user.displayName;

  // Y2K chrome SVG nav icons
  const NavIcon = ({ id, active }) => {
    const c = active ? "#88ff00" : "#1a5540";
    const glow = active ? `drop-shadow(0 0 5px #88ff00cc) drop-shadow(0 0 12px #88ff0055)` : "none";
    const s = { filter: glow, transition: "filter 0.15s" };
    if (id === "workout") return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" style={s}>
        <line x1="6" y1="12" x2="18" y2="12"/>
        <rect x="1" y="10" width="4" height="4" rx="1"/>
        <rect x="19" y="10" width="4" height="4" rx="1"/>
        <rect x="8" y="7" width="3" height="10" rx="1"/>
        <rect x="13" y="7" width="3" height="10" rx="1"/>
      </svg>
    );
    if (id === "topcharts") return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" style={s}>
        <polyline points="22,6 13,15 8,10 2,18"/>
        <polyline points="18,6 22,6 22,10"/>
        <line x1="2" y1="21" x2="22" y2="21"/>
      </svg>
    );
    if (id === "boards") return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" style={s}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        <line x1="9" y1="10" x2="15" y2="10"/>
        <line x1="9" y1="13" x2="13" y2="13"/>
      </svg>
    );
    if (id === "audio") return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" style={s}>
        <circle cx="12" cy="12" r="2"/>
        <path d="M12 2 a10 10 0 0 1 0 20 a10 10 0 0 1 0-20"/>
        <path d="M12 7 a5 5 0 0 1 0 10 a5 5 0 0 1 0-10"/>
      </svg>
    );
    return null;
  };

  const navItems = [
    { id: "workout",   label: "Workout" },
    { id: "topcharts", label: "Top Charts" },
    { id: "boards",    label: "Chat" },
    { id: "audio",     label: "Audio" },
  ];

  return (
    <>
      <style>{css}</style>
      <div className="app-bg" />
      <div className="grid-stars" />
      <div className="app">
        <div className={`sidebar${navExpanded ? "" : " nav-collapsed"}`}>
          {/* Logo — two lines, shrinks when nav retracts */}
          <div className="logo" style={{fontSize: navExpanded ? "22px" : "15px", whiteSpace:"nowrap"}}>
            <span className="logo-l1" style={{display:"block", letterSpacing: navExpanded ? "5px" : "2.5px"}}>BROS OF ST.</span>
            <span className="logo-l2" style={{display:"block", letterSpacing: navExpanded ? "10.5px" : "5px"}}>HYACINTH</span>
          </div>
          {/* Orb — click to toggle nav */}
          <div className="xbox-orb-wrap" onClick={() => setNavExpanded(v => !v)}>
            <div className="xbox-orb" />
            <div style={{position:"absolute",inset:0,borderRadius:"50%",background:"radial-gradient(circle at 50% 55%, transparent 30%, rgba(0,5,0,0.5) 62%, rgba(0,0,0,0.80) 100%)",zIndex:1,pointerEvents:"none"}} />
            <canvas ref={glbCanvasRef} style={{position:"absolute",inset:0,width:"100%",height:"100%",borderRadius:"50%",pointerEvents:"none",zIndex:2,filter:"blur(0.5px) drop-shadow(0 0 10px #aaff00cc) drop-shadow(0 0 25px #88ff0099) drop-shadow(0 0 55px #55dd0066) drop-shadow(0 0 90px #33aa0033)"}} />
            <div className="xbox-bubble" />
            <div className="xbox-bubble" />
            <div className="xbox-bubble" />
            <div className="xbox-bubble" />
            <div className="xbox-bubble" />
          </div>
          {/* Blade nav */}
          <div className={`nav-wrap${navExpanded ? "" : " retracted"}`}>
            {navItems.map(n => (
              <div key={n.id} className={`nav-item-wrap${page===n.id?" active-wrap":""}`} onClick={() => handleSetPage(n.id)}>
                <div className={`nav-item ${page===n.id?"active":""}`}>{n.label}</div>
              </div>
            ))}
            {(user.role === "arch_admin" || user.role === "admin") && (
              <div className="nav-item-wrap" onClick={() => setShowAdmin(true)}>
                <div className="nav-item">{user.role === "arch_admin" ? "Arch-Admin" : "Admin"}</div>
              </div>
            )}
            <div className="nav-item-wrap" onClick={() => setShowProfile(true)}>
              <div className="nav-item">{username}</div>
            </div>
          </div>
        </div>
        <div ref={mainRef} className="main" style={{display:"flex", flexDirection:"column"}}>
          {page === "workout" && <div style={{paddingLeft: navExpanded ? 80 : 0, transition:"padding-left 0.4s cubic-bezier(0.4,0,0.2,1)"}}><WorkoutPage username={username} /></div>}
          {page === "topcharts" && <div style={{paddingLeft: navExpanded ? 80 : 0, transition:"padding-left 0.4s cubic-bezier(0.4,0,0.2,1)"}}><TopChartsPage username={username} /></div>}
          {page === "boards" && <div style={{paddingLeft: navExpanded ? 80 : 0, transition:"padding-left 0.4s cubic-bezier(0.4,0,0.2,1)"}}><BoardPage username={username} /></div>}
          {page === "audio" && <AudioPage currentTrack={currentTrack} setCurrentTrack={setCurrentTrack} isPlaying={isPlaying} setIsPlaying={setIsPlaying} />}
        </div>
        {showBoards && <FigureBackdrop variant="boards" fading={boardsFading} />}
        {showAudio && <AudioFigureBackdrop fading={audioFading} />}
        {showTopCharts && <FigureBackdrop variant="topcharts" fading={topChartsFading} />}
        {showWorkout && <WorkoutFigureBackdrop fading={workoutFading} />}
      </div>
      {currentTrack && (
        <PlayerBar track={currentTrack} isPlaying={isPlaying} setIsPlaying={setIsPlaying} tracks={PERMANENT_TRACKS} setTrack={setCurrentTrack} />
      )}
      {showProfile && (
        <UserProfileModal
          user={user}
          onClose={() => setShowProfile(false)}
          onDeleted={handleDeleted}
        />
      )}
      {showAdmin && (
        <AdminPanel
          currentUser={user}
          onClose={() => setShowAdmin(false)}
        />
      )}
    </>
  );
}
