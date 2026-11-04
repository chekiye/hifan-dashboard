/**
 * 数据库 Schema v1
 *
 * 设计要点（详见 docs/开发文档.md §3）：
 * 1. TMDB 侧 tmdb_work 是唯一真源，local_work 是被比对方
 * 2. 每部作品记录 source_channel，用于评估双通道抓取的必要性与效果
 * 3. gap 表是派生结果，可随时由前三张表重算，不做增量维护
 */

/** Schema 版本号 —— 每次结构变更必须递增并新增 migration 文件 */
export const SCHEMA_VERSION = 1;

/** migration 列表：按顺序执行，只增不改 */
export const MIGRATIONS: string[] = [
  // ── v1: 初始结构 ────────────────────────────────────────────────
  `
  -- ============ TMDB 基准池 ============
  CREATE TABLE IF NOT EXISTS tmdb_work (
    id             INTEGER PRIMARY KEY,          -- TMDB id（tv/movie 各自空间）
    media_type     TEXT    NOT NULL,             -- 'tv' | 'movie'
    name_original  TEXT,                         -- original_name 原始标题（日文/罗马字/英文）
    name_zh        TEXT,                         -- language=zh-CN 取到的中文名（TMDB 无中文则等于原名）
    first_air_date TEXT,
    year           INTEGER,
    episode_total  INTEGER NOT NULL DEFAULT 0,   -- TMDB 声明的总集数
    season_count   INTEGER NOT NULL DEFAULT 0,
    popularity     REAL,
    adult          INTEGER NOT NULL DEFAULT 0,
    genres         TEXT,                         -- JSON array
    source_channel TEXT    NOT NULL,             -- 'keyword'|'local_seed'|'manual'
    fetched_at     TEXT,
    UNIQUE (media_type, id)
  );

  CREATE TABLE IF NOT EXISTS tmdb_episode (
    work_id    INTEGER NOT NULL,
    season     INTEGER NOT NULL,
    episode    INTEGER NOT NULL,
    ep_name    TEXT,                            -- 单集标题（用户明确需求：剧集名）
    air_date   TEXT,
    runtime    INTEGER,
    still_path TEXT,
    overview   TEXT,
    PRIMARY KEY (work_id, season, episode),
    FOREIGN KEY (work_id) REFERENCES tmdb_work(id) ON DELETE CASCADE
  );

  -- ============ 本地库 ============
  CREATE TABLE IF NOT EXISTS local_work (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    dir_path     TEXT    UNIQUE NOT NULL,       -- 绝对路径
    dir_name     TEXT,
    tmdb_id      INTEGER,                       -- 可空 = 未对上
    media_type   TEXT    DEFAULT 'tv',
    parsed_title TEXT,
    parsed_year  INTEGER,
    scan_status  TEXT    NOT NULL DEFAULT 'pending',  -- pending|ok|error
    scan_error   TEXT,
    scanned_at   TEXT,
    FOREIGN KEY (tmdb_id) REFERENCES tmdb_work(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS local_file (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    work_id    INTEGER NOT NULL,
    file_path  TEXT    NOT NULL,
    file_name  TEXT,
    file_size  INTEGER,
    season     INTEGER,                          -- 解析出的季号，可空（剧场版）
    episode    INTEGER,                          -- 解析出的集号，可空
    extension  TEXT,
    FOREIGN KEY (work_id) REFERENCES local_work(id) ON DELETE CASCADE
  );

  -- ============ 比对结果 ============
  CREATE TABLE IF NOT EXISTS match_result (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_work_id  INTEGER,
    local_work_id INTEGER,
    direction     TEXT    NOT NULL,             -- 'tmdb_to_local'|'local_to_tmdb'
    confidence    TEXT    NOT NULL,             -- 'auto'|'review'|'none'
    score         INTEGER NOT NULL DEFAULT 0,
    method        TEXT,                          -- 'id_direct'|'name_exact'|'variant'|'romaji'
    matched_names TEXT,                          -- JSON array: 命中的名字变体
    warning       TEXT,
    matched_at    TEXT,
    UNIQUE (tmdb_work_id, local_work_id, direction),
    FOREIGN KEY (tmdb_work_id) REFERENCES tmdb_work(id) ON DELETE CASCADE,
    FOREIGN KEY (local_work_id) REFERENCES local_work(id) ON DELETE CASCADE
  );

  -- ============ 派生缺口（可重算，不做增量维护） ============
  CREATE TABLE IF NOT EXISTS gap (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    kind             TEXT    NOT NULL,          -- 'missing_work'|'missing_ep'|'unlisted'
    tmdb_work_id     INTEGER,
    local_work_id    INTEGER,
    season           INTEGER,
    missing_episodes TEXT,                      -- JSON array: [3,4,7]
    created_at       TEXT,
    FOREIGN KEY (tmdb_work_id) REFERENCES tmdb_work(id) ON DELETE CASCADE,
    FOREIGN KEY (local_work_id) REFERENCES local_work(id) ON DELETE CASCADE
  );

  -- ============ 采集任务状态（断点续跑用） ============
  CREATE TABLE IF NOT EXISTS job_state (
    job_name      TEXT PRIMARY KEY,             -- 'collect_keyword'|'collect_seed'|'scan_local'|'rebuild_gap'
    status        TEXT NOT NULL,                -- 'idle'|'running'|'done'|'failed'
    cursor        TEXT,                          -- 断点：已完成的最后 id / 页码
    processed     INTEGER NOT NULL DEFAULT 0,
    succeeded     INTEGER NOT NULL DEFAULT 0,
    failed        INTEGER NOT NULL DEFAULT 0,
    started_at    TEXT,
    finished_at   TEXT,
    last_error    TEXT,
    updated_at    TEXT
  );

  -- ============ 索引 ============
  CREATE INDEX IF NOT EXISTS idx_tmdb_year    ON tmdb_work(year);
  CREATE INDEX IF NOT EXISTS idx_tmdb_channel ON tmdb_work(source_channel);
  CREATE INDEX IF NOT EXISTS idx_local_tmdbid ON local_work(tmdb_id);
  CREATE INDEX IF NOT EXISTS idx_file_work    ON local_file(work_id);
  CREATE INDEX IF NOT EXISTS idx_file_se      ON local_file(work_id, season, episode);
  CREATE INDEX IF NOT EXISTS idx_gap_kind     ON gap(kind);
  CREATE INDEX IF NOT EXISTS idx_match_dir    ON match_result(direction, confidence);
  `,

  // ── v2: 图片字段（2026-10-13，需求变更：看板需展示封面与剧照）────────────
  //
  // 起因：用户明确要求「不只是标题，封面图、剧集图等都要下载下来」。
  // v1 只存了文字字段，看板拿不到图片路径 → 补齐图片相关字段。
  //
  // 设计取舍：只存 TMDB 的**相对路径**（如 /abc.jpg），不存完整 URL。
  // 完整 URL 需要拼 CDN 域名 + size 规格，不同规格（w342/w500/original）
  // 对应不同文件；存相对路径可让服务端按需拼接，也可换 CDN 域名而不改数据。
  //
  // ⚠️ migration 采用 append-only：已发布的不可改，改结构一律新增。
  `
  -- ============ TMDB 作品：图片 ============
  ALTER TABLE tmdb_work ADD COLUMN poster_path TEXT;      -- 竖版封面 2:3
  ALTER TABLE tmdb_work ADD COLUMN backdrop_path TEXT;    -- 横版背景 16:9
  ALTER TABLE tmdb_work ADD COLUMN poster_local TEXT;     -- 本地落地相对路径，下载成功后回填
  ALTER TABLE tmdb_work ADD COLUMN logo_path TEXT;        -- 透明 logo（部分作品有）

  -- ============ TMDB 单集：剧照 ============
  ALTER TABLE tmdb_episode ADD COLUMN still_local TEXT;   -- 本地剧照相对路径

  CREATE INDEX IF NOT EXISTS idx_tmdb_poster_local ON tmdb_work(poster_local);
  `,

  // ── v3: 修正标题字段语义（2026-10-13，用户发现看板全是日文/罗马字）──────
  //
  // v2 及之前的字段是错位的：
  //   name_ja ← original_name（正确）
  //   name_zh ← 用 language=ja-JP 拉详情返回的「name」，实际是**罗马字**，不是中文
  //
  // 证据（实测 tmdb/tv/91352）：
  //   original_name = ファイブカード
  //   ja-JP  name   = Faibu Kādo        ← 我错当成中文
  //   zh-CN  name   = 五张魔法牌         ← 真正的中文名
  //
  // 根因：xike-lifan-organize 早就写过「搜索用 ja-JP，中文名要另走详情接口回查」，
  // 本次采集直接用 ja-JP 取详情，把罗马字写进了 name_zh，绕过了那条经验。
  //
  // 处置：改名 name_ja → name_original，并在采集器里以 zh-CN 重新回填。
  `
  -- ALTER TABLE tmdb_work RENAME COLUMN name_ja TO name_original;
  -- ⚠️ 上面这行是本条 migration 留档的原语句，已停用（下方说明原因）。
  --
  -- 2026-10-14 修正（scripts/smoke_v5.mjs 实测抓到）：
  --   这句 RENAME 写错了列名 —— v1 建表 DDL 里用的**已经是** name_original，
  --   于是全新库跑 migration 必然报 no such column: name_ja。
  --   线上库一直没暴露，是因为 v3 早被 _migration 标记为已执行，
  --   这句 SQL 从未在真实数据上跑过，一直是「看起来对」的死代码。
  --
  --   SQLite 的 RENAME COLUMN 没有 IF EXISTS 语义，无法在本文件里自判
  --   「有才改、没有就跳过」。处置：v3 变成空操作（**索引 2 不变**，
  --   已执行过的库照旧跳过），真正需要的列名对齐交给
  --   core/src/db.ts 的 preflightColumnCompat() 在迁移前完成。
  `,

  // ── v4: 全量库 v7 + 待确认队列（2026-10-14）────────────────────────
  //
  // 起因：M2 的 tmdb_work 是「TMDB 自己收录的池」（1284 部），
  // 而 10-14 定稿的 v7 全量库是「TMDB ⇄ hanime ⇄ M-TEAM 三源合一」（1699 部），
  // 两者口径不同、集合不同，塞进同一张表会污染统计。
  //
  // ⭐ 关键设计：每条记录都要带**证据链**（evidence/evidence_json）。
  // 用户口径是「每条必须有二值结论，证据薄弱不可接受」——
  // 看板要能一眼看出「这条凭什么算已定」「那条为什么判无词条」，
  // 否则同一个坑（alternative_titles 假死）会再犯一次。
  `
  -- ============ 全量库 v7（三源合一定稿） ============
  CREATE TABLE IF NOT EXISTS library_work (
    tmdb_id      INTEGER NOT NULL,                -- TMDB id
    media_type   TEXT    NOT NULL DEFAULT 'tv',   -- 'tv'|'movie' —— tv/movie 是两个 id 空间！
    name_zh      TEXT,
    name_original TEXT,                           -- original_name / original_title
    year         INTEGER,
    episodes     INTEGER NOT NULL DEFAULT 0,
    poster_path  TEXT,                            -- TMDB 相对路径，看板拼 CDN
    sources      TEXT,                            -- 'hanime+mteam+tmdb' 组合，逗号分隔
    src_titles   TEXT,                            -- 源标题样例，' | ' 分隔
    -- ⭐ 证据链
    evidence     TEXT,                            -- A|B 级判定依据（字面全同/字面强/池内全同）
    dice         REAL,                            -- bigram Dice 值
    exact        INTEGER NOT NULL DEFAULT 0,      -- 1=命中别名与源标题逐字全同
    alt_names    TEXT,                            -- TMDB 官方别名（含 HK/TW 港台译名）
    via          TEXT,                            -- '网络(ja-JP)'|'V4池内全同'|...
    type_evidence TEXT,                           -- mediaType 怎么定出来的（'zh-CN 命中自身 id「次强音」'）
    ingested_at  TEXT,
    PRIMARY KEY (media_type, tmdb_id)             -- ⭐ 与 tmdb_work 的 UNIQUE 口径一致
  );
  CREATE INDEX IF NOT EXISTS idx_lib_year    ON library_work(year);
  CREATE INDEX IF NOT EXISTS idx_lib_sources ON library_work(sources);

  -- ============ 待确认队列 ============
  -- 四类：
  --   'no_entry'  TMDB 查无此条目（多语言+全区别名+三路查询都试过）
  --   'review'    有候选但置信不足，等人工判断
  --   'attached'  是已入库作品的后续集，attachTo 指向主作品
  --   'type_und'  已入库但 media_type 判不出 —— 危害最大：
  --              主键是 (media_type, tmdb_id)，类型不确定就等于实体不确定
  CREATE TABLE IF NOT EXISTS review_queue (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT    NOT NULL,                -- 'no_entry'|'review'|'attached'|'type_und'
    src          TEXT,                            -- 'hanime'|'mteam'|'library'
    src_title    TEXT    NOT NULL,
    root_title   TEXT,                            -- 剥掉集号后的主标题
    year         INTEGER,
    attach_to    INTEGER,                         -- kind='attached' 时指向 tmdb_id
    attach_name  TEXT,                            -- 主作品名（便于看板直接显示）
    candidate_id INTEGER,                         -- kind='review' 的候选
    candidate_name TEXT,
    dice         REAL,
    evidence     TEXT,                            -- 判定依据（给人看的说明）
    queries_json TEXT,                            -- 试过的查询串，便于人工自己搜
    decided      TEXT,                            -- NULL=待处理 | 'accept' | 'reject' | 'gap'
    decided_at   TEXT,
    UNIQUE (src, src_title, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_rq_kind    ON review_queue(kind);
  CREATE INDEX IF NOT EXISTS idx_rq_decided ON review_queue(decided);
  CREATE INDEX IF NOT EXISTS idx_rq_src     ON review_queue(src, year);
  `,

  // ── v5: 统一 TMDB 2000+ 主库（2026-10-14，产品结构纠正）────────────
  //
  // 起因：8848 看板是本项目的产品本身，主线必须是
  //   「TMDB 2000+ 完整词条 → 本地文件匹配 → 未下载 / 缺集 / 完整」
  //   而不是「核对全量库」。此前把 v7 的 1547 条塞进 library_work 并在
  //   看板上加了第三个页签「全量库 v7」，等于把支线当主线 —— 用户明确否决
  //   （原话：「你这是倒反天乾」「这项目不就废了吗」）。
  //
  // 处置：library_work 降级为「核对证据档」，不再作为看板数据源；
  //      它的内容经 packages/collector/src/enrich_pool.ts 提升进 tmdb_work，
  //      成为主库的一部分。主库 = tmdb_work ∪ (library_work 独有记录)。
  //
  // 实测集合关系（2026-10-14，NAS 线上库）：
  //   tmdb_work        1284
  //   library_work     1547
  //   重叠             1190
  //   仅 library_work   357   ← 待提升（含 2 条 tv/movie 同 id，属两个 id 空间）
  //   仅 tmdb_work       94   ← v7 未覆盖但仍是 TMDB 收录，全是 movie，必须保留
  //   统一主库        1641  （1284 + 357）
  //
  // ⚠️ 关于 v3：上面那条 RENAME COLUMN name_ja 写错了列名 —— v1 建表时
  //   用的已经是 name_original。全新库跑 migration 必然报 no such column。
  //   线上库没暴露是因为 v3 早被 _migration 标记为已执行，那句 SQL 从未
  //   在真实数据上跑过。已由 core/src/db.ts 的 preflightColumnCompat()
  //   在迁移前做幂等列名对齐（v3 的索引不动，历史库照旧跳过）。
  `
  ALTER TABLE tmdb_work ADD COLUMN work_origin    TEXT;   -- 'm2_keyword'|'v7_merge'
  ALTER TABLE tmdb_work ADD COLUMN discovery_srcs  TEXT;   -- 'hanime,mteam,tmdb'
  ALTER TABLE tmdb_work ADD COLUMN evidence_note  TEXT;   -- evidence/dice/exact 摘要
  ALTER TABLE tmdb_work ADD COLUMN evidence_json  TEXT;   -- 完整证据链 JSON（详情抽屉用）

  CREATE INDEX IF NOT EXISTS idx_tmdb_origin ON tmdb_work(work_origin);

  -- ============ tmdb_episode 补 media_type（表重建） ============
  --
  -- 缺陷：tv 与 movie 是 TMDB 两个独立 id 空间，但 tmdb_episode 主键是
  --   (work_id, season, episode)，没有 media_type。线上实测已有 2 条 tv 作品
  --   与库中 movie 同 id（616140 黑市拍卖、1421614 阎罗国），一旦写入季集
  --   就会互相覆盖。与 tmdb_work 的 UNIQUE(media_type, id) 口径必须对齐。
  --
  -- SQLite 不能 ALTER 改主键，只能建新表 → 搬数据 → 删旧表。
  -- media_type 由 tmdb_work 反查（episode 表只有 work_id）。
  CREATE TABLE IF NOT EXISTS tmdb_episode_v5 (
    work_id     INTEGER NOT NULL,
    media_type  TEXT    NOT NULL DEFAULT 'tv',
    season      INTEGER NOT NULL,
    episode     INTEGER NOT NULL,
    ep_name     TEXT,
    air_date    TEXT,
    runtime     INTEGER,
    still_path  TEXT,
    still_local TEXT,
    overview    TEXT,
    PRIMARY KEY (media_type, work_id, season, episode)
  );

  INSERT OR IGNORE INTO tmdb_episode_v5
    (work_id, media_type, season, episode, ep_name, air_date, runtime, still_path, still_local, overview)
  SELECT e.work_id,
         COALESCE((SELECT w.media_type FROM tmdb_work w WHERE w.id = e.work_id LIMIT 1), 'tv'),
         e.season, e.episode, e.ep_name, e.air_date, e.runtime, e.still_path, e.still_local, e.overview
  FROM tmdb_episode e;

  DROP TABLE tmdb_episode;
  ALTER TABLE tmdb_episode_v5 RENAME TO tmdb_episode;

  CREATE INDEX IF NOT EXISTS idx_episode_work ON tmdb_episode(media_type, work_id, season, episode);
  `,

  `
  -- ============ #6 逐件屏蔽（2026-10-20 蛙哥：不是一刀切，要能一件一件屏蔽） ============
  --
  -- 🔴 为什么**必须独立成表**，⛔ 不能复用 tmdb_work.is_quarantined：
  --   is_quarantined 现在混了三种语义：① 10-19 21:45 的「2000 年前整体下线」
  --   ② TMDB 重复副本（铁律 0au/0t）③ 理由不明的历史隔离。
  --   一旦复用，屏蔽一部作品就再也说不清「当初为什么隔离」，
  --   而且屏蔽是**高频、可逆、逐件**的操作，隔离是**低频、批量、语义重**的操作。
  --
  -- ⭐ 两边分开存（蛙哥拍板）：主键不同 —— 确定看板屏蔽作品（tmdb_id），
  --   未确定看板屏蔽源记录（src_key，一源 = 一集），互不干扰。
  --
  -- scope 区分两侧：'board' = 确定看板的 TMDB 作品；
  --   'unconfirmed' = 未确定看板的 source_work 记录。
  CREATE TABLE IF NOT EXISTS work_hidden (
    scope        TEXT    NOT NULL,
    key          TEXT    NOT NULL,   -- board: tmdb_id；unconfirmed: source_work.src_key
    reason       TEXT,               -- 屏蔽理由（可选，方便日后回看）
    hidden_by    TEXT    NOT NULL DEFAULT 'wa',
    hidden_at    TEXT    NOT NULL,
    unhidden_at  TEXT,               -- 取消屏蔽时写时间（⛔ 不 DELETE，保留审计）
    PRIMARY KEY (scope, key)
  );

  CREATE INDEX IF NOT EXISTS idx_hidden_at ON work_hidden(hidden_at);
  `,

  `
  -- ============ #7 源站官方集数（2026-10-21 蛙哥数据完整性专项）============
  --
  -- ⭐ 为什么需要这一列：
  --   2026-10-21 查出「只抓到部分」的根因 —— **hanime 的搜索索引不收录多集作品的全部卷**
  --   （同一部 13 集的作品，索引里只露 1 集，害得蛙哥以为我们抓全了）。
  --   权威全集在**作品播放列表页**，那里有 sidebar-video-count（官方集数）。
  --   ⚠️ 但官方集数不落库的话，看板分不清两件完全不同的事：
  --     ①「我们只抓到 1 集」      —— 我们的漏抓（可修）
  --     ②「源站本来就只有 5 集」  —— 与 TMDB 口径不同（是绑定问题，不是漏抓）
  --   两者都表现为「N 条 vs M 集」⇒ 不落库，蛙哥在看板上会一直误判。
  --
  -- 口径：这一行对应的**那个 hanime 作品**在源站播放列表里的官方集数。
  --   · 一行 = 一个 hanime 作品（src_key）⇒ 官方集数是**行级**的
  --   · 一个 TMDB 作品可能对应多个 hanime 作品（合集/系列，如 tmdb 98089
  --     「一起做愛吧」= 7~8 部独立短片），
  --     所以看板上按作品求和时必须用 SUM(official_episodes)
  --   · NULL = 还没核过（老数据，或没做过播放列表排查的作品）
  --
  -- 数据来自源站只读抓取，⛔ 不参与匹配判定，纯展示 + 闸门用。
  ALTER TABLE source_work ADD COLUMN official_episodes INTEGER;
  `,

  `
  -- ============ #8 TMDB 季名（2026-10-21 蛙哥指正：逐集对齐要按「季」对）============
  --
  -- ⭐ 为什么需要：
  --   逐集对齐如果只拿「集名（剧情名）」去对「源站的卷标题」，必然错位：
  --     TMDB 姦染 S4 = 強好后宮 / 強好派對 / 路線A…（都是剧情名）
  --     源站        = 姦染5～The Daybreak～ 1/2/3
  --   蛙哥原话：「第 4 季本身就叫 姦染5～The Daybreak，单从标题就可以匹配上了，
  --     姦染5～The Daybreak～1-3 刚好 3 集，不就刚好对应第 4 季的 3 集吗」
  --   ⇒ 正确的对齐粒度是**季**：先对「季名 + 季集数」，再对季内分集名。
  --   而库里 tmdb_episode 只有 season 序号 + 集名，**没有季名** ⇒ 必须单独落一张表。
  --
  -- 口径：
  --   · name    = zh-CN 季名（与库里 ep_name 同语种 ⇒ 繁简归一后可直接互比）
  --   · name_ja = 日文季名（与源站日文原名最接近，备用）
  --   · ep_count= 该季在 TMDB 的集数（季级数量核对要用）
  CREATE TABLE IF NOT EXISTS tmdb_season (
    work_id    INTEGER NOT NULL,
    media_type TEXT    NOT NULL DEFAULT 'tv',
    season     INTEGER NOT NULL,
    name       TEXT,          -- zh-CN 季名
    name_ja    TEXT,          -- 日文季名
    ep_count   INTEGER,       -- 该季集数
    air_date   TEXT,          -- 该季首集播出日
    PRIMARY KEY (media_type, work_id, season)
  );

  CREATE INDEX IF NOT EXISTS idx_season_work ON tmdb_season(work_id);
  `,

  `
  -- ============ #9 作品级原名（2026-10-21 蛙哥指正「用原标题对齐」）===========
  --
  -- 为什么要有这一列：
  --   蛙哥原话：「tmdb 的原标题，日语标题，和 hanime 和 mteam 的原标题，
  --             匹配率可以高达 90% 以上」⇒ 要用原标题对齐。
  --   而 hanime 侧**清单页给的是分集级中文译名**（「作品名 1」「作品名 第2話」），
  --   拿它去比 TMDB 的作品名是比不准的（标题被序号污染）——
  --   真正能用的是**作品级**原名：hanime 视频页里 playlist?list= 那个链接的文字
  --   （「ミセスジャンキー ボリューム」「自宅警備員2」…）。
  --
  -- 有了它能：
  --   ① 把「作品名 + 序号」的源标题剥成可比部分（残差匹配，见 align.ts）
  --   ② 核对这一行到底绑的是哪个作品（61456：Free Friend ≠ Free!男子游泳部）
  --   ③ 看板直接显示「作品原名」，核对时一眼能看出译名对不对
  --
  -- 取值：hanime 视频页的作品级原名（日文）；mteam 行留空
  --       （mteam 的 title 本身就是原名，在 source_work.title 里）。
  ALTER TABLE source_work ADD COLUMN work_ja TEXT;
  `,

  `
  -- ============ #10 分集日文集名（2026-10-22 A/B 对拍定案）===========
  --
  -- 为什么要有这一列（**A/B 对拍实测**，不是估算）：
  --   问题：TMDB 的 zh-CN 与 ja-JP 是**两套独立翻译**，
  --        zh-CN 侧 35.9% 的集名是「第 N 集」占位名（铁律 0bc）
  --        ⇒ 「集名锚」在中文侧失效 ⇒ 逐集对齐只能退到 season/vol 档。
  --   实测（research/_align_ja_ab_*，全库对拍，非抽样）：
  --        基线      已配上 6201（marker 1490 / season 2583 / strong 1334 / vol 794）
  --        加 ja 通道 已配上 6214（新增 13 / **丢失 0** / 换集 0）
  --        逐条核验：**13/13 真命中、0 误配**
  --        （例 #93175 源「性愛沙灘上的修學旅行!!」↔ ja 集名
  --          「ヤリモクビーチに修学旅行で!! THE ANIMATION」↔ TMDB S0E1）
  --
  -- ⛔ **为什么不是几百条**（此前 14.1% vs 35.4% 的争论）：
  --   那两个数量的都是「**命中率**」，不是「**落位会变几条**」——
  --   命中 ≠ 会改变落位：多数 ja 命中发生在**已经配对正确**的集上（零增量），
  --   或发生在「同一部内 ja 名不唯一」的集上（当不了锚）。
  --   ⇒ 真增量只有 13 条。**全量对拍是唯一能回答这个问题的口径**。
  --
  -- ⚠️ **ja 名只对 hanime 有效**：源条目的日文原名只在
  --   source_work.entry_detail[].title_ja（hanime 才有）；
  --   mteam 的 title 本身是中文/原名混合、无独立日文原名字段
  --   ⇒ ja 集名与 mteam 源标题**没有同语言的对照物**（铁律 0r 禁跨语言相似度）
  --   ⇒ ja 通道对 mteam 天然无效，这是收益上限低的原因之一。
  --
  -- 取值：TMDB /tv/{id}/season/{n}?language=ja-JP 的 episodes[].name
  --       （★ 必须是 ja-JP；0cy 铁律：集名语言必须与源标题同语言才有区分力）
  --
  -- ⛔ 本迁移**只加列**，回填数据用 UPDATE（不触发 ALTER 守卫）。
  ALTER TABLE tmdb_episode ADD COLUMN ep_name_ja TEXT;
  `,

  `
  -- ============ #N 人工核对标记（2026-10-24 蛙哥）============
  --
  -- 蛙哥原话：「8848 看板目前有屏蔽该部但是没有已核对之类的，就是我到时候
  --   如果确认这一部没问题，我可以在 8848 看板上直接标记我核对过」
  --
  -- ⭐ 语义：**人眼核对过这一部、确认没问题**。是「凭证」，不是「过滤器」——
  --   核对过的部**照样显示在看板上**（⛔ 不像 work_hidden 那样藏起来），
  --   只是多一个 ✓ 角标 + 计入进度（已核对 N/1456）。
  --
  -- 🔴 为什么⛔ 不复用 work_hidden 加一个 scope='checked'：
  --   ① 两者的**默认视图行为相反** —— hidden 要从列表里过滤掉（board.ts:1095
  --      的 visibleEx 会拼一条 NOT EXISTS 子查询查 work_hidden），一旦混进来
  --      核对过的部会被当成「已屏蔽」直接从看板消失 = 灾难）；
  --   ② hidden.stats() 按 scope 分组返回，混进 checked 会污染「已屏蔽 N 部」角标；
  --   ③ 取消屏蔽写 unhidden_at、取消核对写 unchecked_at，语义字段名不同，
  --      硬塞一张表会让「当初是屏蔽还是核对」这件事日后说不清。
  --   ⇒ 与 work_hidden 同构但**独立成表**（和当初不复用 is_quarantined 的理由同源）。
  --
  -- ⛔ 取消核对不 DELETE，写 unchecked_at 保留审计（铁律 0：禁 DELETE）。
  CREATE TABLE IF NOT EXISTS work_checked (
    scope        TEXT    NOT NULL DEFAULT 'board',  -- 预留：将来未确定看板可按源核对
    key          TEXT    NOT NULL,                  -- board: tmdb_id（文本）
    note         TEXT,                              -- 可选备注（如「S2 缺 1 集，已知」）
    checked_by   TEXT    NOT NULL DEFAULT 'wa',
    checked_at   TEXT    NOT NULL,
    unchecked_at TEXT,                              -- 取消核对时写时间（⛔ 不 DELETE）
    PRIMARY KEY (scope, key)
  );

  CREATE INDEX IF NOT EXISTS idx_checked_at ON work_checked(checked_at);
  `,

  /* ══════════════════════════════════════════════════════════════════
     ⭐ 2026-10-27（§70）Emby「动画里番」库同步 —— **入库判定的唯一事实来源**

     蛙哥定调原话：「有没有在这个 emby 库里，这才是里番的入库判定标准」。
     此前看板「入库判定」读的是 `local_file / local_work`（扫 /library/已整理 的本地文件），
     实测两批内容**几乎完全不重叠**：Emby 里番库 457 部 ∩ 本地 622 部 = 仅 3 部。
     根因：Emby 的 17 个库路径全是 `/strm/...` / `/media/downloads/...`，
     **没有任何一个库挂 /library** ⇒ 本地那批文件 Emby 根本看不到。

     🔴 判据是**目录名里的 `{tmdbid=xxxxx}`**：457 部 Series 全部带（0 无 id、0 重复），
        属于 TMDB ID 逐字相等，⛔ 不是标题模糊匹配。
     🔴 权限坑：非 admin 账号若没被授权该库，`Items?ParentId=196470` 会返回 **0 条**
        —— 那是**权限过滤的假 0**，不是库里没有（实测「电视号」账号返 0，admin 返 457）。
     🔴 这两张表只存 **Emby 的事实**，不存任何判断；判据逻辑留在查询处。

     ⛔ 取消条目不 DELETE：同步用 `DELETE` 会丢审计 —— 这里改为
        「先全量写 staging，再按 synced_at 标记」，见 scripts/emby_sync.py。
        表内的行永远代表「某次同步时它确实在库里」。
     ══════════════════════════════════════════════════════════════════ */
  `
  CREATE TABLE IF NOT EXISTS emby_series (
    tmdb_id     INTEGER PRIMARY KEY,   -- 从目录名 {tmdbid=} 解析出的 TMDB ID
    emby_id     TEXT    NOT NULL,      -- Emby 内部 ItemId
    name        TEXT,
    year        INTEGER,
    path        TEXT,                  -- 完整路径（含 {tmdbid=...} 那段）
    child_count INTEGER,
    synced_at   TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS emby_episode (
    tmdb_id   INTEGER NOT NULL,
    season    INTEGER NOT NULL,
    episode   INTEGER NOT NULL,
    emby_id   TEXT,
    series_id TEXT,
    path      TEXT,
    synced_at TEXT,
    PRIMARY KEY (tmdb_id, season, episode)
  );

  CREATE INDEX IF NOT EXISTS idx_emby_ep_work ON emby_episode(tmdb_id);

  -- 每次同步的元信息：库 id、同步时间、Series/Episode 条数
  CREATE TABLE IF NOT EXISTS emby_sync_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  `,

  /* ══════════════════════════════════════════════════════════════════
     ⭐ 2026-10-27（§73）人工确认入库 —— **TMDB 有假集/无资源集时的唯一出路**

     蛙哥原话：「针对这些我知道都入库了，但系统无法判断的，我手动标记入库没问题，
               这种交给我人工判断会好很多」
              「人工标记后的效果和 ai 识别无问题的效果一样」

     ## 为什么会有这张表
     TMDB 存在两类「多出来的集」，机器判不了：
       ① **纯占位假集**：无剧照 / 无简介 / 无片长（如 `#284897` S1E3）
       ② **真番外但无资源**：有剧照、有片长，只是从来没被压制（如 `#207840` S0 的
          「番外篇 3.5 话 / 6.5 话」）
     两者都会让「Emby 已收 N 集 / TMDB N+2 集」永远差几集，入库检测无法闭环。
     全库实测只有 **30 部**是「Emby 每季集号连续无洞 + TMDB 集数更多」，
     规模小到可以人工逐部拍板 —— 那就交给人。

     ## 🔴 为什么⛔ 不复用 work_checked（这两件事核的不是同一个维度）
     | | work_checked | work_emby_verified |
     |---|---|---|
     | 核什么 | TMDB/hanime/mteam 三方**信息对齐**（是不是同一部、集号配得对不对） | Emby 里**到底收全没有** |
     | 影响判定 | ❌ 不影响，只留凭证 | ✅ `embyFull` 直接变 true |
     | 对列表 | 照常显示 + ✓ 描边 | 卡面集数徽章变绿标 |
     一部作品完全可能「信息对齐了但没入库」，也可能「入库了但信息有歧义」
     ⇒ 两个维度，各自独立成表（同 work_hidden 与 work_checked 分表的理由）。

     ## 🔴 snap_eps / snap_need：确认时**必须**存快照（防假闭环）
     只存一个布尔「已确认」会变成永久假绿：
       今天确认「后宫露营 8 集收全」→ 三个月后删掉 2 集 → 卡面还是绿的。
     所以把确认当时的 `Emby 已收 / TMDB 有效` 一起存下来；
     查询时若当前值与之不符 ⇒ 仍然算已入库（人工判断优先），
     但卡面打 `⚠` 提示「确认后数据已变，请复核」。
     ⚠️ 未知（NULL）时不校验 —— 旧数据/接口没给，不能凭空判过期。

     ## ⛔ 取消不 DELETE，写 revoked_at 留审计（铁律 0）
     ══════════════════════════════════════════════════════════════════ */
  `
  CREATE TABLE IF NOT EXISTS work_emby_verified (
    tmdb_id     INTEGER NOT NULL,
    media_type  TEXT    NOT NULL DEFAULT 'tv',
    note        TEXT,                          -- 可选备注（如「S0 番外无资源」）
    verified_by TEXT    NOT NULL DEFAULT 'wa',
    verified_at TEXT    NOT NULL,
    revoked_at  TEXT,                          -- 取消确认时写时间（⛔ 不 DELETE）
    snap_eps    INTEGER,                       -- 确认当时 Emby 已收几集
    snap_need   INTEGER,                       -- 确认当时 TMDB 有效几集（已扣屏蔽季）
    PRIMARY KEY (media_type, tmdb_id)
  );

  CREATE INDEX IF NOT EXISTS idx_emby_ver_at ON work_emby_verified(verified_at);
  `,

  /* ══════════════════════════════════════════════════════════════════
     ⭐ 2026-10-28（§80）喜欢 / 待下 / 订阅 —— **下载队列的候选池**

     蛙哥原话：「再加一个喜欢（待下，订阅）功能就是我点一下，这一部进入一个待下状态，
               空了我去补下载+入库。这功能也要做批量，我可以批量选择喜欢的片」

     ## 与另外三张表的关系（⛔ 四个维度，别混）
     | | work_hidden | work_checked | work_emby_verified | work_want |
     |---|---|---|---|---|
     | 意图 | 不想看 ⇒ 藏起来 | 三方信息核对过 | 入库收全了 | 我想看/想收 ⇒ 待下 |
     | 对列表 | **过滤掉** | 照常显示 + ✓ | 照常显示，集数徽章变绿 | 照常显示 + ♥ |
     | 对判定 | 无 | 无 | `embyFull` 变 true | 无（纯标记，不参与入库判定） |
     | 取消字段 | unhidden_at | unchecked_at | revoked_at | revoked_at |

     🔴 为什么⛔ 不复用 work_checked：核对是「我验过了」，待下是「我还没收」——
        一部完全可以「待下且未核对」。语义相反（一个是完成，一个是待办），
        混在一张表会让「待下清单」要么漏、要么把核过的都当成待下。

     ## 三态（同一张表，靠时间戳表达，⛔ 不 DELETE）
       ① 新加待下   ⇒ want_at 有值、done_at NULL、revoked_at NULL   → 待下中
       ② 已下好/入库 ⇒ done_at 有值（手动点「已下载」，或扫 Emby 自动闭环）→ 已收，仍留在清单
       ③ 不要了     ⇒ revoked_at 有值                              → 出局（历史仍可审计）
       ⭐ 为什么保留「已下好」而不是直接删：蛙哥要的是「空了去补下载」——
          点完之后能看见「这批已经补过了」，否则清单会一直躺着已入库的部。

     ## snap_eps / snap_need：入清单时记一笔 Emby 现状
       用途同 work_emby_verified 的快照 —— 扫 Emby 后能判断「这部是不是这期间收全了」，
       从而自动 done。NULL 表示记的时候拿不到数字（⛔ 不编造）。
     ══════════════════════════════════════════════════════════════════ */
  `
  CREATE TABLE IF NOT EXISTS work_want (
    media_type TEXT    NOT NULL DEFAULT 'tv',
    tmdb_id    INTEGER NOT NULL,
    note       TEXT,
    want_by    TEXT    NOT NULL DEFAULT 'wa',
    want_at    TEXT    NOT NULL,
    done_at    TEXT,                              -- 已下载/已入库（⛔ 不 DELETE）
    revoked_at TEXT,                              -- 取消待下时写时间（⛔ 不 DELETE）
    snap_eps   INTEGER,                           -- 加入时 Emby 已收几集
    snap_need  INTEGER,                           -- 加入时 TMDB 有效几集
    PRIMARY KEY (media_type, tmdb_id)
  );

  CREATE INDEX IF NOT EXISTS idx_want_at ON work_want(want_at);
  `,

  /* ══════════════════════════════════════════════════════════════════
     ⭐ 2026-10-29（§84）hanime 下载链接映射库 —— 「每部剧对应哪个下载链接」

     蛙哥原话：「首先我们能不能把 hanime 里番和泡面番所有剧集的下载链接都扒下来，
               每部剧对应哪个下载链接，都扒下来我们再研究用什么去下载」

     ## 为什么要单独一张表（而不是塞进 source_work.entry_detail）
     - `entry_detail` 是**源站事实**（vid / 集号 / 标题），⛔ 不该混进「会过期的签名」。
       链接是**带时效的派生物**，混进去会让 §79 的「entry_detail 增量合并」判据变脏。
     - 链接**会过期**（实测 TTL 11~12 小时，youjizz 型 48 小时）
       ⇒ 必须把 `expires_at` 存下来，否则用的时候才发现过期，已经下载到一半才失败。

     ## 三个字段的分工
     | vid        | 主键，hanime 视频 id（= entry_detail[].vid） |
     | url        | 当前最高画质的直链（带签名） |
     | expires_at | 签名过期时间戳（Unix 秒）—— ⛔ 不存过期时间就等于没存 |

     ## 为什么 `quality` 单列
     实测画质分布：1080p 1610 / 720p 1885 / 480p 48。
     有 1074 部**最高只有 720p**（老片/低清片，源站没有 1080p 档）
     ⇒ 第二阶段选下载源时要看这个，别默认「有 1080」。

     ## 为什么 `src_kind` 单列
     实测四种源形态，签名参数完全不同 ⇒ 刷新逻辑要按型走：
       hembed  `vdownload[.N].hembed.com/<vid>-sc-<q>p.mp4?secure=<sig>,<ts>`
       hembed  `vdownload[.N].hembed.com/<vid>-<q>p.mp4?token=<sig>&expires=<ts>`（无 1080p 档）
       youjizz `abre-videos.youjizz.com/.../master.m3u8?...&validto=<ts>`
       other   第三方 CDN（lajiao-bo / sb-cd 等，形态不稳定）

     ## 抓取方式（2026-10-29 实测）
     复用飞牛浏览器（fygo-browser）的登录态与 CF clearance，
     在页面上下文里同源 `fetch('/watch?v=<vid>')` 批量取 HTML ⇒ 不用逐页 navigate。
     ⛔ 不硬闯 Cloudflare（requests/curl/FlareSolverr/无头浏览器全部被挡）。
     ══════════════════════════════════════════════════════════════════ */
  `
  CREATE TABLE IF NOT EXISTS source_link (
    vid         TEXT PRIMARY KEY,               -- hanime 视频 id
    url         TEXT NOT NULL,                  -- 最高画质直链（带签名）
    quality     INTEGER,                        -- 1080 / 720 / 480
    src_kind    TEXT,                           -- hembed / youjizz / other
    is_m3u8     INTEGER DEFAULT 0,              -- 1 = HLS（要 ffmpeg 合流），0 = 直链 mp4
    expires_at  INTEGER,                        -- 签名过期 Unix 秒（⛔ 不存就等于没存）
    title       TEXT,                           -- 源站播放页标题（人工核对用）
    fetched_at  TEXT NOT NULL                   -- 抓取时刻 ISO
  );

  CREATE INDEX IF NOT EXISTS idx_link_exp ON source_link(expires_at);
  CREATE INDEX IF NOT EXISTS idx_link_src ON source_link(src_kind);
  `,

  /* ══════════════════════════════════════════════════════════════════
     ⭐ 2026-10-29（§85）hanime 下载任务表 —— 「点了下载之后发生了什么」的审计

     蛙哥：「下载路径落到 /本地下载盘」
     ⇒ 下载动作必须留痕：下了没有、下了多少字节、落在哪个文件、报了什么错。

     ## 为什么用「一集一行 + 状态字段」而不是「一集一行 + 每次尝试一行」
     - 看板要显示「这集已下载 / 下载中 / 失败 / 签名过期」，⇒ 需要**当前态**
     - 铁律 0：⛔ 禁 DELETE ⇒ 失败重试也要留痕，不能覆盖掉历史
     ⇒ 一集一行，状态用时间戳表达三态（同 work_want 的做法）：
        started_at 有值 / done_at NULL      → 进行中或失败（看 error_msg）
        done_at 有值                        → 已完成
        revoked_at 有值                     → 人工作废（文件被删了）

     ## 字段分工
     | vid        | 主键，= source_link.vid（⛔ 不另编 id，保持与链接表一一对应） |
     | media_type | tv / movie（落盘目录与 MP 命名要用） |
     | tmdb_id    | 落位到的 TMDB 作品（用于文件名与「作品级」聚合） |
     | season/ep  | 落位到的季集（文件名 -SxxExx） |
     | file_path  | 落盘后的绝对路径（容器内路径 /downloads/...） |
     | bytes      | 实际落盘字节数（对账用） |
     | quality    | 下载时的画质（源站可能降档，记录当时事实） |
     | error_msg  | 失败原因（签名过期 / HTTP 403 / 磁盘满 …） |

     ## ⛔ 为什么 expires_at 不在这张表
     签名过期时间属于**链接**，属于 source_link。
     这张表只记「下载行为」，两者靠 vid JOIN。
     ══════════════════════════════════════════════════════════════════ */
  `
  CREATE TABLE IF NOT EXISTS work_dl (
    vid         TEXT PRIMARY KEY,               -- = source_link.vid
    media_type  TEXT,                           -- tv / movie
    tmdb_id     INTEGER,                        -- 落位到的 TMDB 作品
    season      INTEGER,                        -- 落位季（1 起；Special=0）
    episode     INTEGER,                        -- 落位集
    file_path   TEXT,                           -- 落盘绝对路径
    bytes       INTEGER,                        -- 实际字节数
    quality     INTEGER,                        -- 下载时画质
    error_msg   TEXT,                           -- 失败原因
    started_at  TEXT,                           -- 开始下载 ISO
    done_at     TEXT,                           -- 完成 ISO（NULL = 未完成）
    revoked_at  TEXT                            -- 人工作废 ISO（⛔ 不 DELETE）
  );

  CREATE INDEX IF NOT EXISTS idx_dl_work ON work_dl(tmdb_id, media_type);
  CREATE INDEX IF NOT EXISTS idx_dl_state ON work_dl(done_at, revoked_at);
  `,
  `

  /* ══════════════════════════════════════════════════════════════════
     ⭐ 2026-10-30（§86）统一 source_link.fetched_at 的时区格式

     ## 🔴 为什么需要（实测踩到的真 bug）
     线上 source_link.fetched_at **混了两种格式**：
       · 3541 条 = 2026-10-29T17:21:13.077379  ← Python 写的本地时间，**无时区标识**
       ·    7 条 = 2026-10-29T11:39:50.470Z      ← JS 写的 UTC，带 Z
     ⇒ **字符串排序把首末算反了**（实测「首次抓取」显示得比「上次抓链接」还晚）
     ⇒ 看板的「新鲜度」指标会说谎。

     ## 🔴 修法：全部换算成 UTC ISO（带 Z）
     - 无时区标识的 ⇒ 源数据确定是 **CST / UTC+8**（NAS 与容器时区实测一致）⇒ 减 8 小时
     - 已带 Z / 有偏移 ⇒ 原样保留（只补齐毫秒位）
     - 毫秒位从原串第 21 位起取 3 位（不足右补零）⇒ 亚秒精度不丢
     ⇒ 之后所有写入方都用 toISOString()（relink.ts / hanime_linkmap_load.ts 都已如此）
     ⇒ 这条 migration 只做一次性归一，⛔ 不动 url / quality / expires_at 等事实字段。

     ## ⚠️ 为什么用固定 -8 hours 而不是 localtime 修饰符
     localtime 依赖**执行时所在机器的时区** ⇒ 换台机器重放这条 migration 就会算错 8 小时。
     源数据的时区是确定的（CST），⇒ 写死偏移更安全。
     ══════════════════════════════════════════════════════════════════ */
  UPDATE source_link
     SET fetched_at =
         CASE WHEN fetched_at LIKE '%Z'
              THEN strftime('%Y-%m-%dT%H:%M:%S', replace(substr(fetched_at, 1, 19), 'T', ' '))
                   || '.' || CASE
                        WHEN length(substr(fetched_at, 21)) >= 3 THEN substr(fetched_at, 21, 3)
                        ELSE substr(fetched_at, 21) || substr('000', 1, 3 - length(substr(fetched_at, 21)))
                      END || 'Z'
              ELSE strftime('%Y-%m-%dT%H:%M:%S',
                            datetime(replace(substr(fetched_at, 1, 19), 'T', ' '), '-8 hours'))
                   || '.' || CASE
                        WHEN length(substr(fetched_at, 21)) >= 3 THEN substr(fetched_at, 21, 3)
                        ELSE substr(fetched_at, 21) || substr('000', 1, 3 - length(substr(fetched_at, 21)))
                      END || 'Z'
            END
   WHERE fetched_at IS NOT NULL
     AND fetched_at != ''
     AND fetched_at NOT LIKE '%Z';
`,
  `
  /* ══════════════════════════════════════════════════════════════════
     ⭐ 2026-10-30（§88）下载队列与实时进度

     ## 🔴 为什么需要（蛙哥原话）
     「能否做进 8848 看板，下载进度能否看见」
     ⇒ 原来的下载是**同步阻塞**的：POST /api/dl/one 一直挂着，一集下完才返回，
       整部下就挂几分钟，中途没有任何数字可看，刷新页面就断。

     ## 🔴 状态**不再新增 state 列**，继续用时间戳推导（同 work_want 的路子）
     | 条件 | 含义 |
     |---|---|
     | done_at 非空 | 已完成 |
     | revoked_at 非空 | 人工作废 |
     | queued_at 非空 + done_at 空 + error_msg 空 | 在队列里（排队或下载中） |
     | error_msg 非空 + done_at 空 | 上次失败 |
     ⇒ 是否「正在下」看 beam_at（心跳）：**超过 90 秒没心跳就是僵死**
       （进程被杀 / 容器重启），worker 会把它捡回来重跑。

     ## 字段
     | queued_at      | 入队时间（排序用，先入先下） |
     | total_bytes    | 源站报的总大小（Content-Length），未知为 NULL |
     | progress_bytes | 已落盘字节（运行中**每秒**更新） |
     | speed_kbps     | 最近一次统计的瞬时速度 |
     | channel        | 走的哪条通道：direct / proxy0 / proxy1 …（算流量用） |
     | beam_at        | 心跳时间（判僵死） |
     | attempts       | 尝试次数（自动重试上限用） |

     ## ⚠️ 不用 backtick 写注释
     这里整段是**模板字符串**，出现反引号会直接截断 SQL（§85 真踩过）。
     ══════════════════════════════════════════════════════════════════ */
  ALTER TABLE work_dl ADD COLUMN queued_at      TEXT;
  ALTER TABLE work_dl ADD COLUMN total_bytes    INTEGER;
  ALTER TABLE work_dl ADD COLUMN progress_bytes INTEGER;
  ALTER TABLE work_dl ADD COLUMN speed_kbps     INTEGER;
  ALTER TABLE work_dl ADD COLUMN channel        TEXT;
  ALTER TABLE work_dl ADD COLUMN beam_at        TEXT;
  ALTER TABLE work_dl ADD COLUMN attempts       INTEGER DEFAULT 0;

  CREATE INDEX IF NOT EXISTS idx_dl_queue ON work_dl(queued_at, done_at, revoked_at);
`,
  `
  /* ══════════════════════════════════════════════════════════════════
     ⭐ 2026-10-30（§91）刮削入库（驱动 MoviePilot v3）

     ## 🔴 为什么必须有这张表
     下载完只等于「文件在待整理目录里躺着」。真正让 Emby 看到内容的是
     **刮削 + 改名 + 搬进 115 媒体库**（剧名 (年) [tmdbid=N]/Season 1/… + nfo + 图片）。
     这一步目前由 MoviePilot 执行（蛙哥 10-30 已实测「完美刮削」），
     看板负责**逐集驱动 + 记录结果**，否则「下完了」和「入库了」永远是两件事。

     ## 🔴 状态推导（同 work_want / work_dl 的路子，⛔ 不新增 state 列）
     | 条件 | 含义 |
     |---|---|
     | done_at 非空 | 已进 115 媒体库（dest 有完整目标路径）|
     | revoked_at 非空 | 人工作废 |
     | queued_at 非空 + done_at 空 + err 空 | 在刮削队列里 |
     | err 非空 + done_at 空 | 上次失败（attempts 计次）|
     | queued_at 空 | 「一条龙」里等下载完成（waiting_dl）|

     ## 字段
     | vid        | = source_link.vid / work_dl.vid（一集一行，主键）|
     | src_path   | MP 侧的源路径（容器路径按 mpPathMap 换算后的）|
     | dest       | MP 返回的最终目标路径（含剧名/季/集名）|
     | title/year | MP 识别出的剧名与年份（与媒体库目录一致）|
     | ep_title   | 集名（从目标文件名解析，如「向着悠远的天穹」）|
     | err        | 失败原因（MP 原文，⛔ 不吞）|

     ## ⚠️ 不用 backtick 写注释
     整段是模板字符串，出现反引号会直接截断 SQL。
     ══════════════════════════════════════════════════════════════════ */
  CREATE TABLE IF NOT EXISTS work_ingest (
    vid         TEXT PRIMARY KEY,
    tmdb_id     INTEGER,
    season      INTEGER,
    episode     INTEGER,
    src_path    TEXT,
    dest        TEXT,
    title       TEXT,
    year        INTEGER,
    ep_title    TEXT,
    err         TEXT,
    queued_at   TEXT,
    done_at     TEXT,
    beam_at     TEXT,
    attempts    INTEGER DEFAULT 0,
    revoked_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ing_state ON work_ingest(done_at, revoked_at, queued_at);
  CREATE INDEX IF NOT EXISTS idx_ing_work  ON work_ingest(tmdb_id);
`,

  `
  -- ============ #20 作品级简介 tmdb_work.overview（2026-10-31）===========
  --
  -- 为什么要有这一列（蛙哥报「8848 看板好多提示 TMDB 无简介，但我去看是有的」）：
  --   TMDB **作品级**（/tv/{id}、/movie/{id}）返回的 overview 是完整剧情简介，
  --   实测 #103258「姬辱 ~公主双人狩猎~」作品级有 274 字中文简介，
  --   而它的 3 集**集级 overview 全是空**（实测 ep1/ep2/ep3 长度均为 0）。
  --   ⇒ 老代码「作品级没有 overview ⇒ 取第一个有简介的集」这条兜底路径，
  --     对这批作品**必然落空** ⇒ 855/1635 部在看板误报「TMDB 无简介」。
  --
  -- 为什么是「加列」而不是「改表重建」：
  --   · ALTER TABLE ADD COLUMN 在 SQLite 上对既有行不重写、不改数据（安全）
  --   · migration 是 append-only ⇒ 只在末尾追加，不动已发布的任何一条
  --   · 迁移随容器启动自动执行（packages/core/src/db.ts:117 migrate(db)）
  --
  -- 取值口径：**只存中文**（language=zh-CN），与看板界面语言一致。
  --   ⚠️ TMDB 无中文翻译时该字段留空（不回落英文/罗马字），避免看板出洋文。
  ALTER TABLE tmdb_work ADD COLUMN overview TEXT;
`,

  `
  -- ============ #21 hanime 逐集标签 + 预览图（2026-10-31 §108）===========
  --
  -- 起因（蛙哥两条需求）：
  --   ① 「TMDB 剧集无图的、但有 hanime 的，抓取 hanime 的预览图做剧集海报」
  --   ④ 「hanime 的每一集都把他的标签抓下来放到对应的集数，看标签就知道类型」
  --
  -- 为什么单独建表而不是塞进 source_work：
  --   · 标签和封面都是**逐视频**（vid）的属性，而 source_work 是**逐作品**一行
  --   · 一个作品多集时，每集的标签不同（实测 ファミレス戦士プリン order1 8 个标签，
  --     order2 会有差异）⇒ 按作品存会互相覆盖
  --   · vid 是天然主键（= source_link.vid = alignment 行里的条目 id）
  --
  -- 字段分工：
  --   | tags        | JSON 数组，顺序与源站页面一致（源站按相关度排的，不要重排）|
  --   | cover_url   | 源站原图 URL（带签名，TTL 约 2 周，仅供追溯/重抓）        |
  --   | cover_local | 本地落地相对路径 still_hn/<vid>.jpg（相对 /images/）        |
  --
  -- 🔴 为什么必须落盘而不是直接用 cover_url 当图片地址：
  --   hembed 的图片 URL 带 secure 签名，实测有效期到 1794623911（约 2 周后）。
  --   直接把外链塞给前端 ⇒ 两周后整片看板的集海报集体裂图，而且浏览器跨域取不到。
  --
  -- ⚠️ 一张 vid 一行，抓失败也要留行（tags 为 NULL）——
  --    否则「没抓到」和「没这条」在数据上无法区分（0r 家族口径）。
  CREATE TABLE IF NOT EXISTS video_tag (
    vid         TEXT PRIMARY KEY,
    tags        TEXT,
    cover_url   TEXT,
    cover_local TEXT,
    fetched_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_vtag_cover ON video_tag(cover_local);
`,

  `
  -- ============ #22 分集简介中文译本（2026-11-01 §114）===========
  --
  -- 起因（蛙哥）：「分集简介里有 1211 条只有英文（中文 277、日文 244）。要翻成中文」。
  --
  -- 🔴 为什么不直接覆盖 overview：
  --   · overview 是 **TMDB 原始值**，下次 refresh / 重抓会整片覆盖 ⇒ 译文丢失
  --   · 数据上必须能分清「TMDB 本来给的」与「我们翻的」（0r 家族口径：
  --     抓失败要留行，同样的，翻过的也要留痕，否则无法回滚/复翻）
  --   · 原文还可能被复用来重新翻译（换更好的引擎/人工精修）
  --   ⇒ 译文单独一列，overview 原样不动。前端取 overviewZh 优先、回退 overview。
  --
  -- 字段分工：
  --   | overview     | TMDB 原始简介，⛔ 永不写入译文 |
  --   | overview_zh  | 中文译文；NULL = 未翻译；空串 = 翻出来没内容（如纯符号）|
  --
  -- ⚠️ 幂等：ALTER TABLE ADD COLUMN 在 SQLite 里没有 IF NOT EXISTS 语义，
  --    由 db.ts 的 _migration 版本号保证只跑一次（与 #20 同法）。
  ALTER TABLE tmdb_episode ADD COLUMN overview_zh TEXT;
`,

  `
  -- ============ #23 逐集媒体体积/画质对照（2026-11-01 §115）============
  --
  -- 起因（蛙哥）：「把本地盘的里番匹配上 8848 看板剧集，标记视频大小，
  --   把 hanime 的下载视频大小也标记出来，对比哪个质量更好」
  --   「要在 8848 看板各处都能看到对比……一眼看出我应该下哪一个」
  --
  -- 🔴 口径 🔴 —— 一集可能同时有三个东西，⛔ 不能混成一个「大小」：
  --   | 字段      | 是什么                                        | 怎么来的 |
  --   | mt_*      | **mteam 盘上原始文件**（NAS /vol02 全量库）    | ffprobe 实测 |
  --   | lib_*     | **库内已整理文件**（115 /library/已整理）      | local_file.file_size（只有大小）|
  --   | src_quality | **hanime 源侧最高可下档位**（1080/720/480）  | source_link.quality |
  --
  --   ⚠️ lib_* **不等于 hanime**：库内混着 mteam 的文件（文件名自带 [FWD-0018] 这类番号，
  --     实测 112 集「双侧都有」里 83 集字节完全相同）。界面必须写「库内」，⛔ 不许写「hanime」。
  --   ⚠️ lib_* 只有大小、没有分辨率：115 是 FUSE 挂载，ffprobe 读不到；Emby 侧是 strm（size=0）。
  --
  -- verdict 取值见 docs/画质对比-问题与计划.md「四、判定口径」，三处页面共用一套，⛔ 不许各写一份。
  --
  -- 🔴 为什么落库而不是每次现算：
  --   ffprobe 扫全盘要 SSH + 700 次进程调用（约 3 分钟），不能挂在接口上；
  --   而下载要跑 24h，数据会变 ⇒ 需要「可重跑的离线快照 + 接口只读快照」。
  --   刷新 = 重跑 scripts/sync_ep_media.py（纯数据，⛔ 不用重建镜像）。
  CREATE TABLE IF NOT EXISTS ep_media (
    work_id     INTEGER NOT NULL,
    season      INTEGER NOT NULL,
    episode     INTEGER NOT NULL,
    -- ── mteam 盘上实测（ffprobe）──────────────────────────────
    mt_size     INTEGER,          -- 字节；NULL = 这集 mteam 还没落盘
    mt_w        INTEGER,
    mt_h        INTEGER,          -- 竖直分辨率，判「非顶格」用它
    mt_codec    TEXT,             -- h264 / hevc …
    mt_mbps     REAL,             -- 视频码率（Mbps，实测；缺 bit_rate 时按 字节/时长 反算）
    mt_sec      REAL,             -- 时长（秒）
    mt_n        INTEGER,          -- 这集挂了几个文件（chs/cht 多语言版会 >1）
    mt_code     TEXT,             -- 源番号，便于人工回查
    mt_files    TEXT,             -- JSON 数组 [{name,size,w,h,codec,mbps,sec,path}]
    -- ── 库内已整理（115）────────────────────────────────────
    lib_size    INTEGER,
    lib_n       INTEGER,
    lib_files   TEXT,             -- JSON 数组 [{name,size}]（没有分辨率，⛔ 不编）
    -- ── hanime 源侧 ─────────────────────────────────────────
    src_quality INTEGER,          -- 源侧最高可下档：1080 / 720 / 480；NULL = 没抓到链接
    -- ── 结论 ────────────────────────────────────────────────
    verdict     TEXT,             -- same / mt_better / mt_slight / even / ha_better /
                                  -- ha_maybe / mt_low / only_mt / only_lib / mt_pending
    note        TEXT,             -- 给蛙哥看的一句话（含数字，⛔ 不写「可能」「大概」这种废话）
    updated_at  TEXT NOT NULL,    -- 快照时间（页面要显示「数据截至」）
    PRIMARY KEY (work_id, season, episode)
  );

  -- 详情页按 work_id 一次取全季；列表页按 verdict 聚合统计
  CREATE INDEX IF NOT EXISTS idx_epmedia_work ON ep_media(work_id);
  CREATE INDEX IF NOT EXISTS idx_epmedia_verdict ON ep_media(verdict);
`,

  `
  -- ============ #24 hanime 源侧实际文件体积（2026-11-01 §116）============
  --
  -- 起因（蛙哥）：「hanime 抓不到视频信息吗？……hanime 下载页，这个下载按钮
  --   无法获取视频大小吗」
  --
  -- 🔴 答案是**能拿到**（2026-11-01 实测，不是推断）：
  --   站点那栏「檔案大小」自己写的是 N/A，但下载按钮指向的是 CDN 直链
  --   （vdownload.hembed.com/<vid>-<q>p.mp4?secure=...），对它发 HEAD 就回
  --   content-length。实测 vid 101432：
  --     1080p 108,698,622 B（103.7 MB）/ 720p 63,841,215 B / 480p 44,165,681 B
  --
  -- 🔴 关键性质：**体积是永久事实，链接不是**。
  --   签名 TTL 约 11~35 小时（secure 参数里的过期时刻），过期后 HEAD 回 410 Gone；
  --   但文件本身大小不会变 ⇒ 抓到一次就永远有效。
  --   ⇒ size 存在 source_link（跟着链接走），重抓时刷新；
  --   ⚠️ 重抓失败（410 / CF 拦）⇒ **不许把已有 size 覆盖成 NULL**，
  --      与「失败不动旧行」是同一条铁律。
  --
  -- ⚠️ 粒度 = vid（= 一集），不是作品：同一部不同集大小差得很远。
  --   所以只加在 source_link 上、由 readEpisodeLinks 按 vid 发给前端，
  --   ⛔ 不塞进 ep_media 的 src_quality 那条（那是**作品级**最高档，粒度不同）。
  ALTER TABLE source_link ADD COLUMN size INTEGER;
`,

  `
  -- ============ #25 mteam 全量种子清单的体积/文件名（2026-11-01 §117）============
  --
  -- 起因（蛙哥）：「hanime 和 mteam 的视频信息是 8848 全库都要做」
  --
  -- 🔴 原来的缺口：ep_media 只有「盘上 ffprobe 实测」那一份体积（mt_size），
  --   而盘上实际只有 868 个文件（全量清单 3594 个）⇒ 930 部作品的 mteam 那一格
  --   只有番号、没有体积，画质对比整列是空的。
  --
  -- 🔴 好消息：种子清单 mt_files.json 里 3594 个视频**全部带体积**
  --   （3590 条有值，合计 1223 GB），不需要等下载完就能显示。
  --
  -- ⚠️ 所以 mteam 侧要分成**两份事实**，⛔ 不许合并成一个 size：
  --      mt_size      盘上实测（ffprobe，有分辨率/编码/码率，是「已到手」）
  --      mt_list_size 清单体积（种子就写着，是「待下/在下的那份有多大」）
  --   两者的 h/codec/mbps 只有盘上那份才有 —— 清单里没有这些字段。
  --
  -- ⚠️ 粒度 = 集（与 mt_size 一致）：清单里一条视频对应一集，多文件装一集的
  --   用 mt_list_n 记个数、mt_list_files 存 JSON。
  ALTER TABLE ep_media ADD COLUMN mt_list_size INTEGER;
  ALTER TABLE ep_media ADD COLUMN mt_list_n INTEGER;
  ALTER TABLE ep_media ADD COLUMN mt_list_files TEXT;
`,
  `  -- ============ #26 人工绑定表（2026-11-01 §124）============
  -- 🔴⚠️ 0r33：本段在 TS 模板字符串内 ⇒ ⛔ **禁止出现反引号**（会终止模板）。
  --    写注释时用中文引号或去掉引号，别用 code 这种写法。
  --
  -- 起因（蛙哥）：「再加一个未匹配的筛选，我直接筛选未匹配，然后人工把未匹配的
  --   匹配上，我们这个全量名单就完整了」
  --
  -- 🔴🔴 为什么要**单独一张表**，而不是直接改 source_work：
  --   source_work 是**匹配层的产物**，每次跑 build_mt_disk_match.py /
  --   mteam_extract.py 都可能被重写覆盖 ⇒ 人工判定会**被机器逻辑吃掉**。
  --   人工事实必须是**独立、只增不改**的一层，机器匹配只能读它、不能覆盖它。
  --   （0r159：人工结论必须比机器结论更硬，否则人工白干）
  --
  -- 📌 口径说明：
  --   · src_key = 人工绑定的**源侧标识**，两种形态：
  --       ① mteam 番号（如 JDXA-56704）—— 大小写不敏感，存大写
  --       ② mteam 月度合集的**作品名键**（_T_<作品名>）—— 2026 那批没有番号
  --   · work_id = 绑定的 TMDB 作品 id
  --   · season/episode = 可选的集位钉死（NULL = 只钉作品，集号交给引擎）
  --   · 一行 = 一条人工绑定；改绑 = 新增一行（superseded_by 标记旧行失效）
  --
  -- ⚠️ **不改 source_work**：那是匹配层的账本，由匹配引擎自己维护。
  --    引擎读本表并优先采用，等价于「人工覆盖机器」。
  CREATE TABLE IF NOT EXISTS manual_bind (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    src           TEXT    NOT NULL,          -- 'mteam'（当前只支持 mteam 文件级未匹配）
    src_key       TEXT    NOT NULL,          -- 番号 或 _T_<作品名>
    work_id       INTEGER NOT NULL,          -- → tmdb_work.id
    media_type    TEXT    NOT NULL DEFAULT 'tv',
    season        INTEGER,                   -- NULL = 不钉
    episode       INTEGER,                   -- NULL = 不钉
    file_name     TEXT,                      -- 原始文件名（留证据，方便回溯是哪条）
    note          TEXT,
    decided_by    TEXT,
    decided_at    TEXT,
    created_at    TEXT,
    superseded_by INTEGER,                   -- 指向改绑后的新行 id；NULL = 生效中
    UNIQUE (src, src_key)
  );

  CREATE INDEX IF NOT EXISTS idx_manual_bind_key ON manual_bind(src, src_key);
  CREATE INDEX IF NOT EXISTS idx_manual_bind_work ON manual_bind(work_id);
`,

  `
  -- ============ #27 逐集「这一集从哪个源取」（2026-11-02 §135）============
  --
  -- 起因（蛙哥原话）：
  --   「新增一个指定集数，比如我第一集打算从 hanime 下，第二集打算直接调取
  --     mteam 的本地视频，就是可以给我手动选择，哪一集我想要哪个资源，
  --     然后新增一个下载按钮，我选好之后点击下载，就可以走完下载，改名，刮削，入库」
  --
  -- 为什么要独立一张表（⛔ 不塞 source_work / work_dl / work_ingest）：
  --   · source_work 是匹配层的账本，由匹配引擎维护（0r159：人工事实别改引擎的账）
  --   · work_dl 主键是 vid（hanime 视频 id）—— mteam 本地文件**没有 vid**
  --   · work_ingest 主键也是 vid，且语义是「刮削任务」不是「来源选择」
  --   ⇒ 来源选择是**人工决策**，单独一层，可追溯、可改、⛔ 不删。
  --
  -- 状态语义：superseded_at IS NULL = 当前生效的那一条。
  --   改选 = 新增一行 + 旧行置 superseded_at（partial unique index 保证每集只有一条生效）。
  --   ⛔ 不做 UPDATE src，也⛔ 不 DELETE —— 改过什么要能查得到。
  --
  -- 空集 = 没人工选过 ⇒ 走默认策略（mteam 盘上已有就用 mteam，否则 hanime）。
  CREATE TABLE IF NOT EXISTS work_ep_src (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    work_id       INTEGER NOT NULL,          -- → tmdb_work.id
    season        INTEGER NOT NULL,
    episode       INTEGER NOT NULL,
    src           TEXT    NOT NULL,          -- 'hanime' | 'mteam'
    hanime_vid    TEXT,                      -- src=hanime 时：具体哪条源（一集可能多条）
    mt_path       TEXT,                      -- src=mteam 时：相对 MT_ROOT 的路径
    note          TEXT,                      -- 人工备注（例：字幕时间轴只配 CHS）
    picked_at     TEXT    NOT NULL,
    superseded_at TEXT                       -- 改选时置位；NULL = 生效中
  );

  -- 每集只允许一条生效的选择（partial unique index —— SQLite 3.8+ 支持）
  CREATE UNIQUE INDEX IF NOT EXISTS idx_epsrc_active
    ON work_ep_src(work_id, season, episode) WHERE superseded_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_epsrc_work ON work_ep_src(work_id, superseded_at);
`,

  `
  -- ============ #23 标签档位（2026-11-04 §151）============
  --
  -- 蛙哥：「把 hanime 的所有视频标签抓出来汇总去重，我不想看伪娘、猎奇这种，
  --        就把这部分高亮，让我一眼看出来，然后避开下载；标签我会不定期增删」
  --
  -- 一行一个标签。level：1 = 避开（红）· 2 = 喜欢（绿）· 0 = 取消过（不展示，留审计）。
  --
  -- 🔴 为什么独立成表，⛔ 不加列到 video_tag：
  --   video_tag 是**抓取产物**，重抓会整片覆盖 ⇒ 人工判定会丢
  --   （与 §114 分集译文不进 overview 是同一条铁律：人工事实必须独立成层，0r159）。
  -- ⚠️ 取消标记写 level=0，⛔ 不 DELETE —— 项目铁律「禁 DELETE」，且可反悔。
  -- ⚠️ 标签原文**逐字匹配** video_tag.tags 里的字符串，⛔ 不做归一化：
  --   源站标签本身就是人工翻译过的中文词，同义词合并是另一件事。
  CREATE TABLE IF NOT EXISTS tag_mark (
    tag        TEXT PRIMARY KEY,
    level      INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT    NOT NULL
  );
`,
];

/** 当前 schema 应有的版本号 */
export const CURRENT_MIGRATION_INDEX = MIGRATIONS.length;
// 说明：migration 采用「只增不改」原则（append-only）。
// 已发布的 migration 一旦执行过就不可修改，否则会出现
// 「新环境跑全部 migration」与「老环境只跑增量」结构不一致的问题。
// 需要改结构时，新增一个 migration 文件并递增 SCHEMA_VERSION。
