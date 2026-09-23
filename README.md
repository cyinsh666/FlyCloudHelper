# FlyCloudHelper

<img src="web/public/flycloud-helper-icon.png" alt="FlyCloudHelper 图标" width="96" />

FlyCloudHelper 是一个可自部署的网盘媒体扫描、元数据刮削、媒体目录和协议兼容服务。它可以直接连接 WebDAV 和主流网盘，建立影视库或音乐库，并通过 Web 管理端、REST API、Jellyfin、Emby 与 Navidrome/Subsonic 协议提供访问能力。

项目不依赖特定客户端才能运行。用户可以直接在 Web 管理端完成网盘登录、路径选择、扫描刮削、媒体库管理、协议账号配置和任务维护，也可以使用兼容客户端访问云端媒体库。Flymby 鸿蒙 APP 只负责上传已有网盘服务的基础信息与登录凭据，并通过普通 Jellyfin、Emby 或 Navidrome 服务使用云端媒体库。

当前已贯通影视和音乐两条独立链路。影视库使用电影、节目、季和集模型，并可共享为 Jellyfin 或 Emby；音乐库使用歌曲、专辑和艺术家模型，通过“发现目录和文件、读取文件资料、在线补全”三阶段扫描后共享为 Navidrome/Subsonic。有声书仍处于接口与数据结构预留阶段。

## 项目定位

- **Provider 层**：负责网盘授权、目录枚举、文件定位、直连下载和中转读取，不直接承担媒体归组与元数据管理。
- **媒体库层**：影视库负责电影与节目归组、TMDB/NFO/插件刮削、手动匹配和海报墙；音乐库负责音频标签、旁挂资料、在线补全、歌曲、专辑、艺术家和封面歌词。
- **任务层**：负责全量扫描、增量扫描、音乐三阶段扫描、视频规格分析、定时执行、并发控制、暂停、终止、重试和进度记录。
- **访问层**：提供 Web 管理端、用户与管理员 REST API、SSE 任务事件、文件访问接口，以及 Jellyfin、Emby、Navidrome/Subsonic 兼容接口。
- **运行边界**：保存目录、元数据、任务状态和必要的加密凭据，不保存网盘媒体正文，不提供转码，也不在 Web 管理端直接播放。

## 界面预览

### 管理概览

![FlyCloudHelper 管理概览](assets/readme/admin-overview.jpg)

### 服务与媒体库

| 服务管理 | 媒体库管理 |
| --- | --- |
| ![FlyCloudHelper 服务管理](assets/readme/services.jpg) | ![FlyCloudHelper 媒体库管理](assets/readme/media-library.jpg) |

### 后台任务与音乐库设置

| 后台任务 | 音乐库与 Navidrome 设置 |
| --- | --- |
| ![FlyCloudHelper 后台任务](assets/readme/background-jobs.jpg) | ![FlyCloudHelper 音乐库与 Navidrome 设置](assets/readme/music-library-settings.jpg) |

## 主要功能

### 账号与管理

- 用户注册、登录、多用户数据隔离和超级管理员初始化。
- 一个用户可创建多个网盘服务；网盘服务只保存基础信息和登录凭据，媒体库独立管理类型、来源关系、扫描、元数据、任务、通知和协议。
- 超级管理员可以管理用户、全部服务、媒体库、任务、插件、TMDB Key、系统配置和审计记录。
- 通知中心记录任务结果、账号注册、服务删除、媒体库清空、会话撤销等事件，支持单条或全部清除。

### 网盘与文件访问

- 内置支持 WebDAV、光鸭、阿里云盘、百度网盘、115网盘、123云盘、天翼云盘个人云、移动云盘和夸克网盘，共 9 类 Provider。
- 光鸭支持官方 API 凭据同步、网页二维码和网页短信验证码三种授权方式。
- 115网盘、123云盘、天翼云盘、移动云盘和夸克网盘由云助手直接完成扫码授权，不依赖 FlymbyServer。
- 阿里云盘和百度网盘支持目录浏览、扫描、稳定文件标识、Token 刷新、直连下载和中转读取，当前通过连接表单填写 Token。
- 9 类 Provider 都可以作为媒体库来源；影视或音乐类型在创建媒体库时选择，华为云空间不在当前支持范围内。
- Provider 提供推荐扫描与刮削并发，实际扫描路径、并发和协议播放方式由媒体库配置。
- 文件访问支持临时直连地址和 HTTP Range 中转；服务端只转发字节流，不转码、不缓存媒体正文。

### 扫描、刮削与媒体库

- 路径选择式配置全量扫描目录和增量扫描目录，并支持本地 NFO 开关、元数据规则与插件来源。
- 扫描影视文件并归组为电影或节目，保存影片、季、集、源文件、海报、简介、年份和首映日期等目录数据。
- 音乐扫描拆分为发现目录和文件、读取文件资料、在线补全三个阶段；音频标签或在线补全失败时仍保留已读取的文件资料，并支持按阶段查看问题和重新执行。
- 音乐库保存歌曲、专辑、艺术家、音频规格、内嵌或旁挂封面与歌词，并支持 MusicBrainz、内置音乐来源和插件来源补全。
- 支持 TMDB 多 Key 动态并发、故障冷却与自动恢复，以及当前部署内跨用户、跨服务共享 14 天的成功结果缓存。
- 支持手动搜索与匹配、清除匹配结果、匹配状态筛选，以及按加入时间、年份、首映日期和名称排序。
- 用户按媒体库浏览海报墙、详情、真实文件路径与源文件信息；管理员可跨用户筛选查看。

### 任务与自动化

- 全量扫描、增量扫描和 ffprobe 视频规格分析使用可管理的后台任务；音乐任务额外展示三个阶段各自的进度、失败与未匹配明细。
- 三类任务均可配置间隔、每日、每周或每月定时执行；视频规格分析使用独立队列，不占用扫描 Worker 槽位。
- 任务记录开始时间、结束时间、实际运行时长、当前路径和阶段统计。
- 支持运行状态筛选、排队等待原因、暂停与继续、终止、删除、失败重试和仅清理已完成任务。
- 默认最多同时执行 5 个扫描刮削任务，具体 Provider 仍使用各自的服务级推荐并发。

### 协议访问

- 影视库可分别启用 Jellyfin `/j/` 和 Emby `/e/` 地址，音乐库可启用 Navidrome/Subsonic `/n/` 地址，地址后缀均可在媒体库设置中修改。
- Jellyfin 与 Emby 覆盖登录、媒体库、首页、列表、搜索、详情、季集、图片、播放定位、直连或中转播放、下载控制及观看状态上报等常用接口。
- Navidrome/Subsonic 覆盖音乐库、艺术家、专辑、歌曲、封面、歌词、收藏、播放历史、播放定位和下载等常用接口；关闭中转后优先返回网盘直连，直连无法满足请求时回退中转。
- 每个协议地址可以创建多个独立账号；账号的会话、收藏、最近播放、观看进度和已播放状态相互隔离，Emby 与 Jellyfin 账号也互不共用。
- 协议层直接使用原始媒体文件，不提供视频或音频转码。

### Flymby 客户端协作

- Flymby 鸿蒙 APP 可以把 WebDAV、光鸭、阿里云盘、百度网盘、115网盘、123云盘、天翼云盘、移动云盘和夸克网盘的基础信息与当前登录凭据单向上传到云助手；华为云空间不支持上传。
- 上传不会携带 APP 本地媒体库、扫描结果或元数据，也不会建立设备绑定和双向同步。重复上传同一设备上的同一本地服务会刷新云助手凭据。
- APP 不读取云助手媒体目录镜像，也不执行迁入或迁回。影视库通过 Jellyfin 或 Emby 使用，音乐库通过 Navidrome/Subsonic 使用。
- 协议账号可以一次性添加为 APP 中普通的 Jellyfin、Emby 或 Navidrome 服务；之后两端各自管理，不保存云助手绑定标记。

## 运行要求

- Node.js 20.19 或更高版本
- npm
- 默认无需安装外部数据库

## 本地启动

```sh
nvm use 20
npm install
npm run dev
```

启动后访问：

- Web 前端：`http://localhost:9935`
- 后台 API：`http://localhost:9934`
- 首次初始化：`http://localhost:9935/setup`

`npm run dev` 会同时启动前端和后台。也可以分别运行：

```sh
npm run dev:api
npm run dev:web
```

不创建 `.env` 时，服务默认使用 SQLite，数据库文件位于 `data/database/flycloud-helper.db`。首次运行会自动创建数据库结构；超级管理员账号需要在初始化页面中设置。

## Docker 启动

### 前后端集成版

生产镜像已经集成 Web 前端、后台 API 和扫描 Worker，部署时只需要启动一个容器。

#### 使用 Docker Compose（推荐）

Docker 部署也比较简单，新建 `docker-compose.yml` 并写入以下内容：

```yaml
services:
  flycloud-helper:
    image: fbinba3955/flycloud-helper:latest
    container_name: flycloud-helper
    restart: unless-stopped
    ports:
      - "9934:9934"
    environment:
      FLYCLOUDHELPER_DATABASE_TYPE: sqlite
      FLYCLOUDHELPER_COOKIE_SECURE: "false"
      FLYCLOUDHELPER_ALLOW_INSECURE_HTTP: "true"
      FLYCLOUDHELPER_PUID: "1000"
      FLYCLOUDHELPER_PGID: "1000"
    volumes:
      - flycloud_helper_data:/data

volumes:
  flycloud_helper_data:
```

然后启动服务：

```sh
docker compose up -d
```

也可以直接下载项目提供的完整配置文件：

```sh
# 下载配置文件
curl -o docker-compose.yml https://raw.githubusercontent.com/fbinba3955/FlyCloudHelper/master/docker-compose.yml

# 启动服务
docker compose up -d

# 查看日志
docker compose logs -f
```

该编排默认拉取 `fbinba3955/flycloud-helper:latest`，使用 SQLite，并把数据库、凭据主密钥、插件和导出文件保存在 `flycloud_helper_data` 持久卷中。启动完成后访问：

```text
http://服务器IP:9934/setup
```

首次进入初始化页面设置超级管理员。需要修改对外端口或连接外部数据库时，在 `docker-compose.yml` 同目录创建 `.env`；例如修改宿主机端口：

```dotenv
FLYCLOUDHELPER_HOST_PORT=19934
```

常用维护命令：

```sh
# 查看运行状态
docker compose ps

# 查看实时日志
docker compose logs -f flycloud-helper

# 拉取新版本并保留原数据升级
docker compose pull
docker compose up -d

# 停止服务但保留数据
docker compose down
```

不要使用 `docker compose down -v`，该命令会同时删除持久卷。需要固定镜像版本时，在 `.env` 中设置 `FLYCLOUDHELPER_IMAGE_TAG=0.1.15`；移除该配置后会继续使用 `latest`。

如果已经克隆项目，进入项目目录直接执行 `docker compose -f docker-compose.yml up -d` 即可。完整编排文件见 [docker-compose.yml](docker-compose.yml)。

#### 直接使用 Docker 命令

直接运行 Docker Hub 公开镜像：

```sh
docker run -d \
  --name flycloud-helper \
  --restart unless-stopped \
  -p 9934:9934 \
  -v flycloud_helper_data:/data \
  fbinba3955/flycloud-helper:latest
```

镜像同时支持 `linux/amd64` 和 `linux/arm64`。固定版本可将 `latest` 改为 `0.1.15`。

容器内部端口固定为 `9934`，`-p` 左侧可以修改宿主机端口。`/data` 必须持久化，其中保存 SQLite 数据库、凭据主密钥、插件和导出文件。即使改用 PostgreSQL 或 MySQL，也不能删除这个数据卷。

镜像启动时会先以 root 身份创建并修复 `/data` 下的数据库、密钥、插件、导出和迁移目录，再按 `FLYCLOUDHELPER_PUID`、`FLYCLOUDHELPER_PGID` 指定的普通用户身份启动服务，默认均为 `1000`。这可以兼容极空间、飞牛等 NAS 创建的 root 所有宿主机挂载目录。使用目录映射且 NAS 所有者不是 `1000:1000` 时，应把两个变量改成该目录实际的 UID/GID；只读挂载、NFS/SMB root squash 或 NAS ACL 禁止容器修改权限时，仍需先在宿主机授权。

启动后访问 `http://服务器地址:9934/setup` 设置超级管理员。

### 连接已有 PostgreSQL

创建不会提交到 Git 的 `.env`：

```dotenv
FLYCLOUDHELPER_DATABASE_TYPE=postgres
FLYCLOUDHELPER_DATABASE_HOST=postgres容器名
FLYCLOUDHELPER_DATABASE_PORT=5432
FLYCLOUDHELPER_DATABASE_NAME=flycloud_helper
FLYCLOUDHELPER_DATABASE_USER=flycloud_helper
FLYCLOUDHELPER_DATABASE_PASSWORD=请替换
FLYCLOUDHELPER_DATABASE_AUTO_CREATE=true
```

如果 PostgreSQL 与 FlyCloudHelper 都运行在 Docker 中，应让两个容器加入同一个网络，并把 `DATABASE_HOST` 设置为 PostgreSQL 容器名，不要填写 `127.0.0.1`：

```sh
docker network create flycloud-network
docker network connect flycloud-network 已有PostgreSQL容器名

docker run -d \
  --name flycloud-helper \
  --restart unless-stopped \
  --network flycloud-network \
  --env-file .env \
  -p 9934:9934 \
  -v flycloud_helper_data:/data \
  fbinba3955/flycloud-helper:latest
```

两个容器已经处于同一网络时，不需要重复执行 `docker network connect`。如果数据库运行在其他主机，`DATABASE_HOST` 填写数据库主机的 IP 或域名。

数据库不存在且自动创建开启时，PostgreSQL 用户必须拥有 `CREATEDB` 权限。服务只创建 `DATABASE_NAME` 指定的数据库，并自动初始化 FlyCloudHelper 表结构，不会创建数据库用户。数据库创建完成后可以按部署策略收回该用户的 `CREATEDB` 权限。

### 连接已有 MySQL

MySQL 使用相同的配置方式：

```dotenv
FLYCLOUDHELPER_DATABASE_TYPE=mysql
FLYCLOUDHELPER_DATABASE_HOST=mysql容器名
FLYCLOUDHELPER_DATABASE_PORT=3306
FLYCLOUDHELPER_DATABASE_NAME=flycloud_helper
FLYCLOUDHELPER_DATABASE_USER=flycloud_helper
FLYCLOUDHELPER_DATABASE_PASSWORD=请替换
FLYCLOUDHELPER_DATABASE_AUTO_CREATE=true
```

MySQL 容器同样需要与 FlyCloudHelper 处于同一个 Docker 网络。自动创建要求用户对目标数据库拥有 `CREATE` 及后续建表、索引和读写权限；服务不会创建数据库用户。

### 使用项目 Compose 创建数据库

由项目同时创建 PostgreSQL 时，在 `.env` 中设置：

```dotenv
POSTGRES_DB=flycloud_helper
POSTGRES_USER=flymby
POSTGRES_PASSWORD=请替换
```

然后执行：

```sh
docker compose -f compose.yml -f compose.postgres.yml up -d
```

由项目同时创建 MySQL 时，在 `.env` 中设置：

```dotenv
MYSQL_DATABASE=flycloud_helper
MYSQL_USER=flymby
MYSQL_PASSWORD=请替换
MYSQL_ROOT_PASSWORD=请替换
```

然后执行：

```sh
docker compose -f compose.yml -f compose.mysql.yml up -d
```

### 从源码构建

从源码构建并启动：

```sh
docker compose -f compose.yml -f compose.build.yml up -d --build
```

默认通过 `http://localhost:9934` 访问服务。生产镜像由同一个 API 进程提供后台接口、Web 静态文件和扫描 Worker。

生产镜像已经直接安装 `ffprobe`（由 Debian `ffmpeg` 软件包提供），同时支持 `linux/amd64` 和 `linux/arm64`。服务详情中的“分析视频规格（ffprobe）”默认关闭；开启后无需在宿主机安装程序或向容器挂载可执行文件。

## 配置方式

复制示例文件后按需修改：

```sh
cp .env.example .env
```

常用环境变量如下。镜像已经在 `ENV` 元数据中声明数据库拆分字段、自动建库、Cookie 和 HTTP Provider 开关，因此 Docker 管理界面可以直接显示这些配置项；数据库地址、端口、名称、用户名和密码默认留空。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FLYCLOUDHELPER_HOST_PORT` | `9934` | Docker 对外端口 |
| `FLYCLOUDHELPER_PUID` | `1000` | 容器内后台进程使用的用户 ID；启动时用于修复 `/data` 权限 |
| `FLYCLOUDHELPER_PGID` | `1000` | 容器内后台进程使用的用户组 ID；启动时用于修复 `/data` 权限 |
| `FLYCLOUDHELPER_DATABASE_TYPE` | `sqlite` | 数据库类型：`sqlite`、`postgres` 或 `mysql` |
| `FLYCLOUDHELPER_SQLITE_PATH` | `data/database/flycloud-helper.db` | SQLite 文件位置 |
| `FLYCLOUDHELPER_DATABASE_HOST` | 空 | PostgreSQL 或 MySQL 地址 |
| `FLYCLOUDHELPER_DATABASE_PORT` | `5432`/`3306` | PostgreSQL 或 MySQL 端口 |
| `FLYCLOUDHELPER_DATABASE_NAME` | 空 | FlyCloudHelper 使用的数据库名称 |
| `FLYCLOUDHELPER_DATABASE_USER` | 空 | 数据库用户名 |
| `FLYCLOUDHELPER_DATABASE_PASSWORD` | 空 | 数据库密码，支持使用同名 `_FILE` 变量读取 Secret |
| `FLYCLOUDHELPER_DATABASE_AUTO_CREATE` | `true` | 数据库不存在时尝试自动创建 |
| `FLYCLOUDHELPER_DATABASE_URL` | 空 | 兼容原有完整连接地址，配置后优先于拆分字段 |
| `FLYCLOUDHELPER_COOKIE_SECURE` | `false` | HTTPS 部署时设为 `true` |
| `FLYCLOUDHELPER_WORKER_CONCURRENCY` | `5` | 同时执行的扫描刮削任务数 |
| `FLYCLOUDHELPER_FFPROBE_PATH` | Docker 中为 `/usr/bin/ffprobe` | ffprobe 可执行文件路径 |
| `FLYCLOUDHELPER_MEDIA_PROBE_CONCURRENCY` | `1` | 独立媒体规格队列并发数；不会占用扫描 Worker 槽位 |
| `FLYCLOUDHELPER_ALLOW_INSECURE_HTTP` | `true` | 是否允许 Provider 使用 HTTP |
| `FLYCLOUDHELPER_CLOUD115_CLIENT_ID` | `100195125` | 115 OpenAPI 公开应用 ID，不是应用 Secret |
| `FLYCLOUDHELPER_HUAWEI_BINDING_PROOF_SECRET` | 空 | 可选的外部账号身份绑定验签密钥；配置后绑定注册必须提供短期受信任签名，支持同名 `_FILE` Secret |

完整配置见 [.env.example](.env.example)。旧版 `FLYMBYSCANNER_*` 环境变量仍可由后台兼容读取，建议新部署统一改为 `FLYCLOUDHELPER_*`。

`FLYCLOUDHELPER_HUAWEI_BINDING_PROOF_SECRET` 只用于 Flymby 外部账号身份绑定，不代表已经接入华为云空间 Provider。

TMDB Key 不再通过环境变量配置。超级管理员登录后，在“系统配置”页面中维护一个或多个 Key；后台会根据健康 Key 数量动态调整刮削并发。

内置 TMDB 刮削使用数据库持久化共享缓存，无需额外配置。电影、节目详情和节目季数据按媒体身份、标题查询条件、语言、地区与详情模式区分，成功结果保留 14 天；缓存不绑定用户、服务或网盘类型，因此同一部署中的全部影视服务可以复用。未匹配、鉴权失败、限流和网络错误不会进入共享缓存，音乐、有声书及插件自有元数据源不使用这份缓存。超级管理员可以在“系统配置”中二次确认后删除全部 TMDB 共享缓存，已入库的媒体数据不会随之删除。

受信任客户端可以在普通用户名、密码注册之外提交外部账号身份摘要，用于避免同一外部账号重复注册。默认空配置适合开发联调；正式启用身份绑定时建议配置 `FLYCLOUDHELPER_HUAWEI_BINDING_PROOF_SECRET`，并由受信任的账号服务按 `v1.过期秒时间戳.随机串.HMAC-SHA256(base64url)` 签发短期凭证。签名正文固定为 `v1\n账号摘要\n过期秒时间戳\n随机串`；配置验签密钥后，缺少、过期或签名无效的绑定注册请求会被拒绝。

PostgreSQL 与 MySQL 使用拆分字段时，服务会自动处理密码中的特殊字符。目标数据库不存在且自动创建开启时，PostgreSQL 用户需要 `CREATEDB` 权限，MySQL 用户需要 `CREATE` 权限；服务只创建指定数据库，之后自动初始化自身表结构，不会创建数据库用户。

网盘服务会根据 Provider 类型为每个服务写入默认扫描任务数和刮削任务数，并允许在服务设置中手动调整为任意正整数，不设置 Provider 最大值；全量和增量扫描都使用当前服务自己的扫描任务数。影片任务使用服务配置的刮削任务数，TMDB 网络请求由当前可用 Key 容量独立调度，不会因为 Key 数量减少而把本地解析和数据库落库一起降为低并发。同一节目目录中的单集文件并发落库；重复全量扫描仍会枚举全部路径并执行缺失对账，但会复用源文件未变化、已匹配且元数据配置修订一致的目录结果。

影视文件名使用内置清洗规则生成刮削查询词，依次移除站点和分类前缀、TMDB/IMDb 标记、合集范围、清晰度和尺寸、来源、编码与位深、音轨字幕、平台、文件大小及发布组；清洗只影响识别查询，不修改网盘中的真实路径和文件名。该规则与已适配客户端的现有媒体识别行为保持兼容。

## 光鸭登录、扫描与文件访问

光鸭连接分为三类：

- `光鸭官方 API 登录`：接收受信任外部客户端同步的官方 API 授权信息，Web 管理端不直接发起该授权。
- `光鸭网页二维码登录`：在 Web 管理端发起，使用光鸭 APP 扫码确认。
- `光鸭网页验证码登录`：在 Web 管理端发起，使用中国大陆手机号和短信验证码登录；未注册手机号按光鸭官网规则创建账号。

网页二维码和网页验证码都通过一次性授权会话创建服务，Token、设备码、手机号原文和短信验证码不会由状态接口回显或写入诊断日志。连接成功后，Access Token、Refresh Token 等字段使用凭据主密钥加密保存。

外部客户端同步官方 API 连接时，可复用服务创建和连接更新接口。更新已有光鸭服务的示例：

```http
PUT /api/v1/services/{serviceId}/connection
Authorization: Bearer {FlyCloudHelper 登录令牌}
Content-Type: application/json
```

```json
{
  "connection": {
    "authMode": "official_api",
    "clientId": "由外部客户端当前光鸭配置提供",
    "projectId": "由外部客户端当前光鸭配置提供",
    "signSecret": "由外部客户端当前光鸭配置提供",
    "deviceId": "由外部客户端当前授权提供",
    "accessToken": "由外部客户端当前授权提供",
    "refreshToken": "由外部客户端当前授权提供",
    "tokenType": "Bearer",
    "expiresAt": 0,
    "userId": "可选的光鸭账号 ID"
  }
}
```

服务端只接受固定字段，并在验证根目录访问成功后替换连接。生产环境建议通过 HTTPS 传输；启用项目的非安全 HTTP 配置时，局域网或调试环境也可以使用 HTTP。创建新服务时使用 `POST /api/v1/services`，把同一 `connection` 放到 `provider.connection`，并设置 `provider.type` 为 `guangya`；创建成功不会自动触发扫描。

授权完成后先从网盘服务快速创建媒体库，再在媒体库设置中选择目录并创建全量或增量扫描任务。光鸭文件枚举结果进入与 WebDAV 相同的媒体处理管线。

客户端可使用以下接口访问结果：

- `GET /api/v1/libraries/:libraryId/items/:itemId/files`：读取影片绑定的源文件及稳定定位。
- `POST /api/v1/libraries/:libraryId/items/:itemId/files/:fileId/access`：用用户 Bearer Token 换取短期文件下载地址；响应不会包含光鸭账号 Token。
- `GET/HEAD /api/v1/libraries/:libraryId/items/:itemId/files/:fileId/stream`：按媒体库协议设置通过 FlyCloudHelper 流式读取源文件，支持 HTTP Range。

APP 上传接口只接收本地网盘服务基础信息、登录凭据和来源幂等标识，不接收媒体目录。云助手不再提供媒体库快照导出。

网页服务详情只管理网盘基础信息、登录凭据和快速创建媒体库入口。扫描路径、元数据、定时任务、通知和协议账号均由媒体库页面管理。

右上角通知中心会持久化展示扫描任务结果，以及新账号注册、服务删除、媒体库清空、密码重置、角色或状态修改、会话撤销等敏感操作。通知严格按用户归属读取，每 10 秒刷新一次，支持单条清除和全部清除；通知清除不会删除审计日志。

文件访问接口返回 `accessType=temporary_url`、`url`、`headers` 和 `expiresAt`，协议客户端可在地址过期前直连网盘/CDN，或按媒体库的 Jellyfin、Emby、Navidrome 播放设置使用云助手中转。服务端只转发字节流，不转码、不缓存媒体正文，也不会向客户端返回网盘密码、Token 或上游认证头。

## 实现进度与后续计划

以下状态以当前仓库代码为准。已完成表示已经形成服务端与 Web 管理闭环；能力边界用于说明当前明确不支持或仍有使用限制的部分。

### 已完成

- [x] **影视扫描与刮削**：已完成路径选择、全量与增量扫描、电影与节目归组、NFO、TMDB、插件、手动匹配、清除匹配和媒体库浏览。
- [x] **后台任务与定时执行**：已完成扫描和视频规格分析队列、定时任务、进度与时长、等待原因、暂停、终止、重试、删除及完成任务清理。
- [x] **AI 模型目录文件清洗**：已完成 OpenAI Chat Completions 兼容模型配置、可用性测试、服务级选择、弱标题与 TMDB 首次未匹配补充、失败回退、任务快照和持久化缓存。
- [x] **9 类 Provider 接入**：WebDAV、光鸭、阿里云盘、百度网盘、115网盘、123云盘、天翼云盘、移动云盘和夸克网盘均已接入目录浏览、扫描、文件定位、直连和按能力中转；115、123、天翼、移动和夸克支持直接扫码登录。
- [x] **音乐三阶段扫描**：已完成目录与文件发现、音频标签和旁挂资料读取、在线元数据补全、阶段进度、问题明细与按阶段重试。
- [x] **网盘音乐与 Navidrome**：9 类 Provider 均可作为音乐媒体库来源，并提供歌曲、专辑、艺术家、封面、歌词和 Navidrome/Subsonic 兼容访问。
- [x] **服务与媒体库解耦**：网盘服务只保存基础信息与登录凭据，媒体库通过独立来源关系管理类型、扫描、元数据、通知和协议；当前限制一对一，数据结构保留多来源扩展能力。
- [x] **Flymby 单向上传与协议接入**：鸿蒙 APP 可上传本地网盘服务和凭据，并把 Jellyfin、Emby、Navidrome 协议账号一次性添加为普通本地服务。
- [x] **Jellyfin 常用协议兼容**：已完成账号登录、媒体库浏览、搜索、详情、季集、图片、播放定位、直连或中转播放及观看状态上报。
- [x] **Emby 独立协议兼容**：已完成独立地址、账号、会话、收藏、续播、历史、下载、地区媒体库和直连或中转播放，不复用 Jellyfin 账号与观看数据。
- [x] **协议多账号隔离**：Jellyfin、Emby 和 Navidrome 地址均可配置多个账号，收藏、观看或播放进度、历史和会话相互隔离。
- [x] **多用户管理与运维界面**：已完成用户隔离、超级管理员、系统配置、插件、通知、审计、Provider 与媒体库筛选，以及 SQLite、PostgreSQL、MySQL 和 Docker 部署。

### 进行中

- [ ] **阿里云盘与百度网盘内置授权流程**：Provider 能力已经可用，目前仍需要用户填写 Access Token、Refresh Token 等连接信息。
- [ ] **通用客户端接入规范**：服务、媒体库和协议访问接口已经存在，仍需整理稳定的公开接口文档、版本策略和参考客户端。
- [ ] **协议兼容性扩展**：Jellyfin、Emby 和 Navidrome/Subsonic 常用流程已经可用，仍需根据更多电视端、桌面端和移动端客户端补充协议细节。
- [ ] **通用 REST 播放进度同步**：协议兼容接口已经保存并隔离用户记录；面向任意 REST 客户端的统一提交、冲突处理和跨设备同步仍需完善。

### 能力边界

- [ ] **Flymby 音乐库同步**：APP 只上传本地网盘服务基础信息和凭据；音乐媒体库在云助手中创建、扫描，并通过 Navidrome/Subsonic 使用。
- [ ] **华为云空间 Provider**：当前没有接入计划；配置项中的华为账号绑定密钥只用于外部账号身份校验。
- [ ] **有声书扫描与刮削**：尚未实现作品、作者、演播者、分卷、章节归组和章节级续播的完整流程。
- [ ] **媒体转码**：Jellyfin、Emby 和 Navidrome/Subsonic 兼容层只提供原文件直连或字节流中转，不进行视频或音频转码。

## 数据与密钥

本地开发数据保存在 `data/`，Docker 数据保存在 `flycloud_helper_data` 持久卷。未配置凭据主密钥时，服务首次启动会随机生成并保存到 `data/secrets/credential-master-key`；设置超级管理员时需要按页面提示备份该密钥。密钥丢失后，数据库中已有的网盘凭据将无法解密。

切换 SQLite、PostgreSQL 或 MySQL 不会自动迁移数据，需要自行执行导出、导入或数据库迁移。

当前项目版本为 `0.1.15`，数据库 schema 版本为 `55`。升级现有数据库时服务会把网盘服务、媒体库来源、媒体配置和协议数据拆分到独立结构；使用不兼容的早期开发数据库时也可以删除并重新初始化，首次启动后重新设置超级管理员。
旧版已软删除的服务及其专属媒体库数据会在升级时彻底清理。新版若有媒体库仍使用某个网盘服务，必须先删除相关媒体库，才能删除该服务。
媒体库设置页会显示关联的网盘服务。当前一对一版本取消最后一个服务关联时会同时删除媒体库及其配置和扫描结果，网盘服务本身保留，不产生无来源的空媒体库。

## 项目结构

```text
api/       Fastify API、数据库、Provider、扫描 Worker 与刮削逻辑
web/       React 管理前端
data/      本地数据库、密钥、插件和导出文件（不会提交到 Git）
```
