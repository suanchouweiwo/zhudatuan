import { useEffect, useRef, useState, type RefObject } from 'react';
export type CommerceSolutionId = 'jingxu' | 'oriental' | 'warm-workshop';
interface CommerceSolution {
  readonly id: CommerceSolutionId;
  readonly name: string;
  readonly english: string;
  readonly badge: string;
  readonly description: string;
  readonly fit: string;
  readonly dna: readonly string[];
  readonly path: string;
  readonly previewLabel: string;
}
export const commerceSolutions: readonly CommerceSolution[] = Object.freeze([
  {
    id: 'jingxu',
    name: '主打团 · 静序',
    english: '主打团 STILLFORM',
    badge: '核心方案 · 推荐',
    description: '为品牌型商城打造的克制、精准、现代零售工作室。',
    fit: '通用品牌、企业商城、长期经营',
    dna: Object.freeze(['暮色紫', '奶白画布', '完整经营闭环']),
    path: '/design-references/admin/first-design/index.html?screen=editor',
    previewLabel: '主打团静序原版方案',
  },
  {
    id: 'oriental',
    name: '主打团 · 东方策展',
    english: '主打团 ORIENTAL EDIT',
    badge: '精品方案',
    description: '以主理人视角组织内容、商品与会员关系的东方美学商城。',
    fit: '生活方式、精品零售、内容型品牌',
    dna: Object.freeze(['东方叙事', '画廊编排', '私域经营']),
    path: '/design-references/admin/kaidian/dist/index.html',
    previewLabel: '主打团东方策展原版方案',
  },
  {
    id: 'warm-workshop',
    name: '主打团 · 暖筑工坊',
    english: '主打团 WARM WORKSHOP',
    badge: '经典方案',
    description: '温暖、可靠、容易上手，让商户像搭积木一样完成店铺。',
    fit: '中小商户、快速建店、亲和型品牌',
    dna: Object.freeze(['暖米画布', '築橙焦点', '创作工坊']),
    path: '/demo/index.html',
    previewLabel: '主打团暖筑工坊原版方案',
  },
]);
const legacySolutionAliases: Readonly<Record<string, CommerceSolutionId>> = Object.freeze({
  studio: 'jingxu',
  editorial: 'oriental',
  classic: 'warm-workshop',
});
export function readCommerceSolution(value: string | null): CommerceSolutionId {
  if (value !== null && commerceSolutions.some((solution) => solution.id === value)) return value as CommerceSolutionId;
  if (value !== null && legacySolutionAliases[value] !== undefined) return legacySolutionAliases[value];
  return 'jingxu';
}
export function commerceSolutionName(id: CommerceSolutionId): string {
  return commerceSolutions.find((solution) => solution.id === id)?.name ?? '主打团 · 静序';
}
export function CommerceSolutionCenter({ open, selected, onSelect, onClose }: Readonly<{
  open: boolean;
  selected: CommerceSolutionId;
  onSelect: (solution: CommerceSolutionId) => void;
  onClose: () => void;
}>) {
  const [candidate, setCandidate] = useState<CommerceSolutionId>(selected);
  const [previewing, setPreviewing] = useState<CommerceSolutionId | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const radioRefs = useRef(new Map<CommerceSolutionId, HTMLInputElement>());
  const previewButtons = useRef(new Map<CommerceSolutionId, HTMLButtonElement>());
  const lastPreviewed = useRef<CommerceSolutionId | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const activeSolution = commerceSolutions.find((solution) => solution.id === previewing);
  const dismiss = previewing === null ? onClose : () => setPreviewing(null);

  useModalKeyboard(open, dismiss, dialogRef, () => radioRefs.current.get(candidate) ?? closeRef.current);

  useEffect(() => {
    if (!open) return;
    setCandidate(selected);
    setPreviewing(null);
    lastPreviewed.current = null;
  }, [open, selected]);

  useEffect(() => {
    if (!open) return;
    if (previewing !== null) {
      backRef.current?.focus();
      return;
    }
    const previewButton = lastPreviewed.current === null ? undefined : previewButtons.current.get(lastPreviewed.current);
    previewButton?.focus();
  }, [open, previewing]);

  if (!open) return null;

  const preview = (solution: CommerceSolutionId) => {
    lastPreviewed.current = solution;
    setPreviewing(solution);
  };
  const confirm = () => {
    onSelect(candidate);
    onClose();
  };

  return <div className="commerceoverlay commerce-solution-overlay">
    <button className="commercedialogbackdrop" type="button" onClick={dismiss}
      aria-label={previewing === null ? '取消并关闭主打团方案中心' : '返回主打团方案中心'} />
    <section ref={dialogRef} className={`commercesolutiondialog${activeSolution === undefined ? '' : ' is-studio'}`}
      role="dialog" aria-modal="true" aria-labelledby="commercesolutiontitle">
      {activeSolution === undefined
        ? <SolutionGalleryHeader closeRef={closeRef} onClose={onClose} />
        : <SolutionStudioHeader solution={activeSolution} backRef={backRef} onBack={() => setPreviewing(null)} onClose={onClose} />}

      {activeSolution === undefined
        ? <SolutionGallery selected={selected} candidate={candidate} onCandidate={setCandidate} onPreview={preview}
          radioRefs={radioRefs} previewButtons={previewButtons} />
        : <SolutionStudio key={activeSolution.id} solution={activeSolution} candidate={candidate === activeSolution.id}
          onCandidate={() => { setCandidate(activeSolution.id); setPreviewing(null); }} />}

      {activeSolution === undefined
        ? <footer className="commercesolutionfooter"><div><strong>当前预览：{commerceSolutionName(selected)}</strong>
          <span>{candidate === selected ? '尚未更改；关闭不会写入任何状态。' : `待确认：${commerceSolutionName(candidate)} · 仅更新本次预览网址。`}</span></div>
          <div className="commercesolutionfooteractions"><button type="button" onClick={onClose}>取消</button>
            <button className="is-primary" type="button" onClick={confirm}>确认预览</button></div></footer>
        : null}
    </section>
  </div>;
}

function SolutionGalleryHeader({ closeRef, onClose }: Readonly<{ closeRef: RefObject<HTMLButtonElement | null>; onClose: () => void }>) {
  return <header className="commercesolutionhead"><div><p>主打团 · SOLUTION CENTER</p><h2 id="commercesolutiontitle">建店方案中心</h2>
    <span>标准 VI 承载业务流程，三套原版工作室按需载入、彼此隔离。</span></div>
    <button ref={closeRef} type="button" onClick={onClose} aria-label="取消并关闭主打团方案中心">×</button></header>;
}

function SolutionStudioHeader({ solution, backRef, onBack, onClose }: Readonly<{
  solution: CommerceSolution;
  backRef: RefObject<HTMLButtonElement | null>;
  onBack: () => void;
  onClose: () => void;
}>) {
  const src = solutionUrl(solution);
  return <header className="commercestudiohead"><button ref={backRef} className="commercestudioback" type="button" onClick={onBack}>← 返回方案中心</button>
    <div><span>{solution.badge}</span><h2 id="commercesolutiontitle">{solution.name}</h2><p>{solution.description}</p></div>
    <div className="commercestudioactions">{src === null
      ? <span className="is-disabled">预览地址未配置</span>
      : <a href={src} target="_blank" rel="noreferrer">独立窗口打开</a>}
      <button type="button" onClick={onClose} aria-label="取消并关闭原版方案预览">×</button></div></header>;
}

function SolutionGallery({ selected, candidate, onCandidate, onPreview, radioRefs, previewButtons }: Readonly<{
  selected: CommerceSolutionId;
  candidate: CommerceSolutionId;
  onCandidate: (solution: CommerceSolutionId) => void;
  onPreview: (solution: CommerceSolutionId) => void;
  radioRefs: RefObject<Map<CommerceSolutionId, HTMLInputElement>>;
  previewButtons: RefObject<Map<CommerceSolutionId, HTMLButtonElement>>;
}>) {
  return <div className="commercesolutionbody"><section className="commercesolutionintro" role="note"><span aria-hidden="true">M</span><div>
    <strong>同一套业务底座，三种成熟建店方式</strong><p>卡片采用轻量识别封面；只有点击“查看完整方案”才载入该套原版代码。预览选择不会修改商城草稿或线上版本。</p>
  </div></section>
    <div className="commercesolutiongrid" role="radiogroup" aria-label="三套主打团方案">
      {commerceSolutions.map((solution, index) => <article key={solution.id}
        className={`commercesolutioncard is-${solution.id}${candidate === solution.id ? ' is-selected' : ''}${selected === solution.id ? ' is-current' : ''}`}>
        <label className="commercesolutionpreview"><input ref={(node) => updateRefMap(radioRefs.current, solution.id, node)}
          type="radio" name="commerce-solution" value={solution.id} checked={candidate === solution.id}
          onChange={() => onCandidate(solution.id)} aria-label={`设为预览方案：${solution.name}`} />
          <span className="commercesolutionordinal">0{index + 1}</span><span className="commercesolutionbadge">{solution.badge}</span>
          <SolutionCover solution={solution} />
          <span className="commercesolutionveil"><i aria-hidden="true">↗</i><b>点击选择 · 完整原版按需载入</b></span>
        </label>
        <div className="commercesolutioncopy"><small>{solution.english}</small><div><strong>{solution.name}</strong>
          {candidate === solution.id && candidate !== selected ? <em>候选预览</em> : null}
          {selected === solution.id ? <em>✓ 当前预览</em> : null}</div><p>{solution.description}</p><dl><dt>适合</dt><dd>{solution.fit}</dd></dl>
          <span className="commercesolutiondna">{solution.dna.map((item) => <i key={item}>{item}</i>)}</span></div>
        <div className="commercesolutionactions"><button ref={(node) => updateRefMap(previewButtons.current, solution.id, node)}
          type="button" onClick={() => onPreview(solution.id)}>查看完整方案</button>
          <button className="is-primary" type="button" disabled={candidate === solution.id} onClick={() => onCandidate(solution.id)}>
            {candidate === solution.id ? (selected === solution.id ? '当前预览' : '候选预览') : '设为预览方案'}</button></div>
      </article>)}
    </div>
    <section className="commercewriteboundary" role="note"><strong>安全切换边界</strong><p>当前只记录网址中的预览方案。正式应用必须建立新装修草稿、完成兼容性检查并通过发布流程，绝不覆盖线上版本。</p></section>
  </div>;
}

function SolutionCover({ solution }: Readonly<{ solution: CommerceSolution }>) {
  return <span className="commercesolutioncover" aria-hidden="true"><span className="commercesolutioncoverbrand">M</span>
    <small>{solution.english}</small><strong>{solution.name.replace('主打团 · ', '')}</strong><i />
    <span className="commercesolutioncovermeta"><b>{solution.dna[0]}</b><b>{solution.dna[1]}</b></span></span>;
}

function SolutionStudio({ solution, candidate, onCandidate }: Readonly<{
  solution: CommerceSolution;
  candidate: boolean;
  onCandidate: () => void;
}>) {
  const src = solutionUrl(solution);
  const [frameState, setFrameState] = useState<'loading' | 'ready' | 'slow'>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setFrameState('loading');
    if (src === null) return;
    const timeout = window.setTimeout(() => setFrameState((current) => current === 'loading' ? 'slow' : current), 8_000);
    return () => window.clearTimeout(timeout);
  }, [attempt, src]);

  if (src === null) return <div className="commercestudiobody is-unavailable"><section role="alert" className="commercestudioerror">
    <span aria-hidden="true">!</span><div><strong>原版预览地址尚未安全配置</strong>
      <p>生产环境必须设置独立的 <code>VITE_ZHUDIAN_SOLUTION_ORIGIN</code>，且不能与中控台同源。系统已拒绝不安全载入。</p></div></section>
    <StudioFooter solution={solution} candidate={candidate} onCandidate={onCandidate} /></div>;

  const status = frameState === 'ready' ? '原版方案已载入，可体验完整交互'
    : frameState === 'slow' ? '载入时间较长，可重试或在独立窗口打开' : '正在载入原版方案…';

  return <div className="commercestudiobody"><div className="commercestudiostatus" role="status" aria-live="polite">
    <span className={`is-${frameState}`} />{status}<b>原始代码未修改</b>
    {frameState === 'slow' ? <button type="button" onClick={() => setAttempt((value) => value + 1)}>重新载入</button> : null}</div>
    <div className="commercestudioframe"><iframe key={attempt} src={src} title={solution.previewLabel}
      onLoad={() => setFrameState('ready')} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer"
      {...(solution.id === 'oriental' ? { allow: 'clipboard-write' } : {})} /></div>
    <StudioFooter solution={solution} candidate={candidate} onCandidate={onCandidate} />
  </div>;
}

function StudioFooter({ solution, candidate, onCandidate }: Readonly<{
  solution: CommerceSolution;
  candidate: boolean;
  onCandidate: () => void;
}>) {
  return <footer className="commercestudiofooter"><div><strong>{solution.name}</strong>
    <span>完整预览与候选选择都不会写入商城；正式保存等待装修草稿与版本接口。</span></div>
    <button type="button" disabled={candidate} onClick={onCandidate}>{candidate ? '✓ 已选为候选预览' : '设为预览方案'}</button></footer>;
}

export function solutionUrl(solution: CommerceSolution): string | null {
  const environment: unknown = import.meta.env;
  const configuredValue = typeof environment === 'object' && environment !== null
    ? (environment as Readonly<Record<string, unknown>>)['VITE_ZHUDIAN_SOLUTION_ORIGIN'] : undefined;
  const configured = typeof configuredValue === 'string' ? configuredValue.trim() : undefined;
  const local = typeof window === 'undefined'
    || window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost';
  const base = configured !== undefined && configured !== ''
    ? configured
    : local ? `http://${typeof window === 'undefined' ? '127.0.0.1' : window.location.hostname}:4174` : null;
  if (base === null) return null;
  try {
    const url = new URL(solution.path, `${base.replace(/\/$/, '')}/`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (typeof window !== 'undefined' && url.origin === window.location.origin) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function updateRefMap<T>(map: Map<CommerceSolutionId, T>, id: CommerceSolutionId, node: T | null) {
  if (node === null) map.delete(id); else map.set(id, node);
}

function useModalKeyboard(open: boolean, onDismiss: () => void, dialogRef: RefObject<HTMLElement | null>, initialFocus: () => HTMLElement | null) {
  const dismissRef = useRef(onDismiss);
  const initialFocusRef = useRef(initialFocus);
  dismissRef.current = onDismiss;
  initialFocusRef.current = initialFocus;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => initialFocusRef.current()?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); dismissRef.current(); return; }
      if (event.key !== 'Tab') return;
      const candidates = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), iframe, [tabindex]:not([tabindex="-1"])',
      );
      if (candidates === undefined || candidates.length === 0) return;
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [dialogRef, open]);
}
