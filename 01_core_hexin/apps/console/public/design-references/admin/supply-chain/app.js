const partners = [
  { id: 'huadong', name: '华东优选商贸', logo: '华', type: '渠道商', status: '合作中', tone: 'success', products: 62, contact: '周经理', since: '2025-03-18', mode: '经销供货', upstream: '源味食品工厂', downstream: '宏泰供应链' },
  { id: 'hongtai', name: '宏泰供应链', logo: '宏', type: '供应商', status: '合作中', tone: 'success', products: 186, contact: '陈经理', since: '2024-09-06', mode: '直接供货', upstream: '多家合作伙伴', downstream: '主打团商城' },
  { id: 'yuanwei', name: '源味食品工厂', logo: '源', type: '生产商', status: '合作中', tone: 'success', products: 34, contact: '林经理', since: '2025-04-22', mode: '生产供货', upstream: '原料合作基地', downstream: '华东优选商贸' },
  { id: 'yunling', name: '云岭农产基地', logo: '岭', type: '产地供应商', status: '资料待完善', tone: 'warning', products: 18, contact: '杨经理', since: '2026-08-26', mode: '产地直供', upstream: '云岭合作农户', downstream: '宏泰供应链' },
  { id: 'xinghai', name: '星海品牌管理', logo: '星', type: '品牌方', status: '待确认', tone: 'info', products: 27, contact: '沈经理', since: '2026-09-08', mode: '品牌授权', upstream: '品牌生产体系', downstream: '华东优选商贸' },
];

const products = [
  { id: 1, name: '动物奶油·粉色皇冠生日蛋糕', code: 'TM-C1001', category: '生日蛋糕', price: 128, stock: 36, status: '已采用', statusKey: 'adopted', updated: '今天 18:42', thumb: '🎂', tone: '' },
  { id: 2, name: '海洋之心·益生菌奶油慕斯', code: 'TM-C1002', category: '慕斯蛋糕', price: 168, stock: 18, status: '审核中', statusKey: 'review', updated: '今天 17:30', thumb: '🍰', tone: 'blue' },
  { id: 3, name: '天空之境无糖生日蛋糕', code: 'TM-C1003', category: '低糖蛋糕', price: 198, stock: 12, status: '草稿', statusKey: 'draft', updated: '昨天 16:20', thumb: '🎂', tone: 'cream' },
  { id: 4, name: '经典巧克力慕斯蛋糕', code: 'TM-C1004', category: '慕斯蛋糕', price: 158, stock: 25, status: '已采用', statusKey: 'adopted', updated: '09-10 14:10', thumb: '🍰', tone: 'choco' },
  { id: 5, name: '莓果森林鲜奶蛋糕', code: 'TM-C1005', category: '鲜奶蛋糕', price: 148, stock: 20, status: '草稿', statusKey: 'draft', updated: '09-09 11:26', thumb: '🎂', tone: '' },
];

const internalNav = [
  ['⌁', '经营驾驶舱'], ['⌁', '数据报表'], ['▥', '店铺装修'], ['◇', '商品管理'], ['⌘', '供应链管理', true],
  ['▱', '订单管理系统'], ['⌘', '分销返佣系统'], ['⇄', '渠道接入系统'], ['▰', '卡券治理台'], ['▦', '财务与对账台'], ['♙', '商城会员'], ['♙', '管理与权限'], ['⌁', '系统治理台'],
];
const partnerNav = [['▥', '工作概览'], ['◇', '我的商品', true], ['▱', '订单履约'], ['▦', '对账结算'], ['♙', '企业资料']];

let selectedPartner = partners[0];
let partnerFilter = '全部';
let productFilter = 'all';

const internalView = document.querySelector('#internalView');
const partnerView = document.querySelector('#partnerView');
const scopeSwitch = document.querySelector('#scopeSwitch');
const mainNav = document.querySelector('#mainNav');
const modalBackdrop = document.querySelector('#modalBackdrop');
const modalTitle = document.querySelector('#modalTitle');
const modalEyebrow = document.querySelector('#modalEyebrow');
const modalBody = document.querySelector('#modalBody');
const modalPrimary = document.querySelector('#modalPrimary');

function navMarkup(items) {
  return items.map(([icon, label, active]) => `<button class="side-link${active ? ' active' : ''}" type="button"><span class="side-icon">${icon}</span>${label}</button>`).join('');
}

function renderInternal() {
  const filtered = filterPartners(partners);
  internalView.innerHTML = `
    <header class="workspace-head">
      <div class="primary-tabs" role="tablist">
        <button class="tab-button active" data-internal-tab="network">供应网络 <span class="count-badge">28</span></button>
        <button class="tab-button" data-internal-tab="requests">合作申请 <span class="count-badge">3</span></button>
        <button class="tab-button" data-internal-tab="changes">关系变更</button>
      </div>
      <div class="head-actions"><button class="button secondary" data-action="invite">⇧ 邀请伙伴</button><button class="button primary" data-action="new-partner">＋ 新增供应节点</button><button class="icon-button" data-action="refresh" aria-label="刷新">↻</button></div>
    </header>
    <div class="filter-zone">
      <div class="search-row"><label class="page-search"><span>⌕</span><input id="partnerSearch" placeholder="搜索企业名称、联系人或供应商品" /></label></div>
      <div class="filter-tabs">${['全部','供应商','渠道商','品牌方','生产商','待确认'].map((item) => `<button class="filter-tab${partnerFilter === item ? ' active' : ''}" data-partner-filter="${item}">${item}${item === '全部' ? ' 28' : ''}</button>`).join('')}</div>
    </div>
    <div class="split-layout" data-internal-content>
      <section class="partner-list">
        <div class="list-head"><span>供应节点</span><span>主体类型</span><span>合作状态</span><span>供货商品</span></div>
        <div id="partnerRows">${partnerRows(filtered)}</div>
        <div class="pagination"><span>1–5 / 共 28 条</span><div class="pages"><button class="page active">1</button><button class="page">2</button><button class="page">3</button><button class="page">›</button></div></div>
      </section>
      <section class="detail-panel">${partnerDetail(selectedPartner)}</section>
    </div>`;
}

function filterPartners(rows) {
  if (partnerFilter === '全部') return rows;
  if (partnerFilter === '待确认') return rows.filter((partner) => partner.status === '待确认');
  return rows.filter((partner) => partner.type.includes(partnerFilter));
}

function partnerRows(rows) {
  if (!rows.length) return '<div class="empty-pane"><div><span>⌕</span><h3>没有匹配的合作伙伴</h3><p>换一个关键词或筛选条件试试</p></div></div>';
  return rows.map((partner) => `
    <button class="partner-row${selectedPartner.id === partner.id ? ' selected' : ''}" data-partner-id="${partner.id}">
      <span class="company-cell"><span class="company-logo">${partner.logo}</span><strong>${partner.name}</strong></span>
      <span class="type-pill">${partner.type}</span><span class="status-pill ${partner.tone}">${partner.status}</span><span class="table-number">${partner.products}</span>
    </button>`).join('');
}

function partnerDetail(partner) {
  return `
    <header class="detail-head"><span class="detail-logo">${partner.logo}</span><div class="detail-title"><h2>${partner.name}<span class="role-tag">${partner.type}</span><span class="status-pill ${partner.tone}">${partner.status}</span></h2><p>联系人：${partner.contact}　·　供货商品 ${partner.products}　·　合作自 ${partner.since}</p></div><div class="detail-actions"><button class="button secondary" data-action="talk">发起沟通</button><button class="button primary" data-action="edit-partner">编辑资料</button><button class="icon-button">…</button></div></header>
    <section class="relationship-card"><h3 class="section-title">供应链路径<button data-action="manage-relation">⌘ 管理关系</button></h3><div class="chain"><div class="chain-node"><strong>${partner.upstream}</strong><small>供货来源</small></div><div class="chain-link"><span>供货</span></div><div class="chain-node"><strong>${partner.name}</strong><small>${partner.type}</small></div><div class="chain-link"><span>${partner.mode}</span></div><div class="chain-node"><strong>${partner.downstream}</strong><small>合作去向</small></div><div class="chain-link"><span>供货</span></div><div class="chain-node"><strong>主打团商城</strong><small>销售商城</small></div></div></section>
    <nav class="detail-tabs" aria-label="供应商详情"><button class="detail-tab active">概览</button><button class="detail-tab">供应商品 <span class="count-badge">${partner.products}</span></button><button class="detail-tab">合同与结算</button><button class="detail-tab">联系人 3</button><button class="detail-tab">记录</button></nav>
    <div class="detail-content"><div class="info-grid"><section class="info-section"><h3>企业资料</h3><div class="info-row"><span>统一社会信用代码</span><b>9131**********26</b></div><div class="info-row"><span>所在地区</span><b>上海市</b></div><div class="info-row"><span>合作模式</span><b>${partner.mode}</b></div><div class="info-row"><span>结算方式</span><b>月结</b></div></section><section class="info-section"><h3>当前关系</h3><div class="info-row"><span>供货来源</span><b>${partner.upstream}</b></div><div class="info-row"><span>合作去向</span><b>${partner.downstream}</b></div><div class="info-row"><span>生效合同</span><b>2 份</b></div><div class="info-row"><span>最近结算</span><b>2026-09-05</b></div></section></div><section class="activity"><h3 class="section-title">近期动态<button>查看全部 ›</button></h3><ul><li><time>今天 10:24</time><span>新增 8 个供应商品</span></li><li><time>09-08 16:17</time><span>月度对账已确认</span></li><li><time>09-05 14:03</time><span>更新食品经营许可</span></li></ul></section></div>`;
}

function renderPartner() {
  partnerView.innerHTML = `
    <header class="workspace-head"><div class="partner-head-copy"><h1>供货工作台</h1><p>欢迎回来，甜觅蛋糕供应链　·　自主维护商品并查看平台采用进度</p></div><div class="head-actions"><button class="button secondary" data-action="preview-store">预览商城效果</button><button class="icon-button" data-action="refresh">↻</button></div></header>
    <div class="partner-layout"><section class="catalog-pane"><div class="catalog-title"><h2>我的商品 <span class="count-badge">42</span></h2><div class="head-actions"><button class="button secondary" data-action="import">⇧ 批量导入</button><button class="button primary" data-action="new-product">＋ 新建商品</button></div></div>
      <label class="page-search"><span>⌕</span><input id="productSearch" placeholder="搜索商品名称、规格或商品编号" /></label>
      <div class="status-tabs">${[['all','全部 42'],['draft','草稿 5'],['review','审核中 3'],['adopted','已采用 34']].map(([key,label]) => `<button class="${productFilter === key ? 'active' : ''}" data-product-filter="${key}">${label}</button>`).join('')}</div>
      <div class="catalog-filters"><select class="select-control"><option>商品分类</option><option>生日蛋糕</option><option>慕斯蛋糕</option><option>低糖蛋糕</option></select><select class="select-control"><option>平台状态</option><option>草稿</option><option>审核中</option><option>已采用</option></select><select class="select-control"><option>配送范围</option><option>上海市</option><option>江浙沪</option><option>全国配送</option></select></div>
      <div id="productRows">${productTable()}</div>
      <div class="pagination"><span>1–5 / 共 42 条</span><div class="pages"><button class="page active">1</button><button class="page">2</button><button class="page">3</button><button class="page">›</button></div></div></section>
      <aside class="task-panel"><h3>待办事项 <span class="count-badge">3</span></h3><div class="task-list"><button class="task-item"><span class="task-dot">!</span><span>3 个商品等待补充资料</span><b>›</b></button><button class="task-item"><span class="task-dot">▣</span><span>本月对账单待确认</span><b>›</b></button><button class="task-item"><span class="task-dot">◷</span><span>配送范围即将到期</span><b>›</b></button></div><section class="flow-card"><h3>商品进入商城</h3><div class="flow-steps"><div class="flow-step done"><strong>创建商品</strong><small>填写商品信息并保存</small></div><div class="flow-step done"><strong>提交审核</strong><small>平台检查资料与规则</small></div><div class="flow-step active"><strong>进入选品中心</strong><small>商城正在查看商品</small></div><div class="flow-step"><strong>商城采用</strong><small>采用后可正式上架</small></div></div></section></aside></div>`;
}

function productTable() {
  const q = (document.querySelector('#productSearch')?.value || '').trim().toLowerCase();
  const rows = products.filter((product) => (productFilter === 'all' || product.statusKey === productFilter) && (!q || `${product.name}${product.code}${product.category}`.toLowerCase().includes(q)));
  if (!rows.length) return '<div class="empty-pane"><div><span>◇</span><h3>暂无对应商品</h3><p>可以新建商品或调整筛选条件</p><button class="button primary" data-action="new-product">＋ 新建商品</button></div></div>';
  return `<table class="product-table"><thead><tr><th>商品信息</th><th>选品类别</th><th>供货价</th><th>库存</th><th>平台状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${rows.map((product) => `<tr><td><span class="product-cell"><span class="cake-thumb ${product.tone}">${product.thumb}</span><span><strong>${product.name}</strong><small>${product.code}</small></span></span></td><td>${product.category}</td><td>¥${product.price}</td><td>${product.stock}</td><td><span class="status-pill ${product.statusKey === 'adopted' ? 'success' : product.statusKey === 'review' ? 'info' : ''}">${product.status}</span></td><td>${product.updated}</td><td class="row-actions"><button data-edit-product="${product.id}">${product.statusKey === 'draft' ? '继续编辑' : '编辑'}</button>${product.statusKey === 'draft' ? `<button data-submit-product="${product.id}">提交审核</button>` : `<button data-view-product="${product.id}">查看</button>`}</td></tr>`).join('')}</tbody></table>`;
}

function switchScope(scope) {
  const isPartner = scope === 'partner';
  internalView.hidden = isPartner;
  partnerView.hidden = !isPartner;
  mainNav.innerHTML = navMarkup(isPartner ? partnerNav : internalNav);
  document.querySelector('#profileName').textContent = isPartner ? '甜觅运营' : 'Ethan';
  document.querySelector('#profileMeta').textContent = isPartner ? '甜觅蛋糕供应链' : '个人中心 · 主打团';
  document.querySelector('#accountScope').textContent = isPartner ? '渠道商 · 甜觅蛋糕' : '商城 · 主打团';
  if (isPartner) renderPartner(); else renderInternal();
}

function internalEmpty(title, description, buttonLabel) {
  return `<div class="empty-pane"><div><span>⌘</span><h3>${title}</h3><p>${description}</p><button class="button primary" data-action="${buttonLabel === '邀请伙伴' ? 'invite' : 'new-partner'}">${buttonLabel}</button></div></div>`;
}

function openModal(kind, payload) {
  const forms = {
    invite: { eyebrow: 'PARTNER INVITATION', title: '邀请合作伙伴', primary: '发送邀请', body: `<div class="form-grid"><label class="field full">企业名称<input placeholder="请输入供应商、渠道商或品牌方名称" /></label><label class="field">主体类型<select><option>供应商</option><option>渠道商</option><option>品牌方</option><option>生产商</option></select></label><label class="field">联系人手机<input placeholder="用于接收开通邀请" /></label><label class="field full">合作说明<textarea placeholder="简单说明计划合作的商品与模式"></textarea></label></div>` },
    partner: { eyebrow: 'SUPPLY PARTNER', title: '新增供应节点', primary: '保存节点', body: `<div class="form-grid"><label class="field full">企业名称<input value="${payload?.name || ''}" placeholder="请输入企业全称" /></label><label class="field">主体类型<select><option>供应商</option><option>渠道商</option><option>品牌方</option><option>生产商</option></select></label><label class="field">合作模式<select><option>直接供货</option><option>经销供货</option><option>品牌授权</option><option>代发履约</option></select></label><label class="field">供货来源<input placeholder="选择或新增合作伙伴" /></label><label class="field">合作去向<input value="宏泰供应链" /></label></div>` },
    product: { eyebrow: 'PRODUCT CREATION', title: payload ? '编辑商品' : '新建商品', primary: payload ? '保存修改' : '保存为草稿', body: `<div class="form-grid"><label class="field full">商品图片<div class="upload-box">＋ 上传商品主图</div></label><label class="field full">商品名称<input id="newProductName" value="${payload?.name || ''}" placeholder="例如：动物奶油草莓生日蛋糕" /></label><label class="field">选品类别<select><option>生日蛋糕</option><option>慕斯蛋糕</option><option>低糖蛋糕</option><option>鲜奶蛋糕</option></select></label><label class="field">供货价<input id="newProductPrice" value="${payload?.price || ''}" placeholder="¥ 0.00" /></label><label class="field">库存<input id="newProductStock" value="${payload?.stock || ''}" placeholder="0" /></label><label class="field">配送范围<select><option>上海市</option><option>江浙沪</option><option>全国配送</option></select></label><label class="field full">规格与说明<textarea placeholder="填写尺寸、口味、制作时间及配送说明"></textarea></label></div>` },
    import: { eyebrow: 'BATCH IMPORT', title: '批量导入商品', primary: '开始导入', body: `<div class="upload-box" style="min-height:180px"><div style="text-align:center"><b>将商品表格拖到这里</b><p style="color:#8398b9;font-size:11px">支持 .xlsx 文件，单次最多 500 条商品</p><button class="button secondary">选择文件</button></div></div>` },
    relation: { eyebrow: 'RELATIONSHIP', title: '管理供应关系', primary: '保存关系', body: `<div class="form-grid"><label class="field full">当前节点<input value="${selectedPartner.name}" disabled /></label><label class="field">供货来源<input value="${selectedPartner.upstream}" /></label><label class="field">合作去向<input value="${selectedPartner.downstream}" /></label><label class="field full">关系类型<select><option>${selectedPartner.mode}</option><option>直接供货</option><option>经销供货</option><option>品牌授权</option><option>代发履约</option></select></label></div>` },
  };
  const form = forms[kind];
  modalEyebrow.textContent = form.eyebrow;
  modalTitle.textContent = form.title;
  modalBody.innerHTML = form.body;
  modalPrimary.textContent = form.primary;
  modalPrimary.dataset.submitKind = kind;
  modalBackdrop.hidden = false;
  setTimeout(() => modalBody.querySelector('input:not([disabled])')?.focus(), 20);
}

function closeModal() { modalBackdrop.hidden = true; }
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2400); }

scopeSwitch.addEventListener('change', (event) => switchScope(event.target.value));
document.addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.matches('[data-close-modal]')) closeModal();
  if (target.dataset.partnerId) { selectedPartner = partners.find((item) => item.id === target.dataset.partnerId); renderInternal(); }
  if (target.dataset.partnerFilter) { partnerFilter = target.dataset.partnerFilter; renderInternal(); }
  if (target.dataset.productFilter) { productFilter = target.dataset.productFilter; renderPartner(); }
  if (target.dataset.internalTab) {
    document.querySelectorAll('[data-internal-tab]').forEach((item) => item.classList.toggle('active', item === target));
    const content = document.querySelector('[data-internal-content]');
    if (target.dataset.internalTab === 'network') renderInternal();
    if (target.dataset.internalTab === 'requests') content.innerHTML = internalEmpty('3 个合作申请待处理', '查看企业资料并决定是否建立供应关系', '邀请伙伴');
    if (target.dataset.internalTab === 'changes') content.innerHTML = internalEmpty('暂无待处理的关系变更', '供应关系调整会在这里集中确认', '新增供应节点');
  }
  const action = target.dataset.action;
  if (action === 'invite') openModal('invite');
  if (action === 'new-partner') openModal('partner');
  if (action === 'edit-partner') openModal('partner', selectedPartner);
  if (action === 'manage-relation') openModal('relation');
  if (action === 'new-product') openModal('product');
  if (action === 'import') openModal('import');
  if (action === 'talk') toast(`已打开与 ${selectedPartner.contact} 的沟通窗口`);
  if (action === 'refresh') toast('数据已更新');
  if (action === 'preview-store') toast('已生成商城预览，商品资料保持不变');
  if (target.dataset.editProduct) openModal('product', products.find((item) => item.id === Number(target.dataset.editProduct)));
  if (target.dataset.viewProduct) toast('商品详情已打开');
  if (target.dataset.submitProduct) {
    const product = products.find((item) => item.id === Number(target.dataset.submitProduct));
    product.status = '审核中';
    product.statusKey = 'review';
    product.updated = '刚刚';
    renderPartner();
    toast('商品已提交审核，可在“审核中”查看进度');
  }
  if (target.classList.contains('task-item')) { target.classList.toggle('done'); toast(target.classList.contains('done') ? '待办已标记完成' : '待办已恢复'); }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'partnerSearch') {
    const q = event.target.value.trim().toLowerCase();
    document.querySelector('#partnerRows').innerHTML = partnerRows(filterPartners(partners).filter((partner) => !q || `${partner.name}${partner.contact}${partner.type}`.toLowerCase().includes(q)));
  }
  if (event.target.id === 'productSearch') document.querySelector('#productRows').innerHTML = productTable();
});

modalPrimary.addEventListener('click', () => {
  const kind = modalPrimary.dataset.submitKind;
  if (kind === 'product' && modalTitle.textContent === '新建商品') {
    const name = document.querySelector('#newProductName').value.trim();
    if (!name) { toast('请先填写商品名称'); return; }
    products.unshift({ id: Date.now(), name, code: `TM-C${1100 + products.length}`, category: '生日蛋糕', price: Number(document.querySelector('#newProductPrice').value) || 0, stock: Number(document.querySelector('#newProductStock').value) || 0, status: '草稿', statusKey: 'draft', updated: '刚刚', thumb: '🎂', tone: '' });
    productFilter = 'all';
    closeModal(); renderPartner(); toast('商品已保存为草稿，可继续完善后提交审核'); return;
  }
  closeModal();
  toast(kind === 'invite' ? '合作邀请已发送' : kind === 'import' ? '导入任务已创建' : kind === 'relation' ? '供应关系已保存' : '资料已保存');
});

modalBackdrop.addEventListener('click', (event) => { if (event.target === modalBackdrop) closeModal(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });

renderInternal();
switchScope('internal');
