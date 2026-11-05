// ==UserScript==
// @name         发行信号 / Release Signal
// @namespace    release-signal.local
// @version      0.5.1
// @license      MIT
// @description  在豆瓣影视详情页显示电影发行记录及剧集按季播出进度，作为搜索前的参考。
// @homepageURL  https://github.com/chenfangshuo/Release-Signal
// @supportURL   https://github.com/chenfangshuo/Release-Signal/issues
// @downloadURL  https://raw.githubusercontent.com/chenfangshuo/Release-Signal/main/release-signal.user.js
// @updateURL    https://raw.githubusercontent.com/chenfangshuo/Release-Signal/main/release-signal.user.js
// @match        https://movie.douban.com/subject/*
// @run-at       document-idle
// @noframes
// @inject-into  content
// @sandbox      DOM
// @connect      api.themoviedb.org
// @connect      api.tmdb.org
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_info
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// ==/UserScript==

/*
MIT License

Copyright (c) 2026 chenfangshuo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The embedded TMDB logo remains the property of its respective rights holder
and is not covered by the above license. See DEVELOPER.md for attribution.
*/

(function () {
  'use strict';

  // 数据与权限约定：凭据、公共发行缓存分别存储，请求只发往两个预设的 HTTPS API 地址。
  const CONFIG_KEY = 'releaseSignal.config.v1';
  const CACHE_KEY = 'releaseSignal.cache.v1';
  const CACHE_TTL = 24 * 60 * 60 * 1000;
  const CACHE_SHORT_TTL = 6 * 60 * 60 * 1000;
  const CACHE_LONG_TTL = 7 * 24 * 60 * 60 * 1000;
  const CACHE_LIMIT = 100;
  const REQUEST_TIMEOUT = 15000;
  const API_ORIGIN = 'https://api.tmdb.org';
  const API_ORIGINS = Object.freeze([API_ORIGIN, 'https://api.themoviedb.org']);
  const DISCLAIMER = '发行记录不保证已有片源；暂未查到不等于没有片源。';
  const WORK_MESSAGES = {
    unmatched: 'TMDB 未匹配到这部作品，无法确认发行记录。',
    ambiguous: 'TMDB 返回多个作品或冲突类型，无法可靠匹配。',
    unsupported: 'TMDB 匹配结果缺少可验证的所属剧集或季数，或属于其他非影视类型，暂时无法判断。',
  };

  // Official approved blue_short logo, unmodified; retrieved 2026-11-05 from:
  // https://www.themoviedb.org/assets/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg
  const TMDB_LOGO = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 273.42 35.52"><defs><style>.cls-1{fill:url(#linear-gradient);}</style><linearGradient id="linear-gradient" y1="17.76" x2="273.42" y2="17.76" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#90cea1"/><stop offset="0.56" stop-color="#3cbec9"/><stop offset="1" stop-color="#00b3e5"/></linearGradient></defs><title>Asset 3</title><g id="Layer_2" data-name="Layer 2"><g id="Layer_1-2" data-name="Layer 1"><path class="cls-1" d="M191.85,35.37h63.9A17.67,17.67,0,0,0,273.42,17.7h0A17.67,17.67,0,0,0,255.75,0h-63.9A17.67,17.67,0,0,0,174.18,17.7h0A17.67,17.67,0,0,0,191.85,35.37ZM10.1,35.42h7.8V6.92H28V0H0v6.9H10.1Zm28.1,0H46V8.25h.1L55.05,35.4h6L70.3,8.25h.1V35.4h7.8V0H66.45l-8.2,23.1h-.1L50,0H38.2ZM89.14.12h11.7a33.56,33.56,0,0,1,8.08,1,18.52,18.52,0,0,1,6.67,3.08,15.09,15.09,0,0,1,4.53,5.52,18.5,18.5,0,0,1,1.67,8.25,16.91,16.91,0,0,1-1.62,7.58,16.3,16.3,0,0,1-4.38,5.5,19.24,19.24,0,0,1-6.35,3.37,24.53,24.53,0,0,1-7.55,1.15H89.14Zm7.8,28.2h4a21.66,21.66,0,0,0,5-.55A10.58,10.58,0,0,0,110,26a8.73,8.73,0,0,0,2.68-3.35,11.9,11.9,0,0,0,1-5.08,9.87,9.87,0,0,0-1-4.52,9.17,9.17,0,0,0-2.63-3.18A11.61,11.61,0,0,0,106.22,8a17.06,17.06,0,0,0-4.68-.63h-4.6ZM133.09.12h13.2a32.87,32.87,0,0,1,4.63.33,12.66,12.66,0,0,1,4.17,1.3,7.94,7.94,0,0,1,3,2.72,8.34,8.34,0,0,1,1.15,4.65,7.48,7.48,0,0,1-1.67,5,9.13,9.13,0,0,1-4.43,2.82V17a10.28,10.28,0,0,1,3.18,1,8.51,8.51,0,0,1,2.45,1.85,7.79,7.79,0,0,1,1.57,2.62,9.16,9.16,0,0,1,.55,3.2,8.52,8.52,0,0,1-1.2,4.68,9.32,9.32,0,0,1-3.1,3A13.38,13.38,0,0,1,152.32,35a22.5,22.5,0,0,1-4.73.5h-14.5Zm7.8,14.15h5.65a7.65,7.65,0,0,0,1.78-.2,4.78,4.78,0,0,0,1.57-.65,3.43,3.43,0,0,0,1.13-1.2,3.63,3.63,0,0,0,.42-1.8A3.3,3.3,0,0,0,151,8.6a3.42,3.42,0,0,0-1.23-1.13A6.07,6.07,0,0,0,148,6.9a9.9,9.9,0,0,0-1.85-.18h-5.3Zm0,14.65h7a8.27,8.27,0,0,0,1.83-.2,4.67,4.67,0,0,0,1.67-.7,3.93,3.93,0,0,0,1.23-1.3,3.8,3.8,0,0,0,.47-1.95,3.16,3.16,0,0,0-.62-2,4,4,0,0,0-1.58-1.18,8.23,8.23,0,0,0-2-.55,15.12,15.12,0,0,0-2.05-.15h-5.9Z"/></g></g></svg>');

  class SignalError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'SignalError';
      this.code = code;
    }
  }

  const formatError = () => new SignalError('format', 'TMDB 响应格式异常，无法确认发行记录。');
  const cancelledError = () => new SignalError('cancelled', '查询已取消。');
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validId = value => Number.isSafeInteger(value) && value > 0;
  const validImdb = value => typeof value === 'string' && /^tt\d{7,12}$/.test(value);
  const validSeason = value => Number.isSafeInteger(value) && value >= 0 && value <= 999;
  const validCacheKey = value => /^tt\d{7,12}(?::s(?:0|[1-9]\d{0,2}))?$/.test(value);

  // 页面识别：只从当前详情页资料区读取 IMDb；缺失或冲突时停止，不按片名猜测。
  function isSubjectUrl(value) {
    try {
      const url = new URL(value);
      return url.origin === 'https://movie.douban.com' && /^\/subject\/[1-9]\d*\/?$/.test(url.pathname);
    } catch { return false; }
  }

  function extractImdb(info) {
    if (!info) return { kind: 'missing', message: '未找到影片资料区域，无法读取 IMDb 编号。' };
    const ids = new Set();
    for (const anchor of info.querySelectorAll('a[href]')) {
      try {
        const url = new URL(anchor.getAttribute('href'), 'https://movie.douban.com');
        if (url.hostname === 'imdb.com' || url.hostname.endsWith('.imdb.com')) {
          const match = url.pathname.match(/^\/title\/(tt\d{7,12})(?:\/|$)/i);
          if (match) ids.add(match[1].toLowerCase());
        }
      } catch { /* Malformed links are not an identity source. */ }
    }
    const text = info.innerText || info.textContent || '';
    for (const match of text.matchAll(/\bIMDb\s*[:：]?\s*(tt\d{7,12})\b/gi)) ids.add(match[1].toLowerCase());
    if (ids.size > 1) return { kind: 'conflict', message: '资料区域有冲突的 IMDb 编号，无法可靠判断。' };
    if (ids.size === 0) return { kind: 'missing', message: '资料区域未找到 IMDb 编号；不会按片名猜测作品。' };
    return { kind: 'found', id: [...ids][0] };
  }

  function matchWork(data) {
    if (!isObject(data) || !Array.isArray(data.movie_results) || !Array.isArray(data.tv_results)) throw formatError();
    const groups = ['movie_results', 'tv_results', 'tv_season_results', 'tv_episode_results', 'person_results'];
    for (const key of groups) {
      if (data[key] !== undefined && !Array.isArray(data[key])) throw formatError();
      if ((data[key] || []).some(item => !isObject(item) || !validId(item.id))) throw formatError();
    }
    const movies = data.movie_results;
    const otherTitles = ['tv_results', 'tv_season_results', 'tv_episode_results'].flatMap(key => data[key] || []);
    if (movies.length + otherTitles.length > 1 || (movies.length + otherTitles.length && (data.person_results || []).length)) return { kind: 'ambiguous' };
    if (movies.length === 1) {
      const movie = movies[0];
      return { kind: 'movie', id: movie.id, title: typeof movie.title === 'string' ? movie.title : '未提供片名' };
    }
    if (data.tv_results.length === 1) {
      const series = data.tv_results[0];
      return { kind: 'tv', id: series.id, title: typeof series.name === 'string' ? series.name : '未提供剧名' };
    }
    // 豆瓣的整季条目有时使用首集的 IMDb 编号，只能凭所属 ID 和季号定位，之后还会核对单集身份。
    const episode = data.tv_episode_results?.[0], season = data.tv_season_results?.[0];
    const child = episode || season;
    if (child && validId(child.show_id) && validSeason(child.season_number)) {
      if (episode && (!Number.isSafeInteger(episode.episode_number) || episode.episode_number < 1 || episode.episode_number > 10000)) return { kind: 'unsupported' };
      return { kind: 'tv', id: child.show_id, title: '未提供剧名', sourceSeason: child.season_number,
        ...(episode ? { sourceEpisode: episode.episode_number, sourceEpisodeId: episode.id } : { sourceSeasonId: season.id }) };
    }
    if (otherTitles.length || (data.person_results || []).length) return { kind: 'unsupported' };
    return { kind: 'unmatched' };
  }

  function seasonNumber(value) {
    if (/^\d{1,3}$/.test(value)) return validSeason(Number(value)) ? Number(value) : null;
    const digits = '零一二三四五六七八九';
    let total = 0, current = 0;
    if (!value || !/^(?:[一二三四五六七八九两]百(?:[一二三四五六七八九两]十[一二三四五六七八九]?|[零〇][一二三四五六七八九])?|[一二三四五六七八九两]?十[一二三四五六七八九]?|[零〇一二三四五六七八九两])$/.test(value)) return null;
    for (const char of value.replaceAll('两', '二').replaceAll('〇', '零')) {
      if (char === '十' || char === '百') { total += (current || 1) * (char === '十' ? 10 : 100); current = 0; }
      else current = digits.indexOf(char);
    }
    return validSeason(total + current) ? total + current : null;
  }

  function extractSeasonHint(info, title = '') {
    const numbers = new Set();
    const add = value => { const number = seasonNumber(value); if (number !== null) numbers.add(number); };
    const select = info?.querySelector?.('select#season');
    if (select) {
      const label = select.selectedOptions?.[0]?.textContent?.trim() || '';
      const match = label.match(/^(?:第\s*)?([\d零〇一二三四五六七八九十百两]+)(?:\s*季)?$/);
      if (match) add(match[1]);
    } else {
      const text = info?.innerText || info?.textContent || '';
      for (const match of text.matchAll(/(?:^|\n)\s*季数\s*[:：]\s*(\d{1,3})(?=\s*(?:\n|$))/g)) add(match[1]);
    }
    for (const match of title.matchAll(/第\s*([\d零〇一二三四五六七八九十百两]+)\s*季|\bSeason\s+(\d{1,3})\b/gi)) add(match[1] || match[2]);
    return { number: numbers.size === 1 ? [...numbers][0] : null, conflict: numbers.size > 1 };
  }

  // 剧集数据：仅保留判定需要的字段。保留异常计数，避免缓存再次规范化后把不完整资料判成完结。
  function normalizeSeries(data, seriesId) {
    if (!isObject(data) || data.id !== seriesId || !Array.isArray(data.seasons)) throw formatError();
    const seasons = [], seen = new Set();
    let invalidCount = Number.isSafeInteger(data.invalidCount) && data.invalidCount > 0 ? data.invalidCount : 0;
    for (const item of data.seasons) {
      if (!isObject(item) || !validId(item.id) || !validSeason(item.season_number)) { invalidCount++; continue; }
      if (seen.has(item.season_number)) throw formatError();
      seen.add(item.season_number);
      seasons.push({ id: item.id, season_number: item.season_number, name: typeof item.name === 'string' ? item.name : '',
        episode_count: Number.isSafeInteger(item.episode_count) && item.episode_count >= 0 && item.episode_count <= 10000 ? item.episode_count : null,
        air_date: sourceDate(item.air_date) });
    }
    seasons.sort((a, b) => a.season_number - b.season_number);
    return { id: seriesId, name: typeof data.name === 'string' ? data.name : '', seasons, invalidCount };
  }

  // 自动识别须服从明确的季号与冲突检查；用户主动切季允许临时查看同一剧集的其他季。
  function resolveSeason(series, work, requested, { autoSeason = true, manualSeason = false } = {}) {
    const has = number => series.seasons.some(item => item.season_number === number);
    if (requested !== null) {
      if (!manualSeason && work.sourceSeason !== undefined && work.sourceSeason !== requested) return { number: null, issue: 'conflict' };
      return has(requested) ? { number: requested, issue: '' } : { number: null, issue: 'missing' };
    }
    if (!autoSeason) return { number: null, issue: 'conflict' };
    if (work.sourceSeason !== undefined) return has(work.sourceSeason) ? { number: work.sourceSeason, issue: '' } : { number: null, issue: 'missing' };
    const regular = series.seasons.filter(item => item.season_number > 0);
    return !series.invalidCount && regular.length === 1 && regular[0].season_number === 1 ? { number: 1, issue: '' } : { number: null, issue: '' };
  }

  function normalizeSeason(data, series, number) {
    const summary = series.seasons.find(item => item.season_number === number);
    if (!summary || !isObject(data) || data.id !== summary.id || data.season_number !== number || !Array.isArray(data.episodes)) throw formatError();
    const episodes = [], numbers = new Set(), ids = new Set();
    let invalidCount = Number.isSafeInteger(data.invalidCount) && data.invalidCount > 0 ? data.invalidCount : 0;
    for (const item of data.episodes) {
      if (!isObject(item) || !validId(item.id) || !Number.isSafeInteger(item.episode_number) || item.episode_number < 1 || item.episode_number > 10000 ||
          item.season_number !== number || (item.show_id !== undefined && item.show_id !== series.id)) { invalidCount++; continue; }
      if (numbers.has(item.episode_number) || ids.has(item.id)) { invalidCount++; continue; }
      numbers.add(item.episode_number); ids.add(item.id);
      episodes.push({ id: item.id, episode_number: item.episode_number, season_number: number,
        air_date: sourceDate(item.air_date), name: typeof item.name === 'string' ? item.name : '',
        episode_type: typeof item.episode_type === 'string' ? item.episode_type : '' });
    }
    episodes.sort((a, b) => a.episode_number - b.episode_number);
    return { id: summary.id, season_number: number, air_date: sourceDate(data.air_date) || summary.air_date, episodes, invalidCount };
  }

  function deriveTvStatus(series, season, today) {
    if (!season) return { status: 'unknown', complete: false, text: '请确认季数', last: null, next: null };
    const summary = series.seasons.find(item => item.season_number === season.season_number);
    const episodes = season.episodes;
    const dated = episodes.filter(item => item.air_date);
    const byDate = (a, b) => a.air_date.localeCompare(b.air_date) || a.episode_number - b.episode_number;
    const past = dated.filter(item => item.air_date <= today).sort(byDate);
    const future = dated.filter(item => item.air_date > today).sort(byDate);
    const last = past.at(-1) || null, next = future[0] || null;
    const contiguous = episodes.every((item, index) => item.episode_number === index + 1);
    const orderedDates = episodes.every((item, index) => !index || (item.air_date && episodes[index - 1].air_date && item.air_date >= episodes[index - 1].air_date));
    const finales = episodes.filter(item => item.episode_type === 'finale');
    // 完结须同时有季终标记、完整连续的集数和已到日期。下一集为空、全剧 Ended/Canceled
    // 或已有日期全部过去，都不能单独作为依据；第 0 季的特别篇是开放集合，不判完结。
    const complete = season.season_number > 0 && !series.invalidCount && !season.invalidCount &&
      summary?.episode_count > 0 && episodes.length === summary.episode_count && contiguous && orderedDates &&
      past.length === episodes.length && finales.length === 1 && finales[0] === episodes.at(-1);
    let status = 'unknown', text = '暂未查到播出信息';
    if (complete) { status = 'available'; text = '本季完结 · ' + episodes.length + ' 集'; }
    else if (last) { status = 'available'; text = '已有播出记录 · 第 ' + last.episode_number + ' 集'; }
    else {
      const firstDate = episodes.find(item => item.episode_number === 1)?.air_date;
      const premiere = firstDate > today ? firstDate : season.air_date > today ? season.air_date : null;
      if (premiere) { status = 'future'; text = '预计开播 · ' + premiere; }
    }
    return { status, complete: Boolean(complete), text, last, next };
  }

  // 日期判定：展示来源标注的日历日期，不把它当作已核实的精确上线时刻。
  // 即使接口带时分秒，也保留 YYYY-MM-DD；强行转换时区可能跨天，导致与来源日期不一致。
  function sourceDate(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d))?$/);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (!year || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
    if (match[7] && match[7] !== 'Z' && Number(match[7].slice(1, 3)) === 14 && match[7].slice(4) !== '00') return null;
    return value.slice(0, 10);
  }

  // 用户的“今天”仍按浏览器本地时区计算；国内正常时区下就是北京时间的日历日。
  function localDay(value) {
    const date = new Date(value);
    return [date.getFullYear().toString().padStart(4, '0'), (date.getMonth() + 1).toString().padStart(2, '0'), date.getDate().toString().padStart(2, '0')].join('-');
  }

  function normalizeReleases(data, movieId) {
    if (!isObject(data) || data.id !== movieId || !Array.isArray(data.results)) throw formatError();
    const records = [], seen = new Set();
    let invalidCount = 0;
    for (const group of data.results) {
      if (!isObject(group) || !Array.isArray(group.release_dates)) { invalidCount++; continue; }
      const country = typeof group.iso_3166_1 === 'string' && /^[A-Z]{2}$/.test(group.iso_3166_1) ? group.iso_3166_1 : '--';
      for (const item of group.release_dates) {
        if (!isObject(item)) { invalidCount++; continue; }
        if (item.type !== 4 && item.type !== 5) continue;
        const date = sourceDate(item.release_date);
        if (!date) { invalidCount++; continue; }
        const record = { kind: item.type === 4 ? 'digital' : 'physical', date, rawDate: item.release_date, country, note: typeof item.note === 'string' ? item.note : '' };
        const key = JSON.stringify([record.kind, date, country, record.note]);
        if (!seen.has(key)) { records.push(record); seen.add(key); }
      }
    }
    records.sort((a, b) => a.date.localeCompare(b.date) || a.country.localeCompare(b.country) || a.kind.localeCompare(b.kind));
    return { records, invalidCount };
  }

  function deriveStatus(normalized, today) {
    const parts = {};
    for (const kind of ['digital', 'physical']) {
      const records = normalized.records.filter(record => record.kind === kind);
      const past = records.filter(record => record.date <= today);
      parts[kind] = { status: past.length ? 'available' : records.length ? 'future' : 'unknown', date: (past[0] || records[0] || {}).date || null };
    }
    const states = Object.values(parts).map(part => part.status);
    return { status: states.includes('available') ? 'available' : states.includes('future') ? 'future' : 'unknown', ...parts };
  }

  function groupReleaseRecords(records) {
    const groups = new Map();
    for (const record of records) {
      const key = JSON.stringify([record.kind, record.date, record.note]);
      if (!groups.has(key)) groups.set(key, { kind: record.kind, date: record.date, note: record.note, countries: [] });
      const group = groups.get(key);
      if (!group.countries.includes(record.country)) group.countries.push(record.country);
    }
    const result = [...groups.values()];
    for (const group of result) group.countries.sort();
    return result.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.note.localeCompare(b.note));
  }

  function cachePolicyAt(entry, at) {
    const tv = entry.result.work.kind === 'tv';
    const series = tv ? normalizeSeries(entry.result.series, entry.result.work.id) : null;
    const season = tv && entry.result.seasonNumber !== null ? normalizeSeason(entry.result.season, series, entry.result.seasonNumber) : null;
    const records = entry.result.work.kind === 'movie' ? normalizeReleases(entry.result.releases, entry.result.work.id).records :
      tv && season ? [...season.episodes.map(item => ({ date: item.air_date })), { date: season.air_date }].filter(item => item.date) : [];
    const today = localDay(at);
    // UTC 只用于计算两个日历日相差几天，避免夏令时干扰；不用于转换或展示发行日期。
    const dayNumber = day => Date.parse(day + 'T00:00:00Z') / 86400000;
    const distances = records.map(record => dayNumber(record.date) - dayNumber(today));
    let ttl = CACHE_TTL;
    if (!records.length || distances.some(distance => Math.abs(distance) <= 7)) ttl = CACHE_SHORT_TTL;
    else if (distances.every(distance => distance <= -30)) ttl = CACHE_LONG_TTL;
    if (tv && !deriveTvStatus(series, season, today).complete) ttl = CACHE_SHORT_TTL;
    let expiresAt = entry.fetchedAt + ttl;
    const fetchedDay = localDay(entry.fetchedAt);
    const nextDate = records.filter(record => record.date > fetchedDay).map(record => record.date).sort()[0];
    if (nextDate) {
      const [year, month, day] = nextDate.split('-').map(Number);
      const boundary = new Date(entry.fetchedAt);
      boundary.setFullYear(year, month - 1, day);
      boundary.setHours(0, 0, 0, 0);
      expiresAt = Math.min(expiresAt, boundary.getTime());
    }
    return { ttl, expiresAt, fresh: at >= entry.fetchedAt && at < expiresAt };
  }

  function cachePolicy(entry, at) {
    // 缓存期限只允许提前，不能延长。旧缓存按查询当天推导初始期限，防止记录变旧后“复活”。
    const original = cachePolicyAt(entry, entry.fetchedAt);
    const current = cachePolicyAt(entry, at);
    const stored = Number.isFinite(entry.expiresAt) ? entry.expiresAt : original.expiresAt;
    const expiresAt = Math.min(original.expiresAt, current.expiresAt, stored);
    return { ttl: expiresAt - entry.fetchedAt, expiresAt, fresh: at >= entry.fetchedAt && at < expiresAt };
  }

  // 凭据保护：仅接受可确认的隔离环境；未知环境暂停查询和输入，不退回网页密钥表单。
  function isIsolatedRuntime(info) {
    return Boolean(info && (
      (info.scriptHandler === 'Violentmonkey' && info.injectInto === 'content') ||
      (info.scriptHandler === 'Tampermonkey' && info.sandboxMode === 'dom')
    ));
  }

  function sameConfig(left, right) {
    return left === right || Boolean(left && right && left.mode === right.mode && left.value === right.value && left.apiOrigin === right.apiOrigin);
  }

  function parseConfig(mode, rawValue, apiOrigin = API_ORIGIN) {
    if (!API_ORIGINS.includes(apiOrigin)) throw new SignalError('config', '请选择预设的 HTTPS API 地址。');
    let value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (mode === 'token') value = value.replace(/^Bearer\s+/i, '');
    if (!['token', 'key'].includes(mode) || !value || value.length > 4096 || !/^[a-zA-Z0-9._-]+$/.test(value)) {
      throw new SignalError('config', '请选择凭据类型并填写有效凭据；不要包含空格或换行。');
    }
    return { version: 1, mode, value, apiOrigin };
  }

  function httpError(status) {
    if (status === 401 || status === 403) return new SignalError('auth', 'TMDB 认证失败或无访问权限，请检查凭据设置。');
    if (status === 429) return new SignalError('rate', 'TMDB 请求过于频繁，请稍后手动重试。');
    if (status >= 500) return new SignalError('server', 'TMDB 服务暂时异常，请稍后重试。');
    if (status === 404) return new SignalError('notfound', 'TMDB 的作品或接口信息不可用，无法确认发行记录。');
    return new SignalError('http', 'TMDB 请求失败（HTTP ' + status + '），请稍后重试。');
  }

  // 请求层：独立计时并主动 abort，不只依赖管理器的 timeout 回调；原始错误和完整 URL 不外显。
  // 用包装函数保留原生计时器的接收者，避免隔离世界中出现 Illegal invocation。
  function createRequester(gmRequest, timers = {
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: id => globalThis.clearTimeout(id),
  }) {
    return function request(path, config, signal) {
      if (!/^\/(?:authentication|find\/tt\d{7,12}|movie\/[1-9]\d*\/release_dates|tv\/[1-9]\d*(?:\/season\/(?:0|[1-9]\d{0,2}))?)$/.test(path)) return Promise.reject(formatError());
      // 未保存地址时使用当前默认值，显式选择保持不变；拒绝任意主机或 HTTP。
      const origin = config?.apiOrigin === undefined ? API_ORIGIN : config.apiOrigin;
      if (!API_ORIGINS.includes(origin)) return Promise.reject(new SignalError('config', '请选择预设的 HTTPS API 地址。'));
      return new Promise((resolve, reject) => {
        let handle, timer, settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          timers.clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          if (error) reject(error); else resolve(value);
        };
        const stop = error => {
          finish(error);
          try { handle?.abort(); } catch { /* No raw manager errors or URLs are logged. */ }
        };
        const cancel = () => stop(cancelledError());
        if (signal?.aborted) { finish(cancelledError()); return; }
        const url = new URL('/3' + path, origin);
        if (path.startsWith('/find/')) url.searchParams.set('external_source', 'imdb_id');
        const headers = { Accept: 'application/json' };
        if (config.mode === 'token') headers.Authorization = 'Bearer ' + config.value;
        else url.searchParams.set('api_key', config.value);
        signal?.addEventListener('abort', cancel, { once: true });
        timer = timers.setTimeout(() => stop(new SignalError('timeout', 'TMDB 查询超时（15 秒），请检查网络后重试。')), REQUEST_TIMEOUT);
        try {
          handle = gmRequest({
            method: 'GET', url: url.href, headers, anonymous: true,
            timeout: REQUEST_TIMEOUT, redirect: 'error',
            onload(response) {
              if (settled) return;
              try {
                if (response.finalUrl && new URL(response.finalUrl).origin !== origin) throw new SignalError('network', 'TMDB 请求发生异常跳转，已拒绝使用其结果。');
                if (response.status === 0) throw new SignalError('network', '无法连接 TMDB，请检查网络后重试。');
                if (response.status < 200 || response.status >= 300) throw httpError(response.status);
                let data;
                try { data = JSON.parse(response.responseText); } catch { throw formatError(); }
                if (!isObject(data)) throw formatError();
                if (data.success === false) throw httpError(data.status_code === 7 || data.status_code === 3 ? 401 : 400);
                finish(null, data);
              } catch (error) { finish(error instanceof SignalError ? error : formatError()); }
            },
            onerror: () => finish(new SignalError('network', '无法连接 TMDB，请检查网络或在设置中尝试备用 API 地址。连接失败不代表没有发行记录。')),
            ontimeout: () => stop(new SignalError('timeout', 'TMDB 查询超时（15 秒），请检查网络后重试。')),
            onabort: () => finish(cancelledError()),
          });
          if (settled && signal?.aborted) { try { handle?.abort(); } catch { /* Already cancelled. */ } }
        } catch { finish(new SignalError('network', '无法发送 TMDB 请求，请检查脚本管理器的网络权限。')); }
      });
    };
  }

  async function verifyCredential(request, config, signal) {
    const data = await request('/authentication', config, signal);
    if (data.success !== true) throw formatError();
  }

  function validResult(result) {
    if (!isObject(result) || !isObject(result.work)) return false;
    if (result.work.kind === 'unsupported') return result.supportVersion === 3;
    if (!['movie', 'tv'].includes(result.work.kind)) return Object.hasOwn(WORK_MESSAGES, result.work.kind);
    if (!validId(result.work.id) || typeof result.work.title !== 'string') return false;
    try {
      if (result.work.kind === 'movie') normalizeReleases(result.releases, result.work.id);
      else {
        const series = normalizeSeries(result.series, result.work.id);
        if (result.work.sourceSeason !== undefined && !validSeason(result.work.sourceSeason)) return false;
        if (result.work.sourceEpisode !== undefined && (!validSeason(result.work.sourceSeason) || !validId(result.work.sourceEpisode) || result.work.sourceEpisode > 10000 || !validId(result.work.sourceEpisodeId))) return false;
        if (result.work.sourceSeasonId !== undefined && (!validSeason(result.work.sourceSeason) || !validId(result.work.sourceSeasonId) || series.seasons.find(item => item.season_number === result.work.sourceSeason)?.id !== result.work.sourceSeasonId)) return false;
        if (result.seasonNumber !== null) {
          if (!validSeason(result.seasonNumber)) return false;
          const season = normalizeSeason(result.season, series, result.seasonNumber);
          if (result.work.sourceEpisode !== undefined && result.seasonNumber === result.work.sourceSeason &&
              season.episodes.find(item => item.episode_number === result.work.sourceEpisode)?.id !== result.work.sourceEpisodeId) return false;
        } else if (result.season != null) return false;
      }
      return true;
    } catch { return false; }
  }

  // 查询与缓存：同一查询合并；分季缓存不能代替当前页面的季数选择。
  function createService({ request, storage, now = Date.now }) {
    let generation = 0;
    const inflight = new Map();
    const readEntries = () => {
      const cache = storage.get(CACHE_KEY, null);
      return isObject(cache) && cache.version === 1 && isObject(cache.entries) ? cache.entries : {};
    };
    const keyFor = (imdb, number) => imdb + (number === null ? '' : ':s' + number);
    function peek(imdb, { seasonNumber = null, autoSeason = true, manualSeason = false } = {}) {
      try {
        if (!validImdb(imdb) || (seasonNumber !== null && !validSeason(seasonNumber))) return null;
        const entry = readEntries()[keyFor(imdb, seasonNumber)];
        if (!isObject(entry) || !Number.isFinite(entry.fetchedAt) || entry.fetchedAt > now() || !validResult(entry.result)) return null;
        let result = entry.result;
        if (result.work.kind === 'tv') {
          const series = normalizeSeries(result.series, result.work.id);
          const resolved = resolveSeason(series, result.work, seasonNumber, { autoSeason, manualSeason });
          if (result.seasonNumber !== resolved.number) return null;
          result = { ...result, series, seasonIssue: resolved.issue, season: result.seasonNumber === null ? null : normalizeSeason(result.season, series, result.seasonNumber) };
        }
        return { result, fetchedAt: entry.fetchedAt, fromCache: true, ...cachePolicy({ ...entry, result }, now()) };
      } catch { return null; }
    }
    function save(imdb, entry) {
      try {
        const entries = { ...readEntries(), [imdb]: entry };
        const trimmed = Object.entries(entries)
          .filter(([key, value]) => validCacheKey(key) && isObject(value) && Number.isFinite(value.fetchedAt) && value.fetchedAt <= now() && validResult(value.result))
          .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, CACHE_LIMIT);
        storage.set(CACHE_KEY, { version: 1, entries: Object.fromEntries(trimmed) });
        return true;
      } catch { return false; }
    }
    function query(imdb, config, { force = false, seasonNumber = null, autoSeason = true, manualSeason = false } = {}) {
      if (!validImdb(imdb) || (seasonNumber !== null && !validSeason(seasonNumber))) return Promise.reject(formatError());
      const key = keyFor(imdb, seasonNumber);
      const taskKey = key + ':' + String(autoSeason) + ':' + String(manualSeason);
      if (inflight.has(taskKey)) return inflight.get(taskKey).promise;
      const cached = peek(imdb, { seasonNumber, autoSeason, manualSeason });
      if (!force && cached?.fresh) return Promise.resolve(cached);
      const current = generation, controller = new AbortController();
      const task = { controller, promise: null };
      task.promise = (async () => {
        const work = matchWork(await request('/find/' + imdb, config, controller.signal));
        if (current !== generation) throw cancelledError();
        const result = { work, supportVersion: 3 };
        if (work.kind === 'movie') {
          result.releases = await request('/movie/' + work.id + '/release_dates', config, controller.signal);
          normalizeReleases(result.releases, work.id);
        } else if (work.kind === 'tv') {
          result.series = normalizeSeries(await request('/tv/' + work.id, config, controller.signal), work.id);
          if (current !== generation) throw cancelledError();
          if (result.series.name) work.title = result.series.name;
          if (work.sourceSeasonId !== undefined && result.series.seasons.find(item => item.season_number === work.sourceSeason)?.id !== work.sourceSeasonId) throw formatError();
          const resolved = resolveSeason(result.series, work, seasonNumber, { autoSeason, manualSeason });
          result.seasonNumber = resolved.number; result.seasonIssue = resolved.issue;
          if (resolved.number !== null) {
            result.season = normalizeSeason(await request('/tv/' + work.id + '/season/' + resolved.number, config, controller.signal), result.series, resolved.number);
            if (work.sourceEpisode !== undefined && resolved.number === work.sourceSeason &&
                result.season.episodes.find(item => item.episode_number === work.sourceEpisode)?.id !== work.sourceEpisodeId) throw formatError();
          }
        }
        if (current !== generation) throw cancelledError();
        const entry = { result, fetchedAt: now() };
        entry.expiresAt = cachePolicy(entry, entry.fetchedAt).expiresAt;
        const saved = save(key, entry);
        return { ...entry, fromCache: false, ...cachePolicy(entry, now()), cacheWarning: !saved };
      })().finally(() => { if (inflight.get(taskKey) === task) inflight.delete(taskKey); });
      inflight.set(taskKey, task);
      return task.promise;
    }
    function invalidate() {
      // abort 只是请求停止通知；管理器仍可能迟到回调，generation 另行阻止旧结果进入缓存和界面。
      generation++;
      for (const task of inflight.values()) task.controller.abort();
      inflight.clear();
    }
    return { query, peek, invalidate };
  }

  // 界面样式只作用于本脚本面板，避免修改豆瓣及其他扩展的布局。
  const STYLE = `
    #release-signal-panel {clear:both;box-sizing:border-box;max-width:100%;margin:10px 0;padding:0;border:0;background:transparent;color:#333;font:13px/1.65 Arial,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere}
    #release-signal-panel * {box-sizing:border-box}
    #release-signal-panel [hidden] {display:none!important}
    #release-signal-panel .rs-summary {display:flex;align-items:center;gap:7px;width:fit-content;max-width:100%;min-height:26px;padding:2px 0;list-style:none;cursor:pointer;color:#666}
    #release-signal-panel .rs-summary::-webkit-details-marker {display:none}
    #release-signal-panel .rs-summary-text {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
    #release-signal-panel .rs-dot {display:inline-block;flex:0 0 8px;width:8px;height:8px;border-radius:50%;background:currentColor}
    #release-signal-panel .rs-chevron {flex:0 0 5px;width:5px;height:5px;margin:0 3px 3px 1px;border-right:1px solid #999;border-bottom:1px solid #999;transform:rotate(45deg)}
    #release-signal-panel .rs-disclosure[open] > .rs-summary .rs-chevron {transform:rotate(225deg);margin-top:4px;margin-bottom:0}
    #release-signal-panel .rs-content {margin-top:6px;padding:10px 12px;border-left:2px solid #e0e8e2;background:#fbfcfb}
    #release-signal-panel .rs-header {display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
    #release-signal-panel .rs-title {margin:0;color:#555;font-size:14px;font-weight:600}
    #release-signal-panel .rs-actions {display:flex;gap:6px;flex-wrap:wrap}
    #release-signal-panel .rs-button {font:inherit;line-height:1.5;padding:2px 8px;border:1px solid #bdcfc2;border-radius:4px;background:#fff;color:#276343;cursor:pointer}
    #release-signal-panel .rs-button:disabled {opacity:.5;cursor:default}
    #release-signal-panel .rs-button:focus-visible,#release-signal-panel summary:focus-visible {outline:2px solid #276343;outline-offset:2px}
    #release-signal-panel p {margin:7px 0}
    #release-signal-panel .rs-status {font-weight:600}
    #release-signal-panel [data-status="available"] {color:#17663a}
    #release-signal-panel [data-status="future"] {color:#805b0b}
    #release-signal-panel [data-status="unknown"],#release-signal-panel .rs-muted {color:#666}
    #release-signal-panel [data-status="error"],#release-signal-panel .rs-error {color:#a53126}
    #release-signal-panel .rs-summary-text[data-status="available"],#release-signal-panel .rs-content [data-status="available"] {color:#426b4f}
    #release-signal-panel .rs-summary-text[data-status="future"] {color:#80652f}
    #release-signal-panel .rs-summary-text[data-status="unknown"],#release-signal-panel .rs-content [data-status="future"],#release-signal-panel .rs-content [data-status="unknown"] {color:#666}
    #release-signal-panel .rs-summary-text[data-status="error"] {color:#8e514a}
    #release-signal-panel .rs-row {display:flex;gap:12px;margin:3px 0}
    #release-signal-panel .rs-season-select {min-width:0;max-width:calc(100% - 100px)}
    #release-signal-panel .rs-label {min-width:88px;font-weight:600}
    #release-signal-panel .rs-footnote {font-size:12px;color:#666}
    #release-signal-panel .rs-records {margin-top:8px}
    #release-signal-panel .rs-records > summary {color:#666;font-size:12px;cursor:pointer}
    #release-signal-panel .rs-config-notice {font-size:12px;color:#426b4f}
    #release-signal-panel .rs-table-wrap {overflow-x:auto;margin-top:8px}
    #release-signal-panel .rs-table {border-collapse:collapse;width:100%;font-size:12px;background:transparent}
    #release-signal-panel .rs-table th,#release-signal-panel .rs-table td {padding:5px;text-align:left;vertical-align:top;border-bottom:1px solid #e0e7e2}
    /* 两种明细表都优先保留固定内容：表头、类型/集号、日期；长地区、标题、说明可换行。 */
    #release-signal-panel .rs-table th,#release-signal-panel .rs-table td:nth-child(-n+2),#release-signal-panel .rs-tv-table td:last-child {white-space:nowrap}
    #release-signal-panel a {color:#276343;background:transparent}
    #release-signal-panel .rs-table a {color:inherit}
    #release-signal-panel a:hover {text-decoration:underline}
    #release-signal-panel .rs-dialog {width:min(460px,calc(100vw - 32px));max-height:85vh;overflow:auto;border:1px solid #bdcfc2;border-radius:8px;padding:20px;background:#fff;color:#333;font:14px/1.7 Arial,"Microsoft YaHei",sans-serif;white-space:normal}
    #release-signal-panel .rs-dialog::backdrop {background:rgba(0,0,0,.25)}
    #release-signal-panel .rs-dialog h3 {font-size:17px;margin:0 0 12px;color:#17663a}
    #release-signal-panel .rs-dialog label {display:block;margin:10px 0 4px}
    #release-signal-panel .rs-input {display:block;width:100%;font:inherit;padding:6px;border:1px solid #bdcfc2;border-radius:4px;background:#fff;color:#333}
    #release-signal-panel .rs-dialog .rs-actions {margin-top:16px}
    #release-signal-panel .rs-logo {display:block;width:100px;height:auto;margin:12px 0}
  `;

  // 页面控制：统一管理折叠状态、临时切季、凭据设置和查询生命周期。
  function createApp({ win, doc, gm, now = Date.now }) {
    if (!isSubjectUrl(win.location.href) || win.self !== win.top || doc.getElementById('release-signal-panel')) return null;
    const info = doc.getElementById('info');
    const host = info?.parentElement || doc.querySelector('#content .article') || doc.getElementById('content');
    if (!host) return null; // Login / security-check pages have no suitable movie content.
    const identity = extractImdb(info);
    const seasonHint = extractSeasonHint(info, doc.querySelector('#content h1')?.textContent || '');
    const isolated = isIsolatedRuntime(gm.info);
    // 清理旧版持久化的季数预览；重新加载必须回到当前豆瓣条目，公共分季缓存仍可复用。
    if (isolated) {
      try { if (gm.get('releaseSignal.seasons.v1', null) !== null) gm.delete('releaseSignal.seasons.v1'); }
      catch { /* Old preferences are ignored even if their removal fails. */ }
    }
    const isolationProblem = '当前管理器未提供所需的隔离环境，已暂停凭据操作与查询。推荐使用暴力猴；篡改猴默认配置暂不兼容。';
    // 在已确认的隔离世界中捕获原生输入方法，密钥不经过网页 DOM，也不回填旧值。
    const privatePrompt = isolated && typeof win.prompt === 'function' ? win.prompt.bind(win) : null;
    const request = createRequester(gm.request);
    const service = createService({ request: (path, credential, signal) => {
      synchronizeConfig(true);
      if (!sameConfig(credential, config) || configReadFailed) throw cancelledError();
      return request(path, credential, signal);
    }, storage: gm, now });
    let config = null, configReadFailed = false;
    try {
      const stored = isolated ? gm.get(CONFIG_KEY, null) : null;
      if (stored) config = parseConfig(stored.mode, stored.value, stored.apiOrigin);
    } catch { configReadFailed = true; }
    let phase = 'idle', data = null, failure = null, uiGeneration = 0, midnightTimer, dialog = null, validationController = null, configNotice = '', configListener = null;
    let wantedSeason = seasonHint.number, manualSeason = false;
    const seasonOptions = () => ({ seasonNumber: wantedSeason, autoSeason: !seasonHint.conflict, manualSeason });
    const node = (tag, className, text) => {
      const element = doc.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const link = (label, href) => {
      const anchor = node('a', '', label);
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      return anchor;
    };
    const button = (label, action) => {
      const element = node('button', 'rs-button', label);
      element.type = 'button';
      element.addEventListener('click', action);
      return element;
    };
    const panel = node('section');
    panel.id = 'release-signal-panel';
    panel.setAttribute('aria-label', '发行信号');
    const disclosure = node('details', 'rs-disclosure'), summary = node('summary', 'rs-summary');
    const dot = node('span', 'rs-dot'), compactStatus = node('span', 'rs-summary-text'), chevron = node('span', 'rs-chevron');
    dot.setAttribute('aria-hidden', 'true');
    chevron.setAttribute('aria-hidden', 'true');
    compactStatus.setAttribute('aria-live', 'polite');
    summary.append(dot, compactStatus, chevron);
    const content = node('div', 'rs-content');
    disclosure.append(summary, content);
    panel.append(disclosure);
    const header = node('div', 'rs-header'), actions = node('div', 'rs-actions');
    const settingsButton = button('设置 TMDB', openSettings);
    const refreshButton = button('刷新', () => { void load(true); });
    actions.append(settingsButton, refreshButton, button('关于', openAbout));
    const sectionTitle = node('h2', 'rs-title', '发行记录');
    header.append(sectionTitle, actions);
    const status = node('p', 'rs-status');
    const configFeedback = node('p', 'rs-config-notice');
    const rows = {}, rowLabels = {};
    content.append(header, status, configFeedback);
    const seasonRow = node('div', 'rs-row'), seasonLabel = node('label', 'rs-label', '季数'), seasonSelect = node('select', 'rs-button rs-season-select');
    seasonSelect.id = 'release-signal-season'; seasonLabel.htmlFor = seasonSelect.id;
    seasonRow.append(seasonLabel, seasonSelect); seasonRow.hidden = true;
    seasonSelect.addEventListener('change', changeSeason);
    content.append(seasonRow);
    for (const [kind, label] of [['digital', 'Web'], ['physical', '实体']]) {
      const row = node('div', 'rs-row'), value = node('span');
      value.dataset.kind = kind;
      rowLabels[kind] = node('span', 'rs-label', label);
      row.append(rowLabels[kind], value);
      rows[kind] = value;
      content.append(row);
    }
    const meta = node('p', 'rs-footnote'), details = node('details', 'rs-records'), recordsTitle = node('summary', '', '全部发行记录');
    const detailBody = node('div');
    details.append(recordsTitle, detailBody);
    content.append(details);
    if (info) info.after(panel); else host.prepend(panel);
    gm.addStyle(STYLE);

    function render() {
      const movie = data?.result.work.kind === 'movie';
      const tv = data?.result.work.kind === 'tv';
      const supported = movie || tv;
      let overall = 'unknown', text = '', compactText = '暂未查到发行记录', state;
      if (movie) {
        const normalized = normalizeReleases(data.result.releases, data.result.work.id);
        state = deriveStatus(normalized, localDay(now()));
        overall = state.status;
        text = { available: '已有发行记录', future: '等待发行', unknown: '暂未查到发行记录' }[overall];
        compactText = text;
        if (overall === 'future') compactText += ' · ' + [state.digital.date, state.physical.date].filter(Boolean).sort()[0];
        renderDetails(normalized, data.result.work);
      } else if (tv) {
        state = deriveTvStatus(data.result.series, data.result.season, localDay(now()));
        overall = state.status; compactText = state.text; text = state.text;
        if (!data.result.season) text = data.result.seasonIssue === 'conflict' ? '季数信息存在冲突，请手动确认。' : wantedSeason !== null ? '当前季数与 TMDB 记录不一致，请手动确认季数。' :
          seasonHint.conflict ? '页面中的季数有冲突，请手动确认。' : '已识别剧集，请选择当前条目对应的季数。';
        renderTvDetails(data.result, state);
      } else {
        detailBody.replaceChildren();
        recordsTitle.textContent = '全部发行记录';
      }
      if (!isolated) {
        text = isolationProblem;
        compactText = '当前环境不受支持';
      } else if (identity.kind !== 'found') {
        text = identity.message;
        compactText = identity.kind === 'conflict' ? 'IMDb 编号冲突' : '无法读取 IMDb';
      } else if (!config) {
        text = configReadFailed ? '无法读取凭据设置，请重新设置 TMDB。' : '请先设置自己的 TMDB 凭据。';
        compactText = '请设置 TMDB';
      } else if (phase === 'loading') {
        overall = 'unknown'; text = '正在查询 TMDB 公开发行记录…'; compactText = '查询中…';
      } else if (failure) {
        overall = 'error'; text = failure.message + (data ? ' 下方保留旧数据，仅供参考。' : '');
        compactText = failure.code === 'auth' ? '认证失败' : '查询失败';
      } else if (data && !supported) {
        text = WORK_MESSAGES[data.result.work.kind];
        compactText = { unmatched: '未匹配到作品', ambiguous: '无法可靠匹配', unsupported: '暂不支持此类型' }[data.result.work.kind];
      } else if (!data) {
        text = '尚未查询当前作品，请点击刷新。';
        compactText = '等待查询';
      }
      compactStatus.textContent = compactText;
      compactStatus.dataset.status = overall;
      dot.dataset.status = overall;
      summary.title = text + '（点击展开或收起）';
      status.textContent = text;
      status.dataset.status = overall;
      status.hidden = supported && (movie || Boolean(data.result.season)) && phase !== 'loading' && !failure;
      sectionTitle.textContent = tv ? '播出记录' : '发行记录';
      seasonRow.hidden = !tv;
      if (tv) {
        const options = [node('option', '', seasonHint.number !== null ? '按页面识别（第 ' + seasonHint.number + ' 季）' : '请选择季数')];
        options[0].value = '';
        for (const item of data.result.series.seasons) {
          const label = (item.season_number === 0 ? '特别篇' : '第 ' + item.season_number + ' 季') +
            (item.episode_count !== null ? ' · ' + item.episode_count + ' 集' : '');
          const option = node('option', '', label); option.value = String(item.season_number); options.push(option);
        }
        seasonSelect.replaceChildren(...options);
        seasonSelect.value = data.result.seasonNumber === null ? '' : String(data.result.seasonNumber);
        seasonSelect.disabled = !config || !isolated;
      }
      configFeedback.textContent = configNotice;
      configFeedback.hidden = !configNotice;
      for (const kind of ['digital', 'physical']) {
        rows[kind].dataset.kind = tv ? (kind === 'digital' ? 'recent' : 'next') : kind;
        rowLabels[kind].textContent = tv ? (kind === 'digital' ? '最近一集' : '下一集') : (kind === 'digital' ? 'Web' : '实体');
        if (tv) {
          const episode = kind === 'digital' ? state.last : state.next;
          rows[kind].textContent = episode ? episodeCode(episode) + ' · ' + (kind === 'physical' ? '预计 ' : '') + episode.air_date :
            !data.result.season ? '请先确认季数' : kind === 'digital' ? '暂无播出记录' : state.complete ? '本季已完结' : '暂未查到日期';
          rows[kind].dataset.status = (kind === 'digital' && episode) || (kind === 'physical' && state.complete) ? 'available' : episode ? 'future' : 'unknown';
          rows[kind].title = episode ? '依据 TMDB 的公开播出日期记录，未独立核实实际播出或平台上线。' : '';
          continue;
        }
        const part = state?.[kind];
        rows[kind].dataset.status = part?.status || 'unknown';
        rows[kind].textContent = part ? ({ available: '已发行 · ', future: '预计 · ', unknown: '暂未查到发行记录' }[part.status] + (part.date || '')) : '无法判断';
        rows[kind].title = part?.status === 'available' ? '依据 TMDB 中最早的有效发行日期记录，未独立核实实际上线。' : '';
      }
      details.hidden = !supported;
      meta.textContent = data ? [
        data.fromCache ? '本地缓存' : 'TMDB 查询结果',
        '查询时间：' + new Date(data.fetchedAt).toLocaleString('zh-CN', { hour12: false }),
        !cachePolicy(data, now()).fresh ? '缓存已过期，请刷新' : '',
        failure ? '旧数据：本次刷新未成功' : '',
        data.cacheWarning ? '缓存未能保存，当前结果仍可查看' : '',
      ].filter(Boolean).join(' · ') : '数据来源：TMDB；仅查看公开发行日期记录。';
      refreshButton.disabled = !isolated || phase === 'loading' || !config || identity.kind !== 'found';
      panel.setAttribute('aria-busy', String(phase === 'loading'));
    }

    function changeSeason() {
      // 只修改当前页面的内存状态；浏览其他季不会改变下次打开本条目时的自动判断。
      const number = seasonSelect.value === '' ? null : Number(seasonSelect.value);
      if (number !== null && (!validSeason(number) || !data?.result.series?.seasons.some(item => item.season_number === number))) return;
      resetQueries(); wantedSeason = number === null ? seasonHint.number : number; manualSeason = number !== null;
      if (data?.result.work.kind === 'tv') data = { ...data, result: { ...data.result, seasonNumber: null, season: null } };
      void load();
    }

    function episodeCode(episode) {
      return 'S' + String(episode.season_number).padStart(2, '0') + 'E' + String(episode.episode_number).padStart(2, '0');
    }

    function renderTvDetails(result, state) {
      detailBody.replaceChildren();
      const season = result.season, work = result.work;
      const source = 'https://www.themoviedb.org/tv/' + work.id + (season ? '/season/' + season.season_number : '');
      recordsTitle.textContent = '全部播出记录' + (season ? '（' + season.episodes.length + ' 集）' : '');
      const sourceLine = node('p'); sourceLine.append(link('TMDB：' + work.title + (season ? ' · 第 ' + season.season_number + ' 季' : ''), source));
      detailBody.append(meta, node('p', 'rs-footnote', '结果仅供参考'), sourceLine);
      if (work.sourceEpisode !== undefined) detailBody.append(node('p', 'rs-footnote', '匹配依据：IMDb 对应 ' + episodeCode({ season_number: work.sourceSeason, episode_number: work.sourceEpisode }) + '，已通过所属剧集与季号定位；以下显示当前所选季的记录。'));
      if (!season) { detailBody.append(node('p', 'rs-muted', '确认季数后查看单集播出记录。')); return; }
      if (state.complete) detailBody.append(node('p', 'rs-footnote', '完结依据：TMDB 标注 ' + episodeCode(season.episodes.at(-1)) + ' 为季终集，且当季集数完整、所有集的日期均已到。'));
      if (season.invalidCount || result.series.invalidCount || season.episodes.some(item => !item.air_date)) {
        detailBody.append(node('p', 'rs-muted', '播出信息不完整；日期缺失或异常的记录不参与日期判断，无法确认本季完结。'));
      }
      if (!season.episodes.length) { detailBody.append(node('p', 'rs-muted', '暂未查到单集播出记录。')); return; }
      const wrap = node('div', 'rs-table-wrap'), table = node('table', 'rs-table rs-tv-table'), head = node('thead'), heading = node('tr'), body = node('tbody');
      for (const label of ['集数', '播出日期', '标题', '标记']) { const th = node('th', '', label); th.scope = 'col'; heading.append(th); }
      head.append(heading);
      for (const episode of season.episodes) {
        const row = node('tr'), code = node('td');
        code.append(link(episodeCode(episode), source + '/episode/' + episode.episode_number));
        row.dataset.status = episode.air_date ? episode.air_date <= localDay(now()) ? 'available' : 'future' : 'unknown';
        row.append(code, node('td', '', episode.air_date || '暂未公布'), node('td', '', episode.name || '—'), node('td', '', episode.episode_type === 'finale' ? '季终集' : '—'));
        body.append(row);
      }
      table.append(head, body); wrap.append(table); detailBody.append(wrap);
    }

    function renderDetails(normalized, work) {
      detailBody.replaceChildren();
      const grouped = groupReleaseRecords(normalized.records);
      recordsTitle.textContent = '全部发行记录（' + grouped.length + ' 组）';
      const source = 'https://www.themoviedb.org/movie/' + work.id + '/releases';
      const sourceLine = node('p');
      sourceLine.append(link('TMDB：' + work.title, source));
      detailBody.append(meta, node('p', 'rs-footnote', '结果仅供参考'), sourceLine);
      if (normalized.invalidCount) detailBody.append(node('p', 'rs-error', '记录不完整：已忽略 ' + normalized.invalidCount + ' 项无效日期或异常记录。'));
      if (!normalized.records.length) {
        detailBody.append(node('p', 'rs-muted', '没有可用于判断的 Digital / Physical 日期；不代表没有片源。'));
        return;
      }
      const wrap = node('div', 'rs-table-wrap'), table = node('table', 'rs-table');
      const head = node('thead'), heading = node('tr'), body = node('tbody');
      for (const label of ['类型', '日期 / 来源', '地区', '记录说明']) {
        const th = node('th', '', label); th.scope = 'col'; heading.append(th);
      }
      head.append(heading);
      for (const record of grouped) {
        const tr = node('tr');
        tr.dataset.status = record.date <= localDay(now()) ? 'available' : 'future';
        const dateCell = node('td');
        dateCell.append(link(record.date, source));
        tr.append(node('td', '', record.kind === 'digital' ? 'Web' : '实体'), dateCell, node('td', '', record.countries.map(countryName).join('、')), node('td', '', record.note || '—'));
        body.append(tr);
      }
      table.append(head, body); wrap.append(table); detailBody.append(wrap);
    }

    function countryName(code) {
      if (code === '--') return '地区未标注';
      try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code) + ' (' + code + ')'; }
      catch { return code; }
    }

    async function load(force = false) {
      synchronizeConfig(true);
      if (!isolated || !config || identity.kind !== 'found' || phase === 'loading') { render(); return; }
      const current = uiGeneration;
      data = data || service.peek(identity.id, seasonOptions());
      failure = null; phase = 'loading'; render();
      try {
        const result = await service.query(identity.id, config, { force, ...seasonOptions() });
        synchronizeConfig(true);
        // 切季或更换凭据后，即使旧请求成功返回，也不能覆盖当前视图。
        if (current !== uiGeneration) return;
        data = result;
      } catch (error) {
        if (current !== uiGeneration || error.code === 'cancelled') return;
        failure = error instanceof SignalError ? error : new SignalError('unknown', '查询未能完成，请重试或检查设置。');
      } finally {
        if (current === uiGeneration) { phase = 'idle'; render(); }
      }
    }

    function closeDialog(element) {
      validationController?.abort();
      validationController = null;
      // close 事件稍后才派发，先移除当前对话框；凭据输入使用原生窗口，不在此 DOM 中。
      element.close();
      element.remove();
      if (dialog === element) dialog = null;
    }

    function createDialog(title) {
      if (dialog) closeDialog(dialog);
      const previousFocus = doc.activeElement;
      const element = node('dialog', 'rs-dialog');
      dialog = element;
      const heading = node('h3', '', title);
      heading.id = 'release-signal-dialog-title';
      element.setAttribute('aria-labelledby', heading.id);
      element.append(heading);
      element.addEventListener('close', () => {
        element.remove();
        if (dialog === element) dialog = null;
        if (!dialog) previousFocus?.focus();
      }, { once: true });
      element.addEventListener('cancel', event => { event.preventDefault(); closeDialog(element); });
      panel.append(element);
      return element;
    }

    function openSettings() {
      synchronizeConfig(true);
      const element = createDialog('设置 TMDB');
      element.dataset.kind = 'settings';
      const form = node('form'), mode = node('select', 'rs-input');
      mode.id = 'release-signal-auth-mode';
      for (const [value, label] of [['token', 'API Read Access Token（推荐）'], ['key', 'API key（v3）']]) {
        const option = node('option', '', label); option.value = value; mode.append(option);
      }
      mode.value = config?.mode || 'token';
      const modeLabel = node('label', '', '凭据类型'); modeLabel.htmlFor = mode.id;
      const apiSelect = node('select', 'rs-input'); apiSelect.id = 'release-signal-api-origin';
      for (const origin of API_ORIGINS) {
        const option = node('option', '', new URL(origin).hostname + (origin === API_ORIGIN ? '（默认）' : '（备用）'));
        option.value = origin; apiSelect.append(option);
      }
      apiSelect.value = config?.apiOrigin || API_ORIGIN;
      const apiLabel = node('label', '', 'API 地址'); apiLabel.htmlFor = apiSelect.id;
      const help = node('p', 'rs-footnote', (config ? '已保存凭据，不回填原值。“保存并查询”沿用现有凭据；更换时点击“替换凭据”。' : '使用你自己的 TMDB 凭据，点击“保存并查询”后在浏览器原生对话框填写。') +
        '默认地址连接失败时，可选择备用地址。切换凭据类型时也需重新填写；页面中不创建密钥输入框。');
      const errorLine = node('p', 'rs-error'); errorLine.setAttribute('role', 'alert');
      const controls = node('div', 'rs-actions');
      const save = node('button', 'rs-button', '保存并查询'); save.type = 'submit';
      const replace = node('button', 'rs-button', '替换凭据'); replace.type = 'submit'; replace.hidden = !config;
      if (!privatePrompt) { save.disabled = true; errorLine.textContent = isolationProblem; }
      const remove = button('删除凭据', () => {
        try { gm.delete(CONFIG_KEY); }
        catch { errorLine.textContent = '删除失败，请检查管理器存储权限。'; return; }
        resetQueries(); config = null; configReadFailed = false; data = null; configNotice = '';
        closeDialog(element); render();
      });
      remove.disabled = !config && !configReadFailed;
      controls.append(save, replace, remove, button('取消', () => closeDialog(element)));
      form.append(help, link('打开 TMDB API 设置', 'https://www.themoviedb.org/settings/api'), modeLabel, mode, apiLabel, apiSelect, errorLine, controls);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!privatePrompt || validationController || synchronizeConfig(true)) return;
        let next;
        try {
          const selectedMode = mode.value;
          const selectedOrigin = apiSelect.value;
          if (!API_ORIGINS.includes(selectedOrigin)) throw new SignalError('config', '请选择预设的 HTTPS API 地址。');
          if (config && selectedMode === config.mode && event.submitter !== replace) {
            next = parseConfig(selectedMode, config.value, selectedOrigin);
          } else {
            const value = privatePrompt('发行信号：填写新的 TMDB ' + (selectedMode === 'token' ? 'API Read Access Token' : 'API key') +
              '，将用于 ' + new URL(selectedOrigin).hostname + '。取消将保留原设置。', '');
            if (value === null || synchronizeConfig(true)) return;
            next = parseConfig(selectedMode, value, selectedOrigin);
          }
        }
        catch (error) { errorLine.textContent = error.message; return; }
        const controller = new AbortController();
        validationController = controller;
        save.disabled = true; replace.disabled = true; remove.disabled = true; mode.disabled = true; apiSelect.disabled = true;
        errorLine.textContent = '正在验证 TMDB 凭据…';
        try {
          await verifyCredential(request, next, controller.signal);
          if (controller.signal.aborted || dialog !== element || synchronizeConfig(true)) return;
          try { gm.set(CONFIG_KEY, next); }
          catch { throw new SignalError('storage', '凭据验证成功，但保存失败，请检查管理器存储权限。'); }
          resetQueries(); config = next; configReadFailed = false; data = null;
          configNotice = 'TMDB 凭据验证成功，已保存。';
          closeDialog(element); void load(true);
        } catch (error) {
          if (!controller.signal.aborted && dialog === element) {
            errorLine.textContent = error instanceof SignalError ? error.message : '凭据验证未完成，请重试。';
          }
        } finally {
          if (validationController === controller) {
            validationController = null;
            save.disabled = false; replace.disabled = false; remove.disabled = !config && !configReadFailed; mode.disabled = false; apiSelect.disabled = false;
          }
        }
      });
      element.append(form); element.showModal(); mode.focus();
    }

    function synchronizeConfig(notify = false) {
      // 存储事件可能延迟或乱序，始终重读管理器存储；请求前和结果返回后也走同一检查。
      if (!isolated) return false;
      let latest = null, readFailed = false;
      try {
        const stored = gm.get(CONFIG_KEY, null);
        if (stored) latest = parseConfig(stored.mode, stored.value, stored.apiOrigin);
      } catch { readFailed = true; }
      if (sameConfig(latest, config) && readFailed === configReadFailed) return false;
      resetQueries();
      if (dialog?.dataset.kind === 'settings') closeDialog(dialog);
      config = latest; configReadFailed = readFailed;
      data = latest && identity.kind === 'found' ? service.peek(identity.id, seasonOptions()) : null;
      configNotice = notify ? (readFailed ? '无法读取最新凭据，请检查设置。' : latest ? '已同步其他页面的凭据设置。' : '凭据已删除。') : '';
      render();
      return true;
    }

    function resetQueries() {
      uiGeneration++; service.invalidate(); phase = 'idle'; failure = null;
    }

    function openAbout() {
      const element = createDialog('关于发行信号');
      const logoLink = link('', 'https://www.themoviedb.org');
      const logo = node('img', 'rs-logo'); logo.alt = 'TMDB'; logo.src = TMDB_LOGO;
      logoLink.append(logo);
      element.append(node('p', '', '发行信号 0.5.1 · 以公开记录作为搜索前的参考。'), logoLink,
        node('p', '', 'This product uses the TMDB API but is not endorsed or certified by TMDB.'),
        node('p', 'rs-footnote', '本产品使用 TMDB API，但未获 TMDB 背书或认证。记录可能缺失或有误，计划日期已过也不代表已经核实实际上线。'),
        link('TMDB 数据与署名说明', 'https://developer.themoviedb.org/docs/faq'),
        node('p', 'rs-footnote', DISCLAIMER),
        node('p', 'rs-footnote', '剧集按季显示公开播出日期。本季完结依据 TMDB 季终标记、完整集数及日期判断，未独立核实实际播出；播出记录不代表对应平台已上线或已有片源。'), button('关闭', () => closeDialog(element)));
      element.showModal();
    }

    function scheduleMidnight() {
      const next = new Date(now()); next.setHours(24, 0, 1, 0);
      midnightTimer = win.setTimeout(() => { render(); scheduleMidnight(); }, Math.max(1000, next.getTime() - now()));
    }
    const onVisible = () => {
      if (!doc.hidden) { synchronizeConfig(true); render(); win.clearTimeout(midnightTimer); scheduleMidnight(); }
    };
    doc.addEventListener('visibilitychange', onVisible);
    win.addEventListener('pagehide', event => {
      if (!event.persisted) {
        validationController?.abort(); resetQueries(); win.clearTimeout(midnightTimer); doc.removeEventListener('visibilitychange', onVisible);
        if (configListener !== null) { try { gm.unwatch(configListener); } catch { /* Page is closing. */ } }
      }
    });
    win.addEventListener('pageshow', onVisible);
    gm.menu('发行信号：设置 TMDB', openSettings);
    gm.menu('发行信号：刷新当前作品', () => { void load(true); });
    gm.menu('发行信号：清空发行记录缓存', () => {
      try { gm.delete(CACHE_KEY); }
      catch { failure = new SignalError('storage', '清空缓存失败，请检查管理器存储权限。'); render(); return; }
      resetQueries(); data = null; void load(true);
    });
    if (isolated) {
      try { configListener = gm.watch(CONFIG_KEY, (_key, _old, _next, remote) => { if (remote && synchronizeConfig(true)) render(); }); }
      catch { /* Requests and visibility changes still re-read the storage. */ }
    }
    render(); scheduleMidnight(); void load();
    return { panel };
  }

  // Node-only exports let tests exercise the installed file itself, with no build
  // or browser globals exposed by the production userscript.
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = { CONFIG_KEY, CACHE_KEY, API_ORIGINS, CACHE_TTL, CACHE_SHORT_TTL, CACHE_LONG_TTL, CACHE_LIMIT, REQUEST_TIMEOUT, SignalError, isSubjectUrl, extractImdb, extractSeasonHint, matchWork, sourceDate, localDay, normalizeReleases, normalizeSeries, normalizeSeason, resolveSeason, groupReleaseRecords, deriveStatus, deriveTvStatus, cachePolicy, isIsolatedRuntime, parseConfig, createRequester, verifyCredential, createService };
    return;
  }
  if (typeof window === 'undefined' || typeof GM_getValue !== 'function') return;
  createApp({ win: window, doc: document, gm: {
    info: typeof GM_info === 'object' ? GM_info : null,
    get: (key, fallback) => GM_getValue(key, fallback),
    set: (key, value) => GM_setValue(key, value),
    delete: key => GM_deleteValue(key),
    watch: (key, callback) => GM_addValueChangeListener(key, callback),
    unwatch: id => GM_removeValueChangeListener(id),
    request: details => GM_xmlhttpRequest(details),
    menu: (label, action) => GM_registerMenuCommand(label, action),
    addStyle: css => GM_addStyle(css),
  } });
})();
