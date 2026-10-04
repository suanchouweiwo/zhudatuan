import morviaMarkWhite from '../../../../../../05_docs_ziliao/VI_shijue/current/ZHU-VI-1.5/assets/svg/morvia-mark-white.svg';
import type { ControlPlane } from './ControlSchema';

export function ControlHero({ plane, refreshing, onRefresh }: Readonly<{
  plane: ControlPlane | undefined;
  refreshing: boolean;
  onRefresh: () => void;
}>) {
  return (
    <section className="controlhero" aria-labelledby="controltitle">
      <div>
        <p>主打团 OPERATIONS CONTROL PLANE</p>
        <h1 id="controltitle">主打团 中控台</h1>
        <strong>{plane?.conclusion ?? '平台态势等待读模型返回，未知状态不会显示为正常。'}</strong>
        <span>{plane?.summary ?? '当前没有可验证的能力覆盖信息。'}</span>
      </div>
      <img className="controlwing" src={morviaMarkWhite} alt="" width="160" height="100" />
      <button type="button" onClick={onRefresh} disabled={refreshing}>
        <RefreshIcon />{refreshing ? '刷新中' : '刷新态势'}
      </button>
    </section>
  );
}

function RefreshIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>;
}

