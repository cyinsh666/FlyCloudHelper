/** 已接入网盘在凭据失效时可能返回的业务错误码。 */
const PROVIDER_AUTHENTICATION_ERROR_CODES = new Set([
  "provider_authentication_failed",
  "aliyundrive_refresh_expired",
  "baidupan_authentication_expired",
  "baidupan_refresh_expired",
  "cloud115_refresh_expired",
  "cloud123_authentication_expired",
  "cloud189_session_expired",
  "cloud189_session_invalid",
  "cloud189_refresh_expired",
  "cloud139_authentication_expired",
  "quark_authentication_expired",
]);

/** 判断任务失败是否需要进入网盘重新授权流程。 */
export function isProviderAuthenticationErrorCode(errorCode: string | null | undefined): boolean {
  return Boolean(errorCode && PROVIDER_AUTHENTICATION_ERROR_CODES.has(errorCode));
}
