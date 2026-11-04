# 里番缺口看板（hifan-dashboard）

自建的里番媒体库看板：115 网盘 / Emby / mteam / hanime 多源对齐，一键下载 → 刮削入库 → 生成 strm，全程网页操作。

## 快速开始（三步）

```bash
mkdir hifan-dashboard && cd hifan-dashboard
# 1. 把本仓库的 docker-compose.yml 下载到这里，改 volumes 三行路径
# 2. 起容器
docker compose up -d
# 3. 浏览器打开 http://NAS的IP:8848
```

首次启动后，进 **设置 → 系统设置** 填你自己的：

| 分组 | 填什么 | 说明 |
|---|---|---|
| 代理 | TMDB 代理 / hanime 扫描代理 / 下载代理 | 大陆网络必填，否则 TMDB 与 hanime 抓不到；宿主机代理填 `http://host.docker.internal:端口`（compose 里已带 extra_hosts 的自建版见下） |
| TMDB | API Key | [themoviedb.org](https://www.themoviedb.org/settings/api) 免费申请 |
| Emby | 地址 / API Key / 媒体库 ID | 不用 Emby 可不填 |
| CMS | 地址 / 账号密码 | 入库第二步自动生成 strm；不用 CMS 可不填 |

**保存即生效，不用重启容器。**

### 用宿主机代理？

在 compose 服务下加两行（Linux 容器默认解析不了这个域名）：

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

## compose 只需要改路径

| 挂载 | 说明 |
|---|---|
| `./data:/app/data` | 数据库+图片，**必须本地盘**（cifs/fuse 网络盘不支持文件锁，SQLite 会损坏） |
| `...:/library` | 你的媒体库；rclone / FUSE 挂载点只挂**父目录**，挂载点本身重启后没恢复会导致容器起不来 |
| `...:/downloads` | 下载落盘目录，必须本地盘 |

## 功能一览

- **海报墙看板**：按年份浏览，作品抽屉展示 mteam / hanime 双源对齐与集位
- **下载队列**：mteam 挑源 → 115 离线/下载 → 自动对齐集位
- **自动刮削入库**：TMDB 详情/nfo/图片 → 复制落位 → 触发 CMS 生成 strm → Emby 刷新
- **设置面板**：代理 / TMDB / Emby / CMS / 调度任务全部可视化配置
- **入库通知过滤**：成人内容通知自动剥离原图（可配路径关键词）

## 镜像

```bash
docker pull ghcr.io/chekiye/hifan-dashboard:latest
```

## 环境要求

- Docker + docker compose v2
- Node 22+（仅本地开发；直接用镜像不需要）
- 数据库用 Node 内置 `node:sqlite`，零原生依赖

## License

仅供学习交流。
