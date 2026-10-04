(function () {
  const root = document.documentElement;
  const styleButtons = Array.from(document.querySelectorAll('[data-style-choice]'));
  const modeButtons = Array.from(document.querySelectorAll('[data-mode-choice]'));
  const componentButtons = Array.from(document.querySelectorAll('[data-component]'));
  const directionIndex = document.getElementById('directionIndex');
  const directionTitle = document.getElementById('directionTitle');
  const directionDescription = document.getElementById('directionDescription');
  const directionDna = document.getElementById('directionDna');
  const productName = document.getElementById('productName');
  const propertyTitle = document.getElementById('propertyTitle');
  const fieldTitle = document.getElementById('fieldTitle');
  const fieldSource = document.getElementById('fieldSource');
  const propertyHint = document.getElementById('propertyHint');
  const widthRange = document.getElementById('widthRange');
  const widthValue = document.getElementById('widthValue');
  const toast = document.getElementById('toast');

  const directions = {
    studio: {
      index: 'DIRECTION 01',
      title: '暖色店鋪工作室',
      description: '像懂生意的設計工作室：可靠、溫暖、帶一點創作感。',
      product: '主打团 Studio',
      dna: ['築橙焦點', '暖米工作臺', '12px 圓角', '創作感']
    },
    editorial: {
      index: 'DIRECTION 02',
      title: 'Editorial Commerce Studio',
      description: '像精品品牌的數位工作室：國際、精準、克制，讓商品內容成為主角。',
      product: '主打团 / EDIT',
      dna: ['電光紫', '石墨畫布', '8px 圓角', '畫廊感']
    },
    classic: {
      index: 'DIRECTION 03',
      title: '實用型商家工作臺',
      description: '接近有贊的企業後臺：藍白、緊湊、直接，功能辨識永遠優先。',
      product: '主打团商家後臺',
      dna: ['標準藍', '冷灰底色', '4px 圓角', '高密度']
    }
  };

  const components = {
    image: ['圖片', '把喜歡的日常慢慢收藏', '品牌素材庫', '圖片元件使用商戶素材；選中框仍使用平台操作色。', 'image'],
    navigation: ['圖文導航', '逛逛我們的新分類', '商城分類樹', '導航資料與商品分類同步，不需要在頁面重複維護。', 'navigation'],
    hero: ['主視覺', '秋季新品，本週上線', '品牌素材庫', '主視覺支援不同人群投放，商城配色不受後臺 VI 影響。', 'image'],
    products: ['商品列表', '本週人氣商品', '商品中心', '商品狀態由商品中心統一管理，失效商品會在發佈前提示。', 'products'],
    ranking: ['商品排行', '今日人氣 Top 10', '商品中心', '排行按近 7 日銷量自動更新，仍可人工置頂。', 'products'],
    category: ['商品分類', '按生活方式探索', '商城分類樹', '分類資料來自商品中心，不在頁面內複製。', 'navigation'],
    coupon: ['優惠券', '會員滿 299 減 30', '商品中心', '優惠券會自動檢查有效期、庫存與適用商品。', 'coupon'],
    countdown: ['倒計時', '秋季新品倒計時', '商品中心', '活動結束後可自動隱藏，或切換為常規商品模組。', 'coupon']
  };

  function applyDirection(name) {
    const direction = directions[name];
    root.dataset.style = name;
    styleButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.styleChoice === name)));
    directionIndex.textContent = direction.index;
    directionTitle.textContent = direction.title;
    directionDescription.textContent = direction.description;
    productName.textContent = direction.product;
    directionDna.replaceChildren(...direction.dna.map((item) => {
      const span = document.createElement('span');
      span.textContent = item;
      return span;
    }));
    localStorage.setItem('zhudian-demo-style', name);
  }

  function applyMode(name) {
    root.dataset.mode = name;
    root.style.colorScheme = name;
    modeButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.modeChoice === name)));
    localStorage.setItem('zhudian-demo-mode', name);
  }

  function selectComponent(name) {
    const detail = components[name];
    componentButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.component === name)));
    propertyTitle.textContent = detail[0];
    fieldTitle.value = detail[1];
    Array.from(fieldSource.options).forEach((option) => option.selected = option.textContent === detail[2]);
    propertyHint.textContent = detail[3];
    document.querySelectorAll('[data-canvas-block]').forEach((block) => {
      block.classList.toggle('is-selected', block.dataset.canvasBlock === detail[4]);
      const oldLabel = block.querySelector('.selection-label');
      if (oldLabel) oldLabel.remove();
    });
    const target = document.querySelector(`[data-canvas-block="${detail[4]}"]`);
    if (target) {
      const label = document.createElement('span');
      label.className = 'selection-label';
      label.textContent = detail[0];
      target.prepend(label);
    }
  }

  let toastTimer;
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2200);
  }

  styleButtons.forEach((button) => button.addEventListener('click', () => applyDirection(button.dataset.styleChoice)));
  modeButtons.forEach((button) => button.addEventListener('click', () => applyMode(button.dataset.modeChoice)));
  componentButtons.forEach((button) => button.addEventListener('click', () => selectComponent(button.dataset.component)));
  widthRange.addEventListener('input', () => { widthValue.textContent = `${widthRange.value}%`; });
  document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => {
    const messages = { preview: '預覽碼已生成，可在微信中查看', publish: '頁面檢查完成，可以提交發佈', save: '已保存為版本 v19' };
    showToast(messages[button.dataset.action]);
  }));

  const storedStyle = localStorage.getItem('zhudian-demo-style');
  const storedMode = localStorage.getItem('zhudian-demo-mode');
  applyDirection(directions[storedStyle] ? storedStyle : 'studio');
  applyMode(storedMode === 'light' ? 'light' : 'dark');
  selectComponent('image');
})();
