// 서버 켜짐/꺼짐 표시 + 꺼져 있을 때 노크하기
// API: worker/설정방법.md 대로 만든 Worker 주소. 아직 없으면 미리보기 모드로 보여요 (?demo=on / ?demo=off)
const API = "__WORKER__";

(function () {
  const pill = document.getElementById("srv");
  const box = document.getElementById("knock");
  if (!pill) return;
  const demo = API.startsWith("__");
  // Worker를 아직 안 붙였으면 실제 홈페이지에서는 아무것도 안 보여요 (가짜 숫자가 나가지 않게). 미리보기는 내 컴퓨터에서만
  if (demo && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  const q = new URLSearchParams(location.search).get("demo");
  let demoCount = 7;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

  async function getStatus() {
    if (demo) return q === "on" ? { online: true, players: 3, max: 20 } : { online: false, knocksToday: demoCount };
    const r = await fetch(API + "/api/status", { cache: "no-store" });
    return r.json();
  }

  async function sendKnock() {
    if (demo) { demoCount++; return { ok: true, knocksToday: demoCount }; }
    const r = await fetch(API + "/api/knock", { method: "POST" });
    return r.json();
  }

  function waitingText(n) {
    return n > 0 ? `오늘 <b>${n}명</b>이 문을 두드렸어요` : "오늘은 아직 아무도 안 두드렸어요";
  }

  function render(s) {
    pill.hidden = false;
    if (s.online) {
      pill.className = "srv on";
      pill.innerHTML = `<i></i>서버 열림 · <b>${s.players}명</b> 놀고 있어요`;
      box.hidden = true;
      return;
    }
    pill.className = "srv off";
    pill.innerHTML = "<i></i>지금은 서버가 쉬는 중";
    box.hidden = false;
    const done = store.get("knocked") === today();
    box.querySelector(".kcount").innerHTML = waitingText(s.knocksToday || 0);
    setDone(done);
  }

  function setDone(done) {
    const b = box.querySelector("button");
    b.disabled = done;
    b.textContent = done ? "✔ 두드렸어요" : "🚪 똑똑 두드리기";
    box.querySelector(".kmsg").textContent = done
      ? "서버 주인에게 전해졌어요. 서버가 열리면 이 페이지에 초록불이 켜져요!"
      : "놀고 싶다면 문을 두드려 주세요. 몇 명이 기다리는지 서버 주인에게 전해져요.";
  }

  box.querySelector("button").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    box.classList.remove("shake");
    void box.offsetWidth;
    box.classList.add("shake");
    try {
      const r = await sendKnock();
      if (r.online) return refresh();
      store.set("knocked", today());
      box.querySelector(".kcount").innerHTML = waitingText(r.knocksToday || 0);
      setDone(true);
    } catch {
      b.disabled = false;
      box.querySelector(".kmsg").textContent = "앗, 전달이 안 됐어요. 잠시 뒤 다시 눌러 주세요.";
    }
  });

  async function refresh() {
    try { render(await getStatus()); }
    catch { pill.hidden = false; pill.className = "srv unk"; pill.innerHTML = "<i></i>서버 상태를 확인하지 못했어요"; }
  }
  refresh();
  setInterval(refresh, 60000);
})();
