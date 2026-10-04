import { Button } from '@shop/design';
import { useState, type FormEvent } from 'react';
import type { ConsoleScope } from '../../entity/session/ConsoleSession';
import type { MallCreateDraft } from './MallCreateCommand';
import './MallCreateJourney.css';

const steps = [
  { label: '商城信息', detail: '名称与自动 H5 域名' },
  { label: '主体资料', detail: '公司与联系人' },
  { label: '经营资料', detail: '类目与店铺类型' },
  { label: '域名品牌', detail: '域名与视觉资产' },
  { label: '微信生态', detail: '小程序与公众号' },
  { label: '支付履约', detail: '收款、物流与售后' },
  { label: '核对开店', detail: '确认创建空商城' },
] as const;

export interface MallOpeningDraft extends MallCreateDraft {
  readonly subjectType: string;
  readonly companyName: string;
  readonly creditCode: string;
  readonly legalRepresentative: string;
  readonly contactName: string;
  readonly contactMobile: string;
  readonly licenseFile: string;
  readonly storeType: string;
  readonly primaryCategory: string;
  readonly businessMode: string;
  readonly brandName: string;
  readonly businessRegion: string;
  readonly businessAddress: string;
  readonly servicePhone: string;
  readonly domainMode: string;
  readonly customDomain: string;
  readonly certificateMode: string;
  readonly brandLogoFile: string;
  readonly faviconFile: string;
  readonly miniProgramMode: string;
  readonly miniProgramAppId: string;
  readonly miniProgramOriginalId: string;
  readonly officialAccountMode: string;
  readonly officialAccountAppId: string;
  readonly videoChannelId: string;
  readonly paymentPlan: string;
  readonly wechatMerchantId: string;
  readonly deliveryMode: string;
  readonly warehouseRegion: string;
  readonly returnContact: string;
  readonly returnAddress: string;
  readonly invoiceMode: string;
  readonly notificationContact: string;
}

export function initialMallOpeningDraft(enterpriseId: string): MallOpeningDraft {
  return {
    enterpriseId,
    name: '',
    code: '',
    publicSlug: 'auto-h5',
    subjectType: 'enterprise',
    companyName: '',
    creditCode: '',
    legalRepresentative: '',
    contactName: '',
    contactMobile: '',
    licenseFile: '',
    storeType: 'general',
    primaryCategory: '',
    businessMode: 'self-operated',
    brandName: '',
    businessRegion: '',
    businessAddress: '',
    servicePhone: '',
    domainMode: 'platform',
    customDomain: '',
    certificateMode: 'managed',
    brandLogoFile: '',
    faviconFile: '',
    miniProgramMode: 'later',
    miniProgramAppId: '',
    miniProgramOriginalId: '',
    officialAccountMode: 'later',
    officialAccountAppId: '',
    videoChannelId: '',
    paymentPlan: 'later',
    wechatMerchantId: '',
    deliveryMode: 'express',
    warehouseRegion: '',
    returnContact: '',
    returnAddress: '',
    invoiceMode: 'later',
    notificationContact: '',
  };
}

export function mallCoreDraft(draft: MallOpeningDraft): MallCreateDraft {
  return {
    enterpriseId: draft.enterpriseId,
    name: draft.name,
    code: draft.code,
    publicSlug: draft.publicSlug,
  };
}

export function MallCreateJourney({
  draft,
  enterprises,
  available,
  busy,
  valid,
  error,
  onChange,
  onSubmit,
  onClose,
}: Readonly<{
  draft: MallOpeningDraft;
  enterprises: readonly ConsoleScope[];
  available: boolean;
  busy: boolean;
  valid: boolean;
  error: string | undefined;
  onChange: (field: keyof MallOpeningDraft, value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}>) {
  const [step, setJourneyStep] = useState(0);
  const setStep = (next: number) => setJourneyStep(Math.max(0, Math.min(steps.length - 1, next)));
  const finalStep = step === steps.length - 1;
  const currentStep = steps[step] ?? steps[0];

  return <form className="command mallcreatewizard" onSubmit={(event) => submitJourney(event, finalStep, valid, onSubmit)}>
    <div className="mallcreateboundary" role="note">
      <span>前端建店蓝图</span>
      <p>商城核心仍只提交基础四项；主体、域名、渠道与履约资料本轮可填写预览，暂不写入后台。</p>
      <b>7 步 · 约 42 项</b>
    </div>
    <div className="mallcreateworkspace">
      <aside className="mallcreatesteps" aria-label="开店流程">
        <p>开店进度 <strong>{step + 1}/7</strong></p>
        <ol>
          {steps.map((candidate, index) => <li key={candidate.label} data-state={stepState(index, step)}>
            <button type="button" onClick={() => setStep(index)} aria-current={index === step ? 'step' : undefined}>
              <span>{index < step ? '✓' : index + 1}</span>
              <div><strong>{candidate.label}</strong><small>{candidate.detail}</small></div>
            </button>
          </li>)}
        </ol>
        <div className="mallcreatedraftnote"><i />草稿仅保留在当前页面</div>
      </aside>
      <section className="mallcreatestage" aria-labelledby="mallcreatestagetitle">
        <header>
          <div><small>STEP {String(step + 1).padStart(2, '0')}</small><h3 id="mallcreatestagetitle">{currentStep.label}</h3></div>
          <span>{currentStep.detail}</span>
        </header>
        {!available ? <p className="notice" role="status">当前范围没有下级商城创建能力。</p> : null}
        {enterprises.length === 0 ? <p className="notice" role="status">当前没有可用于建店的上级范围。</p> : null}
        <JourneyStep step={step} draft={draft} enterprises={enterprises} busy={busy} onChange={onChange} />
        {error === undefined ? null : <p className="notice" role="alert">{error}</p>}
      </section>
    </div>
    <footer className="mallcreatefooter">
      <div><strong>{currentStep.label}</strong><span>{finalStep ? '确认后创建商城核心草稿' : '可随时返回修改，未接入后台的资料不会保存'}</span></div>
      <nav>
        <Button onPress={onClose} isDisabled={busy}>取消</Button>
        {step > 0 ? <Button onPress={() => setStep(step - 1)} isDisabled={busy}>上一步</Button> : null}
        {finalStep
          ? <Button type="submit" tone="primary" isDisabled={!available || !valid || busy}>
              {busy ? '创建中' : '确认创建'}
            </Button>
          : <Button tone="primary" onPress={() => setStep(step + 1)} isDisabled={busy || (step === 0 && !valid)}>
              下一步
            </Button>}
      </nav>
    </footer>
  </form>;
}

function JourneyStep({ step, draft, enterprises, busy, onChange }: Readonly<{
  step: number;
  draft: MallOpeningDraft;
  enterprises: readonly ConsoleScope[];
  busy: boolean;
  onChange: (field: keyof MallOpeningDraft, value: string) => void;
}>) {
  if (step === 0) return <BasicStep draft={draft} enterprises={enterprises} busy={busy} onChange={onChange} />;
  if (step === 1) return <SubjectStep draft={draft} busy={busy} onChange={onChange} />;
  if (step === 2) return <BusinessStep draft={draft} busy={busy} onChange={onChange} />;
  if (step === 3) return <DomainStep draft={draft} busy={busy} onChange={onChange} />;
  if (step === 4) return <WechatStep draft={draft} busy={busy} onChange={onChange} />;
  if (step === 5) return <FulfillmentStep draft={draft} busy={busy} onChange={onChange} />;
  return <ReviewStep draft={draft} />;
}

type StepProps = Readonly<{
  draft: MallOpeningDraft;
  busy: boolean;
  onChange: (field: keyof MallOpeningDraft, value: string) => void;
}>;

function BasicStep({ draft, enterprises, busy, onChange }: StepProps & Readonly<{ enterprises: readonly ConsoleScope[] }>) {
  return <div className="mallcreatefields">
    <p className="mallcreatesectionintro">先建立唯一商城身份；H5 地址由系统创建时分配，以创建任务返回的实际入口为准。</p>
    <div className="fieldgrid">
      <label>所属上级
        <select aria-label="所属上级" value={draft.enterpriseId} disabled={busy} required onChange={(event) => onChange('enterpriseId', event.target.value)}>
          <option value="">请选择上级</option>
          {enterprises.map((enterprise) => <option key={enterprise.id} value={enterprise.id}>{enterprise.name ?? enterprise.id}</option>)}
        </select>
      </label>
      <label>商城名称
        <input aria-label="商城名称" value={draft.name} maxLength={120} disabled={busy} required placeholder="例如：甄选商城" onChange={(event) => onChange('name', event.target.value)} />
      </label>
      <label>商城代码
        <input aria-label="商城代码" value={draft.code} maxLength={32} disabled={busy} required placeholder="例如：ZHENXUAN" onChange={(event) => onChange('code', event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} />
        <small className="muted">3～32 位，以字母开头，只使用大写字母、数字和下划线。</small>
      </label>
      <div className="mallcreateaddresspreview"><small>自动 H5 地址</small><strong>创建时分配</strong><span>创建完成后查看实际入口</span></div>
    </div>
  </div>;
}

function SubjectStep({ draft, busy, onChange }: StepProps) {
  return <div className="mallcreatefields">
    <p className="mallcreatesectionintro">参考成熟 SaaS 的主体认证结构，先收集企业、法人和日常联系人资料。</p>
    <div className="fieldgrid">
      <SelectField label="经营主体类型" field="subjectType" value={draft.subjectType} busy={busy} onChange={onChange} options={[['enterprise', '企业'], ['individual', '个体工商户'], ['organization', '其他组织'], ['personal', '个人']]} />
      <TextField label="企业／主体名称" field="companyName" value={draft.companyName} busy={busy} onChange={onChange} placeholder="营业执照上的完整名称" />
      <TextField label="统一社会信用代码" field="creditCode" value={draft.creditCode} busy={busy} onChange={onChange} placeholder="18 位统一社会信用代码" />
      <TextField label="法定代表人" field="legalRepresentative" value={draft.legalRepresentative} busy={busy} onChange={onChange} placeholder="证件上的姓名" />
      <TextField label="业务联系人" field="contactName" value={draft.contactName} busy={busy} onChange={onChange} placeholder="负责开店配置的联系人" />
      <TextField label="联系人手机" field="contactMobile" value={draft.contactMobile} busy={busy} onChange={onChange} placeholder="用于接收审核结果" inputMode="tel" />
    </div>
    <UploadField label="营业执照" field="licenseFile" value={draft.licenseFile} busy={busy} onChange={onChange} hint="支持 JPG、PNG 或 PDF；本轮仅显示文件名，不上传。" />
  </div>;
}

function BusinessStep({ draft, busy, onChange }: StepProps) {
  return <div className="mallcreatefields">
    <p className="mallcreatesectionintro">经营资料决定后续类目资质、页面模板和默认履约方案。</p>
    <div className="fieldgrid">
      <SelectField label="店铺类型" field="storeType" value={draft.storeType} busy={busy} onChange={onChange} options={[['general', '综合商城'], ['flagship', '品牌旗舰店'], ['specialty', '品牌专卖店'], ['franchise', '类目专营店']]} />
      <SelectField label="主营类目" field="primaryCategory" value={draft.primaryCategory} busy={busy} onChange={onChange} options={[['', '请选择主营类目'], ['food', '食品饮料'], ['home', '家居日用'], ['beauty', '美妆个护'], ['apparel', '服饰箱包'], ['digital', '数码家电'], ['service', '本地生活／服务']]} />
      <SelectField label="经营模式" field="businessMode" value={draft.businessMode} busy={busy} onChange={onChange} options={[['self-operated', '商家自营'], ['platform', '平台联营'], ['mixed', '自营 + 联营']]} />
      <TextField label="品牌名称" field="brandName" value={draft.brandName} busy={busy} onChange={onChange} placeholder="没有品牌可暂不填写" />
      <TextField label="经营地区" field="businessRegion" value={draft.businessRegion} busy={busy} onChange={onChange} placeholder="省 / 市 / 区" />
      <TextField label="经营地址" field="businessAddress" value={draft.businessAddress} busy={busy} onChange={onChange} placeholder="详细经营地址" />
      <TextField label="客服电话" field="servicePhone" value={draft.servicePhone} busy={busy} onChange={onChange} placeholder="消费者可见的客服电话" inputMode="tel" />
    </div>
  </div>;
}

function DomainStep({ draft, busy, onChange }: StepProps) {
  return <div className="mallcreatefields">
    <p className="mallcreatesectionintro">H5 入口由系统创建时分配；实际域名、地址与开通状态以创建任务返回结果为准。</p>
    <div className="mallcreateaddresspreview"><small>H5 入口</small><strong>由创建任务返回实际地址</strong><span>HTTPS 证书由平台统一托管</span></div>
    <div className="fieldgrid">
      <SelectField label="HTTPS 证书" field="certificateMode" value={draft.certificateMode} busy={busy} onChange={onChange} options={[['managed', '平台自动申请']]} />
    </div>
    <div className="mallcreateuploads">
      <UploadField label="商城 Logo" field="brandLogoFile" value={draft.brandLogoFile} busy={busy} onChange={onChange} hint="建议正方形 PNG；本轮不上传。" />
      <UploadField label="浏览器图标" field="faviconFile" value={draft.faviconFile} busy={busy} onChange={onChange} hint="建议 512 × 512 PNG；本轮不上传。" />
    </div>
  </div>;
}

function WechatStep({ draft, busy, onChange }: StepProps) {
  return <div className="mallcreatefields">
    <p className="mallcreatesectionintro">小程序、公众号和视频号分别授权，彼此不作为创建商城的前置条件。</p>
    <section className="mallcreatechannel">
      <header><div><strong>微信小程序</strong><small>商城入口、分享与交易承载</small></div><StatusPill value={draft.miniProgramMode} /></header>
      <div className="fieldgrid">
        <SelectField label="接入方式" field="miniProgramMode" value={draft.miniProgramMode} busy={busy} onChange={onChange} options={[['later', '暂不接入'], ['authorize', '授权已有小程序'], ['register', '申请新小程序']]} />
        {draft.miniProgramMode === 'authorize' ? <><TextField label="小程序 AppID" field="miniProgramAppId" value={draft.miniProgramAppId} busy={busy} onChange={onChange} placeholder="wx 开头的 AppID" /><TextField label="小程序原始 ID" field="miniProgramOriginalId" value={draft.miniProgramOriginalId} busy={busy} onChange={onChange} placeholder="gh_ 开头的原始 ID" /></> : null}
      </div>
    </section>
    <section className="mallcreatechannel">
      <header><div><strong>微信公众号</strong><small>内容触达、菜单与客户沉淀</small></div><StatusPill value={draft.officialAccountMode} /></header>
      <div className="fieldgrid">
        <SelectField label="接入方式" field="officialAccountMode" value={draft.officialAccountMode} busy={busy} onChange={onChange} options={[['later', '暂不接入'], ['authorize', '授权已有公众号'], ['register', '申请新公众号']]} />
        {draft.officialAccountMode === 'authorize' ? <TextField label="公众号 AppID" field="officialAccountAppId" value={draft.officialAccountAppId} busy={busy} onChange={onChange} placeholder="公众号 AppID" /> : null}
      </div>
    </section>
    <TextField label="视频号 ID（选填）" field="videoChannelId" value={draft.videoChannelId} busy={busy} onChange={onChange} placeholder="用于后续直播和商品接入" />
  </div>;
}

function FulfillmentStep({ draft, busy, onChange }: StepProps) {
  return <div className="mallcreatefields">
    <p className="mallcreatesectionintro">这里只确定接入意向。支付开户、物流模板和发票规则仍由各业务模块独立完成。</p>
    <div className="fieldgrid">
      <SelectField label="收款方案" field="paymentPlan" value={draft.paymentPlan} busy={busy} onChange={onChange} options={[['later', '稍后开通'], ['wechat', '微信支付'], ['multi', '微信 + 支付宝'], ['offline', '线下收款']]} />
      {draft.paymentPlan === 'wechat' || draft.paymentPlan === 'multi' ? <TextField label="微信支付商户号" field="wechatMerchantId" value={draft.wechatMerchantId} busy={busy} onChange={onChange} placeholder="已有商户号可填写" /> : null}
      <SelectField label="履约方式" field="deliveryMode" value={draft.deliveryMode} busy={busy} onChange={onChange} options={[['express', '快递发货'], ['local', '同城配送'], ['pickup', '到店自提'], ['digital', '虚拟商品'], ['mixed', '多种方式']]} />
      <TextField label="默认发货地区" field="warehouseRegion" value={draft.warehouseRegion} busy={busy} onChange={onChange} placeholder="仓库所在省 / 市 / 区" />
      <TextField label="退货联系人" field="returnContact" value={draft.returnContact} busy={busy} onChange={onChange} placeholder="售后收件人及电话" />
      <TextField label="默认退货地址" field="returnAddress" value={draft.returnAddress} busy={busy} onChange={onChange} placeholder="完整退货地址" />
      <SelectField label="发票能力" field="invoiceMode" value={draft.invoiceMode} busy={busy} onChange={onChange} options={[['later', '稍后配置'], ['electronic', '电子发票'], ['paper', '纸质发票'], ['both', '电子 + 纸质']]} />
      <TextField label="经营通知接收人" field="notificationContact" value={draft.notificationContact} busy={busy} onChange={onChange} placeholder="手机号或邮箱" />
    </div>
  </div>;
}

function ReviewStep({ draft }: Readonly<{ draft: MallOpeningDraft }>) {
  return <div className="mallcreatereview">
    <p className="mallcreatesectionintro">确认商城核心信息。扩展资料将在对应后台模块接通后分别保存，不会混入商城创建接口。</p>
    <div className="mallcreatesummary">
      <Summary label="商城" value={draft.name || '未填写'} detail={`${draft.code || '—'} · H5 域名自动分配`} tone="ready" />
      <Summary label="经营主体" value={draft.companyName || '待补充'} detail={subjectLabel(draft.subjectType)} tone={draft.companyName === '' ? 'waiting' : 'ready'} />
      <Summary label="域名" value={domainSummary()} detail="平台托管证书" tone="waiting" />
      <Summary label="微信小程序" value={channelSummary(draft.miniProgramMode)} detail={draft.miniProgramAppId || '未提交授权资料'} tone={draft.miniProgramMode === 'later' ? 'waiting' : 'ready'} />
      <Summary label="微信公众号" value={channelSummary(draft.officialAccountMode)} detail={draft.officialAccountAppId || '未提交授权资料'} tone={draft.officialAccountMode === 'later' ? 'waiting' : 'ready'} />
      <Summary label="支付与履约" value={paymentSummary(draft.paymentPlan)} detail={deliverySummary(draft.deliveryMode)} tone="waiting" />
    </div>
    <section className="mallcreatecommitboundary" role="note">
      <strong>本次真正提交</strong>
      <ul><li>商城名称、代码与自动 H5 域名</li><li>所属集团与独立商城身份</li><li>独立商品池和开店草稿</li></ul>
      <strong>暂不提交后台</strong>
      <ul><li>公司证照与联系人资料</li><li>Logo 与浏览器图标</li><li>小程序、公众号、支付、物流和发票配置</li></ul>
    </section>
  </div>;
}

function TextField({ label, field, value, busy, onChange, placeholder, inputMode }: Readonly<{
  label: string;
  field: keyof MallOpeningDraft;
  value: string;
  busy: boolean;
  onChange: (field: keyof MallOpeningDraft, value: string) => void;
  placeholder: string;
  inputMode?: 'text' | 'tel';
}>) {
  return <label>{label}<input aria-label={label} value={value} disabled={busy} placeholder={placeholder} inputMode={inputMode} onChange={(event) => onChange(field, event.target.value)} /></label>;
}

function SelectField({ label, field, value, busy, onChange, options }: Readonly<{
  label: string;
  field: keyof MallOpeningDraft;
  value: string;
  busy: boolean;
  onChange: (field: keyof MallOpeningDraft, value: string) => void;
  options: readonly (readonly [string, string])[];
}>) {
  return <label>{label}<select aria-label={label} value={value} disabled={busy} onChange={(event) => onChange(field, event.target.value)}>
    {options.map(([optionValue, optionLabel]) => <option key={optionValue || 'empty'} value={optionValue}>{optionLabel}</option>)}
  </select></label>;
}

function UploadField({ label, field, value, busy, onChange, hint }: Readonly<{
  label: string;
  field: keyof MallOpeningDraft;
  value: string;
  busy: boolean;
  onChange: (field: keyof MallOpeningDraft, value: string) => void;
  hint: string;
}>) {
  return <label className="mallcreateupload">{label}
    <span><b>{value || '选择文件'}</b><small>{hint}</small></span>
    <input aria-label={label} type="file" disabled={busy} accept=".jpg,.jpeg,.png,.pdf,.ico" onChange={(event) => onChange(field, event.target.files?.[0]?.name ?? '')} />
  </label>;
}

function StatusPill({ value }: Readonly<{ value: string }>) {
  return <span className="mallcreatechannelstatus" data-active={value !== 'later'}>{value === 'later' ? '稍后接入' : value === 'authorize' ? '已有账号' : '准备申请'}</span>;
}

function Summary({ label, value, detail, tone }: Readonly<{ label: string; value: string; detail: string; tone: 'ready' | 'waiting' }>) {
  return <article data-tone={tone}><small>{label}</small><strong>{value}</strong><span>{detail}</span></article>;
}

function submitJourney(event: FormEvent<HTMLFormElement>, finalStep: boolean, valid: boolean, onSubmit: () => void) {
  event.preventDefault();
  if (finalStep && valid) onSubmit();
}

function stepState(index: number, step: number): string {
  if (index === step) return 'current';
  return index < step ? 'complete' : 'upcoming';
}

function subjectLabel(value: string): string {
  return ({ enterprise: '企业', individual: '个体工商户', organization: '其他组织', personal: '个人' } as Record<string, string>)[value] ?? value;
}

function channelSummary(value: string): string {
  return ({ later: '稍后接入', authorize: '授权已有账号', register: '申请新账号' } as Record<string, string>)[value] ?? value;
}

function domainSummary(): string {
  return '由系统创建时分配';
}

function paymentSummary(value: string): string {
  return ({ later: '稍后开通收款', wechat: '微信支付', multi: '微信 + 支付宝', offline: '线下收款' } as Record<string, string>)[value] ?? value;
}

function deliverySummary(value: string): string {
  return ({ express: '快递发货', local: '同城配送', pickup: '到店自提', digital: '虚拟商品', mixed: '多种履约方式' } as Record<string, string>)[value] ?? value;
}
