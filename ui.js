// ui.js - 只负责展示/渲染，不做业务逻辑

function $(id){ return document.getElementById(id); }

function comingSoon(name){
  alert(name + "\n还未上线 / 아직 준비중");
}

function setStatus(msg, ok){
  if(ok === undefined) ok = true;
  var el = $("status");
  if(!el) return;
  el.className = "pill " + (ok ? "ok" : "bad");
  el.textContent = msg;
}

function refreshUI(){
  if($("device")) $("device").textContent = makeDeviceId();
  if($("session")) $("session").textContent = currentSessionId || "无 / 없음";
}

function refreshNet(){
  var el = $("netPill");
  if(!el) return;
  el.textContent = navigator.onLine ? "Online" : "Offline";
  el.style.borderColor = navigator.onLine ? "#0a0" : "#b00";
}

function badgeDisplay(raw){
  var p = parseBadge(raw);
  return p.name ? (p.id + "｜" + p.name) : p.id;
}

function renderSetToHtml(setObj){
  var arr = Array.from(setObj || []);
  if(arr.length === 0) return '<span class="muted">无 / 없음</span>';
  return arr.map(function(x){ return '<span class="tag">' + badgeDisplay(x) + '</span>'; }).join("");
}

function renderActiveLists(){
  if($("pickCount")) $("pickCount").textContent = String(activePick.size);
  if($("pickActiveList")) $("pickActiveList").innerHTML = renderSetToHtml(activePick);

  if($("relabelCount")) $("relabelCount").textContent = String(activeRelabel.size);
  if($("relabelActiveList")) $("relabelActiveList").innerHTML = renderSetToHtml(activeRelabel);
}

function syncLeaderPickUI(){
  var info = $("leaderInfoPick");
  var btnEnd = $("btnEndPick");
  if(!info || !btnEnd) return;

  if(leaderPickOk && leaderPickBadge){
    info.textContent = "组长已登录 ✅ " + leaderPickBadge;
    btnEnd.style.display = "block";
  }else{
    info.textContent = leaderPickBadge ? ("组长未确认（本趟需登录）: " + leaderPickBadge) : "组长未登录 / 팀장 미로그인";
    btnEnd.style.display = "none";
  }
}

function showOverlay(){ $("scannerOverlay").classList.add("show"); }
function hideOverlay(){ $("scannerOverlay").classList.remove("show"); }

window.addEventListener("online", refreshNet);
window.addEventListener("offline", refreshNet);
