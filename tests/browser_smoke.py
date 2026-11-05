"""Offline Chromium UI tests. Uses a fresh context and fake GM APIs only.

Run from the project: python -I -X utf8 tests/browser_smoke.py
No real API credentials, installed extensions, saved browser profiles or PT sites.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "release-signal.user.js").read_text(encoding="utf-8")
FIXTURE = (ROOT / "tests/fixtures/douban.html").read_text(encoding="utf-8")
CONFIG_KEY = "releaseSignal.config.v1"
CACHE_KEY = "releaseSignal.cache.v1"
SEASONS_KEY = "releaseSignal.seasons.v1"
TOKEN = {"version": 1, "mode": "token", "value": "fixture-token-not-real"}
FIXED_TIME = datetime(2026, 11, 5, 4, 0, tzinfo=timezone.utc)


def finding(**updates):
    data = {"movie_results": [{"id": 42, "title": "示例电影"}], "tv_results": [], "tv_episode_results": [], "tv_season_results": [], "person_results": []}
    data.update(updates)
    return data


def releases(*records):
    return {"id": 42, "results": [{"iso_3166_1": "US", "release_dates": list(records)}]}


def record(kind, date, note=""):
    return {"type": kind, "release_date": date, "note": note}


def tv_finding():
    return finding(movie_results=[], tv_results=[{"id": 55, "name": "示例剧集"}])


def tv_series():
    return {"id": 55, "name": "示例剧集", "seasons": [
        {"id": 501, "season_number": 1, "episode_count": 2, "air_date": "2026-11-01"},
        {"id": 502, "season_number": 2, "episode_count": 2, "air_date": "2026-11-01"},
    ]}


def tv_episode(number, date, episode_type="standard", season_number=2):
    return {"id": season_number * 1000 + number, "show_id": 55, "season_number": season_number,
            "episode_number": number, "air_date": date, "episode_type": episode_type, "name": "示例单集"}


def tv_season(*episodes, season_number=2):
    return {"id": 500 + season_number, "season_number": season_number, "air_date": "2026-11-01", "episodes": list(episodes)}


def response(body=None, **options):
    return {"body": body, **options}


def cached_movie():
    return {"version": 1, "entries": {"tt0111161": {"fetchedAt": int(FIXED_TIME.timestamp() * 1000), "result": {"work": {"kind": "movie", "id": 42, "title": "缓存电影"}, "releases": releases(record(4, "2020-01-01"))}}}}


MOCK = r"""
(() => {
  const options = __OPTIONS__;
  const clone = value => JSON.parse(JSON.stringify(value));
  const m = window.__rsMock = {
    storage: options.storage, plans: options.plans, requests: [], menus: {},
    aborts: 0, setError: false, getError: false, listeners: {}, suppressListeners: false,
  };
  window.GM_info = options.info ?? {scriptHandler: 'Tampermonkey', sandboxMode: 'dom'};
  // A fake manager bus, only for test values; production uses GM storage events.
  const channel = options.broadcast === false ? null : new BroadcastChannel('release-signal-test-manager');
  m.remoteChange = ({key, value, deleted}) => {
    const oldValue = m.storage[key];
    if (deleted) delete m.storage[key]; else m.storage[key] = clone(value);
    if (!m.suppressListeners) for (const listener of Object.values(m.listeners)) {
      if (listener.key === key) listener.callback(key, oldValue, value, true);
    }
  };
  if (channel) channel.onmessage = event => m.remoteChange(event.data);
  window.GM_addValueChangeListener = (key, callback) => {
    const id = String(Object.keys(m.listeners).length + 1); m.listeners[id] = {key, callback}; return id;
  };
  window.GM_removeValueChangeListener = id => { delete m.listeners[id]; };
  window.GM_getValue = (key, fallback) => {
    if (m.getError) throw Error('mock storage failure');
    return Object.hasOwn(m.storage, key) ? clone(m.storage[key]) : fallback;
  };
  window.GM_setValue = (key, value) => {
    if (m.setError) throw Error('mock storage failure');
    m.storage[key] = clone(value);
    channel?.postMessage({key, value: clone(value)});
  };
  window.GM_deleteValue = key => { delete m.storage[key]; channel?.postMessage({key, deleted: true}); };
  window.GM_registerMenuCommand = (label, action) => { m.menus[label] = action; };
  window.GM_addStyle = css => {
    const style = document.createElement('style'); style.textContent = css;
    document.head.append(style);
  };
  window.GM_xmlhttpRequest = details => {
    m.requests.push({url: details.url, headers: details.headers, anonymous: details.anonymous});
    const plan = m.plans.shift();
    if (!plan) throw Error('unplanned mock request');
    let timer;
    if (!plan.hang) timer = setTimeout(() => {
      if (plan.networkError) details.onerror({});
      else details.onload({status: plan.status ?? 200, responseText: plan.raw ?? JSON.stringify(plan.body), finalUrl: plan.finalUrl ?? details.url});
    }, plan.delay ?? 0);
    return {abort() {
      m.aborts++;
      if (!plan.ignoreAbort) { clearTimeout(timer); details.onabort({}); }
    }};
  };
})();
"""


class BrowserSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = sync_playwright().start()
        cls.browser = cls.runtime.chromium.launch(headless=True)
        cls.artifacts = Path(tempfile.mkdtemp(prefix="release-signal-browser-"))
        print(f"Chromium: {cls.browser.version}")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.runtime.stop()
        print(f"Screenshots: {cls.artifacts}")

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1050, "height": 900}, timezone_id="Asia/Hong_Kong")
        self.page = self.context.new_page()
        self.errors = []
        self.network = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

        def route_handler(route):
            self.network.append(route.request.url)
            if route.request.is_navigation_request() and route.request.url.startswith("https://movie.douban.com/"):
                route.fulfill(status=200, content_type="text/html; charset=utf-8", body=FIXTURE)
            else:
                route.abort()

        self.context.route("**/*", route_handler)

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], "Unexpected page errors")
        self.assertTrue(all(url.startswith("https://movie.douban.com/") for url in self.network), self.network)

    def start(self, plans=(), *, config=TOKEN, path="/subject/1292052/", html_change=None, cache=None, selections=None, clock=False, info=None):
        storage = {}
        if config is not None:
            storage[CONFIG_KEY] = config
        if cache is not None:
            storage[CACHE_KEY] = cache
        if selections is not None:
            storage[SEASONS_KEY] = selections
        options = {"storage": storage, "plans": list(plans)}
        if info is not None:
            options["info"] = info
        self.page.add_init_script(MOCK.replace("__OPTIONS__", json.dumps(options, ensure_ascii=False)))
        self.page.goto("https://movie.douban.com" + path)
        if clock:
            self.page.clock.install(time=FIXED_TIME)
        else:
            self.page.clock.set_fixed_time(FIXED_TIME)
        if html_change:
            self.page.evaluate(html_change)
        self.page.evaluate(SCRIPT)
        return self.page.locator("#release-signal-panel")

    def requests(self):
        return self.page.evaluate("window.__rsMock.requests")

    def expand(self, panel):
        if panel.locator(".rs-disclosure").get_attribute("open") is None:
            panel.locator(".rs-summary").click()

    def open_settings(self, panel):
        self.expand(panel)
        panel.get_by_role("button", name="设置 TMDB", exact=True).click()

    def open_records(self, panel):
        self.expand(panel)
        if panel.locator(".rs-records").get_attribute("open") is None:
            panel.locator(".rs-records > summary").click()

    def submit_credential(self, panel, value):
        def on_prompt(dialog):
            self.assertEqual(dialog.type, 'prompt')
            self.assertEqual(dialog.default_value, '')
            if value is None:
                dialog.dismiss()
            else:
                dialog.accept(value)
        panel.page.once('dialog', on_prompt)
        replacement = panel.get_by_role('button', name='替换凭据', exact=True)
        (replacement if replacement.is_visible() else panel.get_by_role('button', name='保存并查询', exact=True)).click()

    def another_tab(self, plans=(), **options):
        first = self.page
        second = self.context.new_page()
        second.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page = second
        try:
            panel = self.start(plans, **options)
        finally:
            self.page = first
        return second, panel

    def test_01_render_details_and_local_logo(self):
        dates = releases(record(4, "2026-11-04T00:00:00.000Z", "数字发行记录"), record(5, "2026-11-20T00:00:00.000Z", "实体计划日期"))
        dates["results"].append({"iso_3166_1": "CA", "release_dates": [record(4, "2026-11-04", "数字发行记录")]})
        panel = self.start([response(finding()), response(dates)])
        expect(panel.locator(".rs-status")).to_have_text("已有发行记录")
        expect(panel.locator('[data-kind="digital"]')).to_have_text("已发行 · 2026-11-04")
        expect(panel.locator('[data-kind="physical"]')).to_have_text("预计 · 2026-11-20")
        self.assertTrue(self.page.evaluate("document.querySelector('#info').nextElementSibling.id === 'release-signal-panel'"))
        expect(panel.locator(".rs-summary-text")).to_have_text("已有发行记录")
        expect(panel.locator(".rs-content")).to_be_hidden()
        expect(panel.get_by_role("button", name="设置 TMDB", exact=True)).to_be_hidden()
        self.assertLessEqual(panel.bounding_box()["height"], 28)
        self.assertEqual(panel.locator(".rs-dot").evaluate("el => getComputedStyle(el).backgroundColor"), "rgb(23, 102, 58)")
        self.page.screenshot(path=str(self.artifacts / "page-collapsed.png"))
        panel.screenshot(path=str(self.artifacts / "panel-collapsed.png"))
        panel.locator(".rs-summary").click()
        expect(panel.locator(".rs-content")).to_be_visible()
        expect(panel.locator("tbody")).to_be_hidden()
        panel.screenshot(path=str(self.artifacts / "panel-summary.png"))
        self.open_records(panel)
        expect(panel.locator("tbody tr")).to_have_count(2)
        expect(panel.locator("tbody")).to_contain_text("加拿大 (CA)、美国 (US)")
        self.assertEqual(panel.locator("tbody a").first.get_attribute("href"), "https://www.themoviedb.org/movie/42/releases")
        panel.screenshot(path=str(self.artifacts / "panel-desktop.png"))
        panel.get_by_role("button", name="关于", exact=True).click()
        expect(panel.get_by_role("dialog")).to_contain_text("not endorsed or certified by TMDB")
        self.page.wait_for_function("document.querySelector('.rs-logo').complete && document.querySelector('.rs-logo').naturalWidth > 0")
        panel.get_by_role("dialog").screenshot(path=str(self.artifacts / "about.png"))
        panel.get_by_role("button", name="关闭", exact=True).click()
        expect(panel.get_by_role("dialog")).to_have_count(0)
        panel.locator(".rs-summary").focus()
        self.page.keyboard.press("Enter")
        expect(panel.locator(".rs-content")).to_be_hidden()
        self.page.keyboard.press("Space")
        expect(panel.locator(".rs-content")).to_be_visible()
        self.assertEqual(len(self.requests()), 2)

        # Legacy credentials without an address follow the current default.
        self.assertTrue(all(item['url'].startswith('https://api.tmdb.org/3/') for item in self.requests()))

    def test_02_configure_replace_delete_without_refilling_secret(self):
        panel = self.start(config=None)
        expect(panel.locator(".rs-status")).to_contain_text("请先设置")
        self.assertEqual(self.requests(), [])
        self.page.evaluate("window.__rsMock.menus['发行信号：设置 TMDB']()")
        dialog = panel.get_by_role("dialog")
        expect(dialog).to_be_visible()
        expect(panel.locator(".rs-content")).to_be_hidden()
        expect(dialog.locator('input')).to_have_count(0)
        self.submit_credential(panel, '')
        expect(dialog.get_by_role("alert")).to_contain_text("填写有效凭据")
        self.page.evaluate("window.__rsMock.plans.push({body: {success: true, status_code: 1}}, {body: {movie_results: [], tv_results: []}})")
        self.submit_credential(panel, 'fixture-token-not-real')
        expect(dialog).to_have_count(0)
        expect(panel.locator(".rs-status")).to_contain_text("未匹配")
        expect(panel.locator(".rs-config-notice")).to_contain_text("凭据验证成功")
        self.assertTrue(self.requests()[0]["url"].endswith("/authentication"))
        self.assertEqual(self.page.evaluate(f"window.__rsMock.storage[{json.dumps(CONFIG_KEY)}].value"), "fixture-token-not-real")
        self.open_settings(panel)
        expect(panel.get_by_role('dialog').locator('input')).to_have_count(0)
        panel.get_by_label("凭据类型").select_option("key")
        self.page.evaluate("window.__rsMock.plans.push({body: {success: true}}, {body: {movie_results: [], tv_results: []}})")
        self.submit_credential(panel, 'a' * 32)
        expect(panel.get_by_role("dialog")).to_have_count(0)
        expect(panel.locator(".rs-status")).to_contain_text("未匹配")
        self.assertEqual(len(self.requests()), 4)
        self.assertEqual(self.page.evaluate(f"window.__rsMock.storage[{json.dumps(CONFIG_KEY)}].mode"), "key")
        self.open_settings(panel)
        panel.get_by_role("button", name="删除凭据").click()
        expect(panel.locator(".rs-status")).to_contain_text("请先设置")
        self.assertFalse(self.page.evaluate(f"Object.hasOwn(window.__rsMock.storage, {json.dumps(CONFIG_KEY)})"))
        self.assertEqual(self.page.locator('input[type="password"]').count(), 0)

    def test_03_manual_refresh_keeps_old_data_on_error_and_merges_clicks(self):
        panel = self.start([response(finding()), response(releases(record(4, "2026-11-04")))])
        expect(panel.locator(".rs-status")).to_contain_text("已有发行记录")
        self.page.evaluate("window.__rsMock.plans.push({status: 429, body: {}, delay: 150})")
        self.expand(panel)
        panel.get_by_role("button", name="刷新", exact=True).click()
        expect(panel.get_by_role("button", name="刷新", exact=True)).to_be_disabled()
        self.page.evaluate("window.__rsMock.menus['发行信号：刷新当前作品'](); window.__rsMock.menus['发行信号：刷新当前作品']()")
        expect(panel.locator(".rs-status")).to_contain_text("请求过于频繁")
        expect(panel.locator(".rs-status")).to_contain_text("下方保留旧数据")
        expect(panel.locator(".rs-footnote").first).to_contain_text("旧数据")
        expect(panel.locator('[data-kind="digital"]')).to_contain_text("2026-11-04")
        self.assertEqual(len(self.requests()), 3)

    def test_04_missing_imdb_and_missing_info_do_not_query(self):
        panel = self.start(html_change="document.querySelector('#info').textContent = '导演：测试'")
        expect(panel.locator(".rs-status")).to_contain_text("未找到 IMDb")
        self.assertEqual(self.requests(), [])
        self.page.reload()
        self.page.evaluate("document.querySelector('#info').remove()")
        self.page.evaluate(SCRIPT)
        expect(self.page.locator(".rs-status")).to_contain_text("未找到影片资料区域")
        self.assertEqual(self.requests(), [])

    def test_05_non_detail_paths_and_frames_do_not_run(self):
        self.start(path="/subject/1292052/reviews")
        expect(self.page.locator("#release-signal-panel")).to_have_count(0)
        self.assertEqual(self.requests(), [])
        self.page.evaluate("document.body.append(document.createElement('iframe'))")
        frame = self.page.frames[1]
        frame.evaluate("window.GM_getValue = () => null")
        frame.evaluate(SCRIPT)
        self.assertEqual(frame.locator("#release-signal-panel").count(), 0)

    def test_06_untrusted_text_is_not_html_and_invalid_dates_are_disclosed(self):
        payload = '<img src="x" onerror="window.__xss = true">'
        panel = self.start([response(finding(movie_results=[{"id": 42, "title": payload}])), response(releases(record(4, "2026-11-04", payload), record(5, "2026-02-30")))])
        expect(panel.locator(".rs-status")).to_contain_text("已有发行记录")
        self.open_records(panel)
        expect(panel.locator("tbody")).to_contain_text(payload)
        expect(panel.locator(".rs-records")).to_contain_text("记录不完整")
        self.assertEqual(panel.locator("details img").count(), 0)
        self.assertIsNone(self.page.evaluate("window.__xss"))
        self.assertEqual(self.page.locator('img[src="x"]').count(), 0)

    def test_07_tv_type_never_requests_movie_release_dates(self):
        panel = self.start([response(tv_finding()), response(tv_series())])
        expect(panel.locator(".rs-status")).to_contain_text("请选择")
        self.assertEqual(len(self.requests()), 2)
        expect(panel.locator(".rs-summary-text")).to_have_text("请确认季数")
        self.expand(panel)
        expect(panel.locator('#release-signal-season')).to_be_visible()
        self.assertFalse(any('/movie/' in item['url'] for item in self.requests()))

    def test_08_api_key_and_network_error_have_no_false_no_record_status(self):
        panel = self.start([response({}, status=401)], config={"version": 1, "mode": "key", "value": "a" * 32})
        expect(panel.locator(".rs-status")).to_contain_text("认证失败")
        expect(panel.locator(".rs-summary-text")).to_have_text("认证失败")
        self.assertEqual(panel.locator(".rs-dot").evaluate("el => getComputedStyle(el).backgroundColor"), "rgb(165, 49, 38)")
        self.assertIn("api_key=" + "a" * 32, self.requests()[0]["url"])
        self.assertNotIn("Authorization", self.requests()[0]["headers"])
        expect(panel.locator('[data-kind="digital"]')).to_have_text("无法判断")
        self.assertNotIn("a" * 32, panel.inner_text())
        self.page.evaluate("window.__rsMock.plans.push({networkError: true})")
        self.expand(panel)
        panel.get_by_role("button", name="刷新", exact=True).click()
        expect(panel.locator(".rs-status")).to_contain_text("无法连接 TMDB")
        self.assertIsNone(self.page.evaluate(f"window.__rsMock.storage[{json.dumps(CACHE_KEY)}] ?? null"))

    def test_09_cached_data_recomputes_at_midnight_and_on_visibility_without_requests(self):
        fetched = int(datetime(2026, 11, 5, 15, 50, tzinfo=timezone.utc).timestamp() * 1000)
        cache = {"version": 1, "entries": {"tt0111161": {"fetchedAt": fetched, "result": {"work": {"kind": "movie", "id": 42, "title": "缓存电影"}, "releases": releases(record(4, "2026-11-06T00:00:00.000Z"))}}}}
        # Start before the cached timestamp, then install the intended local 23:59 clock
        # before evaluating the userscript so the cache is correctly considered fresh.
        self.page.add_init_script(MOCK.replace("__OPTIONS__", json.dumps({"storage": {CONFIG_KEY: TOKEN, CACHE_KEY: cache}, "plans": []}, ensure_ascii=False)))
        self.page.goto("https://movie.douban.com/subject/1292052/")
        self.page.clock.install(time=datetime(2026, 11, 5, 15, 59, tzinfo=timezone.utc))
        self.page.evaluate(SCRIPT)
        panel = self.page.locator("#release-signal-panel")
        expect(panel.locator(".rs-status")).to_contain_text("等待")
        expect(panel.locator(".rs-summary-text")).to_have_text("等待发行 · 2026-11-06")
        self.assertEqual(panel.locator(".rs-dot").evaluate("el => getComputedStyle(el).backgroundColor"), "rgb(128, 91, 11)")
        self.page.clock.fast_forward(62000)
        expect(panel.locator(".rs-status")).to_contain_text("已有发行记录")
        expect(panel.locator(".rs-summary-text")).to_have_text("已有发行记录")
        expect(panel.locator(".rs-content")).to_be_hidden()
        self.assertEqual(self.requests(), [])
        self.page.clock.set_fixed_time(datetime(2026, 11, 7, 4, 0, tzinfo=timezone.utc))
        self.page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        expect(panel.locator(".rs-footnote").first).to_contain_text("缓存已过期")
        self.assertEqual(self.requests(), [])

    def test_10_deleting_credentials_cancels_and_ignores_late_result(self):
        panel = self.start([response(finding(), delay=500, ignoreAbort=True)])
        expect(panel.locator(".rs-status")).to_contain_text("正在查询")
        self.open_settings(panel)
        panel.get_by_role("button", name="删除凭据").click()
        self.page.wait_for_timeout(650)
        expect(panel.locator(".rs-status")).to_contain_text("请先设置")
        self.assertEqual(self.page.evaluate("window.__rsMock.aborts"), 1)
        self.assertEqual(len(self.requests()), 1)
        self.assertIsNone(self.page.evaluate(f"window.__rsMock.storage[{json.dumps(CACHE_KEY)}] ?? null"))

    def test_11_expired_cache_and_malformed_response_keep_old_result(self):
        cache = {"version": 1, "entries": {"tt0111161": {"fetchedAt": 1, "result": {"work": {"kind": "movie", "id": 42, "title": "旧电影"}, "releases": releases(record(5, "2020-01-01"))}}}}
        panel = self.start([response(raw="<html>not json</html>")], cache=cache)
        expect(panel.locator(".rs-status")).to_contain_text("响应格式异常")
        expect(panel.locator('[data-kind="physical"]')).to_contain_text("2020-01-01")
        expect(panel.locator(".rs-footnote").first).to_contain_text("缓存已过期")

    def test_12_no_records_and_repeat_injection_are_quiet(self):
        panel = self.start([response(finding()), response(releases())])
        expect(panel.locator(".rs-status")).to_have_text("暂未查到发行记录")
        self.page.evaluate(SCRIPT)
        expect(panel).to_have_count(1)
        self.assertEqual(len(self.requests()), 2)
        self.assertTrue(all(call["anonymous"] for call in self.requests()))
        self.page.set_viewport_size({"width": 420, "height": 900})
        expect(panel.locator(".rs-content")).to_be_hidden()
        self.assertLessEqual(panel.bounding_box()["height"], 28)
        panel.screenshot(path=str(self.artifacts / "panel-narrow.png"))
        self.expand(panel)
        panel.screenshot(path=str(self.artifacts / "panel-narrow-expanded.png"))

    def test_13_storage_failure_keeps_settings_open_and_preserves_value(self):
        panel = self.start([response({"success": True})], config=None)
        self.open_settings(panel)
        self.page.evaluate("window.__rsMock.setError = true")
        self.submit_credential(panel, 'fixture-token-not-real')
        expect(panel.get_by_role("alert")).to_contain_text("保存失败")
        expect(panel.get_by_role("dialog")).to_be_visible()
        self.assertEqual(len(self.requests()), 1)
        panel.get_by_role("button", name="取消", exact=True).click()
        self.assertEqual(self.page.locator('input[type="password"]').count(), 0)

    def test_14_independent_timeout_restores_refresh_button(self):
        panel = self.start([response(hang=True)], clock=True)
        expect(panel.locator(".rs-status")).to_contain_text("正在查询")
        self.page.clock.fast_forward(16000)
        expect(panel.locator(".rs-status")).to_contain_text("查询超时")
        self.expand(panel)
        expect(panel.get_by_role("button", name="刷新", exact=True)).to_be_enabled()
        self.assertEqual(self.page.evaluate("window.__rsMock.aborts"), 1)

    def test_15_wrong_replacement_is_verified_even_with_fresh_cache_and_preserves_old_settings(self):
        panel = self.start([response(finding()), response(releases(record(4, "2020-01-01")))])
        expect(panel.locator(".rs-summary-text")).to_have_text("已有发行记录")
        before = self.page.evaluate(f"window.__rsMock.storage[{json.dumps(CACHE_KEY)}]")
        self.open_settings(panel)
        self.page.evaluate("window.__rsMock.plans.push({status: 401, body: {}})")
        self.submit_credential(panel, 'incorrect-new-token')
        expect(panel.get_by_role("alert")).to_contain_text("认证失败")
        expect(panel.get_by_role("dialog")).to_be_visible()
        self.assertEqual(len(self.requests()), 3)
        self.assertTrue(self.requests()[-1]["url"].endswith("/authentication"))
        self.assertEqual(self.page.evaluate(f"window.__rsMock.storage[{json.dumps(CONFIG_KEY)}]"), TOKEN)
        self.assertEqual(self.page.evaluate(f"window.__rsMock.storage[{json.dumps(CACHE_KEY)}]"), before)

    def test_16_cancelling_validation_does_not_save_late_success(self):
        panel = self.start([response({"success": True}, delay=500, ignoreAbort=True)], config=None)
        self.open_settings(panel)
        self.submit_credential(panel, 'fixture-token-not-real')
        expect(panel.get_by_role("alert")).to_contain_text("正在验证")
        panel.get_by_role("button", name="取消", exact=True).click()
        self.page.wait_for_timeout(650)
        self.assertEqual(self.page.evaluate("window.__rsMock.aborts"), 1)
        self.assertFalse(self.page.evaluate(f"Object.hasOwn(window.__rsMock.storage, {json.dumps(CONFIG_KEY)})"))
        self.assertEqual(self.page.locator('input[type="password"]').count(), 0)
        expect(panel.locator(".rs-summary-text")).to_have_text("请设置 TMDB")

    def test_17_credentials_validate_without_imdb_but_no_movie_lookup_is_sent(self):
        panel = self.start([response({"success": True})], config=None, html_change="document.querySelector('#info').textContent = '导演：示例'")
        self.open_settings(panel)
        self.submit_credential(panel, 'fixture-token-not-real')
        expect(panel.get_by_role("dialog")).to_have_count(0)
        expect(panel.locator(".rs-config-notice")).to_contain_text("凭据验证成功")
        self.assertEqual(len(self.requests()), 1)
        expect(panel.locator(".rs-status")).to_contain_text("未找到 IMDb")

    def test_18_other_tab_deletion_cancels_old_request_and_blocks_refresh(self):
        panel = self.start([response(finding(), delay=800, ignoreAbort=True)])
        expect(panel.locator('.rs-summary-text')).to_have_text('查询中…')
        other, other_panel = self.another_tab(cache=cached_movie())
        self.open_settings(other_panel)
        other_panel.get_by_role('button', name='删除凭据').click()
        expect(panel.locator('.rs-summary-text')).to_have_text('请设置 TMDB')
        self.page.wait_for_timeout(850)
        self.page.evaluate("window.__rsMock.menus['发行信号：刷新当前作品']()")
        self.assertEqual(len(self.requests()), 1)
        self.assertEqual(self.page.evaluate('window.__rsMock.aborts'), 1)
        self.assertIsNone(self.page.evaluate(f"window.__rsMock.storage[{json.dumps(CACHE_KEY)}] ?? null"))

    def test_19_other_tab_replacement_is_used_for_next_refresh(self):
        panel = self.start([response(finding(movie_results=[]))], cache=cached_movie())
        expect(panel.locator('.rs-summary-text')).to_have_text('已有发行记录')
        other, other_panel = self.another_tab([response({'success': True}), response(finding(movie_results=[]))], cache=cached_movie())
        self.open_settings(other_panel)
        self.submit_credential(other_panel, 'replacement-fixture-token')
        expect(other_panel.get_by_role('dialog')).to_have_count(0)
        expect(panel.locator('.rs-config-notice')).to_contain_text('已同步其他页面')
        self.expand(panel)
        panel.get_by_role('button', name='刷新', exact=True).click()
        expect(panel.locator('.rs-summary-text')).to_have_text('未匹配到作品')
        self.assertEqual(len(self.requests()), 1)
        self.assertEqual(self.requests()[0]['headers']['Authorization'], 'Bearer replacement-fixture-token')

    def test_20_late_storage_notification_cannot_send_second_request_with_old_credential(self):
        panel = self.start([response(finding(), delay=200)])
        self.page.evaluate("window.__rsMock.suppressListeners = true; window.__rsMock.remoteChange({key: 'releaseSignal.config.v1', value: {version: 1, mode: 'token', value: 'replacement-fixture-token'}})")
        expect(panel.locator('.rs-summary-text')).to_have_text('等待查询')
        self.assertEqual(len(self.requests()), 1)
        self.assertIsNone(self.page.evaluate(f"window.__rsMock.storage[{json.dumps(CACHE_KEY)}] ?? null"))
        self.page.evaluate("window.__rsMock.plans.push({body: {movie_results: [], tv_results: []}}); window.__rsMock.menus['发行信号：刷新当前作品']()")
        expect(panel.locator('.rs-summary-text')).to_have_text('未匹配到作品')
        self.assertEqual(self.requests()[-1]['headers']['Authorization'], 'Bearer replacement-fixture-token')

    def test_21_remote_change_during_validation_cannot_overwrite_newer_settings(self):
        panel = self.start([response({'success': True}, delay=800, ignoreAbort=True)], config=None)
        self.open_settings(panel)
        self.submit_credential(panel, 'first-candidate-token')
        other, other_panel = self.another_tab([response({'success': True}), response(finding(movie_results=[]))], config=None)
        self.open_settings(other_panel)
        self.submit_credential(other_panel, 'latest-candidate-token')
        expect(panel.get_by_role('dialog')).to_have_count(0)
        self.page.wait_for_timeout(850)
        self.assertEqual(self.page.evaluate(f"window.__rsMock.storage[{json.dumps(CONFIG_KEY)}].value"), 'latest-candidate-token')
        self.assertEqual(len(self.requests()), 1)
        self.assertEqual(self.page.evaluate('window.__rsMock.aborts'), 1)

    def test_22_native_prompt_cancel_keeps_existing_settings(self):
        panel = self.start(cache=cached_movie())
        self.open_settings(panel)
        self.submit_credential(panel, None)
        expect(panel.get_by_role('dialog')).to_be_visible()
        expect(panel.get_by_role('dialog').locator('input')).to_have_count(0)
        self.assertEqual(self.requests(), [])
        self.assertEqual(self.page.evaluate(f"window.__rsMock.storage[{json.dumps(CONFIG_KEY)}]"), TOKEN)

    def test_23_page_context_fallback_refuses_credentials_and_requests(self):
        panel = self.start(info={'scriptHandler': 'Tampermonkey', 'sandboxMode': 'raw'})
        expect(panel.locator('.rs-summary-text')).to_have_text('当前环境不受支持')
        expect(panel.locator('.rs-status')).to_contain_text('推荐使用暴力猴')
        expect(panel.locator('.rs-status')).not_to_contain_text('启用暴力猴 content 或油猴 DOM')
        self.open_settings(panel)
        expect(panel.get_by_role('button', name='保存并查询')).to_be_disabled()
        expect(panel.get_by_role('dialog').locator('input')).to_have_count(0)
        self.assertEqual(self.requests(), [])

    def test_24_isolated_native_prompt_resists_host_overrides_and_dom_observers(self):
        # Run the real file in a Chromium isolated world sharing the same DOM.
        # Hostile page code overrides its own prompt and watches all input/DOM.
        self.page.goto('https://movie.douban.com/subject/1292052/')
        self.page.evaluate("""() => {
          window.__hostPromptCalls = 0; window.__hostInputEvents = 0; window.__hostSawSecret = false;
          window.prompt = () => { window.__hostPromptCalls++; return 'stolen'; };
          document.addEventListener('input', () => window.__hostInputEvents++, true);
          new MutationObserver(() => {
            if (document.documentElement.textContent.includes('native-fixture-secret') ||
                [...document.querySelectorAll('input,textarea')].some(el => el.value.includes('native-fixture-secret'))) window.__hostSawSecret = true;
          }).observe(document.documentElement, {subtree: true, childList: true, characterData: true, attributes: true});
        }""")
        cdp = self.context.new_cdp_session(self.page)
        frame_id = cdp.send('Page.getFrameTree')['frameTree']['frame']['id']
        world_id = cdp.send('Page.createIsolatedWorld', {'frameId': frame_id, 'worldName': 'release-signal-security-test'})['executionContextId']

        def isolated_eval(expression):
            result = cdp.send('Runtime.evaluate', {'contextId': world_id, 'expression': expression, 'returnByValue': True, 'awaitPromise': True})
            self.assertNotIn('exceptionDetails', result)
            return result['result'].get('value')

        options = {'storage': {}, 'plans': [response({'success': True}), response(finding(movie_results=[]))], 'broadcast': False, 'info': {'scriptHandler': 'Violentmonkey', 'injectInto': 'content'}}
        isolated_eval(MOCK.replace('__OPTIONS__', json.dumps(options, ensure_ascii=False)))
        isolated_eval(SCRIPT)
        panel = self.page.locator('#release-signal-panel')
        self.open_settings(panel)
        self.submit_credential(panel, 'native-fixture-secret')
        expect(panel.get_by_role('dialog')).to_have_count(0)
        expect(panel.locator('.rs-config-notice')).to_contain_text('凭据验证成功')
        self.assertEqual(isolated_eval(f"window.__rsMock.storage[{json.dumps(CONFIG_KEY)}].value"), 'native-fixture-secret')
        self.assertEqual(self.page.evaluate('window.__hostPromptCalls'), 0)
        self.assertEqual(self.page.evaluate('window.__hostInputEvents'), 0)
        self.assertFalse(self.page.evaluate('window.__hostSawSecret'))
        self.assertFalse(self.page.evaluate("'__rsMock' in window"))
        self.assertEqual(panel.locator('input,textarea').count(), 0)
        cdp.detach()

    def test_25_tv_season_hint_shows_latest_and_next_with_two_level_details(self):
        data = tv_season(tv_episode(1, '2026-11-04'), tv_episode(2, '2026-11-11', 'finale'))
        panel = self.start([response(tv_finding()), response(tv_series()), response(data)],
                           html_change="document.querySelector('h1').textContent = '示例剧集 第二季 (2026)'")
        expect(panel.locator('.rs-summary-text')).to_have_text('已有播出记录 · 第 1 集')
        expect(panel.locator('.rs-content')).to_be_hidden()
        self.expand(panel)
        expect(panel.locator('.rs-title')).to_have_text('播出记录')
        expect(panel.locator('[data-kind="recent"]')).to_have_text('S02E01 · 2026-11-04')
        expect(panel.locator('[data-kind="next"]')).to_have_text('S02E02 · 预计 2026-11-11')
        expect(panel.locator('#release-signal-season')).to_have_value('2')
        expect(panel.locator('tbody')).to_be_hidden()
        panel.screenshot(path=str(self.artifacts / 'tv-summary.png'))
        self.open_records(panel)
        expect(panel.locator('tbody tr')).to_have_count(2)
        expect(panel.locator('tbody')).to_contain_text('季终集')
        self.assertEqual(panel.locator('tbody a').last.get_attribute('href'), 'https://www.themoviedb.org/tv/55/season/2/episode/2')
        self.assertFalse(any('/movie/' in item['url'] for item in self.requests()))
        panel.screenshot(path=str(self.artifacts / 'tv-details.png'))

    def test_26_tv_confirmed_finale_and_refresh_removing_evidence(self):
        data = tv_season(tv_episode(1, '2026-11-01'), tv_episode(2, '2026-11-04', 'finale'))
        panel = self.start([response(tv_finding()), response(tv_series()), response(data)],
                           html_change="document.querySelector('h1').textContent = '示例剧集 Season 2'")
        expect(panel.locator('.rs-summary-text')).to_have_text('本季完结 · 2 集')
        expect(panel.locator('.rs-dot')).to_have_attribute('data-status', 'available')
        self.expand(panel)
        expect(panel.locator('[data-kind="next"]')).to_have_text('本季已完结')
        self.open_records(panel)
        expect(panel.locator('.rs-records')).to_contain_text('完结依据')
        changed = tv_season(tv_episode(1, '2026-11-01'), tv_episode(2, '2026-11-04'))
        self.page.evaluate('plans => window.__rsMock.plans.push(...plans)', [response(tv_finding()), response(tv_series()), response(changed)])
        panel.get_by_role('button', name='刷新', exact=True).click()
        expect(panel.locator('.rs-summary-text')).to_have_text('已有播出记录 · 第 2 集')
        expect(panel.locator('[data-kind="next"]')).to_have_text('暂未查到日期')

    def test_27_season_preview_does_not_survive_page_load_or_old_saved_preference(self):
        first = tv_season(tv_episode(1, '2026-11-01', season_number=1), tv_episode(2, '2026-11-11', 'finale', season_number=1), season_number=1)
        second = tv_season(tv_episode(1, '2026-11-01'), tv_episode(2, '2026-11-04', 'finale'))
        title = "document.querySelector('h1').textContent = '示例剧集 第一季'"
        panel = self.start([response(tv_finding()), response(tv_series()), response(first),
                            response(tv_finding()), response(tv_series()), response(second)], html_change=title)
        expect(panel.locator('.rs-summary-text')).to_have_text('已有播出记录 · 第 1 集')
        self.expand(panel)
        panel.locator('#release-signal-season').select_option('2')
        expect(panel.locator('.rs-summary-text')).to_have_text('本季完结 · 2 集')
        storage = self.page.evaluate('window.__rsMock.storage')
        self.assertNotIn(SEASONS_KEY, storage)
        old = {'version': 1, 'entries': {'1292052': {'imdb': 'tt0111161', 'number': 2, 'updatedAt': 1}}}
        other, other_panel = self.another_tab(cache=storage[CACHE_KEY], selections=old, html_change=title)
        expect(other_panel.locator('.rs-summary-text')).to_have_text('已有播出记录 · 第 1 集')
        expect(other_panel.locator('#release-signal-season')).to_have_value('1')
        self.assertEqual(other.evaluate('window.__rsMock.requests'), [])
        self.assertFalse(other.evaluate(f"Object.hasOwn(window.__rsMock.storage, {json.dumps(SEASONS_KEY)})"))
        third, third_panel = self.another_tab(path='/subject/1292053/', cache=storage[CACHE_KEY], html_change="document.querySelector('h1').textContent = '示例剧集 第二季'")
        expect(third_panel.locator('.rs-summary-text')).to_have_text('本季完结 · 2 集')
        self.assertEqual(third.evaluate('window.__rsMock.requests'), [])

    def test_28_tv_missing_date_or_partial_finale_stays_in_progress(self):
        data = tv_season(tv_episode(1, None), tv_episode(2, '2026-11-04', 'finale'))
        panel = self.start([response(tv_finding()), response(tv_series()), response(data)],
                           html_change="document.querySelector('h1').textContent = '示例剧集 第二季'")
        expect(panel.locator('.rs-summary-text')).to_have_text('已有播出记录 · 第 2 集')
        self.open_records(panel)
        expect(panel.locator('.rs-records')).to_contain_text('无法确认本季完结')
        expect(panel.locator('[data-kind="next"]')).to_have_text('暂未查到日期')

    def test_29_switching_seasons_aborts_and_discards_a_late_old_result(self):
        first = tv_season(tv_episode(1, '2026-11-01', season_number=1), tv_episode(2, '2026-11-04', 'finale', season_number=1), season_number=1)
        second = tv_season(tv_episode(1, '2026-11-01'), tv_episode(2, '2026-11-11', 'finale'))
        panel = self.start([response(tv_finding()), response(tv_series()),
                           response(tv_finding()), response(tv_series()), response(second, delay=400, ignoreAbort=True),
                           response(tv_finding()), response(tv_series()), response(first)])
        expect(panel.locator('.rs-summary-text')).to_have_text('请确认季数')
        self.expand(panel)
        panel.locator('#release-signal-season').select_option('2')
        self.page.wait_for_function("window.__rsMock.requests.some(item => item.url.includes('/season/2'))")
        panel.locator('#release-signal-season').select_option('1')
        expect(panel.locator('.rs-summary-text')).to_have_text('本季完结 · 2 集')
        self.page.wait_for_timeout(500)
        expect(panel.locator('#release-signal-season')).to_have_value('1')
        expect(panel.locator('[data-kind="recent"]')).to_have_text('S01E02 · 2026-11-04')
        self.assertGreaterEqual(self.page.evaluate('window.__rsMock.aborts'), 1)
        self.assertIsNone(self.page.evaluate(f"window.__rsMock.storage[{json.dumps(CACHE_KEY)}].entries['tt0111161:s2'] ?? null"))

    def test_30_remote_credential_deletion_stops_tv_chain_before_season_request(self):
        panel = self.start([response(tv_finding()), response(tv_series(), delay=300, ignoreAbort=True)],
                           html_change="document.querySelector('h1').textContent = '示例剧集 第二季'")
        self.page.wait_for_function('window.__rsMock.requests.length === 2')
        self.page.evaluate(f"window.__rsMock.remoteChange({{key: {json.dumps(CONFIG_KEY)}, deleted: true}})")
        self.page.wait_for_timeout(400)
        expect(panel.locator('.rs-summary-text')).to_have_text('请设置 TMDB')
        self.assertEqual(len(self.requests()), 2)
        self.assertFalse(any('/season/' in item['url'] for item in self.requests()))

    def test_31_tv_finale_recomputes_at_midnight_without_network(self):
        fetched = int(datetime(2026, 11, 5, 15, 59, tzinfo=timezone.utc).timestamp() * 1000)
        data = tv_season(tv_episode(1, '2026-11-04'), tv_episode(2, '2026-11-06', 'finale'))
        cache = {'version': 1, 'entries': {'tt0111161:s2': {'fetchedAt': fetched, 'result': {
            'work': {'kind': 'tv', 'id': 55, 'title': '示例剧集'}, 'series': tv_series(), 'seasonNumber': 2, 'season': data}}}}
        self.page.add_init_script(MOCK.replace('__OPTIONS__', json.dumps({'storage': {CONFIG_KEY: TOKEN, CACHE_KEY: cache}, 'plans': []}, ensure_ascii=False)))
        self.page.goto('https://movie.douban.com/subject/1292052/')
        self.page.evaluate("document.querySelector('h1').textContent = '示例剧集 第二季'")
        self.page.clock.install(time=datetime(2026, 11, 5, 15, 59, tzinfo=timezone.utc))
        self.page.evaluate(SCRIPT)
        panel = self.page.locator('#release-signal-panel')
        expect(panel.locator('.rs-summary-text')).to_have_text('已有播出记录 · 第 1 集')
        self.page.clock.fast_forward(62000)
        expect(panel.locator('.rs-summary-text')).to_have_text('本季完结 · 2 集')
        self.assertEqual(self.requests(), [])
        self.open_records(panel)
        expect(panel.locator('.rs-footnote').first).to_contain_text('缓存已过期')

    def test_32_tv_titles_are_text_and_narrow_season_picker_stays_inside_panel(self):
        catalog = tv_series()
        catalog['name'] = '<img src=x onerror=window.__xss=1>'
        found = tv_finding(); found['tv_results'][0]['name'] = catalog['name']
        data = tv_season(tv_episode(1, '2026-11-11'), tv_episode(2, '2026-11-18', 'finale'))
        data['episodes'][0]['name'] = '<script>window.__xss=1</script>'
        self.page.set_viewport_size({'width': 360, 'height': 850})
        self.page.route('**/subject/1292052/', lambda route: route.fulfill(status=200, content_type='text/html', body=FIXTURE.replace('.article { width: 620px;', '.article { width: 100%;').replace('.aside { width: 160px;', '.aside { display:none; width: 0;').replace('gap: 40px', 'gap: 0')))
        panel = self.start([response(found), response(catalog), response(data)],
                           html_change="document.querySelector('h1').textContent = '示例剧集 第二季'")
        expect(panel.locator('.rs-summary-text')).to_have_text('预计开播 · 2026-11-11')
        self.open_records(panel)
        self.assertIsNone(self.page.evaluate('window.__xss'))
        self.assertEqual(panel.locator('img').count(), 0)
        self.assertTrue(panel.locator('#release-signal-season').evaluate("el => el.getBoundingClientRect().right <= document.querySelector('#release-signal-panel').getBoundingClientRect().right"))
        panel.screenshot(path=str(self.artifacts / 'tv-narrow.png'))

    def test_33_conflicting_or_absent_season_number_never_chooses_another_silently(self):
        panel = self.start([response(tv_finding()), response(tv_series())],
                           html_change="document.querySelector('h1').textContent = '示例剧集 第九季'")
        expect(panel.locator('.rs-summary-text')).to_have_text('请确认季数')
        expect(panel.locator('.rs-status')).to_contain_text('不一致')
        self.assertEqual(len(self.requests()), 2)
        self.expand(panel)
        expect(panel.locator('#release-signal-season')).to_have_value('')

    def test_34_failed_tv_refresh_preserves_old_season_and_error(self):
        data = tv_season(tv_episode(1, '2026-11-01'), tv_episode(2, '2026-11-04', 'finale'))
        panel = self.start([response(tv_finding()), response(tv_series()), response(data)],
                           html_change="document.querySelector('h1').textContent = '示例剧集 第二季'")
        expect(panel.locator('.rs-summary-text')).to_have_text('本季完结 · 2 集')
        self.expand(panel)
        self.page.evaluate('plans => window.__rsMock.plans.push(...plans)', [response(tv_finding()), response(tv_series()), response({}, status=500)])
        panel.get_by_role('button', name='刷新', exact=True).click()
        expect(panel.locator('.rs-summary-text')).to_have_text('查询失败')
        expect(panel.locator('.rs-status')).to_contain_text('旧数据')
        expect(panel.locator('[data-kind="recent"]')).to_have_text('S02E02 · 2026-11-04')
        self.open_records(panel)
        expect(panel.locator('.rs-footnote').first).to_contain_text('本次刷新未成功')

    def test_35_manual_override_can_return_to_page_hint(self):
        first = tv_season(tv_episode(1, '2026-11-01', season_number=1), tv_episode(2, '2026-11-04', 'finale', season_number=1), season_number=1)
        second = tv_season(tv_episode(1, '2026-11-04'), tv_episode(2, '2026-11-11', 'finale'))
        panel = self.start([response(tv_finding()), response(tv_series()), response(second),
                           response(tv_finding()), response(tv_series()), response(first)],
                           html_change="document.querySelector('h1').textContent = '示例剧集 第二季'")
        expect(panel.locator('.rs-summary-text')).to_have_text('已有播出记录 · 第 1 集')
        self.expand(panel)
        panel.locator('#release-signal-season').select_option('1')
        expect(panel.locator('.rs-summary-text')).to_have_text('本季完结 · 2 集')
        panel.locator('#release-signal-season').select_option('')
        expect(panel.locator('.rs-summary-text')).to_have_text('已有播出记录 · 第 1 集')
        expect(panel.locator('#release-signal-season')).to_have_value('2')
        expect(panel.locator('[data-kind="recent"]')).to_have_text('S02E01 · 2026-11-04')
        self.assertFalse(self.page.evaluate(f"Object.hasOwn(window.__rsMock.storage, {json.dumps(SEASONS_KEY)})"))
        self.assertEqual(len(self.requests()), 6)

    def test_36_season_preview_works_without_saving_any_preference(self):
        data = tv_season(tv_episode(1, '2026-11-01'), tv_episode(2, '2026-11-04', 'finale'))
        panel = self.start([response(tv_finding()), response(tv_series()), response(tv_finding()), response(tv_series()), response(data)])
        expect(panel.locator('.rs-summary-text')).to_have_text('请确认季数')
        self.expand(panel)
        self.page.evaluate('window.__rsMock.setError = true')
        panel.locator('#release-signal-season').select_option('2')
        expect(panel.locator('.rs-summary-text')).to_have_text('本季完结 · 2 集')
        expect(panel.locator('#release-signal-season')).to_have_value('2')
        self.assertEqual(len(self.requests()), 5)
        self.assertFalse(self.page.evaluate(f"Object.hasOwn(window.__rsMock.storage, {json.dumps(SEASONS_KEY)})"))

    def test_37_single_first_season_ignores_specials_and_selects_automatically(self):
        catalog = tv_series()
        catalog['seasons'] = [catalog['seasons'][0], {'id': 500, 'season_number': 0, 'episode_count': 1, 'air_date': None}]
        data = tv_season(tv_episode(1, '2026-11-01', season_number=1), tv_episode(2, '2026-11-04', 'finale', season_number=1), season_number=1)
        panel = self.start([response(tv_finding()), response(catalog), response(data)],
                           html_change="document.querySelector('h1').textContent = '月光骑士 Moon Knight (2022)'")
        expect(panel.locator('.rs-summary-text')).to_have_text('本季完结 · 2 集')
        self.expand(panel)
        expect(panel.locator('#release-signal-season')).to_have_value('1')
        self.assertEqual(len(self.requests()), 3)

    def test_38_episode_imdb_finds_parent_series_and_requested_season(self):
        # Public IDs supplied by the user; parent/episode IDs and dates are fake.
        cases = [('37403692', 'tt37427409', '黑帮领地 第二季 MobLand Season 2', 2),
                 ('36689816', 'tt33997325', '流人 第六季 Slow Horses Season 6', 6)]
        for index, (subject, imdb, title, number) in enumerate(cases):
            with self.subTest(imdb=imdb):
                catalog = tv_series()
                catalog['name'] = title
                catalog['seasons'] = [{'id': 500 + number, 'season_number': number, 'episode_count': 2, 'air_date': '2026-11-01'}]
                data = tv_season(tv_episode(1, '2026-11-01', season_number=number), tv_episode(2, '2026-11-04', 'finale', season_number=number), season_number=number)
                found = finding(movie_results=[], tv_results=[], tv_episode_results=[tv_episode(1, '2026-11-01', season_number=number)])
                change = f"document.querySelector('h1').textContent = {json.dumps(title)}; const a = document.querySelector('#info a'); a.href = 'https://www.imdb.com/title/{imdb}/'; a.textContent = '{imdb}'"
                plans = [response(found), response(catalog), response(data)]
                if index == 0:
                    panel = self.start(plans, path=f'/subject/{subject}/', html_change=change)
                else:
                    _, panel = self.another_tab(plans, path=f'/subject/{subject}/', html_change=change)
                expect(panel.locator('.rs-summary-text')).to_have_text('本季完结 · 2 集')
                self.open_records(panel)
                expect(panel.locator('#release-signal-season')).to_have_value(str(number))
                expect(panel.locator('.rs-records')).to_contain_text('匹配依据：IMDb 对应')
                self.assertEqual(len(panel.page.evaluate('window.__rsMock.requests')), 3)

    def test_39_episode_parent_season_conflict_requires_explicit_confirmation(self):
        found = finding(movie_results=[], tv_results=[], tv_episode_results=[tv_episode(1, '2026-11-01', season_number=2)])
        first = tv_season(tv_episode(1, '2026-11-01', season_number=1), tv_episode(2, '2026-11-04', 'finale', season_number=1), season_number=1)
        panel = self.start([response(found), response(tv_series()), response(found), response(tv_series()), response(first)],
                           html_change="document.querySelector('h1').textContent = '示例剧集 第一季'")
        expect(panel.locator('.rs-summary-text')).to_have_text('请确认季数')
        expect(panel.locator('.rs-status')).to_contain_text('存在冲突')
        self.expand(panel)
        panel.locator('#release-signal-season').select_option('1')
        expect(panel.locator('.rs-summary-text')).to_have_text('本季完结 · 2 集')
        expect(panel.locator('[data-kind="recent"]')).to_have_text('S01E02 · 2026-11-04')

    def test_40_single_season_cannot_override_explicit_page_season(self):
        catalog = tv_series(); catalog['seasons'] = catalog['seasons'][:1]
        panel = self.start([response(tv_finding()), response(catalog)],
                           html_change="document.querySelector('h1').textContent = '示例剧集 第二季'")
        expect(panel.locator('.rs-summary-text')).to_have_text('请确认季数')
        expect(panel.locator('.rs-status')).to_contain_text('不一致')
        self.assertEqual(len(self.requests()), 2)

    def test_41_switch_api_address_reuses_saved_credential_without_a_prompt(self):
        panel = self.start([response({'success': True}), response(finding()), response(releases(record(4, '2026-11-01')))],
                           cache=cached_movie(), config={**TOKEN, 'apiOrigin': 'https://api.themoviedb.org'})
        expect(panel.locator('.rs-summary-text')).to_have_text('已有发行记录')
        prompts = []
        self.page.on('dialog', lambda dialog: (prompts.append(dialog.type), dialog.dismiss()))
        self.open_settings(panel)
        expect(panel.locator('#release-signal-api-origin')).to_have_value('https://api.themoviedb.org')
        panel.locator('#release-signal-api-origin').select_option('https://api.tmdb.org')
        panel.get_by_role('button', name='保存并查询', exact=True).click()
        expect(panel.get_by_role('dialog')).to_have_count(0)
        expect(panel.locator('.rs-summary-text')).to_have_text('已有发行记录')
        self.assertEqual(prompts, [])
        self.assertEqual(len(self.requests()), 3)
        self.assertTrue(all(item['url'].startswith('https://api.tmdb.org/3/') for item in self.requests()))
        stored = self.page.evaluate(f'window.__rsMock.storage[{json.dumps(CONFIG_KEY)}]')
        self.assertEqual(stored['value'], TOKEN['value'])
        self.assertEqual(stored['apiOrigin'], 'https://api.tmdb.org')
        self.assertNotIn(TOKEN['value'], panel.text_content())

    def test_42_failed_api_address_validation_keeps_original_config_and_cache(self):
        saved = {**TOKEN, 'apiOrigin': 'https://api.themoviedb.org'}
        panel = self.start([response({}, status=401)], cache=cached_movie(), config=saved)
        expect(panel.locator('.rs-summary-text')).to_have_text('已有发行记录')
        before = self.page.evaluate(f'window.__rsMock.storage[{json.dumps(CACHE_KEY)}]')
        self.open_settings(panel)
        panel.locator('#release-signal-api-origin').select_option('https://api.tmdb.org')
        panel.get_by_role('button', name='保存并查询', exact=True).click()
        expect(panel.get_by_role('alert')).to_contain_text('认证失败')
        self.assertEqual(self.page.evaluate(f'window.__rsMock.storage[{json.dumps(CONFIG_KEY)}]'), saved)
        self.assertEqual(self.page.evaluate(f'window.__rsMock.storage[{json.dumps(CACHE_KEY)}]'), before)
        self.assertEqual(len(self.requests()), 1)
        self.assertTrue(self.requests()[0]['url'].startswith('https://api.tmdb.org/3/authentication'))

    def test_43_api_origin_change_in_another_tab_cancels_old_origin_and_uses_new_one(self):
        saved = {**TOKEN, 'apiOrigin': 'https://api.themoviedb.org'}
        panel = self.start([response(finding(), delay=1000, ignoreAbort=True)], config=saved)
        expect(panel.locator('.rs-summary-text')).to_have_text('查询中…')
        self.assertTrue(self.requests()[0]['url'].startswith('https://api.themoviedb.org/3/'))
        other, other_panel = self.another_tab([response({'success': True}), response(finding()), response(releases(record(4, '2026-11-01')))], cache=cached_movie(), config=saved)
        self.open_settings(other_panel)
        other_panel.locator('#release-signal-api-origin').select_option('https://api.tmdb.org')
        other_panel.get_by_role('button', name='保存并查询', exact=True).click()
        expect(other_panel.get_by_role('dialog')).to_have_count(0)
        expect(panel.locator('.rs-config-notice')).to_contain_text('已同步')
        self.page.wait_for_timeout(1100)
        self.assertEqual(len(self.requests()), 1)
        self.assertGreaterEqual(self.page.evaluate('window.__rsMock.aborts'), 1)
        self.page.evaluate('plans => window.__rsMock.plans.push(...plans)', [response(finding()), response(releases(record(4, '2026-11-01')))])
        self.expand(panel)
        panel.get_by_role('button', name='刷新', exact=True).click()
        expect(panel.locator('.rs-summary-text')).to_have_text('已有发行记录')
        self.assertTrue(all(item['url'].startswith('https://api.tmdb.org/3/') for item in self.requests()[1:]))

    def test_44_new_and_replacement_credentials_use_the_default_origin_without_selection(self):
        panel = self.start([response({'success': True}), response(finding(movie_results=[])),
                            response({'success': True}), response(finding(movie_results=[]))], config=None)
        self.open_settings(panel)
        expect(panel.locator('#release-signal-api-origin')).to_have_value('https://api.tmdb.org')
        self.submit_credential(panel, 'alternate-fixture-token')
        expect(panel.get_by_role('dialog')).to_have_count(0)
        self.open_settings(panel)
        self.submit_credential(panel, 'replacement-alternate-fixture-token')
        expect(panel.get_by_role('dialog')).to_have_count(0)
        stored = self.page.evaluate(f'window.__rsMock.storage[{json.dumps(CONFIG_KEY)}]')
        self.assertEqual(stored['apiOrigin'], 'https://api.tmdb.org')
        self.assertEqual(stored['value'], 'replacement-alternate-fixture-token')
        self.assertEqual(len(self.requests()), 4)
        self.assertTrue(all(item['url'].startswith('https://api.tmdb.org/3/') for item in self.requests()))

    def test_45_page_cannot_inject_an_unapproved_api_host_into_settings(self):
        panel = self.start(cache=cached_movie())
        self.open_settings(panel)
        self.page.evaluate("const select = document.querySelector('#release-signal-api-origin'); select.add(new Option('invalid', 'https://unapproved.invalid')); select.value='https://unapproved.invalid'")
        panel.get_by_role('button', name='保存并查询', exact=True).click()
        expect(panel.get_by_role('alert')).to_contain_text('预设的 HTTPS API 地址')
        self.assertEqual(self.requests(), [])
        self.assertEqual(self.page.evaluate(f'window.__rsMock.storage[{json.dumps(CONFIG_KEY)}]'), TOKEN)

    def test_46_fixed_columns_stay_on_one_line_in_both_tables_with_long_content_and_zoom(self):
        countries = ['US', 'GB', 'CA', 'AU', 'JP', 'KR', 'HK', 'TW', 'SG', 'FR', 'DE', 'ES', 'IT', 'NL', 'SE', 'NO', 'FI', 'DK', 'CH', 'AT', 'BE', 'BR', 'MX', 'NZ']
        note = '这是一段用于复现电影发行表长说明挤压类型和日期列的模拟文字' * 8
        data = {'id': 42, 'results': [{'iso_3166_1': country, 'release_dates': [record(4, '2026-11-01', note), record(5, '2026-11-02', note)]} for country in countries]}
        movie_panel = self.start([response(finding()), response(data)])
        self.open_records(movie_panel)
        tv_data = tv_season(tv_episode(1, '2026-11-01'), tv_episode(2, '2026-11-04', 'finale'))
        for item in tv_data['episodes']:
            item['name'] = 'A long episode title that must not squeeze the episode/date columns ' * 12
        _, tv_panel = self.another_tab([response(tv_finding()), response(tv_series()), response(tv_data)],
                                      html_change="document.querySelector('h1').textContent='示例剧集 第二季'")
        self.open_records(tv_panel)
        for panel in [movie_panel, tv_panel]:
            page = panel.page
            page.add_style_tag(content='@media(max-width:600px){.aside{display:none}.layout{gap:0}.article{width:100%}}')
            for width in [1050, 360]:
                page.set_viewport_size({'width': width, 'height': 900})
                for zoom in [1, 1.1, 1.25]:
                    page.evaluate('zoom => document.body.style.zoom=String(zoom)', zoom)
                    cells = panel.locator('.rs-table th,.rs-table tbody td:nth-child(-n+2),.rs-tv-table tbody td:last-child').evaluate_all("cells => cells.map(cell => { const range=document.createRange(); range.selectNodeContents(cell); return {text:cell.textContent,lines:new Set([...range.getClientRects()].filter(r=>r.width>0).map(r=>Math.round(r.top))).size}; })")
                    self.assertTrue(all(cell['lines'] == 1 for cell in cells), (width, zoom, cells))
                    self.assertTrue(panel.locator('.rs-table-wrap').evaluate('el => el.getBoundingClientRect().right <= document.querySelector("#release-signal-panel").getBoundingClientRect().right + 1'))
            page.evaluate("document.body.style.zoom='1'")
        movie_panel.screenshot(path=str(self.artifacts / 'movie-fixed-columns.png'))
        tv_panel.screenshot(path=str(self.artifacts / 'tv-fixed-columns.png'))


if __name__ == "__main__":
    unittest.main(verbosity=2)
