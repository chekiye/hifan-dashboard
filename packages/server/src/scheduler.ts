/**
 * 更新调度器 —— 看板设置页驱动的定期扫描
 *
 * 🔴 定位：**cron 表达式由用户在 8848 看板「设置」页里改**，
 *    调度器跑在 server 容器内（node），不依赖 NAS crontab。
 *    理由：蛙哥要求「后续可以自由改时间」，放 NAS crontab 得 SSH；
 *    放看板设置里打开网页就能改。
 *
 * 🔴 两个独立表达式（蛙哥拍板「分两个」）：
 *    - hanimeCron：**主链路** —— 抓 hanime → 差集 → 落事实字段 → 调 TMDB 判定
 *                  （判定= 回答「分集更新 还是 新番」，见 tmdb_judge.ts）
 *    - tmdbCron  ：**兜底** —— hanime 集数比 TMDB 多时重拉分集元数据
 *                  ⛔ 不再 discover 新作品（那是孤儿与未来番的来源）
 *
 * 🔴 铁律 1：**同一次触发不重复执行**
 *   判据 = 「当前分钟」是否等于 cron 命中的那一分钟。
 *   调度器每 30 秒醒一次，同一分钟内可能醒多次 ⇒ 必须去重。
 *
 * 🔴 铁律 2：**上一轮没跑完不叠加**
 *   有任务在跑时直接跳过本轮并记一条 `skipped`，不排队、不并发。
 *   （并发跑同一套抓取 = 同一份产物被两个进程写 ⇒ 文件互相覆盖。）
 *
 * 🔴 铁律 3：**非法 cron 表达式必须暴露，不能静默**
 *   表达式解析失败 ⇒ 该任务标记为 `invalid` 并在设置页显示错误，
 *   ⛔绝不「解析失败就当永不触发」—— 那样看起来装好了但永远不跑。
 *
 * 🔴 铁律 4：**执行记录必须留痕**
 *   每次执行写一条：开始/结束时间、耗时、结果、发现的新增/续更数。
 *   没有记录 = 无法回答「上次更新是什么时候扫的、扫到了什么」。
 *
 * 🔴 铁律 5：**执行记录必须持久化到磁盘**（2026-10-28 补）
 *   只放内存 ⇒ 容器一重启（每次 deploy / NAS 重启）就全没了
 *   ⇒ 用户下周打开看板看到「还没有执行记录」，会以为定时扫描从没跑过
 *   ⇒ 真相恰恰相反：扫过了，只是记录被重启冲掉了。
 *   ⇒ 跟配置文件同目录存 `scheduler.records.json`，滚动保留最近 30 条。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseCron, nextRun, describeCron, cronMatches, CronParseError, type ParsedCron } from './cron.js';

export type TaskName = 'hanime' | 'tmdb';

export interface SchedulerConfig {
  /** hanime 扫描 cron（5 段） */
  hanimeCron: string;
  /** TMDB 扫描 cron（5 段） */
  tmdbCron: string;
  /** 是否启用 */
  enabled: boolean;
  /** hanime 扫描的年份（近 N 年）。空数组 = 全量 */
  hanimeYears: number[];
  /** 是否自动落库（事实字段） */
  autoApply: boolean;
}

export interface RunRecord {
  id: string;
  task: TaskName;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  /** 结果摘要 */
  summary: Record<string, unknown>;
  error: string | null;
  /** 手动触发还是定时触发 */
  trigger: 'cron' | 'manual';
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  // 默认：每周一 04:00（hanime）/ 每周一 04:30（TMDB）
  hanimeCron: '0 4 * * 1',
  tmdbCron: '30 4 * * 1',
  enabled: true,
  // 默认近 1 年（2026）—— 蛙哥拍板「近1年+首次全量基线」
  hanimeYears: [2026],
  autoApply: true,
};

export class Scheduler {
  private config: SchedulerConfig;
  private parsed: Record<TaskName, ParsedCron | null> = { hanime: null, tmdb: null };
  private configError: Record<TaskName, string | null> = { hanime: null, tmdb: null };
  /** 上次触发过的「任务名 + 分钟键」——用于去重 */
  private lastFiredMinute = new Map<TaskName, string>();
  /** 正在运行的任务 */
  private running = new Set<TaskName>();
  /** 执行记录（内存 + 磁盘，滚动保留最近 N 条） */
  private records: RunRecord[] = [];
  /** 执行记录持久化文件路径（与配置同目录） */
  private readonly recordsPath: string;
  private timer: NodeJS.Timeout | null = null;
  private readonly recordsKeep = 30;

  constructor(
    private readonly configPath: string,
    private readonly runner: {
      hanime: () => Promise<Record<string, unknown>>;
      tmdb: () => Promise<Record<string, unknown>>;
    },
    private readonly onLog: (msg: string, meta?: Record<string, unknown>) => void = () => {},
  ) {
    // 🔴 记录文件放配置旁边（同一个数据目录）
    this.recordsPath = configPath.replace(/\.json$/i, '') + '.records.json';
    this.config = this.load();
    this.reparse();
    this.records = this.loadRecords();
  }

  // ── 配置持久化 ────────────────────────────────────────────────

  private load(): SchedulerConfig {
    try {
      if (!existsSync(this.configPath)) return { ...DEFAULT_CONFIG };
      const raw = JSON.parse(readFileSync(this.configPath, 'utf-8')) as Partial<SchedulerConfig>;
      return {
        ...DEFAULT_CONFIG,
        ...raw,
        hanimeYears:
          Array.isArray(raw.hanimeYears) && raw.hanimeYears.length > 0
            ? raw.hanimeYears.map(Number).filter((n) => Number.isFinite(n))
            : [...DEFAULT_CONFIG.hanimeYears],
      };
    } catch (err) {
      this.onLog('调度器配置读取失败，用默认值', { err: String(err) });
      return { ...DEFAULT_CONFIG };
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.configPath), { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      this.onLog('调度器配置写入失败', { err: String(err) });
    }
  }

  /** 🔴 读磁盘上的执行记录（启动时调用） */
  private loadRecords(): RunRecord[] {
    try {
      if (!existsSync(this.recordsPath)) return [];
      const raw = JSON.parse(readFileSync(this.recordsPath, 'utf-8')) as unknown;
      if (!Array.isArray(raw)) return [];
      // 只保留结构对的记录（脏数据不许把整个面板打挂）
      const rows = raw
        .filter(
          (r): r is RunRecord =>
            !!r && typeof r === 'object' && typeof (r as RunRecord).task === 'string',
        )
        .slice(-this.recordsKeep);
      // 🔴🔴 归一化「卡在 running 的记录」——
      //   上一轮跑的过程中容器被 kill（deploy / NAS 重启）⇒ 记录停在 running
      //   ⇒ 读回来永远显示「进行中」，用户以为还在跑（其实早没了）
      //   ⇒ 启动时统一判为 failed（并注明是异常中断）
      let fixed = 0;
      for (const r of rows) {
        if (r.status === 'running') {
          r.status = 'failed';
          r.error = r.error || '上次执行被中断（容器重启或进程终止）';
          r.finishedAt = r.finishedAt || r.startedAt;
          fixed++;
        }
      }
      if (fixed > 0) this.onLog(`归一化 ${fixed} 条中断的执行记录`);
      return rows;
    } catch (err) {
      this.onLog('执行记录读取失败，从空开始', { err: String(err) });
      return [];
    }
  }

  /** 🔴 写磁盘（每条记录都写一次 —— 记录少、文件小，无所谓） */
  private saveRecords(): void {
    try {
      mkdirSync(dirname(this.recordsPath), { recursive: true });
      writeFileSync(this.recordsPath, JSON.stringify(this.records, null, 2), 'utf-8');
    } catch (err) {
      // ⛔ 落盘失败只记日志，⛔不许让整轮执行崩掉（记录是辅助，不是主流程）
      this.onLog('执行记录写入失败', { err: String(err) });
    }
  }

  private reparse(): void {    const exprOf = (task: TaskName): string =>
      task === 'hanime' ? this.config.hanimeCron : this.config.tmdbCron;
    for (const task of ['hanime', 'tmdb'] as readonly TaskName[]) {
      const expr = exprOf(task);
      try {
        this.parsed[task] = parseCron(expr);
        this.configError[task] = null;
      } catch (err) {
        this.parsed[task] = null;
        this.configError[task] =
          err instanceof CronParseError ? err.message : String(err);
        this.onLog(`${task} cron 表达式无效`, { expr, err: this.configError[task] });
      }
    }
  }

  // ── 对外接口 ──────────────────────────────────────────────────

  getConfig(): SchedulerConfig & {
    errors: Record<TaskName, string | null>;
    descriptions: Record<TaskName, string>;
    nextRuns: Record<TaskName, string | null>;
  } {
    const nextRuns = {} as Record<TaskName, string | null>;
    const descriptions = {} as Record<TaskName, string>;
    const now = new Date();
    for (const task of ['hanime', 'tmdb'] as readonly TaskName[]) {
      const p = this.parsed[task];
      descriptions[task] = p ? describeCron(p.expr) : '⚠️ 表达式无效';
      const nr = p ? nextRun(p, now) : null;
      nextRuns[task] = nr ? nr.toISOString() : null;
    }
    return {
      ...this.config,
      errors: { ...this.configError },
      descriptions,
      nextRuns,
    };
  }

  updateConfig(patch: Partial<SchedulerConfig>): {
    ok: boolean;
    config: ReturnType<Scheduler['getConfig']>;
    error?: string;
  } {
    // 🔴 先校验再落盘：非法表达式不许写进去
    if (patch.hanimeCron !== undefined || patch.tmdbCron !== undefined) {
      const exprOf = (task: TaskName): string =>
        task === 'hanime'
          ? (patch.hanimeCron ?? this.config.hanimeCron)
          : (patch.tmdbCron ?? this.config.tmdbCron);
      for (const task of ['hanime', 'tmdb'] as readonly TaskName[]) {
        try {
          parseCron(exprOf(task));
        } catch (err) {
          return {
            ok: false,
            config: this.getConfig(),
            error: `${task} cron 表达式无效：${(err as Error).message}`,
          };
        }
      }
    }
    this.config = { ...this.config, ...patch };
    this.save();
    this.reparse();
    this.onLog('调度器配置已更新', { patch });
    return { ok: true, config: this.getConfig() };
  }

  getRecords(): RunRecord[] {
    return [...this.records].reverse();
  }

  /** 手动触发一次 */
  async runNow(task: TaskName): Promise<RunRecord> {
    if (this.running.has(task)) {
      const rec: RunRecord = {
        id: `manual-${task}-${Date.now()}`,
        task,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        status: 'skipped',
        summary: { reason: '该任务正在运行中，本次不叠加执行' },
        error: null,
        trigger: 'manual',
      };
      this.pushRecord(rec);
      return rec;
    }
    return this.execute(task, 'manual');
  }

  // ── 内部执行 ──────────────────────────────────────────────────

  private async execute(task: TaskName, trigger: 'cron' | 'manual'): Promise<RunRecord> {
    const rec: RunRecord = {
      id: `${trigger}-${task}-${Date.now()}`,
      task,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      status: 'running',
      summary: {},
      error: null,
      trigger,
    };
    this.pushRecord(rec);
    this.running.add(task);
    const t0 = Date.now();
    this.onLog(`开始执行 ${task} 扫描`, { trigger });
    try {
      const summary = await this.runner[task]();
      rec.summary = summary ?? {};
      rec.status = 'ok';
    } catch (err) {
      rec.status = 'failed';
      rec.error = err instanceof Error ? err.message : String(err);
      this.onLog(`${task} 扫描失败`, { err: rec.error });
    } finally {
      this.running.delete(task);
      rec.finishedAt = new Date().toISOString();
      rec.durationMs = Date.now() - t0;
      this.onLog(`${task} 扫描结束`, {
        status: rec.status,
        durationMs: rec.durationMs,
        summary: rec.summary,
      });
      // 🔴🔴 执行结束时**再落一次盘** ——
      //   pushRecord 时 rec 还是 running 态（summary 空、finishedAt null）
      //   ⇒ 只在那儿落盘 ⇒ 磁盘上永远是「进行中」的残缺记录
      //   ⇒ 读回来看到的全是 running ⇒ 面板显示「进行中」，且永远不结束
      this.saveRecords();
    }
    return rec;
  }

  private pushRecord(rec: RunRecord): void {
    this.records.push(rec);
    if (this.records.length > this.recordsKeep) {
      this.records = this.records.slice(-this.recordsKeep);
    }
    // 🔴 落盘 —— 容器重启不丢记录
    this.saveRecords();
  }

  // ── 定时循环 ──────────────────────────────────────────────────

  /**
   * 每 30 秒醒一次，检查两个任务是否命中。
   *
   * 🔴 去重键 = 「任务名 + 年-月-日 时:分」
   *   30 秒醒一次 ⇒ 同一分钟内可能醒 2 次 ⇒ 必须去重，
   *   否则一次触发会跑两遍（实测过：这是 cron 调度器最常见的 bug）。
   */
  private tick(): void {
    if (!this.config.enabled) return;
    const now = new Date();
    for (const task of ['hanime', 'tmdb'] as readonly TaskName[]) {
      const p = this.parsed[task];
      if (!p) continue;
      if (!cronMatches(p, now)) continue;

      const minuteKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
      if (this.lastFiredMinute.get(task) === minuteKey) continue;
      this.lastFiredMinute.set(task, minuteKey);

      if (this.running.has(task)) {
        this.pushRecord({
          id: `cron-${task}-${Date.now()}`,
          task,
          startedAt: now.toISOString(),
          finishedAt: now.toISOString(),
          durationMs: 0,
          status: 'skipped',
          summary: { reason: '上一轮还没跑完，本轮跳过（不叠加）' },
          error: null,
          trigger: 'cron',
        });
        this.onLog(`${task} 上一轮未完成，本轮跳过`);
        continue;
      }
      void this.execute(task, 'cron');
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.onLog('调度器 tick 异常', { err: String(err) });
      }
    }, 30_000);
    // 🔴 unref —— 不让定时器挂住进程（否则容器优雅退出会卡住）
    this.timer.unref?.();
    this.onLog('调度器已启动（每 30 秒检查一次）', {
      hanime: this.config.hanimeCron,
      tmdb: this.config.tmdbCron,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
