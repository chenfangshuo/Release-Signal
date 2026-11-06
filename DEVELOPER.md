# 开发与维护

当前脚本版本为 `0.5.5`，单文件运行，无后端、运行库或构建步骤。使用说明见 [README](README.md)，手动验收步骤见 [验收清单](docs/TAMPERMONKEY-TEST.md)。

## 文件与测试

- `release-signal.user.js`：安装文件，内部按页面读取、数据判定、请求、缓存和界面组织。
- `tests/core.test.cjs`、`tests/tv.test.cjs`：Node 核心逻辑与剧集回归测试。
- `tests/browser_smoke.py`、`tests/fixtures/douban.html`：隔离 Chromium、模拟页面和 GM 接口测试。
- `docs/images/`：README 截图；`LICENSE`：MIT 源码许可。

测试直接加载安装文件；仅 Node 环境导出核心函数，浏览器不暴露测试接口。请求、存储和时间可替换。

测试依赖 Node.js、Python、Playwright 及 Chromium。建议使用独立 Python 虚拟环境，从项目根目录执行：

```sh
python -m pip install playwright==1.64.1
python -m playwright install chromium
node --check release-signal.user.js
node --test tests/core.test.cjs tests/tv.test.cjs
python -I -B -X utf8 tests/browser_smoke.py
```

浏览器测试使用假凭据、拦截响应和全新配置，截图写入系统临时目录。覆盖匹配、日期、完结、缓存、配置竞态、来源链接及窄窗布局；模拟通过不能替代真实管理器验收。

## 匹配与日期

- 仅运行于 HTTPS 豆瓣数字影视详情页，禁止 iframe。优先插入 `#info` 后，样式限定在脚本面板内。
- 只从资料区 IMDb 链接及标注文字读取编号；缺失或冲突时停止，不按片名猜测。TMDB `/find` 只接受唯一且无类型冲突的匹配。
- 电影使用所有地区的类型 **4 Digital / 5 Physical** 日期，忽略院线、首映和电视。有已到日期时，整体状态不能被另一类未来日期覆盖。
- 严格校验并保留来源 `YYYY-MM-DD`，不转换时区改写日期；用户的“今天”按浏览器本地日历日计算。“已发行”只表示记录日期已到。
- 打开页面、跨日及恢复可见时重新判定；跨日和恢复可见本身不发起 API 请求。

## 剧集与完结

通过剧集详情取得季目录，再查询所选季；IMDb 指向单集时，须校验所属剧集、季号和单集 ID。

季数识别优先遵守页面明确提示，页面与 IMDb 所属季冲突时要求确认。无提示时可采用 IMDb 所属季；否则仅在目录正常且唯一普通季为第 1 季时自动选择，特别篇不计入普通季数。

手动切季仅在当前页面内存中预览。偏离自动识别结果时，收起状态加季号，加载或失败时也保留；返回自动识别或重新加载后恢复本页结果。不要重新引入季数持久化。

“本季完结”必须同时满足：

- 普通季，且目录有明确、正整数的总集数。
- 单集数量相符，编号从 1 连续，身份无冲突、重复或异常。
- 所有单集日期有效、顺序一致且均已到。
- 季目录和季详情中的有效开播日期均不晚于已知最早单集日期；缺失季开播日期不会单独否定完整单集证据。
- 恰有一集标记 `episode_type === 'finale'`，且位于当季最后。

日期矛盾时保留播出记录并提示，不确认完结。全剧 Ended/Canceled、没有下一集或现有日期全部过去，均不能单独证明完结；第 0 季特别篇不判完结。

## 界面与来源

- 默认一行；第一层是电影 Web/实体或剧集最近/下一集摘要，第二层才展示完整记录。
- 电影摘要和明细日期均为普通文字，完整记录中统一使用独立 TMDB 来源入口，避免 Web/实体摘要重复链接同一发行页。
- 剧集摘要的“集号 · 日期”为一个单集链接，明细集号也链接对应单集；缺少记录时不生成链接。最上面的状态行只负责折叠。
- 明细表头及前两列保持单行，剧集季终标记也保持单行；长地区、标题、说明允许换行，空间不足时容器横向滚动。
- 外部文本使用 `textContent`；链接只拼接校验过的 ID，新标签页设置 `noopener noreferrer`。

## 凭据与请求

- 凭据仅存于管理器 `releaseSignal.config.v1`，不回填、不进入网页存储或发行缓存，不记录密钥、原始响应和含凭据 URL。
- 输入使用管理器作用域捕获的全局 `prompt`，不要改成 `window.prompt` 或网页输入框。候选凭据先经 `/authentication` 验证，再保存；取消、验证或保存失败时保留原配置。原生输入不可用时，已有凭据仍可查询。
- 暴力猴接受 `content`，篡改猴接受 `raw/js/dom`，保留 `@sandbox DOM` 偏好，不要求更改全局沙盒设置。模式检查是兼容策略，不是隔离证明；不能承诺抵御早于管理器初始化的输入方法改写。
- API 仅允许 `https://api.tmdb.org`（默认）和 `https://api.themoviedb.org`，保留已有显式选择，不自动切换。使用匿名 GM 请求，不读写 Cookie；拒绝跨来源响应。
- 每次请求独立设置 15 秒计时并主动 `abort()`，不能只依赖管理器超时。认证失败、限流、超时、网络、服务及格式错误分别处理，不当作无记录，不循环重试。
- 同页请求合并；配置或季数变化时取消旧任务，递增任务编号以丢弃迟到结果。跨标签通过存储监听同步配置，同时在请求前后及恢复可见时重读存储；候选凭据验证同样遵守取消规则。

## 缓存与升级

公共结果保存在 `releaseSignal.cache.v1`，包含成功的空结果、来源日期、查询时间和固定过期上限；错误不写入成功缓存。电影/未选季使用 IMDb ID，指定季使用 `IMDb ID:s季数`；最多保留 100 项，淘汰查询时间最旧的项。

| 条件 | 时长 |
| --- | --- |
| 无记录、未匹配、不支持、未确认完结的剧集，或任一日期距今天不超过 7 天 | 6 小时 |
| 全部有效日期已过去至少 30 天，且无未来记录 | 7 天 |
| 其他成功结果 | 24 小时 |

读取时重做规范化和判定，过期时间只可提前、不可延长，旧缓存按原查询日推导期限；未来记录最迟到对应本地零点过期，防止状态改变后缓存“复活”。手动刷新绕过缓存，失败可保留旧数据，但标明失败和原查询时间。

升级须保留有效电影缓存，重新查询旧版不支持的剧集缓存；清理但不再读取旧 `releaseSignal.seasons.v1`。缓存不按 API 地址复制，也不代替当前季数选择。

## 发布检查

1. 运行自动化测试，按验收清单检查管理器默认设置、电影/剧集、摘要链接、切季、凭据与跨页同步。
2. 更新元数据和“关于”的版本号；安装/更新 URL 指向 `main`，Release 附件必须与对应版本一致。
3. 检查公开文件与截图，不包含真实凭据、个人测试环境或详细反馈、日志、HAR、浏览器资料和本机路径。截图避开账号、密钥输入和浏览器工具栏。
4. 保留脚本内 MIT 许可、TMDB 官方标志、来源和非背书声明；数据与标志不属于源码 MIT 授权范围。

## 官方资料

- TMDB：[认证](https://developer.themoviedb.org/docs/authentication-application)、[IMDb 查找](https://developer.themoviedb.org/reference/find-by-id)、[电影发行日期](https://developer.themoviedb.org/reference/movie-release-dates)、[季详情](https://developer.themoviedb.org/reference/tv-season-details)、[署名要求](https://developer.themoviedb.org/docs/faq)。
- 管理器：[暴力猴 GM 接口](https://violentmonkey.github.io/api/gm/)、[篡改猴请求](https://www.tampermonkey.net/documentation.php?q=GM_xmlhttpRequest)、[沙盒设置说明](https://www.tampermonkey.net/faq.php?q=Q404)。
