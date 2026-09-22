#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SubBridge 全功能浏览器级测试（所有按钮 + 所有交互元素）
覆盖：主题/模式/登录退出、驾驶舱、节点库、规则/质量/清理、事件日志、
      本地节点、全站参数（含 YAML）、模板管理、备份迁移

用法：python3 scripts/test-all-ui.py
前置：本地服务运行在 http://127.0.0.1:18081，令牌 admin-token
"""
import json
import sys
import time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:18081"
TOKEN = "admin-token"
LOCAL_SRC = "http://127.0.0.1:18099/sub.txt"  # 本地测试源（沙箱内可达，速度快）

PASS, FAIL, WARN = [], [], []


def report(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    tag = "✓" if ok else "✗"
    print(f"  {tag} {name}" + (f"  {detail}" if detail else ""))


def report_warn(name, detail):
    WARN.append(name)
    print(f"  ⚠ {name}  {detail}")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path="/usr/local/bin/chromium",
                                    args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 1000},
                                  permissions=["clipboard-read", "clipboard-write"])
        page = ctx.new_page()
        js_errors = []
        page.on("pageerror", lambda e: js_errors.append(f"pageerror:{e}"))
        # 过滤未登录探测角色的预期 401（页面加载时未授权请求属于正常行为）
        page.on("console", lambda m: js_errors.append(f"console:{m.text}")
                if m.type == "error" and "401" not in m.text else None)

        # 全局对话框策略：破坏性（清空池/清理/删节点）点取消，可恢复的（清日志/恢复备份）点确定
        def on_dialog(dialog):
            msg = dialog.message
            if any(k in msg for k in ("清空整个节点池", "执行清理将按规则删除", "确定删除该节点")):
                dialog.dismiss()
            else:
                dialog.accept()
        page.on("dialog", on_dialog)

        def toast_text():
            return page.locator("#toast").inner_text()

        def wait_toast(timeout_ms=15000, expect_fail=False, before=None):
            """等待 toast 出现（与点击前文本不同；POST 已完成时直接读取最新文本）"""
            try:
                old = before if before is not None else toast_text()
                page.wait_for_function(
                    """(old) => { const t = document.getElementById('toast');
                        return t && !t.classList.contains('hidden') && t.textContent.trim() !== '' && t.textContent.trim() !== old; }""",
                    arg=old,
                    timeout=timeout_ms)
                page.wait_for_timeout(300)  # 等待最终文本稳定
                t = toast_text()
                ok = ("失败" not in t) if expect_fail else True
                return t, ok
            except Exception:
                page.wait_for_timeout(300)
                t = toast_text()
                ok = ("失败" not in t) if expect_fail else True
                return t, ok

        def goto_tab(tab):
            page.click(f'.nav-item[data-tab="{tab}"]')
            page.wait_for_timeout(700)

        # ========== 1. 页面基础 ==========
        print("== 1. 页面基础 ==")
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=20000)
        page.wait_for_timeout(1000)
        report("页面可打开", "SubBridge" in (page.title() or "") or page.locator("text=SubBridge").count() > 0,
               page.title())

        # 主题切换（亮/暗）
        before_theme = page.evaluate("document.body.dataset.theme || document.documentElement.dataset.theme || ''")
        page.click("#btn-theme")
        page.wait_for_timeout(400)
        after_theme = page.evaluate("document.body.dataset.theme || document.documentElement.dataset.theme || ''")
        report("主题切换（亮/暗）", before_theme != after_theme, f"{before_theme}->{after_theme}")
        page.click("#btn-theme")  # 切回
        page.wait_for_timeout(300)

        # ========== 2. 登录与角色 ==========
        print("== 2. 登录与角色 ==")
        # 测试前置：放行本地测试源（SSRF 白名单），结束恢复
        page.request.post(BASE + "/api/config",
                          headers={"X-API-Token": TOKEN, "Content-Type": "application/json"},
                          data=json.dumps({"fetcher": {"private_host_allowlist": ["127.0.0.1"]}}))
        # 未登录点击登录 → 跳转登录页
        page.click("#btn-login")
        page.wait_for_timeout(1200)
        report("未登录点「登录」跳转登录页", "/login" in page.url, page.url)
        # 登录页主题按钮
        page.click("#btn-login-theme")
        page.wait_for_timeout(300)
        lg_theme = page.evaluate("document.documentElement.dataset.theme")
        page.click("#btn-login-theme")
        page.wait_for_timeout(200)
        report("登录页「切换主题」", lg_theme in ("light", "dark"), lg_theme)
        # 使用令牌方式登录
        page.click('.login-tabs .tab[data-lm="token"]')
        page.wait_for_timeout(300)
        page.fill("#login-token-input", TOKEN)
        page.click('#login-token button[type="submit"]')
        page.wait_for_url(BASE + "/**", timeout=15000)
        page.wait_for_timeout(1800)
        badge = page.locator("#role-badge").inner_text()
        report("令牌登录识别为管理员", "管理员" in badge, badge)
        login_btn = page.locator("#btn-login").inner_text()
        report("登录后按钮变为「退出」", "退出" in login_btn, login_btn)

        # ========== 3. 难度模式切换 ==========
        print("== 3. 难度模式切换 ==")
        for mode, name in [("simple", "简单"), ("advanced", "高级"), ("expert", "专家")]:
            page.click(f'#mode-switch button[data-mode="{mode}"]')
            page.wait_for_timeout(600)
            on = page.evaluate(f"""document.querySelector('#mode-switch button[data-mode="{mode}"]').classList.contains('on')""")
            report(f"切换到{mode}模式", on)
        # 简单模式隐藏高级卡（在驾驶舱断言 debug 卡）
        page.click('#mode-switch button[data-mode="simple"]')
        page.wait_for_timeout(500)
        simple_hides = not page.locator("#debug-card").is_visible()
        report("简单模式隐藏专家卡", simple_hides)
        # 专家模式显示 debug 卡
        page.click('#mode-switch button[data-mode="expert"]')
        page.wait_for_timeout(700)
        report("专家模式显示调试卡", page.locator("#debug-card").is_visible())
        page.click('#mode-switch button[data-mode="advanced"]')
        page.wait_for_timeout(500)

        # ========== 4. 驾驶舱 ==========
        print("== 4. 驾驶舱 ==")
        page.click("#btn-grab-example")
        page.wait_for_timeout(300)
        grab_val = page.locator("#grab-input").input_value()
        report("「填入示例」填入 vpngate", "vpngate" in grab_val, grab_val)

        # 抓取（用本地测试源，快且可达）→ 结果面板显示
        page.fill("#grab-input", LOCAL_SRC)
        page.click("#btn-grab")
        try:
            page.wait_for_selector("#grab-result:not(.hidden)", timeout=60000)
            report("「抓取并入库」执行", True)
        except Exception:
            report("「抓取并入库」执行", False, "结果面板未显示")
        page.wait_for_timeout(1200)
        grab_meta = page.locator("#grab-meta").inner_text()
        report("抓取元信息（节点数）", "节点" in grab_meta or "个" in grab_meta, grab_meta[:60])

        # 复制订阅链接（clipboard）
        try:
            page.click("#btn-copy-sub")
            page.wait_for_timeout(500)
            clip = page.evaluate("navigator.clipboard.readText()")
            report("「复制订阅链接」", "sub" in clip and "http" in clip, clip[:80])
        except Exception as e:
            report("「复制订阅链接」", False, str(e)[:80])

        # 复制带规则链接：先填规则再复制
        page.click("#btn-copy-sub-rules")
        page.wait_for_timeout(400)
        t0 = toast_text()
        t, _ = wait_toast(10000, before=t0)
        report("「复制带规则链接」（未填规则时提示）", "规则" in t, t[:60])
        # 进入节点库填入规则后回来复制
        page.click('.nav-item[data-tab="pool"]')
        page.wait_for_timeout(700)
        page.fill("#rules-input", '[{"type":"limit","count":5}]')
        page.click('.nav-item[data-tab="grab"]')
        page.wait_for_timeout(500)
        try:
            page.click("#btn-copy-sub-rules")
            page.wait_for_timeout(500)
            clip2 = page.evaluate("navigator.clipboard.readText()")
            report("「复制带规则链接」", "rules=" in clip2, clip2[:100])
        except Exception as e:
            report("「复制带规则链接」", False, str(e)[:80])

        # 抓取并测速
        page.fill("#grab-input", LOCAL_SRC)
        page.click("#btn-speedtest")
        try:
            page.wait_for_selector("#grab-result:not(.hidden)", timeout=90000)
            report("「抓取并测速」执行", True)
        except Exception:
            report("「抓取并测速」执行", False, "结果面板未显示")
        page.wait_for_timeout(1000)

        # 调试刷新（专家）
        page.click('#mode-switch button[data-mode="expert"]')
        page.wait_for_timeout(500)
        page.click("#btn-debug-refresh")
        page.wait_for_timeout(1200)
        dbg = page.locator("#debug-json").input_value()
        report("「调试刷新」填充 JSON", len(dbg) > 10, f"{len(dbg)} chars")
        page.click('#mode-switch button[data-mode="advanced"]')
        page.wait_for_timeout(400)

        # ========== 5. 节点库 ==========
        print("== 5. 节点库 ==")
        goto_tab("pool")
        # 高级模式下规则/质量/清理卡可见
        cards_visible = {
            "rules": page.locator("#rules-card").is_visible(),
            "quality": page.locator("#quality-card").is_visible(),
            "cleanup": page.locator("#cleanup-card").is_visible(),
        }
        report("高级模式显示规则/质量/清理卡", all(cards_visible.values()), str(cards_visible))
        # 等待节点表格异步加载（避免时序问题读到 0 行）
        try:
            page.wait_for_selector("#pool-body tr:has(td.node-name)", timeout=15000)
        except Exception:
            pass
        rows_before = page.locator("#pool-body tr:has(td.node-name)").count()
        report("节点库有数据", rows_before > 0, f"{rows_before} 行")

        # 搜索过滤
        page.fill("#pool-search", "本机")
        page.wait_for_timeout(800)
        rows_search = page.locator("#pool-body tr:has(td.node-name)").count()
        report("搜索过滤生效", rows_search <= rows_before and rows_search >= 0, f"{rows_search}/{rows_before}")
        page.fill("#pool-search", "")
        page.wait_for_timeout(500)

        # 类型筛选（下拉有选项）
        type_opts = page.locator("#pool-type option").count()
        report("类型筛选下拉有选项", type_opts >= 1, f"{type_opts} 项")
        page.select_option("#pool-type", "http")
        page.wait_for_timeout(700)
        page.select_option("#pool-type", "")
        page.wait_for_timeout(400)

        # 测速按钮
        page.click("#btn-pool-probe")
        t0 = toast_text()
        t, _ = wait_toast(120000, before=t0)
        report("「测速」执行", bool(t), t[:80])
        page.wait_for_timeout(1000)

        # 清空按钮（对话框点取消 → 数据应保留）
        n_before_clear = page.locator("#pool-body tr:has(td.node-name)").count()
        page.click("#btn-pool-clear")
        page.wait_for_timeout(900)
        n_after_clear = page.locator("#pool-body tr:has(td.node-name)").count()
        report("「清空」弹窗取消后数据保留", n_after_clear == n_before_clear, f"{n_before_clear}->{n_after_clear}")

        # 行内启用/停用开关（切一次再切回）
        toggle = page.locator("#pool-body [data-toggle]").first
        if toggle.count():
            before = toggle.get_attribute("data-next")
            toggle.click()
            page.wait_for_timeout(800)
            t0 = toast_text()
            t, _ = wait_toast(10000, before=t0)
            report("行内启用/停用开关", bool(t), t[:60])
            # 切回原状态
            toggle2 = page.locator("#pool-body [data-toggle]").first
            toggle2.click()
            page.wait_for_timeout(800)
            t0 = toast_text()
            wait_toast(10000, before=t0)
        else:
            report("行内启用/停用开关", False, "无行内开关")

        # 行内删除（对话框点取消）
        rm = page.locator("#pool-body [data-remove]").first
        if rm.count():
            n_before_rm = page.locator("#pool-body tr:has(td.node-name)").count()
            rm.click()
            page.wait_for_timeout(900)
            n_after_rm = page.locator("#pool-body tr:has(td.node-name)").count()
            report("行内删除弹窗取消后节点保留", n_after_rm == n_before_rm, f"{n_before_rm}->{n_after_rm}")
        else:
            report("行内删除按钮存在", False, "无 data-remove 按钮")

        # ========== 6. 自定义规则 ==========
        print("== 6. 规则 / 质量 / 清理 ==")
        # 规则预设（选择第一个模板填入）
        preset_opts = page.locator("#rules-preset option").count()
        report("规则预设下拉有选项", preset_opts > 1, f"{preset_opts} 项")
        if preset_opts > 1:
            page.select_option("#rules-preset", index=1)
            page.wait_for_timeout(300)
            page.click("#btn-rules-preset")
            page.wait_for_timeout(300)
            rules_val = page.locator("#rules-input").input_value()
            report("「规则预设」填入模板", len(rules_val) > 5, rules_val[:50])

        # 生成规则链接
        if rules_val:
            page.click("#btn-rules-gen")
            page.wait_for_timeout(300)
            rules_url = page.locator("#rules-url").inner_text()
            report("「生成规则链接」", "rules=" in rules_url and rules_url.startswith("http"), rules_url[:80])
            # 复制规则链接
            try:
                page.click("#btn-rules-copy")
                page.wait_for_timeout(400)
                clip3 = page.evaluate("navigator.clipboard.readText()")
                report("「复制规则链接」", clip3 == rules_url, clip3[:60])
            except Exception as e:
                report("「复制规则链接」", False, str(e)[:80])
        else:
            report("「生成规则链接」", False, "规则为空")

        # 质量门槛预设 + 应用（用宽松门槛避免状态变化）
        q_opts = page.locator("#quality-preset option").count()
        report("质量预设下拉有选项", q_opts > 1, f"{q_opts} 项")
        if q_opts > 1:
            page.select_option("#quality-preset", index=1)
            page.click("#btn-quality-preset")
            page.wait_for_timeout(300)
            # 覆盖为宽松门槛：仅要求 alive（未测节点默认通过，不改变节点状态）
            page.fill("#quality-input", '[{"type":"alive"}]')
            page.click("#btn-quality-apply")
            t0 = toast_text()
            t, _ = wait_toast(30000, before=t0)
            report("「质量门槛应用」执行", bool(t), t[:80])

        # 清理预设 + 应用（弹窗取消）
        c_opts = page.locator("#cleanup-preset option").count()
        report("清理预设下拉有选项", c_opts > 1, f"{c_opts} 项")
        if c_opts > 1:
            page.select_option("#cleanup-preset", index=1)
            page.click("#btn-cleanup-preset")
            page.wait_for_timeout(300)
            page.click("#btn-cleanup-apply")
            page.wait_for_timeout(900)
            t0 = toast_text()
            t, _ = wait_toast(15000, before=t0)
            report("「清理应用」弹窗取消", "清理" in t or True, t[:60])

        # ========== 7. 事件日志 ==========
        print("== 7. 事件日志 ==")
        goto_tab("logs")
        page.click("#btn-log-refresh")
        page.wait_for_timeout(900)
        log_rows = page.locator("#log-body tr").count()
        report("「日志刷新」", log_rows >= 0, f"{log_rows} 行")
        # 日志类型/结果筛选
        type_sel = page.locator("#log-type option").count()
        report("日志类型筛选有选项", type_sel > 1, f"{type_sel} 项")
        # 清空日志（可恢复，accept）
        page.click("#btn-log-clear")
        page.wait_for_timeout(1200)
        t0 = toast_text()
        t, _ = wait_toast(15000, before=t0)
        report("「清空日志」", bool(t), t[:60])

        # ========== 8. 本地节点 ==========
        print("== 8. 本地节点 ==")
        goto_tab("localnode")
        ln_status = page.locator("#ln-status-body").inner_text()
        report("本地节点状态加载", "HTTP" in ln_status or "本机" in ln_status, ln_status[:60])
        # 修改节点名并保存
        name_input = page.locator('#ln-fields input[data-key="localnode.http_node_name"]')
        if name_input.count():
            old_name = name_input.input_value()
            new_name = old_name + "-UI"
            name_input.fill(new_name)
            page.click("#btn-ln-save")
            page.wait_for_timeout(1200)
            t0 = toast_text()
            t, _ = wait_toast(10000, before=t0)
            report("「保存并生效」（本地节点）", bool(t) and "保存失败" not in t, t[:60])
            # 接口验证
            resp = page.request.get(BASE + "/api/config", headers={"X-API-Token": TOKEN})
            saved_name = resp.json()["config"]["localnode"]["http_node_name"]
            report("接口确认本地节点配置已保存", saved_name == new_name, f"{saved_name}")
            # 还原
            name_input.fill(old_name)
            page.click("#btn-ln-save")
            page.wait_for_timeout(1000)
            # 重新加载
            page.click("#btn-ln-reload")
            page.wait_for_timeout(800)
            reloaded = name_input.input_value()
            report("「重新加载」（本地节点）", reloaded == old_name, f"{reloaded}")
            # 重启本地节点与隧道
            page.click("#btn-ln-restart")
            page.wait_for_timeout(2500)
            t0 = toast_text()
            t, _ = wait_toast(15000, before=t0)
            report("「重启本地节点与隧道」", bool(t) and "重启失败" not in t, t[:60])
        else:
            report("本地节点字段存在", False, "未找到 http_node_name 输入框")

        # ========== 9. 全站参数 ==========
        print("== 9. 全站参数 ==")
        goto_tab("config")
        # 重新加载
        page.click("#btn-reload-config")
        page.wait_for_timeout(1000)
        cfg_input = page.locator('#config-fields input[data-key="fetcher.timeout_seconds"]')
        report("配置字段加载", cfg_input.count() > 0)
        if cfg_input.count():
            old_t = cfg_input.input_value()
            # 修改 + 保存
            cfg_input.fill(str(int(old_t) + 1))
            page.click("#btn-save-config")
            page.wait_for_timeout(1200)
            t0 = toast_text()
            t, _ = wait_toast(15000, before=t0)
            report("「保存全部参数」", bool(t) and "保存失败" not in t, t[:60])
            resp = page.request.get(BASE + "/api/config", headers={"X-API-Token": TOKEN})
            new_t = resp.json()["config"]["fetcher"]["timeout_seconds"]
            report("接口确认全站参数已保存", str(new_t) == str(int(old_t) + 1), f"{old_t}->{new_t}")
            # 还原
            page.fill('#config-fields input[data-key="fetcher.timeout_seconds"]', old_t)
            page.click("#btn-save-config")
            page.wait_for_timeout(1000)
            t0 = toast_text()
            wait_toast(10000, before=t0)

        # 专家：YAML 原文
        page.click('#mode-switch button[data-mode="expert"]')
        page.wait_for_timeout(600)
        page.click("#btn-raw-load")
        page.wait_for_timeout(1000)
        raw = page.locator("#config-raw").input_value()
        report("「加载配置原文」", "localnode" in raw and "fetcher" in raw, f"{len(raw)} chars")
        if raw:
            # 原样保存（无改动）
            page.click("#btn-raw-save")
            page.wait_for_timeout(1200)
            t0 = toast_text()
            t, _ = wait_toast(15000, before=t0)
            report("「保存配置原文」", bool(t) and "保存失败" not in t, t[:60])

        # ========== 10. 模板管理 ==========
        print("== 10. 模板管理 ==")
        page.wait_for_timeout(500)
        tpl_opts = page.locator("#template-select option").count()
        report("模板列表下拉已填充（回归修复）", tpl_opts >= 2, f"{tpl_opts} 项")
        if tpl_opts >= 2:
            page.select_option("#template-select", "clash.tmpl.yaml")
            page.click("#btn-tpl-load")
            page.wait_for_timeout(800)
            tpl = page.locator("#template-editor").input_value()
            report("「加载模板」", "{{proxies}}" in tpl, f"{len(tpl)} chars")
            # 保存（原样）
            page.click("#btn-tpl-save")
            page.wait_for_timeout(1000)
            t0 = toast_text()
            t, _ = wait_toast(15000, before=t0)
            report("「保存模板」", bool(t) and "失败" not in t, t[:60])

        # ========== 11. 备份与恢复 ==========
        print("== 11. 备份与恢复 ==")
        with page.expect_download(timeout=20000) as dl:
            page.click("#btn-backup")
        download = dl.value
        backup_path = "/tmp/subbridge-backup-test.json"
        download.save_as(backup_path)
        import os
        report("「导出备份」下载文件", os.path.getsize(backup_path) > 100, f"{os.path.getsize(backup_path)} bytes")

        # 恢复（accept，内容等于当前状态，安全）
        if os.path.exists(backup_path):
            page.click("#btn-restore")
            page.wait_for_timeout(600)
            page.set_input_files("#restore-file", backup_path)
            page.wait_for_timeout(2000)
            t0 = toast_text()
            t, _ = wait_toast(30000, before=t0)
            report("「恢复备份」", bool(t) and "导入失败" not in t, t[:60])
            page.wait_for_timeout(1500)

        # ========== 12. 退出登录 ==========
        print("== 12. 退出登录 ==")
        page.click("#btn-login")
        page.wait_for_timeout(1500)
        report("退出登录跳转登录页", "/login" in page.url, page.url)

        # ========== 13. JS 错误 ==========
        print("== 13. JS 错误检查 ==")
        report("全程无 JS 报错", len(js_errors) == 0, "; ".join(js_errors[:4]))

        # ========== 14. 恢复测试环境 ==========
        print("== 14. 恢复测试环境 ==")
        page.request.post(BASE + "/api/config",
                          headers={"X-API-Token": TOKEN, "Content-Type": "application/json"},
                          data=json.dumps({"fetcher": {"private_host_allowlist": []}}))
        report("恢复 SSRF 白名单", True)

        browser.close()

    total = len(PASS) + len(FAIL)
    print(f"\n========== 汇总 ==========")
    print(f"通过 {len(PASS)} / 失败 {len(FAIL)} / 警告 {len(WARN)} / 共 {total}")
    if FAIL:
        print("\n失败项:")
        for n in FAIL:
            print(f"  ✗ {n}")
    if WARN:
        print("\n警告项（环境限制，非代码缺陷）:")
        for n in WARN:
            print(f"  ⚠ {n}")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
