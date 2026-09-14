import type { FlyCloudHelperDatabase } from "../database.js";
import type { ScanJobRecord } from "../domain.js";
import { ApiError } from "../errors.js";
import type { CredentialVault } from "../secrets.js";
import { parseCloud139Credential } from "../providers/cloud139-protocol.js";

/** 读取稳定账号；WebDAV 还要区分连接根，未知账号不能套用旧资源。 */
function accountIdentity(provider: string, connection: Record<string, unknown>): string {
  if (provider === "cloud139") return parseCloud139Credential(String(connection.authorization ?? "")).account;
  if (provider === "webdav") return JSON.stringify([connection.baseUrl, connection.username ?? ""]);
  return String(connection.userId || connection.accountId || connection.loginName || connection.account || connection.userName || "");
}

/** 用户重新授权后让旧音乐轮次采用同账号新凭据，扫描与元数据配置继续冻结。 */
export async function refreshMusicJobCredential(database: FlyCloudHelperDatabase, vault: CredentialVault, job: ScanJobRecord): Promise<void> {
  await database.query.transaction(async (transaction) => {
    const service = await transaction("cloud_services").where({ id: job.serviceId, user_id: job.userId }).whereNull("deleted_at").forUpdate().first();
    if (!service) throw new ApiError(404, "service_not_found", "音乐服务不存在");
    const revision = Number(service.credential_revision);
    if (revision === Number(job.snapshot.credentialRevision)) return;
    const [previous, next] = await Promise.all([
      transaction("service_credentials").where({ service_id: job.serviceId, revision: Number(job.snapshot.credentialRevision) }).first(),
      transaction("service_credentials").where({ service_id: job.serviceId, revision, status: "active" }).first(),
    ]);
    if (!previous || !next) throw new ApiError(410, "music_credential_unavailable", "原音乐任务凭据已不可用，请创建新扫描");
    const oldAccount = accountIdentity(String(service.provider_type), vault.decrypt(String(previous.encrypted_payload)));
    const newAccount = accountIdentity(String(service.provider_type), vault.decrypt(String(next.encrypted_payload)));
    if (!oldAccount || oldAccount !== newAccount) throw new ApiError(409, "music_scan_account_changed", "无法确认新凭据与原扫描属于同一账号，请创建新服务或新的扫描");
    const current = await transaction("scan_jobs").where({ id: job.id }).forUpdate().first();
    const snapshot = { ...JSON.parse(String(current.snapshot_json)) as Record<string, unknown>, credentialRevision: revision };
    await transaction("scan_jobs").where({ id: job.id }).update({ snapshot_json: JSON.stringify(snapshot), updated_at: new Date().toISOString() });
    job.snapshot = snapshot;
  });
}
