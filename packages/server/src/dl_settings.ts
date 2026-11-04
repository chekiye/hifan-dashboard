/**
 * ⭐ §90（2026-10-30）下载通道的**运行时设置**（看板可改，不用重启容器）
 *
 * ## 为什么单独一个文件，不塞进 config.ts
 * `config.ts` 是环境变量快照，改了必须重建容器。
 * 「要不要走代理」是**运营决策**，蛙哥可能下到一半就想关掉
 * ⇒ 必须能在线改 ⇒ 落 JSON 文件，改完下一集立即生效。
 *
 * ## 🔴 proxyMode 三档（2026-10-30 蛙哥定调）
 * - `off`（默认）：**永不使用代理**。机场 15G/月，一集 500MB，走代理几百集就爆。
 *   直连全灭时**宁可失败并报错**，也不默默烧流量。
 * - `fallback`：直连所有 IP 都失败才降级到代理（旧行为）。
 * - `always`：只用代理（调试/应急用）。
 *
 * ## ⛔ 不影响什么
 * **抓链接（relink）走什么通道与此无关** —— 那条链路是 FlareSolverr +
 * 容器内代理，走的是另一个人工配置。本开关只管「下视频文件」。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export type ProxyMode = 'off' | 'fallback' | 'always';

export interface DlSettings {
  proxyMode: ProxyMode;
}

const DEFAULTS: DlSettings = { proxyMode: 'off' };

function isMode(v: unknown): v is ProxyMode {
  return v === 'off' || v === 'fallback' || v === 'always';
}

export class DlSettingsStore {
  private data: DlSettings = { ...DEFAULTS };
  private loaded = false;

  constructor(private readonly path: string) {}

  /** 懒加载（构造时不碰磁盘，容器只读挂载也不会炸） */
  get(): DlSettings {
    if (!this.loaded) this.load();
    return { ...this.data };
  }

  set(patch: Partial<DlSettings>): DlSettings {
    if (!this.loaded) this.load();
    if (isMode(patch.proxyMode)) this.data.proxyMode = patch.proxyMode;
    this.save();
    return { ...this.data };
  }

  private load(): void {
    this.loaded = true;
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<DlSettings>;
      if (isMode(raw.proxyMode)) this.data.proxyMode = raw.proxyMode;
    } catch {
      /* 文件坏了 ⇒ 回到默认（默认是「不走代理」，最省流量的一档） */
    }
  }

  /** 写临时文件再 rename —— 断电/磁盘满时不会留半截 JSON */
  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      renameSync(tmp, this.path);
    } catch {
      /* 内存里已生效，落盘失败不影响本进程 */
    }
  }
}
