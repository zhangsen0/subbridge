#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SubBridge 一键配置向导（快速开始）浏览器级测试
覆盖：/setup 页面加载 -> 登录校验 -> 场景选择 -> 填订阅 -> 开关 -> 确认应用 -> 完成页
用法：python3 scripts/test-wizard-ui.py
"""
import json
import sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:18081"
TOKEN = "admin-token"
PASS, FAIL = [], []


def report(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"  {detail}" if detail else ""))


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path="/usr/local/bin/chromium",
                                    args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = ctx.new_page()
        js_errors = []
        page.on("pageerror", lambda e: js_errors.append(str(e)))
        # 对话框统一接受（测试中 alert 提示直接确认）
        page.on("dialog", lambda d: d.accept())

        # 预置登录态（localStorage 令牌）
        page.goto(BASE + "/setup", wait_until="domcontentloaded", timeout=20000)
        page.evaluate("localStorage.setItem('subbridge-token', '" + TOKEN + "')")
        page.reload(wait_until="domcontentloaded", timeout=20000)
        page.wait_for_timeout(1500)

        # 1. 页面加载 + 场景列表
        report("向导页可打开", page.locator("text=三步配好你的订阅节点").count() > 0)
        scen_count = page.locator(".scen-card").count()
        report("场景卡片加载（≥20）", scen_count >= 20, f"{scen_count} 个")
        report("步骤条显示 4 步", page.locator(".step-dot").count() >= 4)

        # 2. 第一步：默认选中第一个场景
        first_sel = page.locator(".scen-card.sel").count()
        report("默认选中第一个场景", first_sel >= 1)

        # 3. 上一步按钮在第一步不可见
        report("第一步无「上一步」", page.locator("#wz-back").count() == 0)

        # 4. 默认选中可直接下一步（默认选中第一个场景是省心设计）
        page.click("#wz-next")
        page.wait_for_timeout(600)
        report("默认选中可进入第二步", page.locator("#f-main").count() > 0)

        # 5. 返回第一步选择「游戏加速」再前进
        page.click("#wz-back")
        page.wait_for_timeout(400)
        page.click('.scen-card[data-id="gaming"]')
        sel_ok = " on" not in ""  # 占位
        page.click("#wz-next")
        page.wait_for_timeout(600)
        report("选择场景后可进入第二步（填订阅）", page.locator("#f-main").count() > 0)

        # 6. 填写订阅源并下一步
        page.fill("#f-main", "https://proxy.520215.xyz/sub?token=d662b808e0a23961eb81ce8d40647f4d")
        page.click("#wz-next")
        page.wait_for_timeout(600)
        report("进入第三步（开关）", page.locator("#sw-ln").count() > 0)

        # 7. 开关默认开 + 可切换
        ln_on = " on" in page.locator("#sw-ln").get_attribute("class")
        report("本机节点默认开启", ln_on)
        page.click("#sw-ln")
        ln_off = " on" not in page.locator("#sw-ln").get_attribute("class")
        report("开关可切换", ln_off)
        page.click("#sw-ln")  # 恢复开启

        # 8. 下一步到确认页
        page.click("#wz-next")
        page.wait_for_timeout(600)
        report("进入第四步（确认）", page.locator(".wz-summary").count() > 0)
        summary = page.locator(".wz-summary").inner_text()
        report("摘要含场景与订阅信息", "游戏加速" in summary and "1 个" in summary, summary[:80])

        # 9. 上一步返回再前进
        page.click("#wz-back")
        page.wait_for_timeout(400)
        report("上一步返回第三步", page.locator("#sw-ln").count() > 0)
        page.click("#wz-next")
        page.wait_for_timeout(400)

        # 10. 完成配置
        page.click("#wz-next")
        page.wait_for_timeout(4000)
        done_text = page.locator(".done-box h2").inner_text() if page.locator(".done-box h2").count() else ""
        report("完成页显示", "配置完成" in done_text, done_text)
        link = page.locator(".done-link").inner_text() if page.locator(".done-link").count() else ""
        report("完成页给出订阅链接", link.startswith("/sub?token="), link[:50])

        # 11. 接口确认配置已生效
        resp = page.request.get(BASE + "/api/config", headers={"X-API-Token": TOKEN})
        cfg = resp.json()["config"]
        rules_ok = len(cfg["subscription"]["rules"]) > 0
        report("接口确认场景规则已写入", rules_ok, json.dumps(cfg["subscription"]["rules"], ensure_ascii=False)[:60])

        # 12. 返回驾驶舱按钮
        page.click('.done-box a[href="/"]')
        page.wait_for_url(BASE + "/**", timeout=15000)
        page.wait_for_timeout(1500)
        report("返回驾驶舱", "SubBridge" in (page.title() or "") or page.locator("text=SubBridge").count() > 0)

        # 13. 无 JS 错误
        report("向导全程无 JS 报错", len(js_errors) == 0, "; ".join(js_errors[:3]))

        browser.close()

    total = len(PASS) + len(FAIL)
    print(f"\n结果: {len(PASS)} 通过 / {len(FAIL)} 失败 / 共 {total}")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
