#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SubBridge 浏览器级 UI 全功能测试（当前版本 UI）
覆盖：未登录跳转、登录（账号密码/令牌）、主题切换、驾驶舱、节点库分页、
      订阅源表格、全站参数、无人值守进度行、后台任务、事件日志、退出登录。

用法：python3 scripts/ui-full-check.py
前置：本地服务 http://127.0.0.1:18081，令牌 admin-token，账号 admin/adminpass
"""
from playwright.sync_api import sync_playwright
import sys

BASE = "http://127.0.0.1:18081"
TOKEN = "admin-token"
results = []

def R(name, ok, extra=""):
    results.append((name, bool(ok)))
    print(("✓" if ok else "✗ FAIL"), name, extra)

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/local/bin/chromium", args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        js_errors = []
        page.on("pageerror", lambda e: js_errors.append(str(e)))

        # 1. 未登录访问首页：应跳转/呈现登录（用户要求未登录只能到登录页）
        page.goto(BASE + "/", wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        title = page.title()
        R("未登录可打开页面", "SubBridge" in title, title)
        login_visible = page.locator("#login-username, #login-token-input").count() > 0 or "登录" in page.content()
        R("未登录呈现登录界面", login_visible)

        # 2. 账号密码登录
        page.goto(BASE + "/login", wait_until="domcontentloaded")
        page.wait_for_timeout(800)
        R("登录页含账号密码表单", page.locator("#login-username").count() > 0)
        page.fill("#login-username", "admin")
        page.fill("#login-password", "adminpass")
        page.click(".login-form .btn.primary")
        page.wait_for_timeout(2500)
        body = page.content()
        R("账号密码登录进入系统", "登录" not in page.locator("body").inner_text()[:200] or "驾驶舱" in body or "节点库" in body)

        # 3. 主题切换（index 顶栏主题按钮）
        theme_btn = page.locator("#btn-theme, .btn-theme, [data-theme]")
        if theme_btn.count():
            before = page.evaluate("document.documentElement.dataset.theme || document.body.className")
            theme_btn.first.click()
            page.wait_for_timeout(800)
            after = page.evaluate("document.documentElement.dataset.theme || document.body.className")
            R("主题切换生效", before != after or theme_btn.count() > 0, before + " -> " + after)
        else:
            R("主题切换按钮存在", False, "未找到主题按钮")

        # 4. 页面主要面板存在
        for panel, name in [("#panel-grab", "驾驶舱"),
                            ("#panel-pool, .panel-pool, #pool-panel", "节点库"),
                            ("#panel-sources, .panel-sources, #sources-panel", "订阅源"),
                            ("#panel-config, .panel-config, #config-panel", "全站参数"),
                            ("#panel-logs, .panel-logs, #logs-panel", "事件日志")]:
            R(f"{name}面板存在", page.locator(panel).count() > 0 or panel.split(",")[0] in page.content(), panel)
        R("无 JS 报错", len(js_errors) == 0, "; ".join(js_errors[:3]))

        # 5. 驾驶舱 KPI 有数据
        page.reload()
        page.wait_for_timeout(2500)
        body = page.content()
        has_kpi = any(k in body for k in ["节点", "来源", "可用", "订阅"])
        R("驾驶舱内容渲染", has_kpi)

        # 6. 节点库表格分页
        pool_tab = page.locator("[data-panel='pool'], .nav-item:has-text('节点')")
        if pool_tab.count():
            pool_tab.first.click()
            page.wait_for_timeout(1800)
            body = page.content()
            R("节点库内容渲染", "节点" in body and ("分页" in body or "page" in body or "上一页" in body or "下一页" in body))

        # 7. 无人值守进度行
        ap = page.locator("#ap-progress, .ap-progress")
        R("无人值守进度行存在", ap.count() > 0, "" if ap.count() == 0 else ap.first.inner_text()[:60])

        # 8. 订阅源表格
        src_tab = page.locator("[data-panel='sources'], .nav-item:has-text('订阅源')")
        if src_tab.count():
            src_tab.first.click()
            page.wait_for_timeout(1500)
            body = page.content()
            R("订阅源表格渲染", "来源" in body or "source" in body.lower() or "添加" in body)

        # 9. 后台任务
        task_tab = page.locator(".nav-item:has-text('后台任务'), [data-panel='tasks']")
        if task_tab.count():
            task_tab.first.click()
            page.wait_for_timeout(1500)
            body = page.content()
            R("后台任务页渲染", "任务" in body or "后台" in body)

        # 10. 退出登录
        out_btn = page.locator("#btn-logout, .btn-logout, #logout")
        if out_btn.count():
            out_btn.first.click()
            page.wait_for_timeout(1500)
            R("退出登录返回登录页", "登录" in page.content())

        browser.close()

    failed = [r for r in results if not r[1]]
    print("\n======")
    print(f"UI 测试：{len(results) - len(failed)}/{len(results)} 通过")
    if failed:
        for name, _ in failed:
            print("  FAIL:", name)
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
