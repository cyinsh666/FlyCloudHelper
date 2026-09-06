/** 115扫码登录来源以及换取Cookie时使用的客户端参数。 */
export interface Cloud115ClientType {
  value: string;
  label: string;
  requestApp: string;
  userAgent: string;
  recommended: boolean;
  cookieQr: boolean;
}

/**
 * 115登录来源与 Flymby APP 当前列表保持一致，并保留原有官方OpenAPI入口。
 * iPad端沿用现有推荐项，官方OpenAPI不需要先取得客户端Cookie。
 */
export const CLOUD115_CLIENT_TYPES: Cloud115ClientType[] = [
  { value: "ipad", label: "115生活 iPad端", requestApp: "ios", userAgent: "UPad/1.0.0", recommended: true, cookieQr: true },
  { value: "harmony", label: "115鸿蒙端", requestApp: "harmony", userAgent: "", recommended: false, cookieQr: true },
  { value: "android", label: "115生活 Android端", requestApp: "android", userAgent: "", recommended: false, cookieQr: true },
  { value: "115android", label: "115 Android端", requestApp: "115android", userAgent: "", recommended: false, cookieQr: true },
  { value: "web", label: "网页版", requestApp: "web", userAgent: "", recommended: false, cookieQr: true },
  { value: "ios", label: "115生活 iOS端", requestApp: "ios", userAgent: "UPhone/1.0.0", recommended: false, cookieQr: true },
  { value: "115ios", label: "115 iOS端", requestApp: "115ios", userAgent: "", recommended: false, cookieQr: true },
  { value: "115ipad", label: "115 iPad端", requestApp: "115ipad", userAgent: "", recommended: false, cookieQr: true },
  { value: "linux", label: "Linux端", requestApp: "os_linux", userAgent: "", recommended: false, cookieQr: true },
  { value: "mac", label: "macOS端", requestApp: "os_mac", userAgent: "", recommended: false, cookieQr: true },
  { value: "tv", label: "115网盘 Android电视端", requestApp: "tv", userAgent: "", recommended: false, cookieQr: true },
  { value: "apple_tv", label: "115网盘 Apple TV端", requestApp: "apple_tv", userAgent: "", recommended: false, cookieQr: true },
  { value: "qandroid", label: "115管理 Android端", requestApp: "qandroid", userAgent: "", recommended: false, cookieQr: true },
  { value: "qios", label: "115管理 iOS端", requestApp: "ios", userAgent: "OfficePhone/1.0.0", recommended: false, cookieQr: true },
  { value: "qipad", label: "115管理 iPad端", requestApp: "ios", userAgent: "OfficePad/1.0.0", recommended: false, cookieQr: true },
  { value: "alipaymini", label: "115生活支付宝小程序", requestApp: "alipaymini", userAgent: "", recommended: false, cookieQr: true },
  { value: "wechatmini", label: "115生活微信小程序", requestApp: "wechatmini", userAgent: "", recommended: false, cookieQr: true },
  { value: "openapi", label: "官方 OpenAPI", requestApp: "", userAgent: "", recommended: false, cookieQr: false },
];

/** 按页面提交值读取受支持的115登录来源。 */
export function findCloud115ClientType(value: unknown): Cloud115ClientType | null {
  const clientType = typeof value === "string" ? value.trim() : "";
  return CLOUD115_CLIENT_TYPES.find((item) => item.value === clientType) ?? null;
}
