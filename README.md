
# 🛰️ Bubble × Cloud Run オンラインステータス管理システム

Google Cloud Run 上の Presence API と Bubble を連携し、ユーザーのオンライン・アイドル状態をリアルタイム管理します。  
外部DB不要で、タブ単位で正確にユーザーの状態を追跡できます。

---

## 📘 システム概要

Cloud Run 側が Presence API を提供し、Bubble 側で訪問者・管理者用スクリプトを埋め込むだけで動作します。

---

## 🧍‍♂️ 訪問者ページ（送信側）

Bubble ページの HTML 要素に以下を貼り付けます。  
「Current User's unique id」を動的データに置き換えてください。

```html
<script>
(() => {
  if (document.prerendering) {
    document.addEventListener("prerenderingchange", () => startPresence(), { once: true });
    return;
  }
  startPresence();
  function startPresence() {
    const ORIGIN = "https://online-status-677366504119.asia-northeast1.run.app";
    const uidRaw = "Current User's unique id";
    const UID = (uidRaw && uidRaw.trim()) ? uidRaw.trim() : "logout user";
    const RAW = location.pathname || "/";
    const PATH = ("/" + RAW.replace(/^\/+/,"").replace(/\/+$/,"")).toLowerCase();
    const clientId = (crypto && crypto.randomUUID)? crypto.randomUUID():(Math.random().toString(36).slice(2)+Date.now().toString(36));
    const base = { uid: UID, path: PATH, clientId };
    let isClosing = false;
    const postJSON = (ep,obj)=>{
      if(isClosing && ep!=="/presence/leave")return;
      fetch(`${ORIGIN}${ep}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(obj),credentials:"omit",mode:"cors"}).catch(()=>{});
    };
    let pingTimer=null;
    const ping=()=>postJSON("/presence/ping",base);
    function startPing(){if(pingTimer)return;ping();pingTimer=setInterval(ping,10000);}
    function stopPing(){if(pingTimer){clearInterval(pingTimer);pingTimer=null;}}
    startPing();
    ["mousemove","keydown","click","scroll","focus"].forEach(ev=>addEventListener(ev,()=>postJSON("/presence/hit",base),{passive:true}));
    const bc=('BroadcastChannel'in window)?new BroadcastChannel('presence-bc'):null;
    function notifyLeave(){const msg={type:"leave",uid:UID,path:PATH,clientId,ts:Date.now()};try{bc&&bc.postMessage(msg);}catch(e){}try{localStorage.setItem("presence_leave_msg",JSON.stringify(msg));}catch(e){}}
    function sendLeave(){const pkt={...base,closing:true};if(navigator.sendBeacon){navigator.sendBeacon(`${ORIGIN}/presence/leave`,new Blob([JSON.stringify(pkt)],{type:"application/json"}));return;}fetch(`${ORIGIN}/presence/leave`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pkt),keepalive:true,mode:"cors"});}
    function closeNow(ev){if(ev&&ev.type==="pagehide"&&ev.persisted)return;if(isClosing)return;isClosing=true;notifyLeave();stopPing();sendLeave();}
    addEventListener("pagehide",closeNow,{capture:true});
    addEventListener("beforeunload",closeNow,{capture:true});
    addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden")stopPing();else if(document.visibilityState==="visible")startPing();},{capture:true});
    addEventListener("pageshow",()=>startPing());
  }
})();
</script>
```

---

## 🧭 管理ページ（受信側）

Bubble の管理ページに HTML 要素を追加し、以下を貼り付けます。  
さらに、**JavaScript to Bubble** 要素を2つ追加してください。  

| Function name | 内容 |
|----------------|------|
| `active_users` | アクティブユーザー一覧（Text型） |
| `idle_users`   | アイドルユーザー一覧（Text型） |

```html
<script>
(() => {
  const ORIGIN = "https://online-status-677366504119.asia-northeast1.run.app";
  const SNAP = { active: [], idle: [] };
  function pushToBubble(){
    if(typeof window.bubble_fn_active_users==="function")window.bubble_fn_active_users(JSON.stringify(SNAP.active||[]));
    if(typeof window.bubble_fn_idle_users==="function")window.bubble_fn_idle_users(JSON.stringify(SNAP.idle||[]));
  }
  function fetchSummary(){
    fetch(`${ORIGIN}/presence/summary`)
      .then(r=>r.json())
      .then(d=>{if(!d||!d.ok)return;SNAP.active=d.active||[];SNAP.idle=d.idle||[];pushToBubble();})
      .catch(()=>{});
  }
  fetchSummary();
  setInterval(fetchSummary,1000);
})();
</script>
```

---

## 📋 動作仕様

| 状態 | 判定条件 |
|------|-----------|
| アクティブ | 最後の操作から30秒以内 |
| アイドル | 操作停止30秒〜3分未満 |
| クローズ | 操作停止3分以上またはタブ閉鎖 |

---

## 💡 注意事項

- 複数タブを開いてもタブ単位で管理されます。  
- タブを閉じた時は **BroadcastChannel** と **localStorage** により即時反映されます。  
- Chrome の **prerender** 対策済み（検索バー候補での誤検出なし）。  
- Safari など `sendBeacon` が制限される場合、`fetch(keepalive)` に自動フォールバックします。  

---

© 2025 Bubble Online API Project — MIT License
