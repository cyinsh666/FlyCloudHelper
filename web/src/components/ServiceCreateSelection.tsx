import { HardDrive } from "lucide-react";
import type { ReactNode } from "react";
import type { ProviderDescriptor } from "@/lib/api";

// 关键变量：Provider 图标直接复用 Flymby APP 的同名图标资源，未知类型使用通用磁盘图标。
const providerIconPaths: Record<string, string> = {
  webdav: "/provider-icons/webdav.png",
  aliyundrive: "/provider-icons/aliyundrive.png",
  baidupan: "/provider-icons/baidupan.png",
  guangya: "/provider-icons/guangya.png",
  cloud115: "/provider-icons/cloud115.png",
  cloud123: "/provider-icons/cloud123.png",
  cloud189: "/provider-icons/cloud189.png",
  cloud139: "/provider-icons/cloud139.png",
  quark: "/provider-icons/quark.png",
};

/** 展示普通平铺选择项，选中态只改变同宽边框和背景，不额外显示对号。 */
export function SelectableServiceOption({
  title,
  description,
  icon,
  selected,
  disabled = false,
  onSelect,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`flex min-h-16 w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
        selected
          ? "border-foreground/70 bg-secondary/70"
          : "border-border bg-background/40 hover:bg-secondary/45"
      } disabled:cursor-not-allowed disabled:opacity-45`}
    >
      <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-secondary/70">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

/** 返回 Provider 选择项的连接方式说明。 */
export function getProviderSelectionDescription(provider: ProviderDescriptor): string {
  if (provider.authenticationMode === "web_qr" || provider.authenticationMode === "authorization_session") {
    return provider.authMethods?.[0]?.displayName ?? "扫码登录";
  }
  return "填写连接信息";
}

/** 返回 Provider 对应的 Flymby 图标，未来新增类型没有资源时显示通用图标。 */
export function ProviderSelectionIcon({ providerType }: { providerType: string }) {
  const iconPath = providerIconPaths[providerType];
  return iconPath
    ? <img src={iconPath} alt="" className="size-10 rounded-lg object-contain" />
    : <HardDrive className="size-5 text-muted-foreground" />;
}
