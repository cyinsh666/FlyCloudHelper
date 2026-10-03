# 云助手与 APP 服务媒体库架构调整实施方案

## 1. 方案状态

本文档用于记录 FlyCloudHelper 与 Flymby 鸿蒙 APP 的架构调整和实际实施状态。本文已经合并 `codex://threads/01a0c97e-486a-7e42-9e77-26ab09e1f5ce` 中《云助手服务配置复制与管理方案》的已确认规则；发生冲突时，以本会话中更新后的“服务与媒体库解耦、删除旧双向同步”规则为准。除特别说明外，本文后续“APP”均指鸿蒙 APP。

> 实施状态（2026-09-23）：已经进入代码实施。云助手已完成服务与媒体库表结构拆分、`library_sources` 来源关系、媒体库配置和协议数据归属调整、聚合服务与迁移后端入口删除、服务单向上传接口、Web 服务/媒体库页面拆分；鸿蒙 APP 已完成九类网盘单向上传、媒体库创建与配置、任务入口，以及 Jellyfin、Emby、Navidrome 协议账号添加到本机。当前代码按项目要求只做静态检查，不执行编译和测试。旧托管镜像实现仍有仅供历史代码编译的内部类，新的页面、路由和上传流程不再创建或进入该状态，后续物理删除这些无入口类时需连同 WebDAV 旧托管分支一次移除。

> 升级删除规则补充：旧版已软删除的网盘服务在 Schema 55 升级时连同其专属媒体库、目录、任务和协议数据彻底清理；仍有效的服务才建立新的来源关系。新版服务只要仍被任一媒体库来源引用，就拒绝删除，必须先删除相关媒体库以解除依赖。

当前确认的产品边界：

1. 云助手中的“服务”只表示一个网盘连接，保存网盘基础信息和登录凭据。
2. 创建网盘服务时不再选择影视、音乐或有声书类型。
3. 本次实现一个网盘服务对应一个媒体库；后续允许多个网盘服务共同作为一个媒体库的数据来源。
4. APP 不再与云助手双向同步媒体库，不维护云端媒体库的本地镜像。
5. APP 不再支持媒体库迁入、迁回、设备绑定和目录增量同步。
6. APP 只能把本地已经存在的网盘服务单向上传到云助手，上传内容只包含基础信息和登录凭据。
7. APP 使用云助手中的媒体内容时，只能使用云助手暴露的 Emby、Jellyfin、Navidrome 等协议服务。
8. APP 可以调用云助手管理接口管理网盘服务、媒体库、任务和协议配置，但不能使用云助手内部目录或文件接口播放媒体。
9. 支持上传的网盘范围为 WebDAV、光鸭、阿里云盘、百度网盘、115 网盘、123 云盘、天翼云盘、移动云盘和夸克网盘。
10. 华为云空间不在本次支持范围内。
11. 不保留旧双向同步接口和运行时兼容分支。
12. 不新增测试用例，不执行编译；功能由用户在实施后自行验证。
13. 网盘服务与媒体库的数据结构完全解耦，两者不直接保存对方主键，通过独立的媒体库来源关联表建立关系。
14. APP 上传成功后原本地网盘服务保持不变，再询问用户是否删除，并说明两端同时使用可能触发登录失效、限流或账号风控。
15. APP 可以管理媒体库的 Jellyfin、Emby、Navidrome 开关及协议账号；用户选择某个协议中的某个账号“添加到本机”时，一次性创建一个普通、独立的本地协议服务。
16. 本次 APP 修改范围只包括鸿蒙 APP；Android、macOS 和 Android TV 不在本次实施范围内。

### 1.1 汇聚来源与最终裁决

本总方案汇聚以下两份方案：

- FlyCloudHelper 原方案：本文件重命名前的《云助手服务与媒体库架构调整实施方案》初稿。
- Flymby APP 方案：`/Users/shijianting/WebstormProjects/flymby/doc/云助手服务配置复制/云助手服务配置复制与管理方案.md`。

汇聚后的冲突处理：

| 冲突项 | 总方案采用规则 |
| --- | --- |
| 扫描、刮削、任务和协议原来放在服务详情 | 全部迁到媒体库，服务详情只管理网盘连接 |
| 旧方案按服务区分视频或音乐 | 服务不保存媒体类型，媒体库保存类型 |
| 旧方案协议接口按 `serviceId` | 改为按 `libraryId`，协议账号归属于媒体库 |
| 旧方案保留历史托管和迁回兼容 | 按当前要求整体删除，不保留运行时兼容入口 |
| 旧方案上传后本地服务处理 | 保留本地服务，成功后再询问是否删除并提示风控 |
| 旧方案协议账号添加到本机 | 保留，改为从媒体库协议账号一次性创建普通本地协议服务 |
| APP 上传基本信息曾包含媒体类型 | 删除媒体类型；只上传网盘服务基本信息、凭据和幂等来源标识 |

本文件是后续云助手与 APP 同时修改的唯一实施依据。两份来源文档保留为历史分析，不再单独指导实施。

---

## 2. 调整目标

### 2.1 数据职责清晰

网盘服务只负责回答两个问题：

- 数据从哪个 Provider 读取。
- 使用哪一组登录凭据读取。

媒体库负责回答以下问题：

- 这是影视、音乐还是有声书媒体库。
- 扫描哪些目录。
- 如何扫描、识别和刮削。
- 是否启用定时任务和通知。
- 对外提供哪一种媒体协议。
- 协议账号、播放状态和用户偏好归属于哪个媒体库。

### 2.2 APP 与云助手解耦媒体数据

APP 只保留管理面能力和协议客户端能力：

```text
管理面
APP -> FlyCloudHelper 管理 API -> 网盘服务、媒体库、任务、协议配置

媒体面
APP -> Emby / Jellyfin / Navidrome 协议 -> FlyCloudHelper 媒体库
```

APP 不再经过以下链路：

```text
APP -> FlyCloudHelper Catalog API -> 云端媒体条目 -> APP 本地网盘播放器
```

### 2.3 本次一对一，设计保留多服务一库

本次实现关系为：

```text
网盘服务 A -- 媒体库来源 A -- 媒体库 A
```

本次一个网盘服务最多关联一个媒体库，一个媒体库也只能包含一个网盘服务。未来关系扩展为：

```text
网盘服务 A -- 媒体库来源 A --┐
网盘服务 B -- 媒体库来源 B --┼-- 媒体库 X
网盘服务 C -- 媒体库来源 C --┘
```

因此不能在 `cloud_services` 中保存 `library_id`，也不能在 `media_libraries` 中保存 `service_id`。两者通过独立的 `library_sources` 表关联。本次通过唯一约束限制一对一，后续多服务一库只需放开 `library_id` 的唯一约束，媒体库和网盘服务主表均不需要再次调整。

---

## 3. 本次不做的内容

1. 不把 APP 本地媒体目录、刮削结果、播放记录或媒体 ID 上传到云助手。
2. 不从云助手下载完整或增量媒体目录到 APP。
3. 不建立 APP 设备与云助手网盘服务的长期绑定关系。
4. 不支持把云助手媒体库迁回 APP 本地网盘媒体库。
5. 不支持把 APP 本地媒体库快照迁入云助手。
6. 不自动合并不同设备上传的相同网盘账号。
7. 不使用 FlymbyServer 协助网盘登录或凭据转换。
8. 不支持华为云空间上传。
9. 不在本阶段补齐有声书扫描、刮削和协议实现；数据模型保留 `audiobook` 类型，页面在能力未完成前保持不可创建状态。
10. 不删除云助手 Web 管理端使用的媒体目录查询接口。
11. 删除云助手自身的媒体库 ZIP 快照导出功能，以及依赖快照实现的 APP 迁入、迁回链路；扫描任务配置快照继续保留。
12. 本次不实现一个媒体库同时扫描多个网盘服务，也不实现跨来源媒体合并；只把来源维度预留到数据结构、扫描根目录和源文件归属中。
13. 不自动删除 APP 原本地网盘服务，删除必须由用户在上传成功提示中主动选择。
14. 不持续关联或追踪已经添加到本机的 Jellyfin、Emby、Navidrome 服务。
15. 不修改 Android、macOS 和 Android TV 客户端。

---

## 4. 当前结构与主要问题

### 4.1 网盘服务承担了媒体库职责

当前 `cloud_services` 同时保存：

- `library_id`
- `data_type`
- `scan_profile_revision`
- `metadata_profile_revision`
- `last_scan_at`
- `notification_enabled`
- APP 专用中转相关配置

这使网盘服务主表直接承担媒体库归属，服务和媒体库无法独立创建、删除和演进。

### 4.2 媒体库直接持有服务外键

当前 `media_libraries.service_id` 带唯一约束，同时保存冗余 `provider_type`。即使直接解除唯一约束，也只能得到“一个服务多个媒体库”的一对多结构，不能支持目标中的“多个服务一个媒体库”。因此必须移除媒体库主表中的 `service_id`，增加独立来源关联表。

### 4.3 协议账号和播放状态以服务为边界

当前以下数据以 `service_id` 为归属：

- Jellyfin/Navidrome 通用访问账号和会话。
- Emby 账号和会话。
- 播放进度、播放会话、播放历史。
- 收藏和协议虚拟条目偏好。
- 音乐播放列表。

如果协议数据继续归属于服务，未来多个服务汇入同一媒体库时会出现多套互不一致的协议账号和播放状态。协议对外代表媒体库，因此必须改为媒体库归属。

### 4.4 APP 同步模块与新边界冲突

当前云助手仍包含：

- `client_service_links`
- `service_migrations`
- `service_migration_chunks`
- `service_transfer_outs`
- `catalog_changes`
- 服务绑定接口、媒体库迁移接口和迁回接口。

当前 APP 仍包含媒体库迁移、迁回、云端目录读取、云端文件定位、本地托管卡片和设备绑定恢复逻辑。这些能力均与新的单向上传和协议访问规则冲突。

---

## 5. 目标数据模型

### 5.1 `cloud_services`

保留字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 云助手网盘服务 ID |
| `user_id` | 所属用户 |
| `display_name` | 网盘服务名称 |
| `provider_type` | Provider 类型 |
| `status` | `active`、`reauthorization_required`、`disabled` |
| `connection_status` | Provider 连接状态 |
| `credential_revision` | 当前凭据修订 |
| `device_id` | Provider 登录需要的设备标识，可为空 |
| `device_name` | Provider 登录需要的设备名称，可为空 |
| `client_name` | Provider 登录需要的客户端名称，可为空 |
| `created_at`、`updated_at`、`deleted_at` | 生命周期字段 |

删除字段：

- `library_id`
- `data_type`
- `relay_playback_enabled`
- `notification_enabled`
- `scan_profile_revision`
- `metadata_profile_revision`
- `last_scan_at`

服务状态不再使用 `scanning`。是否有任务运行由任务表实时计算。

### 5.2 `service_credentials`

继续按 `service_id + revision` 保存不可变的加密凭据修订。扫描任务快照保留 `credentialRevision`，用于识别任务运行期间凭据是否发生变化。

凭据只允许以下模块解密：

- Provider 连接检查。
- Provider 目录浏览。
- 扫描 Worker。
- 协议播放地址解析。

凭据不进入日志、媒体库配置、协议响应和 APP 媒体服务配置。

### 5.3 `media_libraries`

新增或调整字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 媒体库 ID |
| `user_id` | 所属用户 |
| `display_name` | 媒体库名称 |
| `data_type` | `video`、`music`、`audiobook` |
| `status` | `active`、`disabled` |
| `scan_profile_revision` | 当前扫描配置修订 |
| `metadata_profile_revision` | 当前刮削配置修订 |
| `catalog_version` | 云助手内部目录版本 |
| `notification_enabled` | 任务结果通知开关 |
| `last_scan_at` | 最近成功完成扫描时间 |
| Jellyfin 配置字段 | 仅影视库有效 |
| Emby 配置字段 | 仅影视库有效 |
| Navidrome 配置字段 | 仅音乐库有效 |
| 协议路径后缀字段 | 按媒体库保持唯一 |
| `created_at`、`updated_at` | 生命周期字段 |

扫描任务完成时在同一事务中将 `last_scan_at` 写入所属 `media_libraries`；`cloud_services` 不再承载该字段。AI 补充任务不更新最近扫描时间。该问题已验证修复，临时定位日志已清理。

删除字段：

- `service_id`
- 冗余的 `provider_type`
- `app_relay_playback_enabled`

`media_libraries` 不保存网盘服务 ID 和 Provider 类型。媒体库的来源通过 `library_sources` 获取。

### 5.4 `library_sources`

新增独立媒体库来源表：

| 字段 | 说明 |
| --- | --- |
| `id` | 媒体库来源 ID，扫描和源文件使用该 ID 定位来源 |
| `user_id` | 所属用户 |
| `library_id` | 媒体库 ID |
| `service_id` | 网盘服务 ID |
| `status` | `active`、`disabled` |
| `sort_order` | 为后续多来源顺序预留，本次固定为 0 |
| `created_at`、`updated_at` | 生命周期字段 |

本次一对一约束：

```text
UNIQUE (user_id, service_id)
UNIQUE (user_id, library_id)
```

这两个约束保证一个服务最多进入一个媒体库，一个媒体库也只有一个来源。未来实现多服务一库时，仅删除 `user_id + library_id` 唯一约束，保留 `user_id + service_id` 唯一约束。

服务和媒体库主表均不保存对方 ID。所有需要从媒体库访问 Provider 的链路统一经过：

```text
media_libraries -> library_sources -> cloud_services -> service_credentials
```

### 5.5 扫描与刮削配置

将以下表改为媒体库归属：

| 当前表 | 目标表 | 主归属字段 |
| --- | --- | --- |
| `service_scan_profiles` | `library_scan_profiles` | `library_id` |
| `service_metadata_profiles` | `library_metadata_profiles` | `library_id` |
| `service_scan_schedules` | `library_scan_schedules` | `library_id` |

配置修订唯一约束调整为：

```text
user_id + library_id + revision
```

定时任务唯一约束调整为：

```text
user_id + library_id + scan_mode
```

扫描配置中的每个根目录增加 `librarySourceId`。本次创建媒体库时自动写入唯一来源 ID；未来一个媒体库增加多个来源后，扫描根目录不需要改变结构即可明确属于哪个网盘服务。

### 5.6 媒体文件与目录归属

媒体目录本身属于媒体库，Provider 文件属于媒体库来源：

- `media_items` 只保存 `library_id`，删除 `service_id`。
- `source_files` 保存 `library_id + library_source_id`，删除直接 `service_id` 归属。
- `audio_file_tags`、`nfo_sidecar_cache`、`scan_root_runs` 和媒体规格文件记录增加或改用 `library_source_id`。
- `file_links` 继续连接媒体条目和源文件。

源文件唯一约束调整为：

```text
user_id + library_id + library_source_id + provider_resource_id
```

协议播放时按以下链路解析凭据：

```text
媒体条目 -> 文件关联 -> 源文件 -> 媒体库来源 -> 网盘服务 -> 当前凭据
```

该结构允许未来一个媒体条目关联来自不同网盘服务的多个文件版本。本次不实现跨来源条目合并规则。

### 5.7 协议账号与播放数据

协议对外暴露的是媒体库，因此以下数据全部改为 `library_id` 归属：

- 访问账号。
- 协议会话。
- 播放进度。
- 播放会话。
- 播放历史。
- 条目偏好和虚拟条目偏好。
- 音乐播放列表及其条目。
- Emby 独立账号、会话和播放数据。

实施时采用新的 `library_*` 表名，完成数据复制后删除旧 `service_*` 协议数据表，不保留双写。

账号名唯一约束调整为：

```text
library_id + username_lookup
```

协议会话必须同时校验：

- Token 属于当前媒体库。
- 账号属于当前媒体库。
- 请求路径后缀解析出的媒体库与会话媒体库一致。

### 5.8 扫描任务

`scan_jobs` 和 `media_probe_jobs` 保存：

- `library_id`：获取扫描配置、刮削配置和媒体数据归属。
- `library_source_id`：定位本次任务使用的网盘来源。
- `service_id`：作为任务执行快照保留，用于凭据修订校验和 Provider 并发控制，不作为媒体库关系事实来源。

任务快照至少冻结：

```json
{
  "serviceId": "网盘服务ID",
  "libraryId": "媒体库ID",
  "librarySourceId": "媒体库来源ID",
  "providerType": "cloud115",
  "credentialRevision": 3,
  "scanProfileRevision": 6,
  "metadataProfileRevision": 4,
  "dataType": "video"
}
```

本次一个媒体库只有一个来源，创建一次扫描只生成一个来源任务。未来多服务一库时，媒体库扫描入口为每个启用来源分别创建来源任务；现有 Worker、源文件唯一键和任务快照不需要更换归属模型。

### 5.9 APP 上传来源与幂等记录

新增 `service_import_sources`，用于识别同一设备上的同一本地服务，并解决网络重试导致的重复创建：

| 字段 | 说明 |
| --- | --- |
| `id` | 记录 ID |
| `user_id` | 云助手用户 |
| `service_id` | 已创建的网盘服务 |
| `source_device_id` | 来源 APP 设备 ID，仅用于幂等和审计 |
| `source_local_service_id` | 来源本地网盘服务 ID，仅用于幂等和精确删除提示 |
| `request_id` | 最近一次成功上传请求 ID |
| `provider_type` | 来源 Provider 类型，用于拒绝错误复用 |
| `created_at` | 创建时间 |

唯一约束：

```text
user_id + source_device_id + source_local_service_id
user_id + request_id
```

该表不是设备绑定，不保存媒体库 ID，也不参与媒体读取、服务删除限制或 APP 本地服务状态同步。相同请求重试或同一设备上的同一本地服务再次上传时返回原 `service_id`；其他设备上的相似服务不按名称、地址或账号自动合并。设备 ID 和本地服务 ID 属于上传幂等元数据，不属于云助手网盘服务的业务配置。

同一本地服务再次上传时不覆盖云助手现有名称和凭据，只返回已经创建的服务；云助手凭据变化统一通过“更新登录凭据”处理，上传接口不兼任凭据更新接口。

---

## 6. 媒体库能力规则

| 媒体库类型 | 扫描刮削 | 可配置协议 | 当前阶段 |
| --- | --- | --- | --- |
| `video` | 影视三阶段扫描刮削 | Jellyfin、Emby，可分别启用 | 完整支持 |
| `music` | 音乐三阶段扫描刮削 | Navidrome | 完整支持 |
| `audiobook` | 保留数据类型 | 本次不配置协议 | 暂不开放创建 |

协议开关必须按媒体库类型校验：

- 音乐库不能启用 Jellyfin 或 Emby。
- 影视库不能启用 Navidrome。
- 未实现的有声书库不能启用任何协议。

媒体库类型在媒体库页面管理，不进入网盘服务数据。为避免已有目录和协议数据被错误解释，修改类型必须同时满足：

- 没有运行中、排队中或等待重试的任务。
- 媒体库中没有源文件和媒体条目。
- 没有启用任何媒体协议，也没有协议账号。

满足条件时，`PATCH /api/v1/libraries/:libraryId` 可以修改类型，并创建适用于新类型的第一版元数据配置。扫描路径仍保留，因为路径属于媒体库来源；不满足条件时返回明确冲突信息，由用户清空媒体库和协议配置后再修改。

---

## 7. Provider 与任务并发规则

### 7.1 服务级连接状态

Provider 鉴权失败时更新网盘服务的 `connection_status` 和 `status`。本次与该服务一对一关联的媒体库显示来源连接异常，但已经保存的媒体目录仍然保留。未来多服务一库时，只把对应来源标记为异常，其他来源可以继续工作。

非鉴权类扫描失败只影响当前媒体库和当前任务，不修改其他媒体库状态。

### 7.2 服务级 Provider 并发

第一阶段同一个网盘服务同一时间只允许一个需要读取 Provider 的重任务运行，包括：

- 全量扫描。
- 增量扫描。
- 音乐扫描的目录读取阶段。
- 视频规格分析中需要重新读取媒体文件的阶段。

不同网盘服务仍可以按照全局 Worker 并发并行运行。该限制用于避免共享凭据刷新、Provider 限流和同账号并发冲突。媒体库与服务是否一对一不影响这条限制，锁始终以实际来源服务 ID 为键。

### 7.3 媒体库级状态

媒体库只保存 `active` 或 `disabled`。扫描中、排队、失败和完成状态从最近任务计算，不写入媒体库状态。

---

## 8. 云助手 API 调整

### 8.1 网盘服务接口

保留或调整：

```http
GET    /api/v1/services
POST   /api/v1/services
GET    /api/v1/services/:serviceId
PATCH  /api/v1/services/:serviceId
POST   /api/v1/services/:serviceId/connection/reconnect
POST   /api/v1/services/:serviceId/connection/validate
PUT    /api/v1/services/:serviceId/connection
DELETE /api/v1/services/:serviceId
```

`POST /api/v1/services` 只接收服务名称、Provider 类型和登录连接，不再接收 `dataType`、扫描配置和刮削配置，也不自动创建媒体库。

连接操作分为两类：

- “使用当前凭据重新连接”调用 `connection/reconnect`，验证云助手已保存的凭据，并允许 Provider 自动刷新 Token 后原位加密保存。
- “重新登录”通过 Provider 授权页得到新的连接对象，先调用 `connection/validate`，再携带 `expectedRevision` 调用 `PUT connection` 生成新的不可变凭据修订。

重新登录时校验稳定账号标识，发现账号已经变化则拒绝覆盖并提示新建网盘服务。新凭据验证失败或修订冲突时保留旧凭据，不修改来源本地服务。

Provider 目录浏览仍挂在服务下，因为目录浏览使用网盘凭据：

```http
POST /api/v1/services/:serviceId/directories
```

### 8.2 APP 单向上传接口

新增：

```http
POST /api/v1/services/import
```

请求结构：

```json
{
  "requestId": "APP生成的单次上传请求ID",
  "sourceDeviceId": "来源设备ID",
  "sourceLocalServiceId": "来源本地服务ID",
  "displayName": "我的115网盘",
  "providerType": "cloud115",
  "providerSchemaVersion": 1,
  "connection": {
    "provider允许的登录字段": "值"
  }
}
```

响应结构：

```json
{
  "created": true,
  "reused": false,
  "service": {
    "id": "云助手服务ID",
    "displayName": "我的115网盘",
    "providerType": "cloud115",
    "status": "active",
    "connectionStatus": "connected",
    "credentialRevision": 1
  }
}
```

处理顺序：

1. 根据登录用户确定 `user_id`。
2. 检查 `requestId` 是否已经成功创建服务。
3. 按 `用户 + 来源设备 + 来源本地服务` 查询上传来源记录；已经存在时校验 Provider 一致并返回原服务。
4. 检查 Provider 是否属于支持上传范围。
5. 使用现有 Provider 连接解析和字段裁剪逻辑校验凭据。
6. 执行最小连接验证，不读取扫描目录。
7. 创建 `cloud_services` 和第一版 `service_credentials`。
8. 写入 `service_import_sources`。
9. 返回服务信息，不创建媒体库。

请求中禁止出现以下字段：

- `dataType`
- `libraryId`
- `scanProfile`
- `metadataProfile`
- `roots`
- `catalogVersion`
- `mediaItems`

服务详情只返回基础信息、凭据是否已配置、连接状态、重新登录能力和 `canCreateLibrary` 布尔值，不返回关联媒体库详情，也不返回扫描、刮削、任务、通知或协议配置。

上传成功后，APP 保持原本地服务、凭据和媒体数据不变，并询问是否删除原本地服务。默认操作为“保留本地服务”，提示内容必须说明：APP 与云助手同时使用同一账号或令牌时，可能同时刷新凭据或高频访问网盘，从而造成登录失效、接口限流或账号风控。

只有云助手服务创建或幂等复用成功、凭据验证保存成功、来源记录写入成功时才显示删除询问。用户选择删除时按 `sourceLocalServiceId` 精确调用原 Provider 的完整本地删除流程，不能按名称或账号猜测。删除失败不回滚已经创建的云助手服务，本地服务也保持原状，并提示用户稍后手动删除。

### 8.3 媒体库接口

新增或调整：

```http
GET    /api/v1/libraries
POST   /api/v1/libraries
GET    /api/v1/libraries/:libraryId
PATCH  /api/v1/libraries/:libraryId
DELETE /api/v1/libraries/:libraryId
GET    /api/v1/libraries/:libraryId/sources
PATCH  /api/v1/libraries/:libraryId/scan-profile
PATCH  /api/v1/libraries/:libraryId/metadata-profile
GET    /api/v1/libraries/:libraryId/schedules
PUT    /api/v1/libraries/:libraryId/schedules/:scanMode
POST   /api/v1/libraries/:libraryId/jobs
```

创建媒体库请求包含：

```json
{
  "displayName": "电影",
  "dataType": "video",
  "sourceServiceId": "网盘服务ID",
  "scanProfile": {
    "fullRoots": [],
    "incrementalRoots": []
  },
  "metadataProfile": {
    "profiles": {}
  }
}
```

创建事务只负责：

1. 校验来源服务归属、连接状态并确认尚未关联媒体库。
2. 校验 Provider 是否支持对应媒体类型。
3. 创建媒体库。
4. 创建唯一的 `library_sources` 记录。
5. 创建第一版扫描和刮削配置，根目录写入新来源 ID。
6. 生成三种协议路径后缀，但默认按媒体类型只开放适用协议。

服务详情页的“快速创建媒体库”不直接调用创建接口，而是打开统一的“创建媒体库”页面，并通过页面参数传入当前 `serviceId`。创建页面把当前服务自动加入“关联服务”区域，展示服务名称、Provider 和连接状态；用户继续填写媒体库名称、类型、扫描路径和元数据配置，点击创建后才调用 `POST /api/v1/libraries`。

从服务详情进入时，当前服务固定为本次唯一关联服务，不允许在页面内替换。从媒体库管理页进入通用创建页面时，用户可以从尚未关联媒体库的服务中选择一个。无论从哪个入口提交，如果服务已经存在来源关联，接口均返回稳定冲突码，不允许本次创建第二个媒体库。

为后续多服务一库预留但本次不开放写操作：

```http
POST   /api/v1/libraries/:libraryId/sources
DELETE /api/v1/libraries/:libraryId/sources/:sourceId
```

后续开放时只增加来源记录和对应扫描根目录，不修改服务或媒体库主表。

### 8.4 协议管理接口

协议设置和账号管理统一改为媒体库路径：

```http
GET    /api/v1/libraries/:libraryId/protocols
PATCH  /api/v1/libraries/:libraryId/protocols/jellyfin
PATCH  /api/v1/libraries/:libraryId/protocols/emby
PATCH  /api/v1/libraries/:libraryId/protocols/navidrome
POST   /api/v1/libraries/:libraryId/protocols/:protocol/accounts
PATCH  /api/v1/libraries/:libraryId/protocols/:protocol/accounts/:accountId
POST   /api/v1/libraries/:libraryId/protocols/:protocol/accounts/:accountId/reset-password
POST   /api/v1/libraries/:libraryId/protocols/:protocol/accounts/:accountId/revoke-sessions
DELETE /api/v1/libraries/:libraryId/protocols/:protocol/accounts/:accountId
POST   /api/v1/libraries/:libraryId/protocols/:protocol/accounts/:accountId/client-access
```

协议 URL 的路径后缀继续来自媒体库。现有媒体库升级后沿用原后缀，避免已经添加到客户端的 Emby、Jellyfin 或 Navidrome 地址失效。

APP 可以在媒体库详情中管理协议开关和账号。影视库允许 Jellyfin、Emby 分别启用或同时启用，音乐库只允许 Navidrome。每个已启用协议分别维护账号列表，支持创建、修改、重置密码、撤销会话和删除账号。

`client-access` 只处理路径中指定的一个协议账号，请求结构为：

```json
{
  "requestId": "APP生成的单次建卡请求ID",
  "targetDeviceId": "目标设备ID"
}
```

响应只返回创建一张普通本地协议服务卡片所需的信息：

```json
{
  "protocolType": "jellyfin",
  "accountId": "协议账号ID",
  "baseUrl": "云助手协议访问地址",
  "username": "协议用户名",
  "credential": {
    "设备可用的密码或Token字段": "值"
  }
}
```

服务端必须校验协议已经启用、账号属于当前用户和当前媒体库，并按 `requestId` 幂等返回同一结果。该接口不创建协议账号，不返回其他协议或其他账号，也不建立本地卡片与云助手的持续绑定。

APP 成功保存卡片后，不保存云助手网盘服务 ID、媒体库 ID、协议账号 ID 或托管标记。本地卡片成为普通、独立的 Jellyfin、Emby 或 Navidrome 服务；云助手后续关闭协议、修改密码、撤销会话或删除账号时，不主动修改、标记或删除本地卡片。本地卡片删除也不影响云助手协议账号和媒体库。

### 8.5 删除的接口

删除：

- `/api/v1/service-migrations/**`
- `/api/v1/services/:serviceId/client-bindings/**`
- `/api/v1/services/:serviceId/transfer-outs/**`
- `/api/v1/libraries/:libraryId/changes`
- APP Bearer Token 专用的媒体文件定位和访问接口
- 只用于媒体库迁入或迁回的能力查询、上传分块和凭据领取接口

Web 管理端使用的媒体目录列表、搜索和详情接口继续保留；媒体库快照接口删除。

---

## 9. 云助手后端实施范围

### 9.1 Schema 与领域模型

主要文件：

- `api/src/schema.ts`
- `api/src/domain.ts`
- `api/src/database.ts`

任务：

- [ ] 将 Schema 版本从 54 提升到 55。
- [ ] 从服务和媒体库主表移除彼此的外键，新增 `library_sources` 关联表并启用本次一对一唯一约束。
- [ ] 创建媒体库级配置、计划、协议账号、会话和播放数据表。
- [ ] 创建 `service_import_sources` 及来源键、请求键唯一索引。
- [ ] 删除 APP 双向同步相关表。
- [ ] 删除 APP 专用中转配置和目录变更表。
- [ ] 更新领域模型，移除服务级媒体字段和迁移类型。

### 9.2 Repository 拆分

主要文件：

- `api/src/service-repository.ts`
- 新增 `api/src/library-repository.ts`
- `api/src/service-access.ts`
- Jellyfin、Emby、Navidrome 的存储访问文件

职责划分：

- `ServiceRepository` 只管理网盘服务、凭据和连接状态。
- `LibraryRepository` 管理媒体库、扫描配置、刮削配置、计划、目录清理和删除。
- 协议 Repository 使用 `libraryId` 读取账号、会话、进度和偏好。
- 媒体库删除同时删除来源关联，但不删除网盘服务。
- 已关联媒体库的服务禁止直接删除，避免通过服务生命周期反向删除媒体库数据。

### 9.3 路由

主要文件：

- `api/src/routes/service-routes.ts`
- `api/src/routes/catalog-routes.ts`
- 新增 `api/src/routes/library-routes.ts`
- 删除 `api/src/routes/service-migration-routes.ts`

路由层完成：

- 网盘服务创建与 APP 单向上传分开建模。
- 媒体库 CRUD、配置、任务和协议接口使用 `libraryId`。
- 删除绑定、迁入、迁回和 APP 媒体访问入口。
- 管理员接口继续从会话确定目标用户，不接受客户端伪造归属。

### 9.4 Worker 与定时任务

主要文件：

- `api/src/worker.ts`
- `api/src/media-probe-worker.ts`
- `api/src/scan-schedule-service.ts`
- `api/src/protocol-scan-service.ts`
- `api/src/runtime.ts`
- `api/src/server.ts`

任务：

- [ ] 从媒体库加载扫描和刮削修订。
- [ ] 从网盘服务加载 Provider 和凭据修订。
- [ ] 调度锁改为服务级 Provider 锁，任务结果继续按媒体库隔离。
- [x] 最近扫描时间写入媒体库。
- [ ] 移除 Service Migration Worker 的创建、恢复和启动逻辑。
- [ ] 保留服务凭据更新后的任务修订检查。

### 9.5 协议服务

主要文件：

- `api/src/jellyfin-service.ts`
- `api/src/emby-service.ts`
- `api/src/routes/jellyfin-routes.ts`
- `api/src/routes/emby-routes.ts`
- `api/src/music/**`

任务：

- [ ] 协议路径后缀首先解析 `libraryId`。
- [ ] 账号、会话、播放数据全部校验媒体库归属。
- [ ] Provider 播放地址通过“媒体条目 -> 源文件 -> 媒体库来源”查找服务和凭据。
- [ ] 协议账号、目录和播放状态只归属于媒体库，不因来源服务变化而改变归属。
- [ ] 当前一对一实现仍使用 `librarySourceId` 解析文件，为后续多服务一库保留入口。
- [ ] 影视库可分别启用 Jellyfin 和 Emby。
- [ ] 音乐库只启用 Navidrome。

### 9.6 删除旧同步模块

删除文件：

- `api/src/service-migration-repository.ts`
- `api/src/service-migration-worker.ts`
- `api/src/routes/service-migration-routes.ts`

同时清理：

- `api/src/config.ts` 中只用于迁移文件、分块大小和迁移恢复的配置。
- `api/src/runtime.ts`、`api/src/server.ts` 中的迁移组件装配。
- `api/src/service-repository.ts` 中的绑定、迁回、目录变更写入和旧表清理。
- README、项目说明和接口文档中的双向同步描述。

---

## 10. 云助手 Web 页面调整

### 10.1 服务列表

主要文件：

- `web/src/pages/ServicePages.tsx`
- `web/src/lib/api.ts`
- `web/src/pages/OverviewPage.tsx`

服务卡片只展示：

- 服务名称。
- Provider 图标与名称。
- 连接状态圆点。
- 登录凭据状态。

删除服务卡片上的媒体类型、扫描修订、刮削修订、最近扫描和增量扫描按钮。

### 10.2 创建服务

创建页只保留：

- 服务名称。
- Provider 选择。
- Provider 登录或连接配置。
- 连接验证和创建操作。

创建成功后进入服务详情页。服务详情提供“快速创建媒体库”入口，该入口只打开创建媒体库页面并自动带入当前服务，不在创建服务事务中自动生成媒体库。

### 10.3 服务详情

云端服务和媒体库均在个人模式创建，创建内容归属当前登录账户。管理员模式不展示创建入口；旧管理员创建服务地址跳转到个人模式的创建页，不再提供选择其他用户创建服务的表单。

服务详情只展示网盘层内容：

- 服务名称、Provider、连接状态等基础信息。
- 登录凭据是否有效、凭据更新时间和登录方式等脱敏状态。
- “重新登录”入口，按 Provider 进入扫码、授权或账号密码更新流程。
- 未关联媒体库时展示“快速创建媒体库”；点击后打开统一创建媒体库页面，关联服务自动添加当前服务。
- 已关联媒体库后隐藏“快速创建媒体库”，服务页不提供“进入媒体库”入口；媒体库统一从“媒体库管理”进入。
- 删除服务放入页面操作菜单；存在来源关联时禁止删除并引导先删除媒体库。

服务详情不展示媒体库类型、扫描路径、扫描进度、定时任务、刮削配置、通知、协议账号、快照和媒体任务。

### 10.4 媒体库页面

主要文件：

- `web/src/pages/LibraryPages.tsx`
- `web/src/pages/JobCatalogPages.tsx`

创建媒体库页面使用统一路由和同一套提交逻辑：

- 从服务详情进入时携带 `sourceServiceId` 页面参数，关联服务区域自动添加当前服务并锁定。
- 从媒体库管理页进入时，不携带服务参数，由用户选择一个尚未关联的服务。
- 关联服务区域的数据结构使用数组，但本次最多一项；这样未来多服务一库可以增加服务选择，不需要重写媒体库表单。
- 页面打开只填写表单，不预先创建媒体库、来源记录或默认协议账号。

媒体库详情承载：

- 媒体库名称和类型管理。
- 当前唯一来源服务及其连接状态。
- 全量及增量扫描路径。
- 当前扫描进度、阶段、数量和错误信息。
- 扫描并发配置。
- 刮削和元数据配置。
- 定时任务。
- 通知配置。
- 手动扫描、重试和清空目录。
- Jellyfin、Emby 或 Navidrome 设置。
- 协议账号管理。
- 当前媒体库任务列表。

任务卡片重点展示媒体库名称，并补充来源服务名称。本次每个媒体库只展示一个来源；页面数据结构使用来源数组，为后续多服务一库保留展示能力。

### 10.5 删除旧页面内容

删除：

- 绑定设备列表和解绑入口。
- APP 专用中转播放开关。
- 迁入状态、迁回状态和迁移进度。
- 把云助手网盘服务还原成本地网盘服务的旧“添加到本机”提示。

媒体库协议账号上的“添加到本机”继续保留，它只用于一次性创建普通 Jellyfin、Emby 或 Navidrome 本地服务卡片。

---

## 11. Flymby APP 调整

APP 工程路径：`/Users/shijianting/WebstormProjects/flymby`

### 11.1 保留的能力

APP 保留：

- 云助手登录和凭据保存。
- 云助手网盘服务列表与详情管理。
- 云助手媒体库列表、创建、配置和任务管理。
- 从本地网盘服务发起“上传到云助手”。
- 将云助手暴露的 Emby、Jellyfin、Navidrome 地址按普通协议服务添加到 APP。
- 现有 Emby、Jellyfin、Navidrome 客户端播放链路。

### 11.2 新增单向上传链路

新增文件：

- `main/src/main/ets/flycloudhelper/FlyCloudHelperServiceUploadApi.ets`
- `main/src/main/ets/flycloudhelper/FlyCloudHelperServiceUploadService.ets`
- `main/src/main/ets/pages/setting/FlyCloudHelperServiceUploadPage/index.ets`
- 页面专用的 `model` 和 `helper` 文件。

上传步骤：

1. 用户在云助手管理的新增入口中选择“上传本地网盘服务”。
2. 页面列出当前设备上受支持且已经完成登录的本地网盘服务。
3. 用户选择一个服务，页面展示网盘名称、网盘类型、目标云助手账号、将上传的内容和不会上传的内容。
4. APP 读取该服务当前基础信息和登录凭据，并使用 Provider 现有能力校验或刷新凭据。
5. APP 生成一次性 `requestId`，携带 `sourceDeviceId`、`sourceLocalServiceId` 调用 `/api/v1/services/import`。
6. 成功后显示已创建或已经存在的云助手服务，并说明本地服务仍保持原状。
7. APP 询问是否删除原本地服务，默认操作为“保留本地服务”，同时展示两端共用账号可能造成登录失效、限流或账号风控的说明。
8. 用户选择删除时，再次确认服务名称，并按原本地 `serverId` 复用该 Provider 的完整删除流程。
9. 删除失败不回滚云助手服务，本地服务保持原状并提示稍后手动删除。
10. 用户可以进入云助手服务详情管理凭据，或从服务的快速入口打开创建媒体库页面。

不同 Provider 的凭据转换独立编写明确分支，不通过一个大型归一化对象处理。函数和关键变量按项目要求添加注释。

上传失败时不修改本地服务，也不显示删除询问。协议是否启用、是否存在协议账号、是否已经添加本地协议服务，均不影响网盘服务上传结果和删除询问。

上传成功提示统一为：

> 已上传到 Fly云助手
>
> 云助手已保存服务基础信息与登录凭据，本地网盘服务仍可继续使用。是否删除本地网盘服务？
>
> 如果 APP 与云助手同时使用同一账号或令牌，两端可能同时刷新凭据或高频访问网盘，可能导致登录失效、接口限流或账号风控。

按钮为“保留本地服务”和“删除本地服务”，默认操作为“保留本地服务”。

### 11.3 协议账号一次性添加到本机

主要文件：

- `main/src/main/ets/flycloudhelper/FlyCloudHelperServiceApi.ets`
- `main/src/main/ets/flycloudhelper/FlyCloudHelperJellyfinMediaCenterService.ets`
- `main/src/main/ets/flycloudhelper/FlyCloudHelperNavidromeMediaCenterService.ets`
- 新增 Emby 协议服务协调类，或新增职责单一的 `FlyCloudHelperProtocolLocalServiceCreator.ets` 统一调度三种现有建卡能力。
- 云助手媒体库详情页及其协议账号组件。

操作流程：

1. 用户在媒体库详情中打开 Jellyfin、Emby 或 Navidrome 账号列表。
2. 用户选择一个具体账号并点击“添加到本机”。
3. APP 生成单次 `requestId`，调用该账号的 `client-access` 接口。
4. APP 使用返回的协议地址、用户名和凭据创建一张对应的本地协议服务卡片。
5. 本地保存成功后结束创建关系，不写入托管、云助手服务、媒体库或协议账号绑定字段。
6. 添加一个账号只创建一张卡片，不自动添加同协议的其他账号，也不自动创建其他协议卡片。

同一次请求重试不得重复保存卡片。保存失败时保留云助手协议和账号，用户可以从原账号再次执行“添加到本机”。云助手后续变化不主动影响已创建卡片；卡片按照普通 Jellyfin、Emby 或 Navidrome 服务的现有编辑、连接失败和删除行为运行。

由于本地卡片与云助手账号不保留绑定，用户结束一次建卡后再次主动点击同一账号，可以再创建一张普通协议服务卡片；幂等控制只阻止同一次请求因网络重试产生重复卡片。

### 11.4 云助手网盘凭据管理

APP 在“云助手服务详情 -> 网盘连接”直接使用云助手服务 ID 管理凭据，不查找来源本地服务，也不要求当前设备仍保存原本地服务。

页面区分两种操作：

| 操作 | APP 行为 | 云助手行为 |
| --- | --- | --- |
| 使用当前凭据重新连接 | 直接提交服务 ID | 验证已保存凭据，允许 Provider 自动刷新 Token 并原位保存 |
| 更新登录凭据 | 打开该 Provider 的扫码、授权、验证码或账号密码流程，得到独立连接对象 | 验证连接和稳定账号标识，按 `expectedRevision` 写入新凭据修订 |

当服务为 `reauthorization_required` 时，页面主操作显示“更新登录凭据”。WebDAV 允许编辑地址、用户名和密码；各网盘复用现有 Provider 登录组件，但登录结果只提交给云助手，不先创建本地网盘服务卡片。

| Provider | 更新登录凭据方式 |
| --- | --- |
| WebDAV | 编辑地址、用户名和密码，保存前验证连接 |
| 光鸭官方 API | 在管理页完成官方授权，提交最终有效 Token 和设备信息 |
| 光鸭网页登录 | 在管理页创建授权会话并完成扫码或验证码登录 |
| 阿里云盘、百度网盘 | 复用现有授权流程得到新的独立连接对象 |
| 115、123、天翼、夸克、移动云盘 | 复用各 Provider 登录组件，将结果直接提交给云助手 |

页面只展示 Provider、登录方式、脱敏账号摘要、连接状态、凭据修订和最近验证时间，不回显 Token、Cookie 或密码。新凭据验证失败、账号不一致或修订冲突时保留旧凭据；更新成功也不修改来源本地服务。若本地服务仍保留，更新成功后只再次展示简短共用账号风险说明，不重复询问删除。

### 11.5 删除迁入、迁回和本地镜像

删除文件及其引用：

- `FlyCloudHelperMigrationApi.ets`
- `FlyCloudHelperMigrationService.ets`
- `FlyCloudHelperTransferApi.ets`
- `FlyCloudHelperTransferService.ets`
- `FlyCloudHelperCloudImportService.ets`
- `FlyCloudHelperCatalogApi.ets`
- `FlyCloudHelperCatalogRepository.ets`
- `FlyCloudHelperPlaybackService.ets`
- `FlyCloudHelperManagedServicePolicy.ets`
- `FlyCloudHelperManagedServiceResetService.ets`
- `FlyCloudHelperMigrationPage/`

`FlyCloudHelperLocalServiceManager.ets` 和 `FlyCloudHelperMediaActionGateway.ets` 在移除引用后进行检查：如果剩余职责只服务于托管媒体库，则整体删除；如果仍有协议服务管理职责，则拆出协议专用类后删除原文件。

### 11.6 清理本地状态字段

从 `ServerInfoData.ets` 及备份映射中删除：

- `flyCloudManaged`
- `flyCloudServiceId`
- `flyCloudLibraryId`
- `flyCloudMigrationId`
- `flyCloudMigrationRequestId`
- `flyCloudMigrationState`
- `flyCloudMigrationLocalCleanupCompleted`
- `flyCloudMigrationSnapshotPath`
- `flyCloudMigrationSnapshotSha256`
- `flyCloudMigrationSnapshotBytes`
- `flyCloudMigrationChunkBytes`
- `flyCloudCatalogVersion`
- `flyCloudTransferOutId`
- `flyCloudTransferOutState`

协议服务如果需要识别来源，只在 Emby、Jellyfin 或 Navidrome 服务配置中保存协议所需的云助手地址和路径，不再保存网盘服务或媒体库绑定状态。

### 11.7 页面入口调整

需要移除或替换入口的主要文件：

- `FlyCloudHelperSettingPage/index.ets`
- `FlyCloudHelperServiceDetailPage/index.ets`
- `WebdavVideoLibrarySettingPage.ets`
- `Servers.ets`
- 各网盘新增或编辑页面中对 `FlyCloudHelperMediaActionGateway` 的调用。

页面调整规则：

- 云助手管理的新增入口提供“上传本地网盘服务”，替代原“迁移到云助手”。
- 删除把云助手网盘服务还原为本地网盘服务的旧“添加到本机”、迁回本机和解除绑定操作。
- 上传成功不新增网盘服务卡片。
- 云助手服务详情使用服务与媒体库两层结构。
- 云助手服务详情的“快速创建媒体库”打开统一创建媒体库页面，并把当前服务自动加入关联服务区域。
- 媒体库协议账号继续提供“添加到本机”，且只创建用户所选账号对应的一张 Emby、Jellyfin 或 Navidrome 普通服务卡片。

### 11.8 客户端范围

本次只修改鸿蒙 APP，完成网盘服务上传、服务与媒体库管理、云助手凭据更新、协议开关和账号管理，以及单账号添加到本机。Android、macOS 和 Android TV 不修改，也不作为本次验收范围；后续接入时复用本方案确定的云助手接口和边界，不影响本次云助手接口设计。

---

## 12. 数据库升级方案

### 12.1 升级原则

数据库升级只转换云助手内部已有数据，不属于 APP 媒体库迁入功能。升级必须保留：

- 现有网盘服务和加密凭据。
- 现有媒体库 ID。
- 现有媒体条目、源文件和关联关系。
- 现有扫描任务历史。
- 现有 Jellyfin、Emby、Navidrome 路径后缀。
- 现有协议账号、播放进度、收藏和播放列表。

媒体库 ZIP 快照导出已从产品中移除，不属于升级后保留的功能；扫描任务配置快照仍随任务历史保留。

以上保留范围仅包含尚未删除的网盘服务及其媒体库。旧版 `cloud_services.deleted_at` 非空的服务视为用户已经删除，升级时不恢复为禁用来源，而是连同其专属数据彻底删除。

不保留：

- APP 设备绑定。
- 未完成和历史迁入任务。
- 未完成和历史迁回任务。
- 迁移分块文件记录。
- APP 目录增量变更记录。

### 12.2 转换顺序

Schema 55 升级在事务能力允许的范围内按以下顺序执行：

1. 为 `media_libraries` 增加名称、类型、配置修订、通知和最近扫描字段。
2. 校验旧版已软删除服务与专属媒体库的归属；若媒体库还有其他来源，停止升级。按任务、目录、来源关系、媒体库、服务的顺序，在事务中彻底删除该服务的历史数据。
3. 使用剩余服务的一对一关系，把 `cloud_services` 的媒体字段复制到对应媒体库。
4. 创建 `library_sources`，根据现有 `cloud_services.library_id` 和 `media_libraries.service_id` 为每组有效数据生成稳定来源 ID。
5. 创建 `library_scan_profiles`、`library_metadata_profiles` 和 `library_scan_schedules`，复制原服务级配置，并为扫描根目录补充来源 ID。
6. 为源文件、扫描根目录运行记录、NFO 缓存、音频标签和规格记录补充来源 ID；媒体条目改为仅归属于媒体库。
7. 创建媒体库级协议账号、会话、播放数据和播放列表表。
8. 通过原服务唯一对应的媒体库 ID 复制协议数据。
9. 校验每个剩余服务和媒体库恰好生成一条来源关联；发现异常时终止升级并记录服务 ID、媒体库 ID，不静默生成或合并数据。
10. 重建 `media_libraries`，删除 `service_id` 和冗余 Provider 字段。
11. 删除 `cloud_services.library_id` 及其他媒体库字段。
12. 删除旧服务级配置表和协议数据表。
13. 删除绑定、迁入、迁回和目录变更表。
14. 更新 `system_state.schema_version` 为 55。

SQLite、PostgreSQL 和 MySQL 对删除列、外键和重建表的支持不同。`schema.ts` 中需要按项目现有跨数据库方式创建目标表、复制数据、校验数量后替换，不能依赖只在某一种数据库可用的直接改列语法。

### 12.3 升级校验

升级函数在提交前检查：

- 有效服务数量与升级前未删除服务数量一致。
- 有效媒体库数量与升级前未删除服务对应的媒体库数量一致。
- 本次每个服务和媒体库都恰好存在一条 `library_sources` 记录。
- `library_sources.service_id` 和 `library_sources.library_id` 均无重复。
- 扫描和刮削配置修订都能找到对应记录。
- 每个源文件都能找到媒体库来源，且 Provider 资源唯一约束没有冲突。
- 每条协议账号和播放数据都能映射到媒体库。
- 协议路径后缀没有变化且仍保持唯一。
- 媒体条目、源文件和文件关联数量没有减少。

任何一项失败都终止升级，不更新 Schema 版本。

需要重点识别的历史异常包括：

- `cloud_services.library_id` 指向不存在的媒体库。当前该字段没有数据库外键约束，理论上可能形成悬空值。
- `cloud_services.library_id` 与 `media_libraries.service_id` 互相指向的对象不一致。
- 服务或媒体库一侧存在，另一侧已被旧代码、手工 SQL 或异常清理删除。
- `source_files`、协议账号、播放数据或扫描配置中的 `service_id`、`library_id` 与主关系不一致；其中部分历史表只保存普通字符串，没有外键约束。
- 旧版本升级中断、开发阶段手工修改数据库，或历史缺陷绕过事务后留下重复或孤立记录。

正常通过现有创建流程生成、且从未被手工修改的数据库通常不会出现这些情况。升级前仍进行检查，是因为本次要永久删除旧的双向归属字段；如果在关系不明确时自动猜测，会把扫描目录、协议账号或媒体条目迁到错误媒体库。发现异常时保留原数据库和 Schema 版本，通过日志列出具体服务 ID、媒体库 ID 和异常类型，修正数据后重新升级。

---

## 13. 删除行为

### 13.1 删除媒体库

删除媒体库前禁止存在运行中或等待中的该媒体库任务。删除范围包括：

- 媒体库配置和计划。
- 扫描、刮削和规格任务数据。
- 媒体条目、源文件、文件关联和缓存。
- 协议账号、会话和播放数据。

来源关联随媒体库删除，网盘服务本身不受影响，删除后可以再次用于快速创建新的媒体库。
删除时先清理已完成的扫描和规格任务，再删除来源关系；未结束的任务仍阻止删除。
媒体库设置页显示当前关联的网盘服务名称、类型和连接状态，并提供前往服务详情及取消关联的操作。本次只实现一个服务对应一个媒体库；取消该唯一关联等同于删除媒体库，必须明确告知扫描结果、任务配置和协议账号会一并删除。当前运行链路要求媒体库至少有一个来源，因此不保留无来源的空媒体库；未来支持多服务一库后，取消非最后一个来源可单独处理该来源的数据。

### 13.2 删除网盘服务

删除网盘服务前检查全部 `library_sources` 关联。如果服务被任一媒体库引用（包括停用或登录失效的来源），用户端和管理端的删除按钮均为不可用状态，提示先在媒体库中解除全部关联；后端返回 `409 service_in_use`，不自动停用或解除来源。删除媒体库也会解除其来源关联。创建媒体库、添加聚合来源和删除服务共用服务行锁，避免并发新增关联时误删服务。所有依赖解除后，仍需确认没有未结束的扫描或规格任务，确认删除只删除：

- 网盘服务基础信息。
- 全部凭据修订。
- APP 上传幂等记录。

网盘服务删除不级联删除媒体库，从数据库约束和 Repository 行为两层保证两种数据结构独立。

### 13.3 失败恢复与并发

| 场景 | 处理 |
| --- | --- |
| 上传响应丢失或同一请求重试 | 按请求键或来源唯一键返回已经创建的云助手服务，不重复创建 |
| Provider 凭据验证失败 | 不创建云助手服务，不修改本地服务，不显示删除询问 |
| 用户选择保留本地服务 | 两端独立运行，不创建同步任务，展示共用账号风险说明 |
| 本地服务删除失败 | 云助手服务与本地服务都保留，提示用户稍后手动删除 |
| 协议开关或账号操作失败 | 保留原协议和账号状态，不影响网盘服务与媒体库 |
| 协议账号添加到本机失败 | 保留云助手协议和账号，允许从同一账号重试 |
| 两台设备同时更新云助手凭据 | 后提交请求因 `expectedRevision` 冲突失败，刷新服务详情后重试 |
| 新凭据验证失败或登录成其他账号 | 旧凭据保持有效；账号不一致时提示新建网盘服务 |
| Provider 自动刷新失败 | 服务标记为需要重新授权，服务详情引导“更新登录凭据” |

---

## 14. 日志设计

实施期间增加以下统一日志关键字：

| 关键字 | 使用范围 |
| --- | --- |
| `codex-flycloud-service-upload` | APP 单向上传、幂等命中、连接校验和创建结果 |
| `codex-flycloud-local-delete-choice` | 上传成功后的保留或删除选择，以及精确删除结果 |
| `codex-flycloud-credential-manage` | 云助手凭据重新连接、更新登录和修订冲突 |
| `codex-flycloud-protocol-local-create` | 协议开关、账号管理和单账号添加到本机 |
| `codex-media-library-deleted-service-purge` | Schema 55 清理旧版软删除服务及归属校验、快照文件清理 |
| `codex-media-library-ownership-migration` | Schema 55 数据归属转换和数量校验 |
| `codex-media-library-service-delete` | 拦截删除仍被媒体库引用的网盘服务 |
| `codex-media-library-source-unlink` | 媒体库设置中取消最后一个服务关联的操作 |
| `codex-media-library-protocol` | 协议媒体库解析、账号归属和串库排查 |

日志变量 key 使用中文，例如：

```text
日志关键字、阶段、用户ID、服务ID、媒体库ID、网盘类型、请求ID、结果、错误码、错误信息
```

日志中禁止输出登录 Token、Cookie、密码、Provider 完整授权字段和协议密码。用户确认功能修好后，删除任务定位用的 `codex-*` 临时日志，并根据实际实施结果更新本文档；必要的常规业务日志改用项目正式关键字。

---

## 15. 实施阶段

### 阶段一：数据模型与 Repository

- [ ] 完成 Schema 55 升级函数。
- [ ] 拆分服务和媒体库 Repository。
- [ ] 完成媒体库级配置、计划和协议数据访问。
- [ ] 保持现有任务和目录数据可读。

阶段完成标准：现有一对一数据完成内部转换，服务表和媒体库表不再保存对方主键，所有现有关系均转换为唯一的媒体库来源记录。

### 阶段二：扫描、刮削与协议链路

- [ ] 调整任务创建、定时任务和 Worker 快照。
- [ ] 建立服务级 Provider 重任务锁。
- [ ] 调整 Jellyfin、Emby 和 Navidrome 的媒体库归属。
- [ ] 验证协议数据归属于媒体库，Provider 数据归属于媒体库来源。

阶段完成标准：一个未关联服务可以快速创建一个影视库或音乐库；扫描和协议通过来源记录访问 Provider，不依赖服务或媒体库主表中的相互外键。

### 阶段三：云助手 Web 页面

- [ ] 精简网盘服务列表和创建页。
- [ ] 服务详情只保留基础信息、凭据状态、重新登录，以及未关联时的快速创建媒体库入口。
- [ ] 扫描、刮削、任务和协议设置迁入媒体库页面。
- [ ] 删除绑定、迁入、迁回和 APP 中转相关页面内容。

阶段完成标准：仅通过 Web 即可完成“创建网盘服务 -> 创建媒体库 -> 扫描 -> 配置协议”的完整流程。

### 阶段四：鸿蒙 APP 单向上传与管理页面

- [ ] 新增本地网盘服务上传接口封装和页面。
- [ ] 上传成功后增加默认保留、可选精确删除本地服务和共用账号风险提示。
- [ ] 更新 APP 中的服务与媒体库管理模型。
- [ ] 补齐云助手网盘凭据的重新连接和更新登录流程。
- [ ] 补齐媒体库协议开关、账号管理和单账号一次性添加到本机。
- [ ] 删除本地托管卡片、绑定恢复、迁入和迁回流程。
- [ ] 删除直接读取云助手媒体目录和文件定位的链路。
- [ ] 保留并检查 Emby、Jellyfin、Navidrome 标准客户端链路。

阶段完成标准：APP 上传网盘后默认保留本地服务，用户可在明确提示后精确删除原服务；APP 可独立管理云助手凭据和媒体库协议账号，并能把所选的单个账号一次性创建为普通本地协议服务；APP 只能通过协议服务浏览和播放云助手媒体。

### 阶段五：删除旧模块与文档收口

- [ ] 删除云助手迁移 Worker、路由、表和配置。
- [ ] 删除 APP 迁移、迁回、目录镜像和托管字段。
- [ ] 更新 README、项目说明和接口文档。
- [ ] 搜索并清除“迁入”“迁回”“双向同步”“设备绑定”以及把云助手网盘服务还原成本地网盘服务的旧文案。
- [ ] 保留媒体库协议账号上的“添加到本机”，并确认其文案明确表示创建普通协议服务。
- [ ] 用户确认功能后删除本次临时诊断日志，并更新方案实施状态。

阶段完成标准：运行时代码不存在旧双向同步接口、设备绑定、快照迁移或直接媒体访问兼容分支。

---

## 16. 用户验收清单

按照项目规则不新增测试用例、不执行编译，由用户实施后自行验证以下场景。

### 16.1 网盘服务

- [ ] Web 创建网盘服务时不再选择媒体类型。
- [ ] APP 上传九类支持的本地网盘服务时只提交基础信息和凭据。
- [ ] 华为云空间没有上传入口。
- [ ] 同一个上传请求重试不会重复创建服务。
- [ ] 同一设备上的同一本地服务更换请求 ID 再次上传时返回原云助手服务。
- [ ] 再次上传同一本地服务不会覆盖云助手名称或凭据，凭据变化通过“更新登录凭据”处理。
- [ ] 其他设备上的相似账号不会仅按名称或账号自动合并。
- [ ] APP 上传后本地网盘服务和本地扫描结果保持不变。
- [ ] 上传成功后默认保留本地服务，并显示两端共用账号的登录失效、限流和风控说明。
- [ ] 选择删除时只删除原 `serverId` 对应服务；删除失败不回滚云助手服务。
- [ ] 使用当前凭据重新连接可以保存 Provider 自动刷新的凭据。
- [ ] 更新登录凭据可以完成 Provider 重新授权，修订冲突或账号不一致不会覆盖旧凭据。

### 16.2 服务与媒体库关系

- [ ] 网盘服务和媒体库主表均不保存对方 ID。
- [ ] 未关联服务可以快速创建一个媒体库。
- [ ] 已关联服务不允许创建第二个媒体库，并且不再展示快速创建入口。
- [ ] 删除媒体库后，原网盘服务仍然存在并可以重新创建媒体库。
- [ ] 已关联媒体库的网盘服务不能直接删除。
- [ ] 来源表和扫描根目录均保存稳定 `librarySourceId`。
- [ ] 数据结构放开媒体库侧唯一约束后能够容纳多个服务来源，无需再次修改服务和媒体库主表。

### 16.3 协议

- [ ] 影视库可以分别启用 Jellyfin 和 Emby。
- [ ] 音乐库可以启用 Navidrome。
- [ ] 音乐库不能启用 Jellyfin 或 Emby。
- [ ] 影视库不能启用 Navidrome。
- [ ] 协议账号、目录、播放进度和收藏只归属于媒体库，不归属于来源服务。
- [ ] 升级前已经配置的协议路径继续可用。
- [ ] 从一个协议中选择一个账号“添加到本机”时只创建一张对应的普通协议服务卡片。
- [ ] 添加到本机失败不修改云助手协议和账号，重试同一次请求不重复建卡。
- [ ] 用户结束一次建卡后再次主动添加同一协议账号时，允许创建另一张普通协议服务卡片。
- [ ] 本地卡片不保存云助手服务、媒体库或协议账号的持续绑定字段。
- [ ] 云助手关闭协议、修改或删除账号后，不主动修改、标记或删除本地卡片。
- [ ] 删除本地协议服务卡片不影响云助手媒体库和协议账号。

### 16.4 APP 边界

- [ ] 本次只修改和验收鸿蒙 APP，Android、macOS 和 Android TV 不发生代码变化。
- [ ] APP 不再出现迁入、迁回、绑定设备和把云助手网盘服务还原到本机的入口。
- [ ] APP 不再生成 `flyCloudManaged` 网盘服务卡片。
- [ ] APP 不再调用云助手目录增量和媒体文件访问接口。
- [ ] APP 仍可管理云助手服务、媒体库、任务和协议配置。
- [ ] APP 通过标准 Emby、Jellyfin、Navidrome 服务正常浏览和播放媒体。
- [ ] 没有来源本地网盘服务的设备也能更新云助手凭据、管理媒体库协议账号并添加普通协议服务。

### 16.5 升级数据

- [ ] 原有服务、媒体库、媒体条目和扫描任务仍存在。
- [ ] 原有扫描和刮削配置归属到原媒体库。
- [ ] 原有协议账号、播放进度、收藏和播放列表仍存在。
- [ ] 原有协议 URL 后缀未变化。
- [ ] 旧绑定、迁入、迁回和目录增量数据已删除。

---

## 17. 最终完成标准

满足以下全部条件后，本次架构调整完成：

1. 网盘服务表只保存基础信息、连接状态和登录凭据引用。
2. 媒体类型、扫描、刮削、定时任务、通知和协议均归属于媒体库。
3. 本次一个网盘服务与一个媒体库建立一对一来源关系，服务和媒体库主表完全解耦。
4. APP 只允许单向上传本地网盘服务的基础信息和登录凭据。
5. APP 不保存云助手媒体库镜像，不存在迁入、迁回和设备绑定。
6. APP 消费云助手媒体只经过 Emby、Jellyfin、Navidrome 等协议。
7. 现有云助手数据完成内部升级，现有协议地址保持可用。
8. `library_sources`、扫描根目录和源文件已经保留多服务一库所需的来源维度，后续扩展不需要重构主表。
9. 代码、页面、数据库和文档中不再存在旧双向同步运行链路。
10. 上传来源记录只用于幂等和审计，不形成设备绑定；上传成功后的本地删除由用户明确选择。
11. 协议账号“添加到本机”只执行一次性建卡，建卡完成后两端不再联动。
