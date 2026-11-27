import type { UserProfile } from '../types';

export function MemberProfileDetails({ user }: { user: UserProfile }) {
  const details = [
    ['会员名称', user.name],
    ['会员身份码', user.identityCode],
    ['登录手机号', user.accountSettingsPhone ?? user.phone],
    ['手机号验证', user.phoneVerified ? '已验证' : '待验证'],
    ['所属企业', user.enterpriseName],
    ['所属部门', user.department],
  ];

  return (
    <dl aria-label="当前会员资料" className="divide-y divide-slate-100 rounded-xl border border-slate-200 px-3 text-xs">
      {details.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 py-2.5">
          <dt className="font-semibold text-slate-600">{label}</dt>
          <dd className="break-words text-slate-900">{value || '暂未显示'}</dd>
        </div>
      ))}
    </dl>
  );
}
