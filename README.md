# CK 仓库作业系统 - Project Snapshot

## 部署信息
- GitHub Pages：https://ck91888.github.io/cangku
- GitHub Repo：https://github.com/ck91888/cangku
- 前端文件：index.html / app.js / ui.js / style.css
- 缓存策略：script 引用带版本号，例如 app.js?v=20260226-1

## 数据写入（Google Form）
- FORM_URL：https://docs.google.com/forms/u/0/d/e/1FAIpQLSer3mWq6A6OivAJKba5JE--CwlKnU6Teru586HCOZVoJo6qQg/formResponse
- 字段映射：
  - event = entry.806252256
  - device_id = entry.1221756343
  - pick_session_id = entry.139498995
  - wave_id = entry.2002106420
  - ts = entry.179441545
  - da_id = entry.1739228641
  - biz = entry.1934762358
  - task = entry.53174481

## 工牌规则
- 员工工牌：EMP-001|名字（支持韩文）
- 长期日当：DAF-001|名字（长期可用）
- 每日日当：DA-YYYYMMDD-xx（当天生成）

## 当前模块（已上线）
- B2C / PICK：start + wave + join/leave + 组长登录 + 组长 end
- B2C / RELABEL：start/end + join/leave
- B2C / PACK：只 join/leave（口径：每人 join→leave 统计工时）
- 全屏扫码：html5-qrcode
- 本地状态：localStorage（恢复波次/名单）

## 锁（防跨设备重复）
- GAS WebApp exec：https://script.google.com/macros/s/AKfycbwPXpP853p_AVgTAfpTNThdiSd6Ho4BqpRs1vKX41NYxa3gNYJV6FULx-4Wmsf0uNw/exec
- 动作：lock_acquire / lock_release
- 作用：同一工牌不能在不同设备/不同任务同时在岗

## 当前要做的 P0（下一步）
1) labor 去重与防脏数据：
   - 已在 active：禁止重复 join
   - 不在 active：禁止 leave
   - 扫码成功：先关摄像头再 submit，避免卡住连扫重复
2) PACK 页面：补 activePack 名单/人数（如需要）
3) 统计脚本：按“每人 join→leave”匹配系统出库明细（发货时间精确到秒）计算人效
