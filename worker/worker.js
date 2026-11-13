// 요리월드 상태 · 노크 Worker (Cloudflare Workers, 무료 요금제로 충분)
//
//   GET  /api/status   서버 켜짐/꺼짐 + 접속 인원 (+ 꺼져 있으면 오늘 노크 수)
//   POST /api/knock    서버가 꺼져 있을 때 "열어 주세요" 노크 (같은 사람은 하루 1번만 셈)
//   GET  /admin?key=…  관리자용: 날짜별 노크 수
//
// 설정값 (Cloudflare 대시보드 → Worker → 설정 → 변수):
//   MC_HOST          서버 주소 (비밀 값으로 넣기. 홈페이지에는 절대 안 나가요)
//   MC_PORT          포트 (기본 25565)
//   ADMIN_KEY        관리자 페이지 비밀번호 (비밀 값)
//   ALLOWED_ORIGIN   홈페이지 주소 (예: https://아이디.github.io). 비우면 어디서나 허용
//   DISCORD_WEBHOOK  (선택) 노크할 때마다 디스코드 알림
//   KNOCKS           KV 저장소 연결 이름

import { connect } from "cloudflare:sockets";

const DAY_MS = 86400000;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return cors(env, new Response(null, { status: 204 }));
    try {
      if (url.pathname === "/api/status" && req.method === "GET") return cors(env, json(await status(env, ctx)));
      if (url.pathname === "/api/knock" && req.method === "POST") return cors(env, json(await knock(req, env, ctx)));
      if (url.pathname === "/admin") return admin(url, env);
    } catch (e) {
      return cors(env, json({ error: "서버 확인 중 문제가 생겼어요" }, 500));
    }
    return new Response("없는 주소예요", { status: 404 });
  },
};

// ── 서버 상태 ───────────────────────────────────────────────
async function status(env, ctx) {
  // 30초 동안은 저장해 둔 결과를 써요 (방문자가 많아도 서버를 계속 두드리지 않게)
  const cache = caches.default;
  const key = new Request("https://cache.local/status");
  const hit = await cache.match(key);
  if (hit) return withKnocks(await hit.json(), env);

  let s;
  try {
    // MC_HOST may be "주소" or "주소:포트" (playit 주소를 그대로 붙여넣어도 돼요)
    const [h, pt] = String(env.MC_HOST || "").trim().split(":");
    s = await ping(h, Number(pt || env.MC_PORT || 25565));
  } catch {
    s = { online: false };
  }
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(s), { headers: { "cache-control": "max-age=30" } })));
  return withKnocks(s, env);
}

async function withKnocks(s, env) {
  if (!s.online) s.knocksToday = Number((await env.KNOCKS.get("c:" + today())) || 0);
  return s;
}

// 마인크래프트 서버 목록 핑 (게임 런처가 서버 목록에서 하는 것과 같은 방식)
async function ping(host, port) {
  const sock = connect({ hostname: host, port });
  const timer = new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 4000));
  const work = (async () => {
    const w = sock.writable.getWriter();
    const hostB = new TextEncoder().encode(host);
    const hs = [...varint(0x00), ...varint(767), ...varint(hostB.length), ...hostB, (port >> 8) & 255, port & 255, ...varint(1)];
    await w.write(new Uint8Array([...varint(hs.length), ...hs]));
    await w.write(new Uint8Array([1, 0x00]));                  // status request
    const r = sock.readable.getReader();
    let buf = new Uint8Array(0);
    while (true) {
      const { value, done } = await r.read();
      if (done) break;
      buf = concat(buf, value);
      const p = { i: 0 };
      try {
        const len = readVar(buf, p);
        if (buf.length < p.i + len) continue;                   // 아직 덜 받음
        readVar(buf, p);                                        // packet id
        const sl = readVar(buf, p);
        const info = JSON.parse(new TextDecoder().decode(buf.slice(p.i, p.i + sl)));
        return {
          online: true,
          players: info.players?.online ?? 0,
          max: info.players?.max ?? 0,
          version: info.version?.name ?? "",
        };
      } catch (e) {
        if (e.message === "short") continue;
        throw e;
      }
    }
    throw new Error("closed");
  })();
  try {
    return await Promise.race([work, timer]);
  } finally {
    sock.close().catch(() => {});
  }
}

// ── 노크 ────────────────────────────────────────────────────
async function knock(req, env, ctx) {
  const s = await status(env, ctx);
  if (s.online) return { ok: false, online: true };
  const day = today();
  // 같은 사람(IP)은 하루에 한 번만. IP는 그대로 저장하지 않고 알아볼 수 없게 바꿔서 저장해요
  const ip = req.headers.get("cf-connecting-ip") || "?";
  const who = await sha(ip + "|" + day + "|" + (env.ADMIN_KEY || "yori"));
  const seenKey = "k:" + day + ":" + who.slice(0, 24);
  const countKey = "c:" + day;
  let n = Number((await env.KNOCKS.get(countKey)) || 0);
  if (await env.KNOCKS.get(seenKey)) return { ok: true, already: true, knocksToday: n };
  n += 1;
  await env.KNOCKS.put(seenKey, "1", { expirationTtl: 2 * 86400 });
  await env.KNOCKS.put(countKey, String(n), { expirationTtl: 400 * 86400 });
  if (env.DISCORD_WEBHOOK) {
    ctx.waitUntil(fetch(env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `🚪 똑똑! 누군가 요리월드를 열어 달래요 (오늘 ${n}번째)` }),
    }));
  }
  return { ok: true, knocksToday: n };
}

// ── 관리자 페이지 ───────────────────────────────────────────
async function admin(url, env) {
  if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY)
    return new Response("비밀번호가 달라요", { status: 403 });
  const rows = [];
  let total = 0;
  for (let d = 0; d < 30; d++) {
    const day = today(-d);
    const n = Number((await env.KNOCKS.get("c:" + day)) || 0);
    total += n;
    rows.push(`<tr><td>${day}</td><td>${n}</td><td><span style="display:inline-block;height:12px;width:${n * 8}px;background:#e0b04a;border-radius:3px"></span></td></tr>`);
  }
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>노크 기록</title><style>body{font-family:system-ui,sans-serif;background:#1d1611;color:#f3e6cc;max-width:560px;margin:0 auto;padding:16px}
td{padding:4px 8px;border-bottom:1px solid #4a3a2a}h1{font-size:22px}</style>
<h1>🚪 노크 기록 (최근 30일 · 합계 ${total}번)</h1><table>${rows.join("")}</table>
<p style="color:#c4ab88;font-size:13px">같은 사람은 하루에 한 번만 세요. 날짜는 한국 시간 기준이에요.</p>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// ── 도우미 ──────────────────────────────────────────────────
function today(offsetDays = 0) {                       // 한국 시간 날짜 (YYYY-MM-DD)
  return new Date(Date.now() + 9 * 3600000 + offsetDays * DAY_MS).toISOString().slice(0, 10);
}
function varint(n) {
  const out = [];
  n >>>= 0;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}
function readVar(buf, p) {
  let v = 0, shift = 0;
  while (true) {
    if (p.i >= buf.length) throw new Error("short");
    const b = buf[p.i++];
    v |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return v;
    shift += 7;
    if (shift > 35) throw new Error("bad varint");
  }
}
function concat(a, b) {
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
}
async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function json(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function cors(env, res) {
  res.headers.set("access-control-allow-origin", env.ALLOWED_ORIGIN || "*");
  res.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  res.headers.set("access-control-allow-headers", "content-type");
  return res;
}
