/** 共享领域类型 —— 所有包统一从这里取，禁止各自定义 */

export type MediaType = 'tv' | 'movie';

/** 作品在全集池里的来源通道，用于评估双通道策略效果 */
export type SourceChannel = 'keyword' | 'local_seed' | 'manual';

export type Confidence = 'auto' | 'review' | 'none';
export type Direction = 'tmdb_to_local' | 'local_to_tmdb';
export type GapKind = 'missing_work' | 'missing_ep' | 'unlisted';
export type JobStatus = 'idle' | 'running' | 'done' | 'failed';

/** TMDB 作品（基准池条目） */
export interface TmdbWork {
  id: number;
  mediaType: MediaType;
  nameJa: string | null;
  nameZh: string | null;
  firstAirDate: string | null;
  year: number | null;
  episodeTotal: number;
  seasonCount: number;
  popularity: number | null;
  adult: boolean;
  genres: number[];
  sourceChannel: SourceChannel;
  fetchedAt: string | null;
}

/** TMDB 单集元数据 */
export interface TmdbEpisode {
  workId: number;
  season: number;
  episode: number;
  epName: string | null;
  airDate: string | null;
  runtime: number | null;
  stillPath: string | null;
  overview: string | null;
}

/** 本地作品（被比对方） */
export interface LocalWork {
  id: number;
  dirPath: string;
  dirName: string | null;
  tmdbId: number | null;
  mediaType: MediaType;
  parsedTitle: string | null;
  parsedYear: number | null;
  scanStatus: 'pending' | 'ok' | 'error';
  scannedAt: string | null;
}

/** 本地视频文件 */
export interface LocalFile {
  id: number;
  workId: number;
  filePath: string;
  fileName: string | null;
  fileSize: number | null;
  season: number | null;
  episode: number | null;
  extension: string | null;
}

/** 比对结果 */
export interface MatchResult {
  id?: number;
  tmdbWorkId: number | null;
  localWorkId: number | null;
  direction: Direction;
  confidence: Confidence;
  score: number;
  method: string | null;
  matchedNames: string[];
  warning: string | null;
  matchedAt: string | null;
}

/** 缺口 */
export interface Gap {
  id?: number;
  kind: GapKind;
  tmdbWorkId: number | null;
  localWorkId: number | null;
  season: number | null;
  missingEpisodes: number[];
}

/** 看板概览统计 */
export interface OverviewStats {
  totalPool: number;
  owned: number;
  missingWork: number;
  missingEp: number;
  unlisted: number;
  complete: number;
  coveragePct: number;
}

/** API 统一响应包 */
export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}