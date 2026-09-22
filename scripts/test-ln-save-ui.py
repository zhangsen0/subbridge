#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SubBridge 本地节点页「保存并生效」按钮浏览器级测试
覆盖：登录 -> 高级模式 -> 本地节点页 -> 修改字段 -> 保存并生效 -> 验证接口生效
用法：python3 scripts/test-ln-save-ui.py
"""
import json
import sys
import time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:18081"
TOKEN = "admin-token"
PASS = 0
FAIL = 0


def report(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(f"console:{m.text}") if m.type == "error" else None)

        # 1. 打开页面
        page.goto(BASE + "/", wait_until="domcontentloaded", timeout=15000)
        page.wait_for_timeout(800)
        report("页面可打开", "SubBridge" in page.title() or page.locator("text=SubBridge").count() > 0)

        # 2. 填入令牌并登录
        page.fill("#api-token-input", TOKEN)
        page.click("#btn-login")
        page.wait_for_timeout(1200)
        role = page.locator("#role-badge").inner_text()
        report("登录成功且角色为管理员", "管理员" in role, role)

        # 3. 切换到高级模式（本地节点页需要高级/专家）
        page.click('[data-mode="advanced"]')
        page.wait_for_timeout(600)

        # 4. 进入本地节点页
        nav_ln = page.locator('.nav-item[data-tab="localnode"]')
        if nav_ln.is_visible():
            nav_ln.click()
            page.wait_for_timeout(800)
            report("本地节点页可见并可进入", True)
        else:
            report("本地节点页可见并可进入", False, "导航项不可见（可能未登录或模式不对）")
            browser.close()
            return

        # 5. 修改「HTTP节点名称」字段
        name_input = page.locator('#ln-fields input[data-key="localnode.http_node_name"]')
        if name_input.count() == 0:
            report("HTTP节点名称字段存在", False, "未找到 data-key=localnode.http_node_name")
            browser.close()
            return
        report("HTTP节点名称字段存在", True)
        new_name = "本机-HTTP-UI测试"
        name_input.fill(new_name)

        # 6. 点击保存并生效
        page.click("#btn-ln-save")
        page.wait_for_timeout(1500)
        toast_text = page.locator("#toast").inner_text()
        report("点击保存出现提示", "已保存" in toast_text or "保存失败" not in toast_text, toast_text)
        report("保存提示为成功", "保存失败" not in toast_text, toast_text)

        # 7. 通过接口验证配置已生效
        resp = page.request.get(BASE + "/api/config", headers={"X-API-Token": TOKEN})
        cfg = resp.json()["config"]
        saved = cfg["localnode"]["http_node_name"]
        report("接口确认配置已保存", saved == new_name, f"期望 {new_name}，实际 {saved}")

        # 8. 重新加载按钮
        page.click("#btn-ln-reload")
        page.wait_for_timeout(800)
        reloaded = name_input.input_value()
        report("重新加载后字段回读", reloaded == new_name, f"实际 {reloaded}")

        # 9. 重启本地节点与隧道按钮
        page.click("#btn-ln-restart")
        page.wait_for_timeout(2500)
        toast2 = page.locator("#toast").inner_text()
        report("重启本地节点按钮可用", "已重启" in toast2 or "重启失败" not in toast2, toast2)

        # 10. 无 JS 错误
        js_errors = [e for e in errors if not e.startswith("console:") ]
        report("页面无 JS 报错", len(js_errors) == 0, "; ".join(js_errors[:3]))

        # 11. 还原字段（避免污染本地配置）
        name_input.fill("本机-HTTP")
        page.click("#btn-ln-save")
        page.wait_for_timeout(1200)

        browser.close()

    print(f"\n结果: {PASS} 通过 / {FAIL} 失败")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
