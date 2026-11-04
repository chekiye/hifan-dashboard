/**
 * cron 表达式解析与匹配 —— 自研 5 段 cron，不引第三方库
 *
 * 🔴 为什么自研：
 *   看板容器（hifan-dashboard）只装了自己的 node_modules，
 *   引 cron 库要多一层依赖 + 打进镜像。
 *   5 段 cron（分 时 日 月 周）的匹配逻辑本身很简单，
 *   自研还能保证**行为可预期**（第三方库的历史兼容包袱多）。
 *
 * 语法（标准 5 段，⛔不是 6 段带秒）：
 *   ┌─── 分钟 (0-59)        ┐
 *   │ ┌─ 小时 (0-23)        │ │
 *   │ │ ┌─ 日 (1-31)        │ │ │
 *   │ │ │ ┌─ 月 (1-12)      │ │ │ │
 *   │ │ │ │ ┌─ 周 (0-7, 0=周日, 7=周日) │ │ │ │ │
 *   * * * * *
 *
 * 支持语法：
 *   `*`      全部
 *   `a`      单值
 *   `a-b`    区间
 *   `a,b,c`  列表
 *   星号加斜杠 n    步长（如 每 15 分钟）
 *   `a-b/n`  区间步长
 *   `7` 在周字段等价于 `0`（周日）
 *
 * 🔴 铁律：**非法表达式必须报错，不能静默当成「永不触发」**。
 *   静默失效的 cron = 自动化看起来装好了但永远不跑 ⇒ 数据永远不更新，
 *   而看板上看不出任何异常（这正是历史上「缺口隐身」的同类病因）。
 */

export interface CronField {
  /** 该字段允许的值集合 */
  values: Set<number>;
  /** 🔴 原始片段是不是通配（星号 或 星号带步长）—— 日/周的 OR 语义靠它判定 */
  wildcard: boolean;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
  /** 原始表达式 */
  expr: string;
}

export class CronParseError extends Error {}

const RANGES = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  // 0 和 7 都是周日
  dayOfWeek: { min: 0, max: 7 },
} as const;

type FieldName = keyof typeof RANGES;

function parseField(raw: string, name: FieldName): CronField {
  const { min, max } = RANGES[name];
  const values = new Set<number>();
  let wildcard = false;

  const push = (n: number) => {
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new CronParseError(
        `${name} 字段的值 ${n} 超出范围 ${min}-${max}（表达式片段「${raw}」）`,
      );
    }
    // 周字段：7 归一为 0
    values.add(name === 'dayOfWeek' ? n % 7 : n);
  };

  for (const part of raw.split(',')) {
    const seg = part.trim();
    if (!seg) throw new CronParseError(`${name} 字段有空片段（表达式片段「${raw}」）`);

    // 步长
    let step = 1;
    let body = seg;
    const slash = seg.indexOf('/');
    if (slash >= 0) {
      body = seg.slice(0, slash).trim();
      const stepRaw = seg.slice(slash + 1).trim();
      if (!/^\d+$/.test(stepRaw)) {
        throw new CronParseError(`${name} 字段的步长「${stepRaw}」不是数字`);
      }
      step = Number(stepRaw);
      if (step <= 0) throw new CronParseError(`${name} 字段的步长必须 > 0`);
    }

    if (body === '*') {
      wildcard = true;
      for (let n = min; n <= max; n += step) push(n);
      continue;
    }

    const dash = body.indexOf('-');
    if (dash > 0) {
      const a = body.slice(0, dash).trim();
      const b = body.slice(dash + 1).trim();
      if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) {
        throw new CronParseError(`${name} 字段的区间「${body}」格式错误`);
      }
      const from = Number(a);
      const to = Number(b);
      if (from > to) {
        throw new CronParseError(`${name} 字段的区间「${body}」起点大于终点`);
      }
      for (let n = from; n <= to; n += step) push(n);
      continue;
    }

    if (!/^\d+$/.test(body)) {
      throw new CronParseError(`${name} 字段的「${body}」不是合法数字`);
    }
    push(Number(body));
  }

  if (values.size === 0) throw new CronParseError(`${name} 字段解析后为空`);
  return { values, wildcard };
}

/** 解析 5 段 cron 表达式 */
export function parseCron(expr: string): ParsedCron {
  const trimmed = (expr ?? '').trim();
  if (!trimmed) throw new CronParseError('cron 表达式为空');
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      `cron 表达式必须是 5 段（分 时 日 月 周），收到 ${parts.length} 段：「${trimmed}」`,
    );
  }
  return {
    minute: parseField(parts[0], 'minute'),
    hour: parseField(parts[1], 'hour'),
    dayOfMonth: parseField(parts[2], 'dayOfMonth'),
    month: parseField(parts[3], 'month'),
    dayOfWeek: parseField(parts[4], 'dayOfWeek'),
    expr: trimmed,
  };
}

/**
 * 判断某个时刻是否命中。
 *
 * 🔴 日与周的**联合语义**（标准 cron 行为）：
 *   - 若日与周**都是 `*`** ⇒ 命中条件 = 且
 *   - 若其中之一被限定 ⇒ 命中条件 = **或**（OR）
 *   这是 POSIX cron 的语义，实现必须一致，否则用户直觉会错。
 */
export function cronMatches(cron: ParsedCron, d: Date): boolean {
  if (!cron.minute.values.has(d.getMinutes())) return false;
  if (!cron.hour.values.has(d.getHours())) return false;
  if (!cron.month.values.has(d.getMonth() + 1)) return false;

  const domRestricted = !isWildcard(cron.dayOfMonth);
  const dowRestricted = !isWildcard(cron.dayOfWeek);

  const domHit = cron.dayOfMonth.values.has(d.getDate());
  // JS: 0=周日 … 6=周六
  const dowHit = cron.dayOfWeek.values.has(d.getDay());

  if (domRestricted && dowRestricted) return domHit || dowHit;
  if (domRestricted) return domHit;
  if (dowRestricted) return dowHit;
  return true;
}

function isWildcard(f: CronField): boolean {
  return f.wildcard;
}

/**
 * 计算下一次命中时间（从 from 之后开始，不含 from 本身）。
 * 返回 null 表示该表达式永不命中（如 2 月 30 日）。
 */
export function nextRun(cron: ParsedCron, from: Date): Date | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  // 最多往后找 5 年（足够覆盖 2 月 29 日这类）
  const limit = new Date(from.getTime());
  limit.setFullYear(limit.getFullYear() + 5);
  while (d <= limit) {
    if (cronMatches(cron, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** 把表达式解析成人类可读的中文描述（用于看板展示） */
export function describeCron(expr: string): string {
  let c: ParsedCron;
  try {
    c = parseCron(expr);
  } catch (e) {
    return `⚠️ 表达式无效：${(e as Error).message}`;
  }
  const p = (f: CronField, names?: string[]): string => {
    const arr = [...f.values].sort((a, b) => a - b);
    if (names) return arr.map((n) => names[n] ?? String(n)).join('、');
    return arr.join('、');
  };
  const dowNames = ['日', '一', '二', '三', '四', '五', '六'];
  const parts: string[] = [];
  if (c.minute.values.size === 1) {
    const mm = [...c.minute.values][0];
    parts.push(mm === 0 ? '整点' : `每小时第 ${mm} 分`);
  } else {
    parts.push(`分钟 ${p(c.minute)}`);
  }
  if (c.hour.values.size === 1) parts.push(`${[...c.hour.values][0]} 点`);
  else parts.push(`小时 ${p(c.hour)}`);
  if (!isWildcard(c.dayOfWeek)) parts.push(`周${p(c.dayOfWeek, dowNames)}`);
  else if (!isWildcard(c.dayOfMonth)) parts.push(`每月 ${p(c.dayOfMonth)} 日`);
  else parts.push('每天');
  return parts.join(' · ');
}
