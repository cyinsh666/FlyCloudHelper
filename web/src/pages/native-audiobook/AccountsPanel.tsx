import { Copy, Monitor, Pencil, Plus, Trash2, X } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatusPill } from "@/components/ui-kit";
import { ProtocolPasswordInput } from "@/components/ProtocolPasswordInput";
import { deleteNativeAudiobookAccount, listNativeAudiobookAccounts, listNativeAudiobookDevices, nativeAudiobookAddress, revokeNativeAudiobookDevice, revokeNativeAudiobookDevices, saveNativeAudiobookAccount, type NativeAudiobookAccount, type NativeAudiobookAccountInput, type NativeAudiobookService } from "@/lib/native-audiobook-api";
import { copyNativeText, NativePager, NativeSkeleton, NativeToggle, useNativeCursor, useNativeResource } from "./components";

/** 当前库账号不提供选库步骤，编辑时保持已有授权范围。 */
function AccountEditor({ state }: { state: { service: NativeAudiobookService; account: NativeAudiobookAccount | null; admin: boolean; busy: boolean; onSave: (input: NativeAudiobookAccountInput) => Promise<void>; onCancel: () => void } }) {
  const [username, setUsername] = useState(state.account?.Username ?? "");
  const [password, setPassword] = useState("");
  const [noPassword, setNoPassword] = useState(state.account?.HasPassword === false);
  const [enabled, setEnabled] = useState(state.account?.Enabled ?? true);
  const [download, setDownload] = useState(state.account?.CanDownload ?? false);
  // 关键变量：新账号固定属于当前库，编辑账号不恢复已被撤销的库授权。
  const allowed = state.account?.AllowedLibraryIds.filter((id) => state.service.LibraryIds.includes(id)) ?? [...state.service.LibraryIds];
  /** 密码留空按创建或编辑语义省略，退出表单后明文不保留。 */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (state.busy || !noPassword && state.account?.HasPassword === false && !password) return;
    // 关键变量：已有免密码状态不重复重置哈希，取消免密码则必须提交新密码。
    const passwordPatch = noPassword ? state.account?.HasPassword === false ? {} : { Password: "" } : password ? { Password: password } : {};
    // 关键变量：创建默认采用用户名，编辑不提交显示名称，保留原账号记录。
    await state.onSave({ Username: username.trim(), ...passwordPatch, AllowedLibraryIds: allowed, Enabled: enabled, CanDownload: download });
  }
  return <form onSubmit={(event) => void submit(event)} className="mb-3 space-y-3 rounded-lg border border-border bg-secondary/20 p-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="min-w-0"><span className="text-xs text-muted-foreground">访问用户名</span><input className="mt-1.5 block w-full min-w-0 rounded-lg border border-input bg-background/50 px-3 py-2 text-sm disabled:opacity-50" required minLength={4} maxLength={255} disabled={state.busy} autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
      <div className="min-w-0"><span className="text-xs text-muted-foreground">{state.account ? "新密码" : "登录密码"}</span><ProtocolPasswordInput state={{ value: password, noPassword, disabled: state.busy, required: state.account?.HasPassword === false, placeholder: state.account ? "留空表示不修改" : "留空时自动生成密码", onChange: setPassword, onNoPasswordChange: setNoPassword }} /></div>
    </div>
    <div className="grid gap-2 sm:grid-cols-2"><NativeToggle state={{ label: "启用账号", checked: enabled, disabled: state.busy, onChange: setEnabled }} /><NativeToggle state={{ label: "允许下载", description: "仅影响该账号的单章下载", checked: download, disabled: state.busy, onChange: setDownload }} /></div>
    <div className="flex flex-wrap gap-2"><PrimaryButton type="submit" disabled={state.busy}>{state.busy ? "正在保存…" : state.account ? "保存账号" : "创建账号"}</PrimaryButton><SecondaryButton disabled={state.busy} onClick={state.onCancel}>取消</SecondaryButton></div>
  </form>;
}

/** 设备会话单独分页，撤销一个设备不会撤销其他设备。 */
function DevicesPanel({ state }: { state: { service: NativeAudiobookService; account: NativeAudiobookAccount; onClose: () => void } }) {
  const pager = useNativeCursor();
  const resource = useNativeResource(() => listNativeAudiobookDevices(state.service.ServiceId, state.account.AccountId, pager.cursor), [state.service.ServiceId, state.service.UpdatedAt, state.account.AccountId, pager.cursor]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);
  /** 撤销本次明确选择的设备，并刷新当前有界列表。 */
  async function revoke(id: string, name: string): Promise<void> {
    if (lock.current || !window.confirm(`撤销设备“${name}”的登录？该设备需要重新登录。`)) return;
    lock.current = true; setBusy(true); setMessage(null);
    try { await revokeNativeAudiobookDevice(state.service.ServiceId, state.account.AccountId, id); await resource.refresh(); setMessage("设备登录已撤销"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "撤销失败"); }
    finally { lock.current = false; setBusy(false); }
  }
  return <Panel title={`${state.account.Username} · 已登录设备`} className="mt-3 p-4 sm:p-4" action={<SecondaryButton disabled={busy} onClick={state.onClose}><X className="size-4" />关闭</SecondaryButton>}>
    {(message || resource.error) && <p role="status" className="mb-2 text-sm text-muted-foreground">{message || resource.error}</p>}{!resource.data && resource.loading && <NativeSkeleton />}
    <div className="space-y-2">{resource.data?.Items.map((device) => <article key={device.AuthSessionId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"><div className="min-w-0"><p className="truncate text-sm">{device.DeviceInfo.DeviceName}</p><p className="mt-1 text-[11px] text-muted-foreground">{device.DeviceInfo.Client} {device.DeviceInfo.Version} · 有效至 {new Date(device.ExpiresAt).toLocaleString("zh-CN")}</p></div><SecondaryButton disabled={busy || resource.loading} onClick={() => void revoke(device.AuthSessionId, device.DeviceInfo.DeviceName)}>撤销登录</SecondaryButton></article>)}</div>
    {resource.data?.Items.length === 0 && <p className="py-3 text-sm text-muted-foreground">当前页没有有效设备会话。</p>}<NativePager state={{ page: pager.page, loading: busy || resource.loading, hasNext: resource.data?.HasMore ?? false, onPrevious: pager.back, onNext: () => pager.next(resource.data?.NextCursor ?? null) }} />
  </Panel>;
}

/** 在当前媒体库中管理 FlyAudioBook 账号、凭据和设备。 */
export function NativeAccountsPanel({ state }: { state: { service: NativeAudiobookService; admin: boolean } }) {
  const pager = useNativeCursor();
  const resource = useNativeResource(() => listNativeAudiobookAccounts(state.service.ServiceId, pager.cursor), [state.service.ServiceId, pager.cursor, state.service.PermissionsRevision]);
  const [editing, setEditing] = useState<NativeAudiobookAccount | null | undefined>(undefined);
  const [devices, setDevices] = useState<NativeAudiobookAccount | null>(null);
  const [credential, setCredential] = useState<{ username: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 关键变量：密码只保留在本页面当前 state 中，切入口或关闭后即丢弃。
  const lock = useRef(false);

  /** 账号所有修改立即占用操作锁，统一展示服务端错误。 */
  async function perform(operation: () => Promise<void>, success: string): Promise<void> {
    if (lock.current) return; lock.current = true; setBusy(true); setMessage(null);
    try { await operation(); await resource.refresh(); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : "账号操作失败"); }
    finally { lock.current = false; setBusy(false); }
  }
  /** 新建密码只显示一次，编辑密码留空不提交。 */
  async function save(input: NativeAudiobookAccountInput): Promise<void> {
    if (editing?.Enabled && !input.Enabled && !window.confirm("停用账号会撤销其设备登录，继续？")) return;
    await perform(async () => {
      const created = await saveNativeAudiobookAccount(state.service.ServiceId, editing?.AccountId ?? null, input);
      if (!editing && created.Password) setCredential({ username: created.Account.Username, password: created.Password });
      else if (input.Password !== undefined) setCredential(null);
      setDevices(null);
      setEditing(undefined);
    }, editing ? "账号已保存" : input.Password === "" ? "免密码账号已创建" : "账号已创建，请保存密码");
  }
  /** 启停时说明现有设备登录会受到影响。 */
  async function toggle(account: NativeAudiobookAccount): Promise<void> {
    if (account.Enabled && !window.confirm(`停用“${account.Username}”并撤销其登录？`)) return;
    await perform(async () => { await saveNativeAudiobookAccount(state.service.ServiceId, account.AccountId, { Enabled: !account.Enabled }); setDevices(null); }, account.Enabled ? "账号已停用" : "账号已启用");
  }
  /** 删除仅清理当前入口账号的原生记录。 */
  async function remove(account: NativeAudiobookAccount): Promise<void> {
    if (!window.confirm(`删除“${account.Username}”及其原生收听记录、收藏和书签？此操作不会删除媒体库。`)) return;
    await perform(async () => { await deleteNativeAudiobookAccount(state.service.ServiceId, account.AccountId); if (devices?.AccountId === account.AccountId) setDevices(null); if (editing?.AccountId === account.AccountId) setEditing(undefined); setCredential(null); }, "账号已删除");
  }
  /** 撤销全部登录后保留收藏和续听资料。 */
  async function revoke(account: NativeAudiobookAccount): Promise<void> {
    if (!window.confirm(`撤销“${account.Username}”的全部设备登录？收听记录会保留。`)) return;
    await perform(async () => { await revokeNativeAudiobookDevices(state.service.ServiceId, account.AccountId); setDevices(null); }, "全部设备登录已撤销");
  }
  /** 只在用户明确复制时读取当前内存凭据。 */
  async function copy(): Promise<void> {
    if (!credential) return;
    try { await copyNativeText(`服务地址：${nativeAudiobookAddress(state.service)}\n用户名：${credential.username}\n密码：${credential.password}`); setMessage("账号信息已复制"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "复制失败"); }
  }

  return <><Panel title="FlyAudioBook 访问账号" description="账号属于当前媒体库，同一账号的设备之间共享续听。" className="mt-4" action={<SecondaryButton disabled={busy || state.service.Deleting} onClick={() => setEditing(null)}><Plus className="size-4" />添加账号</SecondaryButton>}>
    {(message || resource.error) && <p role="status" className="mb-3 text-sm text-muted-foreground">{message || resource.error}</p>}
    {credential && <div className="mb-3 rounded-lg border border-border bg-secondary/35 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm">请保存本次生成的密码，关闭后无法再次查看。</p><button type="button" aria-label="关闭密码展示" onClick={() => setCredential(null)}><X className="size-4" /></button></div><p className="mt-2 break-all font-mono text-sm">{credential.username} · {credential.password}</p><div className="mt-2"><SecondaryButton onClick={() => void copy()}><Copy className="size-4" />复制账号信息</SecondaryButton></div></div>}
    {editing !== undefined && <AccountEditor key={`${editing?.AccountId ?? "new"}:${state.service.PermissionsRevision}`} state={{ service: state.service, account: editing, admin: state.admin, busy, onSave: save, onCancel: () => setEditing(undefined) }} />}
    {!resource.data && resource.loading && <NativeSkeleton />}
    <div className="space-y-2">{resource.data?.Items.map((account) => <article key={account.AccountId} className="rounded-lg border border-border bg-secondary/35 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-medium">{account.Username}</p><StatusPill tone={account.Enabled ? "success" : "neutral"}>{account.Enabled ? "已启用" : "已停用"}</StatusPill></div>
          <p className="mt-1 text-[11px] text-muted-foreground">{account.HasPassword === false ? "免密码" : "需要密码"} · {account.CanDownload ? "允许下载" : "禁止下载"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SecondaryButton disabled={busy} onClick={() => setEditing(account)}><Pencil className="size-4" />编辑</SecondaryButton>
          <SecondaryButton disabled={busy} onClick={() => setDevices(account)}><Monitor className="size-4" />设备</SecondaryButton>
          <SecondaryButton disabled={busy} onClick={() => void revoke(account)}>撤销会话</SecondaryButton>
          <SecondaryButton disabled={busy} onClick={() => void toggle(account)}>{account.Enabled ? "停用" : "启用"}</SecondaryButton>
          <button type="button" disabled={busy} onClick={() => void remove(account)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-40"><Trash2 className="size-3.5" />删除</button>
        </div>
      </div>
    </article>)}</div>
    {resource.data?.Items.length === 0 && <p className="py-3 text-sm text-muted-foreground">当前页没有账号，可在右上方添加。</p>}<NativePager state={{ page: pager.page, loading: busy || resource.loading, hasNext: resource.data?.HasMore ?? false, onPrevious: pager.back, onNext: () => pager.next(resource.data?.NextCursor ?? null) }} /><p className="mt-3 text-[11px] text-muted-foreground">已有密码无法查看，可以编辑账号重设；修改密码会撤销原有登录。</p>
  </Panel>{devices && <DevicesPanel key={devices.AccountId} state={{ service: state.service, account: devices, onClose: () => setDevices(null) }} />}</>;
}
