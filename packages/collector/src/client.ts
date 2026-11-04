/**
 * TMDB API 客户端
 *
 * 实测要点（详见 docs/开发文档.md §4）：
 * 1. 大陆直连 api.themoviedb.org 超时，必须走代理
 * 2. 限流 0.25 秒/请求
 * 3. 详情接口偶发超时，必须重试；仍失败不能丢弃，标记待重试
 * 4. 分页上限 1000 页
 * 5. keyword = hentai(id 198385) 是唯一实测有效的里番枚举入口
 */

/**
 * 🔴🔴 判据唯一实现：**只有「含汉字且不含假名」才算中文译名**。
 *
 * 2026-10-28 蛙哥指出「怎么全是英文，hanime 都搜不到」——
 * TMDB 对大批新番没有中文翻译，请求 `language=zh-CN` 它会原样返回
 * 英文名 / 罗马字 / 日文原名，旧代码照单全收写进 `name_zh`。
 *
 * 三道判据缺一不可：
 *   ① 空 ⇒ null
 *   ② **含假名 ⇒ null** ← 最容易漏。「お嬢様はHがお好き」里有汉字「嬢様」，
 *      只判 `[\u4e00-\u9fff]` 会被当成中文名收下（实测已踩）。
 *      中文译名不会带假名。
 *   ③ 不含汉字 ⇒ null（英文 / 罗马字 / 纯数字）
 *
 * ⚠️ `・`(U+30FB) 不参与假名判定 —— 它落在 `ァ-ヺ`(U+30A1–U+30FA) 之外，
 *    所以「新・最終痴漢電車」这类带中点的标题不会被误杀。
 */
export function pickChineseName(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/[ぁ-ゖァ-ヺ]/.test(s)) return null;
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(s) ? s : null;
}

export interface TmdbClientOptions {
  apiKey: string;
  baseUrl: string;
  /** 代理地址，如 http://host.docker.internal:7890；空字符串表示直连 */
  proxy: string;
  /** 限流间隔（毫秒） */
  rateLimitMs: number;
  /** 详情接口最大重试次数 */
  maxRetries: number;
}

export interface PagedResult<T> {
  page: number;
  total_pages: number;
  total_results: number;
  results: T[];
}

export class TmdbError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'TmdbError';
  }
}

/**
 * 带代理的 JSON 请求封装
 *
 * ⚠️ 代理实现说明：
 *   Node 内置 fetch（undici）可通过 ProxyAgent 走代理，但 undici 未声明为直接依赖。
 *   这里在首次请求时**一次性**初始化代理，而非每次请求都 setGlobalDispatcher
 *   —— 后者是明显的性能隐患，且 undici 缺失时会静默失效。
 *
 * ── §126（2026-11-01）DNS 污染兜底 ─────────────────────────────
 *   病根：`api.themoviedb.org` 的 DNS 被污染到 Twitter/Facebook 段
 *   （系统 DNS → 104.244.46.9；NAS IPv6 → 2a03:2880:…face:b00c），
 *   域名怎么解析都到不了 TMDB；代理侧那台 7890 的 CONNECT 隧道能建但握手后
 *   立刻 EOF（出口节点全挂）。
 *   ⇒ 兜底：直连 **CloudFront 真实 IP 池** + TLS SNI 仍为 `api.themoviedb.org`
 *     （CloudFront 靠 SNI 分流，所以 SNI 不能改；只改 TCP 落点）。
 *   实测那 6 个 IP 都返回 401 = 真到 TMDB 了。
 *   ⚠️ 只在「代理 + 直连都失败」后才启用，正常网络下优先走前面的路。
 */
export class Http {
  private proxyState: 'untried' | 'ready' | 'unavailable' = 'untried';
  private warned = false;
  /** pinned 兜底 dispatcher（懒建，null = 不可用） */
  private pinned: unknown = null;
  private pinnedTried = false;

  constructor(private readonly proxy: string) {}

  private async ensureProxy(): Promise<boolean> {
    if (!this.proxy || this.proxyState !== 'untried') {
      return this.proxyState === 'ready';
    }
    try {
      const undici = await import('undici');
      undici.setGlobalDispatcher(new undici.ProxyAgent(this.proxy));
      this.proxyState = 'ready';
    } catch {
      if (!process.env.HTTP_PROXY && !process.env.HTTPS_PROXY && !this.warned) {
        this.warned = true;
        console.warn(
          `[tmdb] 代理 ${this.proxy} 启用失败，且无 HTTP_PROXY/HTTPS_PROXY 环境变量；` +
            `将尝试直连 —— 实测大陆直连 api.themoviedb.org 会超时。`,
        );
      }
      this.proxyState = 'unavailable';
    }
    return this.proxyState === 'ready';
  }

  /** §126：DNS 污染兜底 dispatcher（固定 CloudFront IP + SNI） */
  private async ensurePinned(): Promise<unknown> {
    if (this.pinnedTried) return this.pinned;
    this.pinnedTried = true;
    try {
      const { Agent } = await import('undici');
      const { lookup } = await import('node:dns');
      const IPS = [
        '13.32.99.99', '18.64.156.99', '99.84.191.99',
        '13.35.99.99', '18.160.10.99', '99.86.129.99',
      ];
      this.pinned = new Agent({
        connect: {
          timeout: 15_000,
          // ⭐ SNI 必须是真域名（CloudFront 靠它分流）
          servername: 'api.themoviedb.org',
          lookup: (hostname: string, opts: unknown, cb: unknown) => {
            if (hostname === 'api.themoviedb.org') {
              const pick = IPS[Math.floor(Math.random() * IPS.length)];
              if ((opts as { all?: boolean } | undefined)?.all) {
                (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(
                  null,
                  IPS.map((address) => ({ address, family: 4 })),
                );
              } else {
                (cb as unknown as (e: null, a: string, f: number) => void)(null, pick, 4);
              }
              return;
            }
            (lookup as unknown as (h: string, o: unknown, c: unknown) => void)(hostname, opts, cb);
          },
        },
        headersTimeout: 20_000,
        bodyTimeout: 30_000,
      });
    } catch {
      this.pinned = null;
    }
    return this.pinned;
  }

  async fetchJson(url: string, timeoutMs: number): Promise<unknown> {
    await this.ensureProxy();
    try {
      return await this.doFetch(url, timeoutMs, undefined);
    } catch (err) {
      // ── §126：代理/直连都失败 ⇒ 试 DNS 污染兜底
      if (url.includes('api.themoviedb.org')) {
        const pinned = await this.ensurePinned();
        if (pinned) {
          try {
            return await this.doFetch(url, timeoutMs, pinned);
          } catch (err2) {
            throw err2;
          }
        }
      }
      throw err;
    }
  }

  private async doFetch(
    url: string,
    timeoutMs: number,
    dispatcher: unknown,
  ): Promise<unknown> {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
      ...(dispatcher ? { dispatcher: dispatcher as never } : {}),
    });

    if (!res.ok) {
      let detail = '';
      try {
        detail = ((await res.json()) as { status_message?: string }).status_message ?? '';
      } catch {
        try {
          detail = (await res.text()).slice(0, 200);
        } catch {
          detail = '(无法读取错误体)';
        }
      }
      throw new TmdbError(`TMDB ${res.status}: ${detail}`, res.status, url);
    }
    return res.json();
  }
}

export class TmdbClient {
  private readonly http: Http;
  private lastRequestAt = 0;
  /** 累计请求数与失败数，供健康检查上报 */
  stats = { requests: 0, failures: 0 };

  constructor(private readonly opts: TmdbClientOptions) {
    this.http = new Http(opts.proxy);
  }

  /** 限流：保证相邻请求间隔不小于 rateLimitMs */
  private async throttle(): Promise<void> {
    const wait = this.opts.rateLimitMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  private buildUrl(path: string, params: Record<string, string | number>): string {
    const url = new URL(this.opts.baseUrl + path);
    url.searchParams.set('api_key', this.opts.apiKey);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** 单次请求（不重试） */
  async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    await this.throttle();
    this.stats.requests++;
    try {
      return (await this.http.fetchJson(this.buildUrl(path, params), 25_000)) as T;
    } catch (err) {
      this.stats.failures++;
      throw err;
    }
  }

  /** 带重试的请求 —— 详情接口必须用这个 */
  async getWithRetry<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.opts.maxRetries; attempt++) {
      try {
        return await this.get<T>(path, params);
      } catch (err) {
        lastErr = err;
        // 4xx（除 429）是确定性错误，重试无意义
        if (
          err instanceof TmdbError &&
          err.status &&
          err.status >= 400 &&
          err.status < 500 &&
          err.status !== 429
        ) {
          break;
        }
        if (attempt < this.opts.maxRetries) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
    }
    throw lastErr;
  }

  // ── 枚举（通道 A）────────────────────────────────────────────

  /** keyword 枚举里番（2000 年起） */
  async discoverByKeyword(
    mediaType: 'tv' | 'movie',
    keywordId: number,
    dateGte: string,
    page: number,
  ): Promise<PagedResult<Record<string, unknown>>> {
    const dateKey = mediaType === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte';
    const sortKey = mediaType === 'tv' ? 'first_air_date.desc' : 'primary_release_date.desc';
    return this.get<PagedResult<Record<string, unknown>>>(`/discover/${mediaType}`, {
      with_keywords: keywordId,
      include_adult: 'true',
      [dateKey]: dateGte,
      sort_by: sortKey,
      page,
    });
  }

  // ── 搜索（§79 定期更新判定）───────────────────────────────

  /**
   * 🔴 按标题搜 TMDB —— 供「hanime 发现的新内容 → 判定是分集更新还是新番」使用。
   *
   * 🔴🔴 铁律：**⛔ 不用 `/search/multi`**
   *   `multi` 会把 tv/movie 混在一起按热度截断，冷门里番经常被挤出结果集，
   *   表现是「TMDB 明明有，却搜不到」—— 而错误信息是空的。
   *   ⇒ 必须**分端点**搜 `search/tv` 与 `search/movie`，两边的结果各自判定。
   *
   * 🔴 铁律：**⛔ 不传年份过滤参数**（`first_air_date_year` / `primary_release_year`）
   *   源站的 `year` 是**逐集配信年**（0da/0bg），TMDB 的是**首播年**，
   *   两者差 1 年是常态。传了年份 ⇒ 真配对在搜索阶段就被过滤掉 ⇒ 永远匹配不上。
   *   年份交给判据层的硬闸门（`judgeSimilarity` 里差 >2 才拒）处理。
   *
   * @param query 原始标题（⛔ 不要预先 canon，判据层自己会归一变体）
   * @returns TMDB 原始结果数组（**可能为空** —— 空 = 该端点无词条，不是「没搜」）
   */
  async search(
    mediaType: 'tv' | 'movie',
    query: string,
    page = 1,
  ): Promise<Array<Record<string, unknown>>> {
    const q = String(query || '').trim();
    if (!q) return [];
    const r = await this.getWithRetry<PagedResult<Record<string, unknown>>>(`/search/${mediaType}`, {
      query: q,
      include_adult: 'true',
      language: 'zh-CN',
      page,
    });
    return Array.isArray(r.results) ? r.results : [];
  }

  /**
   * 🔴 拉别名 —— 判据必须吃到**全别名**才有命中率。
   *
   * 实证（match_core.mjs 注释里记过）：TMDB 的**正确日文名常常不在 `name_original`**，
   * 而在 `alternative_titles`（`tv|43975` → `["JP","キャンパス 〜桜の舞う中で〜"]`）。
   * 只喂 `name_original` ⇒ 大量真配对判成「跨文字系统失效」。
   *
   * ⚠️ 这是**额外一次请求**，只在候选进入最终判定时调用，⛔ 不要对每个搜索结果都调。
   */
  async alternativeTitles(mediaType: 'tv' | 'movie', id: number): Promise<string[]> {
    try {
      const r = await this.getWithRetry<{
        titles?: Array<{ iso_3166_1?: string; title?: string }>;
        results?: Array<{ iso_3166_1?: string; title?: string }>;
      }>(`/${mediaType}/${id}/alternative_titles`);
      const rows = r.titles ?? r.results ?? [];
      return rows.map((x) => String(x.title ?? '')).filter(Boolean);
    } catch {
      // 别名拉不到不影响主判据（还有 name / original_name）
      return [];
    }
  }

  // ── 详情（通道 B / 季集元数据）─────────────────────────────

  /**
   * ⚠️ 语言参数是本项目最容易出错的地方（2026-10-13 实际踩过）
   *
   * 现象：用 `language=ja-JP` 拉详情，TMDB 返回的 `name` 是**罗马字**，
   *      我却把它写进了 name_zh，导致看板标题全是「姉モネ / Anemone」这类罗马字。
   *
   * 正确做法（xike-lifan-organize 早就记过这条经验，本次绕过了）：
   *   - 搜索 / 匹配用 ja-JP（匹配率更高）
   *   - **中文名必须单独用 language=zh-CN 回查**
   *
   * 实测 tmdb/tv/91352：
   *   original_name = ファイブカード
   *   ja-JP  name   = Faibu Kādo      ← 罗马字
   *   zh-CN  name   = 五张魔法牌       ← 中文
   */
  async tvDetail(id: number, language = 'zh-CN'): Promise<Record<string, unknown>> {
    return this.getWithRetry<Record<string, unknown>>(`/tv/${id}`, { language });
  }

  async movieDetail(id: number, language = 'zh-CN'): Promise<Record<string, unknown>> {
    return this.getWithRetry<Record<string, unknown>>(`/movie/${id}`, { language });
  }

  /** 通用详情（按 media_type 分派，默认取中文名） */
  async detail(mediaType: 'tv' | 'movie', id: number): Promise<Record<string, unknown>> {
    return mediaType === 'movie' ? this.movieDetail(id) : this.tvDetail(id);
  }

  /**
   * 拉中文名 —— 与原始标题分离
   *
   * 返回 { original, zh }：
   *   original = original_name（永远是原始语种标题）
   *   zh       = language=zh-CN 的 name，但**只在含汉字时返回**；
   *              TMDB 无中文翻译时返回 `null`（⛔ 不再回退成英文/罗马字）
   *
   * 🔴🔴 2026-10-28 修的坑：旧版本「无中文则回退为 original」，
   *   于是 `Deco x Deco` / `Hamehara` / `Muchuu no Tou` 这些**英文或罗马字**
   *   被当成中文名写进 `name_zh` ⇒ 看板显示英文 ⇒ 用户拿去 hanime 搜不到。
   *   ⇒ 现在「没有中文」就明说 `null`，让调用方去 hanime 侧回填真中文名。
   *
   * @param hasChinese 该次请求 TMDB 是否**真的**给了中文名
   */
  async fetchTitles(
    mediaType: 'tv' | 'movie',
    id: number,
  ): Promise<{ original: string | null; zh: string | null; hasChinese: boolean }> {
    const d = await this.detail(mediaType, id);
    const original =
      (d.original_name as string) ?? (d.original_title as string) ?? null;
    const raw = (d.name as string) ?? (d.title as string) ?? null;
    const zh = pickChineseName(raw);
    const hasChinese = Boolean(zh && zh !== original);
    return { original, zh, hasChinese };
  }

  /**
   * 拉取季集元数据
   *
   * TMDB 的 season_number=0 是 Specials（花絮 / OVA 特典）。
   * 实测本地库里存在 Season 00 结构的作品，因此**保留** season 0，
   * 但在 type 里标为 'specials' 便于后续筛选区分。
   */
  async seasonsOf(
    mediaType: 'tv' | 'movie',
    id: number,
  ): Promise<
    Array<{
      season: number;
      name: string;
      isSpecials: boolean;
      episodes: Array<{
        episode: number;
        name: string | null;
        airDate: string | null;
        runtime: number | null;
        stillPath: string | null;
        overview: string | null;
      }>;
    }>
  > {
    if (mediaType === 'movie') {
      const d = await this.movieDetail(id);
      return [{
        season: 0,
        name: '劇場版',
        isSpecials: false,
        episodes: [{
          episode: 1,
          name: (d.title as string) ?? null,
          airDate: (d.release_date as string) ?? null,
          runtime: typeof d.runtime === 'number' ? d.runtime : null,
          stillPath: (d.backdrop_path as string) ?? null,
          overview: (d.overview as string) ?? null,
        }],
      }];
    }

    // ⚠️⚠️ TMDB API 的一个坑：/tv/{id}/seasons 只要带 language 参数就返回 404
    //
    // 实测 tmdb/tv/335777：
    //   /tv/335777/seasons?language=zh-CN  → {"status_code":34} 404
    //   /tv/335777/seasons（无 language）  → 正常返回
    //   /tv/335777/season/1?language=zh-CN → 正常（逐季详情接口没这毛病）
    //
    // 首轮采季集时我给 seasons 列表接口也传了 language=zh-CN，
    // 结果 1189 部 tv 全部 404，只有走 movie 分支的 95 部成功。
    // → seasons 列表必须**不带 language**，逐季详情才带。
// ⚠️⚠️⚠️ TMDB 对成人动画词条的限制（2026-10-13 实测，踩了整整一轮）
    //
    // `/tv/{id}/seasons`（季列表接口）对这些里番词条**一律返回 404**：
    //   tv/335777 / 91352 / 250693 / 103259 全部 404
    //   但 `/tv/{id}` 详情接口正常（type 是 Miniseries/Video/Scripted）
    //
    // 我最初误判为「带 language 参数导致」，改掉后仍全挂，深入才定位到：
    //   **是词条本身，不是参数**。
    //
    // ✅ 替代方案：季数取自详情接口的 number_of_seasons，
    //    再逐个调 `/tv/{id}/season/{n}` —— 该接口完全正常，还带 still 剧照。
    //
    // 首轮采集结果：1189 部 tv 全失败，只有走 movie 分支的 95 部成功。
    const detail = await this.tvDetail(id);

    const declaredSeasons = Number(detail.number_of_seasons ?? 0);
    const declaredEpisodes = Number(detail.number_of_episodes ?? 0);

    type Ep = {
      episode: number; name: string | null; airDate: string | null;
      runtime: number | null; stillPath: string | null; overview: string | null;
    };
    type Season = { season: number; name: string; isSpecials: boolean; episodes: Ep[] };

    const out: Season[] = [];

    // season 0 是 Specials（花絮/OVA 特典），里番常见；不存在时会 404 直接跳过
    const targets: number[] = [0];
    for (let s = 1; s <= declaredSeasons; s++) targets.push(s);

    for (const sn of targets) {
      let sd: Record<string, unknown>;
      let eps: Array<Record<string, unknown>>;
      try {
        sd = await this.getWithRetry<Record<string, unknown>>(
          `/tv/${id}/season/${sn}`,
          { language: 'zh-CN' },
        );
        eps = (sd.episodes as Array<Record<string, unknown>>) ?? [];
      } catch {
        continue;
      }
      if (!eps.length) continue;

      out.push({
        season: sn,
        name: (sd.name as string) ?? (sn === 0 ? 'Specials' : `Season ${sn}`),
        isSpecials: sn === 0,
        episodes: eps.map((e) => ({
          episode: Number(e.episode_number ?? 0),
          name: (e.name as string) ?? null,
          airDate: (e.air_date as string) ?? null,
          runtime: typeof e.runtime === 'number' ? e.runtime : null,
          stillPath: (e.still_path as string) ?? null,
          overview: (e.overview as string) ?? null,
        })),
      });
    }

    // 兜底：逐季接口全挂但详情声明了集数 → 至少记下总量，保证缺口判断有基准线
    if (!out.length && declaredEpisodes > 0) {
      out.push({
        season: 1,
        name: 'Season 1',
        isSpecials: false,
        episodes: Array.from({ length: declaredEpisodes }, (_, i): Ep => ({
          episode: i + 1, name: null, airDate: null,
          runtime: null, stillPath: null, overview: null,
        })),
      });
    }

    return out;
  }

  /** 连通性校验 */
  async ping(): Promise<boolean> {
    try {
      await this.get('/configuration');
      return true;
    } catch {
      return false;
    }
  }
}