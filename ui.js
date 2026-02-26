// ui.js - 只负责展示/渲染，不做业务逻辑
// ✅ 避免与 app.js 重名：不定义 setStatus/refreshUI/refreshNet/showOverlay/hideOverlay/comingSoon
// ✅ badgeDisplay / renderSetToHtml / renderActiveLists / syncLeaderPickUI 均在 app.js 中定义
// ✅ session 已结束：syncLeaderPickUI 在 app.js 里已加 session-closed 检查

function $(id){ return document.getElementById(id); }

/** ===== Helpers ===== */
function uiIsSessionClosedSafe(){
  try{
    if(typeof isSessionClosed === "function") return !!isSessionClosed();
  }catch(e){}
  return false;
}

/** ===== Optional: lightweight UI refresh hook =====
 * 你原来 ui.js 里有 online/offline 监听，但 refreshNet 已在 app.js 里做了。
 * 这里不再重复绑定，避免覆盖/重复。
 */
