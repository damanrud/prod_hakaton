"""Run against a built AutoChoice instance (BASE_URL), on mobile and desktop."""
import os
from playwright.sync_api import expect, sync_playwright

with sync_playwright() as api:
    browser = api.chromium.launch(executable_path=os.getenv("CHROMIUM_PATH"), args=["--no-sandbox"])
    for width in (390, 1366):
        page = browser.new_page(viewport={"width": width, "height": 844}, reduced_motion="no-preference")
        errors = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.goto(os.getenv("BASE_URL", "http://127.0.0.1:8000"))
        expect(page.locator(".scenario-card")).to_have_count(3)
        page.evaluate("""() => {
            window.timings = {};
            document.addEventListener('click', e => {
                if (e.target.closest('[data-action=start]')) window.timings.start = performance.now();
                if (document.querySelector('#quiz-progress')?.value === 15)
                    window.timings.finish = performance.now();
            }, true);
            new MutationObserver(() => {
                for (const [screen, key] of [['quiz','start'],['results','finish']]) {
                    if (document.getElementById(screen) && window.timings[key] && !window.timings[screen])
                        window.timings[screen] = performance.now() - window.timings[key];
                }
            }).observe(document.body, {childList:true, subtree:true});
        }""")
        page.get_by_role("button", name="Начать подбор").first.click()
        expect(page.locator("#quiz")).to_be_visible()
        for i in range(15):
            if i in (2, 3, 10):
                page.locator(".option-card").first.click()
                page.get_by_role("button", name="Продолжить").click()
            else:
                page.get_by_role("button", name="Пропустить").click()
        expect(page.locator(".compare-toggle").first).to_be_visible()
        print(width, page.evaluate("window.timings"), flush=True)
        page.locator(".compare-toggle").nth(0).click()
        page.locator(".compare-toggle").nth(1).click()
        page.get_by_role("button", name="Сравнить 2 автомобиля").click()
        expect(page.get_by_role("dialog")).to_be_visible()
        page.keyboard.press("Escape")
        page.get_by_role("button", name="Изменить ответы").click()
        page.locator(".edit-question").first.click()
        page.get_by_role("button", name="Указать свою сумму").click()
        page.get_by_role("spinbutton").fill("1")
        page.get_by_role("button", name="Сохранить и пересчитать").click()
        expect(page.locator("#results-title")).to_have_text("Не нашли подходящих автомобилей")
        assert not errors, errors
        page.close()
    browser.close()
