import asyncio
from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:18081"
results = []
def R(name, ok, extra=""):
    results.append((name, ok))
    print(("PASS" if ok else "FAIL"), name, extra)

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path="/usr/local/bin/chromium", args=["--no-sandbox"])
        page = await browser.new_page(viewport={"width":1440,"height":900})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        # 1. 未登录主页
        await page.goto(BASE, wait_until="networkidle")
        R("未登录：登录按钮", await page.locator("#btn-login").inner_text() == "登录")
        R("未登录：admin 导航隐藏", await page.locator("[data-tab=config]").is_hidden())

        # 2. 登录页
        await page.goto(BASE + "/login", wait_until="networkidle")
        R("登录页有密码框", await page.locator("input[type=password]").count() > 0)

        # 3. 模拟登录（localStorage token）
        await page.evaluate("localStorage.setItem('subbridge-token','admin-token'); localStorage.setItem('subbridge-theme','dark');")
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(2500)
        R("登录后：按钮=退出", await page.locator("#btn-login").inner_text() == "退出")
        R("登录后：徽标=管理员", "管理员" in await page.locator("#role-badge").inner_text())
        R("登录后：全站参数导航可见", await page.locator("[data-tab=config]").is_visible())
        kpi = (await page.locator("#kpi-pool-total").inner_text()).strip()
        R("驾驶舱 KPI 有数字", kpi not in ("", "-"), "kpi=" + kpi)
        log_rows = await page.locator("#recent-logs .ln-item, #recent-logs tr, #recent-logs div").count()
        R("最近动态有内容", log_rows > 1, "rows=" + str(log_rows))

        # 4. 主题切换
        await page.locator("#btn-theme").click()
        theme = await page.evaluate("document.documentElement.dataset.theme")
        R("主题→浅色", theme == "light", theme)
        await page.locator("#btn-theme").click()
        R("主题→深色", await page.evaluate("document.documentElement.dataset.theme") == "dark")

        # 5. 难度切换
        await page.locator("#mode-switch button[data-mode=expert]").click()
        R("专家模式显示调试卡", await page.locator("#debug-card").is_visible())
        await page.locator("#mode-switch button[data-mode=simple]").click()
        R("简单模式隐藏调试卡", await page.locator("#debug-card").is_hidden())
        await page.locator("#mode-switch button[data-mode=advanced]").click()

        # 6. 节点库
        await page.locator("[data-tab=pool]").click()
        await page.wait_for_timeout(800)
        rows = await page.locator("#pool-body tr").count()
        R("节点库有数据", rows > 0, "rows=" + str(rows))
        # 搜索
        await page.locator("#pool-search").fill("decathlon")
        await page.wait_for_timeout(500)
        filtered = await page.locator("#pool-body tr:visible").count()
        R("节点搜索生效", filtered < rows and filtered >= 0, "filtered=" + str(filtered))
        await page.locator("#pool-search").fill("")

        # 7. 抓取流程
        await page.locator("[data-tab=grab]").click()
        await page.locator("#grab-input").fill("http://127.0.0.1:18099/sub.txt")
        await page.locator("#btn-grab").click()
        await page.wait_for_timeout(2000)
        grab_rows = await page.locator("#grab-nodes tr").count()
        R("抓取成功显示节点", grab_rows > 0, "rows=" + str(grab_rows))

        # 8. 事件日志
        await page.locator("[data-tab=logs]").click()
        await page.wait_for_timeout(800)
        log_rows = await page.locator("#log-body tr").count()
        R("事件日志有记录", log_rows > 0, "rows=" + str(log_rows))

        # 9. 全站参数 + 搜索
        await page.locator("[data-tab=config]").click()
        await page.wait_for_timeout(1000)
        fields = await page.locator("#config-fields .field").count()
        R("全站参数表字段", fields > 0, "fields=" + str(fields))
        await page.locator("#config-search").fill("timeout")
        await page.wait_for_timeout(300)
        vis = await page.locator("#config-fields .field:visible").count()
        R("参数搜索", 0 < vis < fields, "vis=" + str(vis))
        await page.locator("#config-search").fill("")

        # 10. 无 JS 错误
        real_errors = [e for e in errors if "401" not in e and "404" not in e and "ERR_" not in e]
        R("无 JS 错误", len(real_errors) == 0, str(real_errors[:3]))

        await page.locator("[data-tab=grab]").click()
        await page.wait_for_timeout(600)
        await page.screenshot(path="/tmp/shot-final.png")
        print("截图: /tmp/shot-final.png")
        await browser.close()

asyncio.run(main())
print("\n=== 汇总:", sum(1 for _,ok in results if ok), "/", len(results), "===")
