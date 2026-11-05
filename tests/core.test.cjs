'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const rs = require('../release-signal.user.js');

const config = rs.parseConfig('token', 'fixture-token-not-real');
const find = (extra = {}) => ({ movie_results: [{ id: 42, title: '测试电影' }], tv_results: [], tv_episode_results: [], tv_season_results: [], person_results: [], ...extra });
const releases = (...items) => ({ id: 42, results: [{ iso_3166_1: 'US', release_dates: items }] });
const record = (type, date, note = '') => ({ type, release_date: date, note });
const memory = () => {
  const data = {};
  return { data, get: (key, fallback) => structuredClone(data[key] ?? fallback), set: (key, value) => { data[key] = structuredClone(value); } };
};
const fakeInfo = (hrefs, text) => ({ querySelectorAll: () => hrefs.map(href => ({ getAttribute: () => href })), innerText: text });

test('only numeric HTTPS Douban movie detail pages are allowed', () => {
  assert.equal(rs.isSubjectUrl('https://movie.douban.com/subject/1292052/?from=top'), true);
  for (const url of ['https://movie.douban.com/', 'https://movie.douban.com/subject/42/reviews', 'https://movie.douban.com/subject/not-a-number/', 'https://movie.douban.com.evil/subject/42/', 'http://movie.douban.com/subject/42/', 'https://book.douban.com/subject/42/', 'invalid']) assert.equal(rs.isSubjectUrl(url), false, url);
});

test('IMDb uses trusted title-link hosts and labelled text, never arbitrary title numbers', () => {
  assert.deepEqual(rs.extractImdb(fakeInfo(['https://www.imdb.com/title/tt0111161/?ref_=x'], 'IMDb: tt0111161')), { kind: 'found', id: 'tt0111161' });
  assert.equal(rs.extractImdb(fakeInfo([], '导演: 测试\nIMDb：\n tt12345678')).id, 'tt12345678');
  assert.equal(rs.extractImdb(fakeInfo(['https://imdb.com.evil/title/tt0111161/'], '其他编号 tt0111161')).kind, 'missing');
  assert.equal(rs.extractImdb(fakeInfo(['https://m.imdb.com/title/tt0111161/'], 'IMDb: tt12345678')).kind, 'conflict');
  assert.equal(rs.extractImdb(null).kind, 'missing');
});

test('matching accepts unique movies and TV series while refusing conflicts and standalone episodes/seasons', () => {
  assert.deepEqual(rs.matchWork(find()), { kind: 'movie', id: 42, title: '测试电影' });
  assert.equal(rs.matchWork(find({ movie_results: [] })).kind, 'unmatched');
  assert.deepEqual(rs.matchWork(find({ movie_results: [], tv_results: [{ id: 7, name: '测试剧集' }] })), { kind: 'tv', id: 7, title: '测试剧集' });
  for (const key of ['tv_episode_results', 'tv_season_results', 'person_results']) {
    assert.equal(rs.matchWork(find({ movie_results: [], [key]: [{ id: 21 }] })).kind, 'unsupported');
  }
  assert.equal(rs.matchWork(find({ tv_results: [{ id: 21 }] })).kind, 'ambiguous');
  assert.equal(rs.matchWork(find({ movie_results: [{ id: 42 }, { id: 43 }] })).kind, 'ambiguous');
  for (const malformed of [{}, null, { movie_results: {}, tv_results: [] }, find({ tv_results: [{ id: '21' }] })]) assert.throws(() => rs.matchWork(malformed), { code: 'format' });
});

test('calendar dates strictly validate leap days and timestamp syntax without timezone conversion', () => {
  for (const value of ['2024-02-29', '2026-11-06T00:00:00.000Z', '2026-11-06T00:00:00+14:00', '2026-11-06T23:59:59-10:00']) assert.equal(rs.sourceDate(value), value.slice(0, 10));
  for (const value of ['2026-02-29', '1900-02-29', '2024-02-30', '2026-13-01', '2026-00-01', '2026-01-00', '0000-01-01', '2026-11-06T25:00:00Z', '2026-11-06T00:00:00+14:30', '2026-11-06junk', '2026-11-06T00:00:00', '', null]) assert.equal(rs.sourceDate(value), null, String(value));
});

test('all regions are included, only types 4/5 count, duplicates collapse and bad records are disclosed', () => {
  const data = releases(record(1, '2020-01-01'), record(2, '2020-01-01'), record(3, '2020-01-01'), record(6, '2020-01-01'), record(4, '2026-11-06'), record(4, '2026-11-06'), record(5, 'bad'));
  data.results.push({ iso_3166_1: 'JP', release_dates: [record(5, '2026-11-04')] }, { iso_3166_1: 'ZZZ', release_dates: [record(4, '2026-11-05')] }, { release_dates: null });
  const normalized = rs.normalizeReleases(data, 42);
  assert.equal(normalized.records.length, 3);
  assert.equal(normalized.records[0].country, 'JP');
  assert.equal(normalized.records[1].country, '--');
  assert.equal(normalized.invalidCount, 2);
  for (const malformed of [{}, { id: 43, results: [] }, { id: 42, results: null }]) assert.throws(() => rs.normalizeReleases(malformed, 42), { code: 'format' });
});

test('due records beat future dates across both formats; today counts as date reached', () => {
  const get = (...items) => rs.deriveStatus(rs.normalizeReleases(releases(...items), 42), '2026-11-05');
  assert.equal(get().status, 'unknown');
  assert.equal(get(record(3, '2020-01-01')).status, 'unknown');
  const mixed = get(record(4, '2026-11-10'), record(5, '2026-11-05'));
  assert.equal(mixed.status, 'available');
  assert.equal(mixed.digital.status, 'future');
  assert.equal(mixed.physical.status, 'available');
  const both = get(record(4, '2020-01-01'), record(4, '2026-12-01'), record(5, '2027-01-01'));
  assert.equal(both.status, 'available');
  assert.equal(both.digital.date, '2020-01-01');
  assert.equal(get(record(4, '2026-11-06'), record(5, '2026-12-01')).status, 'future');
});

test('browser-local day and source calendar dates remain correct across timezones', () => {
  const script = `const r=require(${JSON.stringify(path.resolve(__dirname, '../release-signal.user.js'))}); process.stdout.write(JSON.stringify([r.localDay(Date.parse('2026-11-05T16:30:00Z')),r.sourceDate('2026-11-06T00:00:00.000Z')]));`;
  for (const [zone, day] of [['Asia/Hong_Kong', '2026-11-06'], ['America/Los_Angeles', '2026-11-05'], ['Pacific/Honolulu', '2026-11-05']]) {
    const child = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), [day, '2026-11-06']);
  }
});

test('configuration supports both methods, strips optional Bearer prefix and rejects header injection', () => {
  assert.deepEqual(rs.parseConfig('token', ' Bearer fixture-token '), { version: 1, mode: 'token', value: 'fixture-token', apiOrigin: 'https://api.tmdb.org' });
  assert.equal(rs.parseConfig('key', 'a'.repeat(32)).mode, 'key');
  for (const args of [['token', ''], ['key', 'x\nCookie:y'], ['token', 'x y'], ['other', 'x']]) assert.throws(() => rs.parseConfig(...args), { code: 'config' });
});

test('API address settings default to api.tmdb.org and preserve explicitly saved origins', () => {
  assert.equal(rs.parseConfig('token', 'fixture-token').apiOrigin, 'https://api.tmdb.org');
  for (const origin of rs.API_ORIGINS) assert.equal(rs.parseConfig('token', 'fixture-token', origin).apiOrigin, origin);
  for (const origin of ['http://api.tmdb.org', 'https://api.tmdb.org/', 'https://api.tmdb.org.evil.invalid', 'https://other.invalid', '', null]) {
    assert.throws(() => rs.parseConfig('token', 'fixture-token', origin), { code: 'config' });
  }
});

function transport(response) {
  const calls = [];
  const request = rs.createRequester(details => {
    calls.push(details);
    queueMicrotask(() => details.onload(response));
    return { abort() {} };
  });
  return { calls, request };
}

test('network only uses the fixed API, omits cookies, and keeps tokens out of URLs', async () => {
  const t = transport({ status: 200, responseText: JSON.stringify(find()) });
  await t.request('/find/tt0111161', config);
  const call = t.calls[0], url = new URL(call.url);
  assert.equal(url.origin, 'https://api.tmdb.org');
  assert.equal(url.searchParams.get('external_source'), 'imdb_id');
  assert.equal(url.href.includes(config.value), false);
  assert.equal(call.headers.Authorization, 'Bearer ' + config.value);
  assert.equal(call.anonymous, true);
  assert.equal(call.redirect, 'error');
  assert.equal(Object.hasOwn(call, 'cookie'), false);
  assert.equal(Object.hasOwn(call.headers, 'Cookie'), false);
  await t.request('/movie/42/release_dates', rs.parseConfig('key', 'a'.repeat(32)));
  assert.equal(new URL(t.calls[1].url).searchParams.get('api_key'), 'a'.repeat(32));
  assert.equal(Object.hasOwn(t.calls[1].headers, 'Authorization'), false);
  await assert.rejects(t.request('https://other.invalid/path', config), { code: 'format' });
  assert.equal(t.calls.length, 2);
});

test('both preset API origins support tokens and keys without silently changing hosts', async () => {
  for (const origin of rs.API_ORIGINS) {
    for (const mode of ['token', 'key']) {
      const t = transport({ status: 200, responseText: '{}' });
      const credential = rs.parseConfig(mode, 'fixture-endpoint-credential', origin);
      await t.request('/authentication', credential);
      assert.equal(new URL(t.calls[0].url).origin, origin);
      assert.equal(t.calls[0].anonymous, true);
      if (mode === 'token') {
        assert.equal(t.calls[0].headers.Authorization, 'Bearer fixture-endpoint-credential');
        assert.equal(t.calls[0].url.includes(credential.value), false);
      } else assert.equal(new URL(t.calls[0].url).searchParams.get('api_key'), credential.value);
    }
  }
  const t = transport({ status: 401, responseText: '{}' });
  await assert.rejects(t.request('/authentication', rs.parseConfig('token', 'fixture-token', 'https://api.tmdb.org')), { code: 'auth' });
  assert.equal(t.calls.length, 1);
});

test('request layer rejects unapproved origins before sending any credential', async () => {
  const t = transport({ status: 200, responseText: '{}' });
  for (const origin of ['http://api.tmdb.org', 'https://elsewhere.invalid', 'https://api.tmdb.org/path']) {
    await assert.rejects(t.request('/authentication', { ...config, apiOrigin: origin }), { code: 'config' });
  }
  assert.equal(t.calls.length, 0);
  await t.request('/authentication', { version: 1, mode: 'token', value: 'legacy-fixture-token' });
  assert.equal(new URL(t.calls[0].url).origin, 'https://api.tmdb.org');
});

test('redirects to the other allowed API host are still rejected for the chosen request', async () => {
  for (const origin of rs.API_ORIGINS) {
    const other = rs.API_ORIGINS.find(value => value !== origin);
    const t = transport({ status: 200, responseText: '{}', finalUrl: other + '/3/authentication' });
    await assert.rejects(t.request('/authentication', rs.parseConfig('token', 'fixture-token', origin)), { code: 'network' });
    assert.equal(t.calls.length, 1);
  }
});

test('HTTP, malformed JSON, API errors and redirects are failures, never empty release records', async () => {
  for (const [status, code] of [[0, 'network'], [401, 'auth'], [403, 'auth'], [429, 'rate'], [503, 'server'], [404, 'notfound'], [418, 'http']]) {
    await assert.rejects(transport({ status, responseText: 'secret should not be echoed' }).request('/find/tt0111161', config), error => error.code === code && !error.message.includes('secret'));
  }
  for (const responseText of ['<html>blocked</html>', 'null', '[]', '{broken']) await assert.rejects(transport({ status: 200, responseText }).request('/find/tt0111161', config), { code: 'format' });
  await assert.rejects(transport({ status: 200, responseText: '{"success":false,"status_code":7}' }).request('/find/tt0111161', config), { code: 'auth' });
  await assert.rejects(transport({ status: 200, responseText: '{}', finalUrl: 'https://other.invalid/' }).request('/find/tt0111161', config), { code: 'network' });
});

test('independent 15-second timer aborts even when the manager never calls ontimeout', async () => {
  let timed, cleared = 0, aborted = 0, call;
  const request = rs.createRequester(details => { call = details; return { abort() { aborted++; details.onabort(); } }; }, {
    setTimeout(callback, milliseconds) { assert.equal(milliseconds, 15000); timed = callback; return 123; },
    clearTimeout(id) { assert.equal(id, 123); cleared++; },
  });
  const promise = request('/find/tt0111161', config);
  timed();
  await assert.rejects(promise, { code: 'timeout' });
  call.onload({ status: 200, responseText: '{}' });
  assert.equal(aborted, 1);
  assert.equal(cleared, 1);
});

test('abort cancels requests and a pre-aborted signal sends nothing', async () => {
  let sent = 0, aborted = 0;
  const request = rs.createRequester(details => { sent++; return { abort() { aborted++; details.onabort(); } }; });
  const controller = new AbortController();
  const promise = request('/find/tt0111161', config, controller.signal);
  controller.abort();
  await assert.rejects(promise, { code: 'cancelled' });
  await assert.rejects(request('/find/tt0111161', config, controller.signal), { code: 'cancelled' });
  assert.equal(sent, 1); assert.equal(aborted, 1);
});

test('network and synchronous manager errors are sanitized', async () => {
  const request = rs.createRequester(() => { throw new Error('secret API URL'); });
  await assert.rejects(request('/find/tt0111161', config), error => error.code === 'network' && !error.message.includes('secret'));
  const failing = rs.createRequester(details => { queueMicrotask(details.onerror); return { abort() {} }; });
  await assert.rejects(failing('/find/tt0111161', config), { code: 'network' });
});

test('successful empty records cache for six hours; refresh bypasses cache and concurrent calls merge', async () => {
  const storage = memory(); let now = 100000000, calls = 0;
  const service = rs.createService({ storage, now: () => now, request: async route => { calls++; return route.startsWith('/find') ? find() : releases(); } });
  const first = service.query('tt0111161', config);
  assert.equal(first, service.query('tt0111161', config, { force: true }));
  await first; assert.equal(calls, 2);
  assert.equal((await service.query('tt0111161', config)).fromCache, true);
  assert.equal(calls, 2);
  now += rs.CACHE_SHORT_TTL - 1;
  await service.query('tt0111161', config); assert.equal(calls, 2);
  now++;
  await service.query('tt0111161', config); assert.equal(calls, 4);
  await service.query('tt0111161', config, { force: true }); assert.equal(calls, 6);
});

test('a cached future date reaching today expires and refetches on the next lookup', async () => {
  let now = new Date(2026, 10, 5, 23, 59).getTime(), calls = 0;
  const service = rs.createService({ storage: memory(), now: () => now, request: async route => { calls++; return route.startsWith('/find') ? find() : releases(record(4, '2026-11-06T00:00:00.000Z')); } });
  const entry = await service.query('tt0111161', config);
  const normalized = rs.normalizeReleases(entry.result.releases, 42);
  assert.equal(rs.deriveStatus(normalized, rs.localDay(now)).status, 'future');
  now += 2 * 60000;
  assert.equal(service.peek('tt0111161').fresh, false);
  const updated = await service.query('tt0111161', config);
  assert.equal(updated.fromCache, false);
  assert.equal(rs.deriveStatus(rs.normalizeReleases(updated.result.releases, 42), rs.localDay(now)).status, 'available');
  assert.equal(calls, 4);
});

test('cache policy varies for empty, near, recent, future and old records, with a local-date expiry cap', () => {
  const at = new Date(2026, 10, 5, 12).getTime();
  const entry = (...items) => ({ fetchedAt: at, result: { work: { kind: 'movie', id: 42, title: '测试' }, releases: releases(...items) } });
  for (const [items, ttl] of [
    [[], rs.CACHE_SHORT_TTL],
    [[record(4, '2026-11-10')], rs.CACHE_SHORT_TTL],
    [[record(4, '2026-11-04')], rs.CACHE_SHORT_TTL],
    [[record(4, '2026-12-01')], rs.CACHE_TTL],
    [[record(4, '2026-10-20')], rs.CACHE_TTL],
    [[record(4, '2026-09-01'), record(5, '2026-09-10')], rs.CACHE_LONG_TTL],
    [[record(4, '2026-09-01'), record(5, '2026-12-01')], rs.CACHE_TTL],
    [[record(4, '2026-09-01'), record(5, '2026-11-06')], rs.CACHE_SHORT_TTL],
  ]) {
    const cached = entry(...items);
    assert.equal(rs.cachePolicy(cached, at).ttl, ttl);
    assert.equal(rs.cachePolicy(cached, at + ttl - 1).fresh, true);
    assert.equal(rs.cachePolicy(cached, at + ttl).fresh, false);
  }
  const nearMidnight = entry(record(4, '2026-11-06T00:00:00.000Z'));
  nearMidnight.fetchedAt = new Date(2026, 10, 5, 23, 59).getTime();
  assert.equal(rs.cachePolicy(nearMidnight, nearMidnight.fetchedAt).expiresAt, new Date(2026, 10, 6).getTime());
  assert.equal(rs.cachePolicy(nearMidnight, nearMidnight.fetchedAt + 60000).fresh, false);
  const approaching = entry(record(4, '2026-11-13'));
  assert.equal(rs.cachePolicy(approaching, at).ttl, rs.CACHE_TTL);
  assert.equal(rs.cachePolicy(approaching, new Date(2026, 10, 6, 1).getTime()).fresh, false);
});

test('expired caches cannot revive when records move into a longer TTL class, including legacy entries', async () => {
  const storage = memory();
  let now = new Date(2026, 10, 5, 12).getTime(), calls = 0;
  const service = rs.createService({ storage, now: () => now, request: async route => {
    calls++;
    return route.startsWith('/find') ? find() : releases(record(4, '2026-10-12'));
  } });
  await service.query('tt0111161', config);
  const stored = storage.data[rs.CACHE_KEY].entries.tt0111161;
  const originalDeadline = now + rs.CACHE_TTL;
  assert.equal(stored.expiresAt, originalDeadline);
  now = new Date(2026, 10, 7, 12).getTime();
  assert.equal(service.peek('tt0111161').fresh, false);
  now = new Date(2026, 10, 11, 12).getTime();
  assert.equal(service.peek('tt0111161').fresh, false);
  assert.equal(service.peek('tt0111161').expiresAt, originalDeadline);
  delete stored.expiresAt; // Existing v0.2.x caches have only fetchedAt.
  assert.equal(service.peek('tt0111161').fresh, false);
  assert.equal(service.peek('tt0111161').expiresAt, originalDeadline);
  await service.query('tt0111161', config);
  assert.equal(calls, 4);

  const recent = { fetchedAt: new Date(2026, 10, 8, 1).getTime(), result: { work: { kind: 'movie', id: 42, title: 'recent' }, releases: releases(record(4, '2026-11-01')) } };
  assert.equal(rs.cachePolicy(recent, new Date(2026, 10, 8, 8).getTime()).fresh, false);
  assert.equal(rs.cachePolicy(recent, new Date(2026, 10, 9, 0).getTime()).fresh, false);
});

test('a persisted earlier expiry is respected and later tampering cannot extend the original deadline', () => {
  const at = new Date(2026, 10, 5, 12).getTime();
  const entry = { fetchedAt: at, expiresAt: at + 60000, result: { work: { kind: 'movie', id: 42, title: 'test' }, releases: releases(record(4, '2026-10-20')) } };
  assert.equal(rs.cachePolicy(entry, at + 60000).fresh, false);
  entry.expiresAt = at + rs.CACHE_LONG_TTL;
  assert.equal(rs.cachePolicy(entry, at).expiresAt, at + rs.CACHE_TTL);
});

test('credential entry requires a known isolated manager runtime, never a page/raw fallback', () => {
  assert.equal(rs.isIsolatedRuntime({ scriptHandler: 'Violentmonkey', injectInto: 'content' }), true);
  assert.equal(rs.isIsolatedRuntime({ scriptHandler: 'Tampermonkey', sandboxMode: 'dom' }), true);
  for (const info of [null, {}, { scriptHandler: 'Violentmonkey', injectInto: 'page' }, { scriptHandler: 'Violentmonkey', injectInto: 'auto' }, { scriptHandler: 'Tampermonkey', sandboxMode: 'raw' }, { scriptHandler: 'Tampermonkey', sandboxMode: 'js' }]) assert.equal(rs.isIsolatedRuntime(info), false);
});

test('grouping combines countries only for identical type, date and note, retaining different evidence', () => {
  const data = releases(record(4, '2026-11-04', '同一说明'), record(4, '2026-11-04', '不同说明'), record(5, '2026-11-04', '同一说明'));
  data.results.push({ iso_3166_1: 'CA', release_dates: [record(4, '2026-11-04T00:00:00.000Z', '同一说明'), record(4, '2026-11-05', '同一说明')] });
  const normalized = rs.normalizeReleases(data, 42);
  const before = structuredClone(normalized);
  const grouped = rs.groupReleaseRecords(normalized.records);
  assert.equal(grouped.length, 4);
  assert.deepEqual(grouped.find(item => item.kind === 'digital' && item.date === '2026-11-04' && item.note === '同一说明').countries, ['CA', 'US']);
  assert.equal(grouped.find(item => item.note === '不同说明').countries.length, 1);
  assert.deepEqual(normalized, before);
});

test('credential verification always uses the official validation route and refuses an invalid success response', async () => {
  const calls = [], controller = new AbortController();
  await rs.verifyCredential(async (route, credential, signal) => { calls.push({ route, credential, signal }); return { success: true, status_code: 1 }; }, config, controller.signal);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/authentication');
  assert.equal(calls[0].credential, config);
  assert.equal(calls[0].signal, controller.signal);
  await assert.rejects(rs.verifyCredential(async () => ({}), config), { code: 'format' });
  await assert.rejects(rs.verifyCredential(async () => { throw new rs.SignalError('auth', '认证失败'); }, config), { code: 'auth' });
});

test('unsupported standalone episodes and unmatched lookups cache without requesting movie release dates', async () => {
  for (const data of [find({ movie_results: [] }), find({ movie_results: [], tv_episode_results: [{ id: 7 }] })]) {
    let calls = 0;
    const service = rs.createService({ storage: memory(), request: async () => { calls++; return data; } });
    const result = await service.query('tt0111161', config);
    assert.ok(['unmatched', 'unsupported'].includes(result.result.work.kind));
    await service.query('tt0111161', config); assert.equal(calls, 1);
  }
});

test('failed refresh preserves the previous cache, and malformed/future-dated cache is ignored', async () => {
  const storage = memory(); let fail = false;
  const service = rs.createService({ storage, now: () => 100000000, request: async route => { if (fail) throw new rs.SignalError('network', 'test failure'); return route.startsWith('/find') ? find() : releases(); } });
  await service.query('tt0111161', config);
  const before = structuredClone(storage.data);
  fail = true;
  await assert.rejects(service.query('tt0111161', config, { force: true }), { code: 'network' });
  assert.deepEqual(storage.data, before);
  storage.data[rs.CACHE_KEY].entries.tt0111161.fetchedAt = 100000001;
  assert.equal(service.peek('tt0111161'), null);
  storage.data[rs.CACHE_KEY] = { version: 1, entries: { tt0111161: { fetchedAt: 1, result: {} } } };
  assert.equal(service.peek('tt0111161'), null);
});

test('credential changes invalidate old async results even if the underlying request ignores cancellation', async () => {
  const storage = memory(); let resolveOld, calls = 0;
  const service = rs.createService({ storage, request: async route => {
    calls++;
    if (calls === 1) return new Promise(resolve => { resolveOld = resolve; });
    return route.startsWith('/find') ? find({ movie_results: [] }) : releases();
  } });
  const old = service.query('tt0111161', config);
  const oldRejected = assert.rejects(old, { code: 'cancelled' });
  service.invalidate();
  const fresh = await service.query('tt0111161', rs.parseConfig('token', 'replacement'));
  resolveOld(find()); await oldRejected;
  assert.equal(fresh.result.work.kind, 'unmatched');
  assert.equal(storage.data[rs.CACHE_KEY].entries.tt0111161.result.work.kind, 'unmatched');
  assert.equal(calls, 2);
});

test('bounded cache evicts oldest entries; storage failures do not erase a successful network result', async () => {
  const storage = memory(); let now = 100000;
  const service = rs.createService({ storage, now: () => now++, request: async () => find({ movie_results: [] }) });
  for (let index = 0; index < 101; index++) await service.query('tt' + (1000000 + index), config);
  const entries = storage.data[rs.CACHE_KEY].entries;
  assert.equal(Object.keys(entries).length, 100);
  assert.equal(Object.hasOwn(entries, 'tt1000000'), false);
  const broken = rs.createService({ storage: { get() { throw Error('unavailable'); }, set() { throw Error('unavailable'); } }, request: async () => find({ movie_results: [] }) });
  const result = await broken.query('tt0111161', config);
  assert.equal(result.result.work.kind, 'unmatched'); assert.equal(result.cacheWarning, true);
});

test('metadata keeps install scope and grants narrow, with only the project publication URLs', () => {
  const source = readFileSync(path.resolve(__dirname, '../release-signal.user.js'), 'utf8');
  const header = source.split('// ==/UserScript==')[0];
  assert.match(header, /@match\s+https:\/\/movie\.douban\.com\/subject\/\*/);
  assert.match(header, /@noframes/);
  assert.match(header, /@inject-into\s+content/);
  assert.match(header, /@sandbox\s+DOM/);
  assert.match(header, /@grant\s+GM_addValueChangeListener/);
  assert.match(header, /@license\s+MIT\b/);
  assert.deepEqual([...header.matchAll(/@connect\s+(\S+)/g)].map(match => match[1]), ['api.themoviedb.org', 'api.tmdb.org']);
  assert.doesNotMatch(header, /@(?:require|resource|author)\b/);
  for (const field of ['downloadURL', 'updateURL']) {
    assert.equal(header.match(new RegExp('@' + field + '\\s+(\\S+)'))?.[1], 'https://raw.githubusercontent.com/chenfangshuo/Release-Signal/main/release-signal.user.js');
  }
  assert.match(header, /@homepageURL\s+https:\/\/github\.com\/chenfangshuo\/Release-Signal\s/);
  assert.match(header, /@supportURL\s+https:\/\/github\.com\/chenfangshuo\/Release-Signal\/issues\s/);
  assert.doesNotMatch(source, /\b(?:innerHTML|outerHTML|unsafeWindow|localStorage|document\.cookie|GM_cookie|console\.log)\b/);
});
