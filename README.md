# 里番缺口看板（hifan-dashboard）

自建的里番媒体库看板：TMDB / 115 / Emby / mteam / hanime 多源对齐，
一键下载 → 刮削入库 → 生成 strm，全程网页操作。

**当前版本 v1.2.0** · 更新记录见 [CHANGELOG.md](CHANGELOG.md)

## 快速开始（三步）

```bash
mkdir hifan-dashboard && cd hifan-dashboard
# 1. 把本仓库的 docker-compose.yml 下载到这里，改 volumes 三行路径
# 2. 起容器
docker compose up -d
# 3. 浏览器打开 http://NAS的IP:8848
```

首次启动后进 **设置 → 系统设置**，共 9 组，填你自己的东西：

| 分组 | 填什么 | 生效 |
|---|---|---|
| 代理 | TMDB / hanime / 下载 三个代理 | 保存即生效 |
| TMDB | API Key（必填，[免费申请](https://www.themoviedb.org/settings/api)） | 保存即生效 |
| Emby | 地址 / API Key / 媒体库 ID / 管理员 UID | 保存即生效 |
| CMS | cloud-media-sync 地址与账号（可选） | 保存即生效 |
| 存储路径 | 容器内路径（对应挂载） | **需重启容器** |
| 下载与入库行为 | 直连优先、磁盘下限、重试次数等 | 保存即生效 |
| 企业微信推送 | 转发器地址（可选） | 保存即生效 |
| 访问认证 | 登录用户名密码（公网必填） | 保存即生效 |
| 扫描 | 排除目录（⛔ 别删 CloudDrive） | 保存即生效 |

每组都有 **「测: xxx」** 按钮，点了发真实请求：
代理测节点通不通、Emby 测 key 与库 ID、路径直接告诉你
「目录不存在（挂载没就绪）」还是「存在但不可写」—— 自建最常踩的两个坑。

**保存即生效，不用重启容器**（路径组除外）。

### 用宿主机代理 / 连宿主 Emby

模板 compose 已带 `extra_hosts`，容器内直接填 `http://host.docker.internal:端口` 即可。
如果你的 compose 没有这行，手动加：

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

## compose 只需要改路径

| 挂载 | 说明 |
|---|---|
| `./data:/app/data` | 数据库+图片，**必须本地盘**（cifs/fuse 不支持文件锁，SQLite 会损坏） |
| `...:/library` | 你的媒体库；rclone / FUSE 挂载点只挂**父目录**，挂载点本身重启后没恢复会导致容器起不来 |
| `...:/downloads` | 下载落盘目录，必须本地盘 |
| `...:/strm:ro` | 可选，CMS 生成的 strm 库，用来验证文件真的落盘了 |

## 功能一览

- **海报墙看板**：按年份浏览，作品抽屉展示 mteam / hanime 双源对齐与集位
- **入库检测**：与 Emby 逐集比对，给出缺集清单与未下载清单
- **下载队列**：挑源 → 排队下载 → 直连优先、失败降级代理，磁盘满自动停
- **自动刮削入库**：TMDB 详情/nfo/图片 → 复制落位 → 触发 CMS 生成 strm → Emby 刷新
- **更新扫描**：定时抓源站发现新番/新集，判定后落库并推企业微信
- **人工匹配**：未匹配条目可手动绑 TMDB，独立成层、留审计
- **设置面板**：9 组配置全可视化，带真实探活

## 镜像

```bash
docker pull ghcr.io/chekiye/hifan-dashboard:latest
```

## 环境要求

- Docker + docker compose v2
- Node 22+（仅本地开发；直接用镜像不需要）
- 数据库用 Node 内置 `node:sqlite`，零原生依赖

## 常见问题

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 扫 Emby 出来 0 部 | 管理员 UID 不是 admin | 设置页换 admin 的 uid |
| 入库报「库根不存在」 | 挂载没就绪 / 路径错 | 点「测: 媒体库根目录」看真实报错 |
| 采集全超时 | 没配代理 | 配代理后点「测: TMDB 代理」 |
| 面板改路径没生效 | 路径类要重启 | `docker compose up -d` |

## License

仅供学习交流。
