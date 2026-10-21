/** 协议账号密码框右侧统一提供免密码选择，勾选不会误提交输入框中的旧值。 */
export function ProtocolPasswordInput({ state }: { state: {
  value: string; noPassword: boolean; disabled?: boolean; required?: boolean; placeholder?: string; label?: string;
  onChange: (value: string) => void; onNoPasswordChange: (value: boolean) => void;
} }) {
  return <div className="mt-1.5 flex min-w-0 items-center gap-3">
    <input type="password" aria-label={state.label ?? "登录密码"} autoComplete="new-password" value={state.value} required={!state.noPassword && state.required} disabled={state.disabled || state.noPassword} placeholder={state.noPassword ? "无需密码登录" : state.placeholder} onChange={(event) => state.onChange(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-input bg-background/50 px-3 py-2 text-sm disabled:opacity-50" />
    <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"><input type="checkbox" checked={state.noPassword} disabled={state.disabled} onChange={(event) => state.onNoPasswordChange(event.target.checked)} className="size-4 accent-foreground" />无密码</label>
  </div>;
}
