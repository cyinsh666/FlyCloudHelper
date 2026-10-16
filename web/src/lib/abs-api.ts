import { requestJson } from "@/lib/api";

/** ABS 协议账号公开字段；列表接口不返回已有密码。 */
export interface AbsAccount {
  id: string;
  username: string;
  hasPassword: boolean;
  canDownload: boolean;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

/** 当前有声书库独立的 ABS 共享配置。 */
export interface AbsSettings {
  enabled: boolean;
  pathSuffix: string;
  path: string;
  url: string | null;
  relayPlaybackEnabled: boolean;
  accounts: AbsAccount[];
}

export interface AbsSettingsPatch {
  enabled?: boolean;
  pathSuffix?: string;
  relayPlaybackEnabled?: boolean;
}

export interface AbsAccountPatch {
  username?: string;
  password?: string;
  status?: "active" | "disabled";
  canDownload?: boolean;
}

/** 按控制台权限选择当前媒体库的协议管理路径。 */
function absSettingsPath(libraryId: string, admin: boolean): string {
  return `${admin ? "/api/v1/admin" : "/api/v1"}/libraries/${encodeURIComponent(libraryId)}/abs-settings`;
}

/** 读取 ABS 设置，不创建协议账号。 */
export async function getAbsSettings(libraryId: string, admin = false): Promise<AbsSettings> {
  const result = await requestJson<{ settings: AbsSettings }>(absSettingsPath(libraryId, admin));
  return result.settings;
}

/** 只修改明确提交的协议开关、后缀或中转方式。 */
export async function updateAbsSettings(
  libraryId: string,
  patch: AbsSettingsPatch,
  admin = false,
): Promise<AbsSettings> {
  const result = await requestJson<{ settings: AbsSettings }>(absSettingsPath(libraryId, admin), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return result.settings;
}

/** 新建独立 ABS 账号；省略密码时服务端生成并在本次响应中返回。 */
export function createAbsAccount(
  libraryId: string,
  input: { username: string; password?: string; canDownload?: boolean },
  admin = false,
): Promise<{ account: AbsAccount; password: string }> {
  return requestJson(`${absSettingsPath(libraryId, admin)}/accounts`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 更新账号，未提交 password 时保留原密码。 */
export async function updateAbsAccount(
  libraryId: string,
  accountId: string,
  patch: AbsAccountPatch,
  admin = false,
): Promise<AbsAccount> {
  const result = await requestJson<{ account: AbsAccount }>(
    `${absSettingsPath(libraryId, admin)}/accounts/${encodeURIComponent(accountId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
  return result.account;
}

/** 删除当前媒体库的独立 ABS 账号。 */
export async function deleteAbsAccount(libraryId: string, accountId: string, admin = false): Promise<void> {
  await requestJson(`${absSettingsPath(libraryId, admin)}/accounts/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
  });
}

/** 撤销账号已登录会话，不删除其收听数据。 */
export async function revokeAbsSessions(libraryId: string, accountId: string, admin = false): Promise<void> {
  await requestJson(
    `${absSettingsPath(libraryId, admin)}/accounts/${encodeURIComponent(accountId)}/revoke-sessions`,
    {
      method: "POST",
      body: "{}",
    },
  );
}

/** 公开地址未配置时使用浏览器当前可达入口拼接协议相对路径。 */
export function resolveAbsAddress(settings: AbsSettings): string {
  return settings.url?.trim() || (settings.path ? `${window.location.origin}${settings.path}` : "");
}
