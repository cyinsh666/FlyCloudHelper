import { Search, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { SecondaryButton } from "@/components/ConsoleShell";
import { FilterChip, Panel } from "@/components/ui-kit";
import type {
  AdminUser,
  MediaType,
  ProviderDescriptor,
  ServiceListFilters,
  ServiceStatus,
} from "@/lib/api";

const dataTypeLabels: Record<MediaType, string> = {
  video: "影视",
  music: "音乐",
  audiobook: "有声书",
};

const serviceStatusLabels: Record<ServiceStatus, string> = {
  active: "正常",
  scanning: "扫描中",
  disabled: "已停用",
  reauthorization_required: "需重新授权",
};

/** 展示一行可自动换行的平铺筛选项。 */
function ServiceFilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/** 管理端服务和媒体库列表共用的筛选面板。 */
export function AdminServiceFilters({
  value,
  users,
  providers,
  resultCount,
  onChange,
}: {
  value: ServiceListFilters;
  users: AdminUser[];
  providers: ProviderDescriptor[];
  resultCount: number;
  onChange: (next: ServiceListFilters) => void;
}) {
  const [searchText, setSearchText] = useState(value.search ?? "");

  useEffect(() => {
    setSearchText(value.search ?? "");
  }, [value.search]);

  /** 提交服务名称搜索，不在每次输入时重复请求列表。 */
  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onChange({ ...value, search: searchText.trim() || undefined });
  }

  /** 更新一个筛选字段，空值统一表示不限。 */
  function updateFilter(name: keyof ServiceListFilters, rawValue: string): void {
    onChange({ ...value, [name]: rawValue || undefined });
  }

  /** 清除全部筛选并同步清空搜索输入。 */
  function clearFilters(): void {
    setSearchText("");
    onChange({});
  }

  return (
    <Panel className="mb-4" title="筛选" action={<span className="text-xs text-muted-foreground">共 {resultCount.toLocaleString()} 项</span>}>
      <form onSubmit={submitSearch} className="grid gap-5">
        <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_auto]">
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-input bg-background/50 px-3 py-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input aria-label="搜索服务名称" placeholder="搜索服务名称" value={searchText} onChange={(event) => setSearchText(event.target.value)} className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          </div>
          <div className="flex gap-2">
            <SecondaryButton type="submit"><Search className="size-4" /> 查询</SecondaryButton>
            <SecondaryButton type="button" onClick={clearFilters}><X className="size-4" /> 清除</SecondaryButton>
          </div>
        </div>
        <div className="grid gap-4 rounded-xl border border-border bg-background/25 p-4">
          <ServiceFilterRow label="所属账户">
            <FilterChip active={!value.userId} onClick={() => updateFilter("userId", "")}>全部</FilterChip>
            {users.map((user) => <FilterChip key={user.userId} active={value.userId === user.userId} onClick={() => updateFilter("userId", user.userId)}>{user.username}</FilterChip>)}
          </ServiceFilterRow>
          <ServiceFilterRow label="网盘类型">
            <FilterChip active={!value.providerType} onClick={() => updateFilter("providerType", "")}>全部</FilterChip>
            {providers.map((provider) => <FilterChip key={provider.type} active={value.providerType === provider.type} onClick={() => updateFilter("providerType", provider.type)}>{provider.displayName}</FilterChip>)}
          </ServiceFilterRow>
          <ServiceFilterRow label="数据类型">
            <FilterChip active={!value.dataType} onClick={() => updateFilter("dataType", "")}>全部</FilterChip>
            {Object.entries(dataTypeLabels).map(([valueKey, label]) => <FilterChip key={valueKey} active={value.dataType === valueKey} onClick={() => updateFilter("dataType", valueKey)}>{label}</FilterChip>)}
          </ServiceFilterRow>
          <ServiceFilterRow label="服务状态">
            <FilterChip active={!value.status} onClick={() => updateFilter("status", "")}>全部</FilterChip>
            {Object.entries(serviceStatusLabels).map(([valueKey, label]) => <FilterChip key={valueKey} active={value.status === valueKey} onClick={() => updateFilter("status", valueKey)}>{label}</FilterChip>)}
          </ServiceFilterRow>
        </div>
      </form>
    </Panel>
  );
}
