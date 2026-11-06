'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const rs = require('../release-signal.user.js');

const credential = rs.parseConfig('token', 'fixture-tv-token-not-real');
const finding = () => ({ movie_results: [], tv_results: [{ id: 55, name: '示例剧集' }] });
const series = (count = 2) => ({ id: 55, name: '示例剧集', status: 'Returning Series', seasons: [
  { id: 501, season_number: 1, episode_count: count, air_date: '2026-11-01' },
  { id: 502, season_number: 2, episode_count: count, air_date: '2026-11-01' },
  { id: 500, season_number: 0, episode_count: count, air_date: null },
] });
const episode = (number, date, type = 'standard', season = 2) => ({ id: season * 1000 + number, show_id: 55, season_number: season, episode_number: number, air_date: date, name: '第 ' + number + ' 集', episode_type: type });
const season = (...episodes) => ({ id: 502, season_number: 2, air_date: '2026-11-01', episodes });
function state(data, catalog = series(), today = '2026-11-05') {
  const show = rs.normalizeSeries(catalog, 55);
  return rs.deriveTvStatus(show, rs.normalizeSeason(data, show, data.season_number), today);
}
const memory = () => {
  const data = {};
  return { data, get: (key, fallback) => structuredClone(data[key] ?? fallback), set: (key, value) => { data[key] = structuredClone(value); } };
};

test('season hints use only explicit labels, selected season and season titles; missing/conflicting hints stay unresolved', () => {
  assert.deepEqual(rs.extractSeasonHint(null, '示例电影 2026'), { number: null, conflict: false });
  assert.equal(rs.extractSeasonHint({ innerText: '季数：2\n集数：10' }, '示例剧集 第二季').number, 2);
  assert.equal(rs.extractSeasonHint(null, 'Example Season 12').number, 12);
  assert.equal(rs.extractSeasonHint(null, '示例剧集 第一百零二季').number, 102);
  assert.equal(rs.extractSeasonHint(null, '示例剧集 第十十季').number, null);
  assert.equal(rs.extractSeasonHint(null, '示例剧集 第一百二季').number, null);
  assert.equal(rs.extractSeasonHint({ innerText: '季数：2' }, '示例剧集 第一季').conflict, true);
  assert.equal(rs.extractSeasonHint({ querySelector: () => ({ selectedOptions: [{ textContent: '2' }] }), innerText: '季数：1\n2\n3' }, '').number, 2);
});

test('TV shows have independent latest/next episodes; broadcast dates do not imply a season finale', () => {
  const progress = state(season(episode(1, '2026-11-04'), episode(2, '2026-11-11')));
  assert.equal(progress.status, 'available');
  assert.equal(progress.complete, false);
  assert.equal(progress.last.episode_number, 1);
  assert.equal(progress.next.episode_number, 2);
  assert.match(progress.text, /已有播出记录/);
  const planned = state(season(episode(1, '2026-11-11'), episode(2, '2026-11-18', 'finale')));
  assert.equal(planned.status, 'future');
  assert.equal(planned.text, '预计开播 · 2026-11-11');
  assert.equal(state(season(episode(1, null), episode(2, null))).status, 'unknown');
  assert.equal(state(season(episode(2, '2026-11-11', 'finale'))).status, 'unknown');
});

test('a complete known season with a final episode flag turns green at the calendar boundary', () => {
  const data = season(episode(1, '2026-11-04'), episode(2, '2026-11-06', 'finale'));
  assert.equal(state(data).complete, false);
  const completed = state(data, series(), '2026-11-06');
  assert.equal(completed.complete, true);
  assert.equal(completed.status, 'available');
  assert.equal(completed.text, '本季完结 · 2 集');
});

test('season premiere dates cannot fall after an episode when confirming completion, including cached data', () => {
  for (const [catalogDate, detailDate] of [
    ['2027-01-01', '2027-01-01'], ['2027-01-01', '2026-11-01'],
    ['2026-11-01', '2027-01-01'], ['2026-11-03', '2026-11-03'],
    [null, '2027-01-01'], ['2027-01-01', null],
  ]) {
    const catalog = series(); catalog.seasons[1].air_date = catalogDate;
    const show = rs.normalizeSeries(catalog, 55);
    const data = season(episode(1, '2026-11-01'), episode(2, '2026-11-04', 'finale'));
    data.air_date = detailDate;
    const normalized = rs.normalizeSeason(data, show, 2);
    for (const current of [normalized, rs.normalizeSeason(normalized, show, 2)]) {
      for (const today of ['2026-11-05', '2027-02-01']) {
        const result = rs.deriveTvStatus(show, current, today);
        assert.equal(result.premiereConflict, true, JSON.stringify([catalogDate, detailDate]));
        assert.equal(result.complete, false);
        assert.equal(result.status, 'available');
        assert.equal(result.text, '已有播出记录 · 第 2 集');
      }
    }
  }
  for (const start of ['2026-10-30', '2026-11-01', null]) {
    const catalog = series(); catalog.seasons[1].air_date = start;
    const data = season(episode(1, '2026-11-01'), episode(2, '2026-11-04', 'finale'));
    data.air_date = start;
    assert.equal(state(data, catalog).complete, true);
    assert.equal(state(data, catalog).premiereConflict, false);
  }
  const future = state(season(episode(1, '2026-11-11'), episode(2, '2026-11-18', 'finale')));
  assert.equal(future.premiereConflict, false);
  assert.equal(future.text, '预计开播 · 2026-11-11');
});

test('contradictory premiere dates shorten a previously completed season cache to six hours', () => {
  const at = new Date(2026, 10, 5, 12).getTime();
  const catalog = series(); catalog.seasons[1].air_date = '2027-01-01';
  const show = rs.normalizeSeries(catalog, 55);
  const data = rs.normalizeSeason(season(episode(1, '2026-09-01'), episode(2, '2026-09-02', 'finale')), show, 2);
  const storage = memory();
  storage.data[rs.CACHE_KEY] = { version: 1, entries: { 'tt1234567:s2': {
    fetchedAt: at, expiresAt: at + rs.CACHE_LONG_TTL,
    result: { work: { kind: 'tv', id: 55, title: '测试' }, series: show, seasonNumber: 2, season: data },
  } } };
  const service = rs.createService({ storage, now: () => at + rs.CACHE_SHORT_TTL, request: async () => { throw Error('unexpected request'); } });
  const cached = service.peek('tt1234567', { seasonNumber: 2 });
  assert.equal(cached.expiresAt, at + rs.CACHE_SHORT_TTL);
  assert.equal(cached.fresh, false);
  assert.equal(rs.deriveTvStatus(cached.result.series, cached.result.season, '2026-11-05').complete, false);
});

test('all-past dates, Ended/Canceled or missing next episode alone never establish completion', () => {
  for (const status of ['Ended', 'Canceled', 'Returning Series']) {
    const show = { ...series(), status, next_episode_to_air: null };
    assert.equal(state(season(episode(1, '2026-11-01'), episode(2, '2026-11-02')), show).complete, false);
    assert.equal(state(season(episode(1, '2026-11-01'), episode(2, '2026-11-02', 'mid_season')), show).complete, false);
  }
});

test('missing dates, unknown counts, number gaps, duplicate IDs, multiple/non-final finale flags and conflicting dates forbid completion', () => {
  const good = () => season(episode(1, '2026-11-01'), episode(2, '2026-11-02', 'finale'));
  const cases = [
    season(episode(1, null), episode(2, '2026-11-02', 'finale')),
    season(episode(1, '2026-02-29'), episode(2, '2026-11-02', 'finale')),
    season(episode(1, '2026-11-01'), episode(3, '2026-11-02', 'finale')),
    season(episode(1, '2026-11-01', 'finale'), episode(2, '2026-11-02', 'finale')),
    season(episode(1, '2026-11-01', 'finale'), episode(2, '2026-11-02')),
    season(episode(1, '2026-11-03'), episode(2, '2026-11-02', 'finale')),
    season(episode(1, '2026-11-01'), episode(2, '2026-11-02', 'finale'), episode(2, '2026-11-02', 'finale')),
  ];
  const sameId = good(); sameId.episodes[1].id = sameId.episodes[0].id; cases.push(sameId);
  const wrongShow = good(); wrongShow.episodes[1].show_id = 99; cases.push(wrongShow);
  for (const data of cases) assert.equal(state(data).complete, false);
  for (const count of [null, undefined, 0, 3, '2']) {
    const show = series(); show.seasons.forEach(item => { item.episode_count = count; });
    assert.equal(state(good(), show).complete, false);
  }
});

test('specials are open collections and cannot be declared complete', () => {
  const data = { id: 500, season_number: 0, episodes: [episode(1, '2026-11-01', 'standard', 0), episode(2, '2026-11-02', 'finale', 0)] };
  assert.equal(state(data).complete, false);
});

test('series/season identities are validated, malformed records stay incomplete after cache normalization', () => {
  const show = rs.normalizeSeries(series(), 55);
  assert.throws(() => rs.normalizeSeries(series(), 99), { code: 'format' });
  assert.throws(() => rs.normalizeSeason(season(), show, 1), { code: 'format' });
  const duplicate = series(); duplicate.seasons.push(duplicate.seasons[0]);
  assert.throws(() => rs.normalizeSeries(duplicate, 55), { code: 'format' });
  const data = season(episode(1, '2026-11-01'), episode(2, '2026-11-02', 'finale'), null);
  const normalized = rs.normalizeSeason(data, show, 2);
  assert.equal(normalized.invalidCount, 1);
  assert.equal(rs.deriveTvStatus(show, rs.normalizeSeason(normalized, show, 2), '2026-11-05').complete, false);
});

test('TV cache keys separate seasons and unselected series, and requests never use movie release dates', async () => {
  const storage = memory(), calls = [];
  const service = rs.createService({ storage, request: async path => {
    calls.push(path);
    if (path.startsWith('/find/')) return finding();
    if (path === '/tv/55') return series();
    const number = Number(path.split('/').at(-1));
    return { id: 500 + number, season_number: number, episodes: [episode(1, '2026-11-01', 'standard', number), episode(2, '2026-11-04', 'finale', number)] };
  } });
  const catalog = await service.query('tt1234567', credential);
  assert.equal(catalog.result.seasonNumber, null);
  assert.equal(calls.length, 2);
  const first = service.query('tt1234567', credential, { seasonNumber: 1 });
  assert.equal(first, service.query('tt1234567', credential, { seasonNumber: 1 }));
  await first;
  await service.query('tt1234567', credential, { seasonNumber: 2 });
  assert.equal(service.peek('tt1234567', { seasonNumber: 1 }).result.season.season_number, 1);
  assert.equal(service.peek('tt1234567', { seasonNumber: 2 }).result.season.season_number, 2);
  const before = calls.length;
  await service.query('tt1234567', credential, { seasonNumber: 2 });
  assert.equal(calls.length, before);
  assert.equal(Object.keys(storage.data[rs.CACHE_KEY].entries).length, 3);
  assert.equal(calls.some(path => path.startsWith('/movie/')), false);
});

test('an unknown requested season never silently falls back to the first/latest season', async () => {
  const calls = [];
  const service = rs.createService({ storage: memory(), request: async path => { calls.push(path); return path.startsWith('/find/') ? finding() : series(); } });
  const result = await service.query('tt1234567', credential, { seasonNumber: 3 });
  assert.equal(result.result.seasonNumber, null);
  assert.equal(calls.length, 2);
});

test('old unsupported TV caches are rechecked, while existing movie caches retain compatibility', async () => {
  const storage = memory(), at = Date.now(); let calls = 0;
  storage.data[rs.CACHE_KEY] = { version: 1, entries: { tt1234567: { fetchedAt: at, result: { work: { kind: 'unsupported' } } } } };
  storage.data[rs.CACHE_KEY].entries.tt7654321 = { fetchedAt: at, result: { work: { kind: 'movie', id: 42, title: '旧版电影' }, releases: { id: 42, results: [] } } };
  const service = rs.createService({ storage, now: () => at, request: async path => { calls++; return path.startsWith('/find/') ? finding() : series(); } });
  assert.equal((await service.query('tt7654321', credential)).result.work.kind, 'movie');
  assert.equal(calls, 0);
  assert.equal(service.peek('tt1234567'), null);
  assert.equal((await service.query('tt1234567', credential)).result.work.kind, 'tv');
  assert.equal(calls, 2);
});

test('TV caches expire by next episode midnight and completion cannot revive an expired entry', () => {
  const at = new Date(2026, 10, 5, 23, 59).getTime();
  const show = rs.normalizeSeries(series(), 55);
  const data = rs.normalizeSeason(season(episode(1, '2026-11-01'), episode(2, '2026-11-06', 'finale')), show, 2);
  const entry = { fetchedAt: at, result: { work: { kind: 'tv', id: 55, title: '测试' }, series: show, seasonNumber: 2, season: data } };
  assert.equal(rs.cachePolicy(entry, at).expiresAt, new Date(2026, 10, 6).getTime());
  assert.equal(rs.cachePolicy(entry, at + 120000).fresh, false);
  assert.equal(rs.cachePolicy(entry, at + 35 * 86400000).fresh, false);
});

test('TV request routes remain restricted to validated numeric series and season IDs', async () => {
  const calls = [];
  const request = rs.createRequester(details => { calls.push(details); queueMicrotask(() => details.onload({ status: 200, responseText: '{}' })); return { abort() {} }; });
  await request('/tv/55', credential);
  await request('/tv/55/season/0', credential);
  for (const path of ['/tv/55/season/-1', '/tv/55/season/1000', '/tv/55/season/2?other=x', '/tv/55/watch/providers', '/tv/55/season/2/episode/3', '/tv/nope']) await assert.rejects(request(path, credential), { code: 'format' });
  assert.equal(calls.length, 2);
});

test('a unique IMDb episode resolves only through validated parent IDs and season coordinates', () => {
  const data = { movie_results: [], tv_results: [], tv_episode_results: [episode(1, '2026-11-01')] };
  assert.deepEqual(rs.matchWork(data), { kind: 'tv', id: 55, title: '未提供剧名', sourceSeason: 2, sourceEpisode: 1, sourceEpisodeId: 2001 });
  const incomplete = structuredClone(data); delete incomplete.tv_episode_results[0].show_id;
  assert.equal(rs.matchWork(incomplete).kind, 'unsupported');
  const conflict = structuredClone(data); conflict.tv_results = [{ id: 55 }];
  assert.equal(rs.matchWork(conflict).kind, 'ambiguous');
});

test('only a sole first regular season can be inferred; specials do not count and explicit/conflicting hints take precedence', () => {
  const show = rs.normalizeSeries(series(), 55), work = { kind: 'tv', id: 55, title: '测试' };
  show.seasons = show.seasons.filter(item => item.season_number !== 2);
  assert.equal(rs.resolveSeason(show, work, null).number, 1);
  assert.equal(rs.resolveSeason(show, work, null, { autoSeason: false }).number, null);
  assert.equal(rs.resolveSeason(show, work, 2).number, null);
  show.seasons = show.seasons.map(item => item.season_number === 1 ? { ...item, season_number: 2 } : item);
  assert.equal(rs.resolveSeason(show, work, null).number, null);
  assert.equal(rs.resolveSeason(rs.normalizeSeries(series(), 55), work, null).number, null);
});

test('episode coordinates determine the season unless an explicit page conflict needs confirmation or a user previews another season', () => {
  const show = rs.normalizeSeries(series(), 55), work = { kind: 'tv', id: 55, title: '测试', sourceSeason: 2 };
  assert.equal(rs.resolveSeason(show, work, null).number, 2);
  assert.deepEqual(rs.resolveSeason(show, work, 1), { number: null, issue: 'conflict' });
  assert.equal(rs.resolveSeason(show, work, 1, { manualSeason: true }).number, 1);
});

test('single first season auto-selection is cacheable without retaining a user preference', async () => {
  const storage = memory(), calls = [];
  const show = series(); show.seasons = show.seasons.filter(item => item.season_number !== 2);
  const data = { id: 501, season_number: 1, episodes: [episode(1, '2026-11-01', 'standard', 1), episode(2, '2026-11-02', 'finale', 1)] };
  const service = rs.createService({ storage, request: async path => { calls.push(path); return path.startsWith('/find/') ? finding() : path === '/tv/55' ? show : data; } });
  assert.equal((await service.query('tt1234567', credential)).result.seasonNumber, 1);
  assert.equal((await service.query('tt1234567', credential)).fromCache, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(Object.keys(storage.data), [rs.CACHE_KEY]);
  assert.equal(service.peek('tt1234567', { autoSeason: false }), null);
});

test('episode parent mapping checks the matched episode against the selected season response', async () => {
  const storage = memory(), found = { movie_results: [], tv_results: [], tv_episode_results: [episode(1, '2026-11-01')] };
  const data = season(episode(1, '2026-11-01'), episode(2, '2026-11-02', 'finale'));
  const service = rs.createService({ storage, request: async path => path.startsWith('/find/') ? found : path === '/tv/55' ? series() : data });
  const matched = await service.query('tt1234567', credential);
  assert.equal(matched.result.seasonNumber, 2);
  assert.equal(matched.result.work.title, '示例剧集');
  storage.data[rs.CACHE_KEY].entries.tt1234567.result.work.sourceEpisodeId = 999;
  assert.equal(service.peek('tt1234567'), null);
  storage.data[rs.CACHE_KEY].entries.tt1234567.result.work.sourceEpisodeId = 2001;
  data.episodes[0].id = 999;
  await assert.rejects(service.query('tt1234567', credential, { force: true }), { code: 'format' });
  assert.equal(service.peek('tt1234567').result.season.episodes[0].id, 2001);
});
