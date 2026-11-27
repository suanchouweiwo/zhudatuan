import React, { useId, useState } from 'react';
import { useMall, LaptopPage } from '../../context/MallContext';
import { ShoppingCart, Trash2, Plus, Minus, CreditCard, Gift, ShieldCheck, CheckCircle2, Building, MapPin, FileText, Zap, ArrowRight, RefreshCw } from 'lucide-react';
import { getLoadedChinaRegions, loadChinaRegions } from '../../features/miniprogram/address/chinaRegions';
import { STOREFRONT_WEB_SURFACE_COPY, type StorefrontWebSurface } from './StorefrontWebStandard';
import { checkoutDeliveryAddress } from '../../context/checkoutSelectedCart';
import { PaymentResultPage } from '../common/PaymentResultPage';

interface LaptopCartCheckoutPageProps {
  onSelectTab: (tab: LaptopPage) => void;
  surface?: StorefrontWebSurface;
}

function formatDeduction(amount: number): string {
  const display = amount.toFixed(2);
  return display === '0.00' ? '¥0.00' : `-¥${display}`;
}

export const LaptopCartCheckoutPage: React.FC<LaptopCartCheckoutPageProps> = ({ onSelectTab, surface = 'laptop' }) => {
  const { cart, updateCartQuantity, removeCartItem, user, addresses, showToast, navigateTo, checkoutSelectedCart,
    refreshCheckoutAddresses, sessionStatus, isSubmittingOrder, activePaymentSession,
    refreshCheckoutAfterCartChange, checkoutPublicationError } = useMall();
  const surfaceCopy = STOREFRONT_WEB_SURFACE_COPY[surface];

  const [useWelfareDeduction, setUseWelfareDeduction] = useState<boolean>(true);
  const [useMealDeduction, setUseMealDeduction] = useState<boolean>(true);
  const [invoiceHeader, setInvoiceHeader] = useState<string>(user.enterpriseName);
  const [isAddingAddress, setIsAddingAddress] = useState(false);
  const [addressId, setAddressId] = useState<string>();
  const [addressChooserOpen, setAddressChooserOpen] = useState(false);
  const [refreshingAddresses, setRefreshingAddresses] = useState(false);
  const [addressRefreshFailed, setAddressRefreshFailed] = useState(false);
  const [refreshingCheckout, setRefreshingCheckout] = useState(false);
  const [checkoutRefreshFailed, setCheckoutRefreshFailed] = useState(false);
  const checkoutStatusId = useId();
  const chooserId = useId();
  const selectedAddress = checkoutDeliveryAddress(addresses, addressId);
  const cartChanged = activePaymentSession?.checkoutFailure === 'cart-changed';
  const waitingForOrder = isSubmittingOrder && activePaymentSession?.orderId === null
    && (activePaymentSession.stage === 'validating' || activePaymentSession.stage === 'creating-order');
  const paymentResult = cartChanged || waitingForOrder ? null : activePaymentSession;
  const checkoutStatus = cartChanged
    ? (checkoutRefreshFailed ? '暂时无法刷新结算信息，请重试。' : '购物车有变化，本次未创建订单。刷新后请重新核对结算信息。')
    : checkoutPublicationError;

  const toggleAddressChooser = async () => {
    if (addressChooserOpen) { setAddressChooserOpen(false); return; }
    setAddressChooserOpen(true);
    setIsAddingAddress(false);
    setAddressRefreshFailed(false);
    setRefreshingAddresses(true);
    try {
      await refreshCheckoutAddresses();
    } catch {
      setAddressRefreshFailed(true);
    } finally {
      setRefreshingAddresses(false);
    }
  };

  // Calculate totals
  const subtotal = cart.reduce((sum, item) => sum + item.product.priceWelfare * item.quantity, 0);

  // Maximum allowed deductions
  const maxWelfareDeduction = useWelfareDeduction ? Math.min(subtotal, user.welfareBalance) : 0;
  const remainingAfterWelfare = Math.max(0, subtotal - maxWelfareDeduction);

  // Meal deduction applied to eligible items or remaining
  const maxMealDeduction = useMealDeduction ? Math.min(remainingAfterWelfare, user.mealBalance) : 0;

  const totalDeduction = maxWelfareDeduction + maxMealDeduction;
  const gapPayment = Math.max(0, subtotal - totalDeduction);

  const handleCheckout = () => void checkoutSelectedCart(addressId);

  const refreshCheckout = async () => {
    setRefreshingCheckout(true);
    setCheckoutRefreshFailed(false);
    try {
      const refreshed = await refreshCheckoutAfterCartChange();
      setCheckoutRefreshFailed(!refreshed);
    } catch {
      setCheckoutRefreshFailed(true);
    } finally {
      setRefreshingCheckout(false);
    }
  };

  const emptyCart = (
    <div className="bg-white border border-gray-200 rounded-lg p-8 text-center space-y-3">
      <div className="text-gray-400">您的企采购物车内暂无商品</div>
      <button onClick={() => onSelectTab('category')} className="bg-[var(--sw-brand)] text-white text-xs font-bold px-4 py-2 rounded-md hover:bg-blue-700 cursor-pointer">
        选购企业福利商品
      </button>
    </div>
  );

  return (
    <div className="w-full bg-[#F5F7FA] min-h-[80vh] pb-10 font-sans">
      <div className="sw-web-container max-w-[1240px] mx-auto pt-3 px-3 space-y-3">
        {/* 页头标题 */}
        <div className="flex items-center justify-between text-xs border-b border-gray-200 pb-2">
          <div className="flex items-center gap-2">
            <ShoppingCart className="w-4 h-4 text-[var(--sw-brand)]" />
            <h1 className="font-extrabold text-sm text-gray-900">购物车与企业福利联合结算</h1>
          </div>
          <span className="text-gray-400">{surfaceCopy.cartLayoutLabel}</span>
        </div>

        {/* 购物车为空处理 */}
        {cart.length === 0 && !paymentResult ? emptyCart : (
          /* 主体两栏：左侧商品表格与订单配置 (~65%) | 右侧固定结算卡片 (~35%) */
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-start">
            {/* 左侧区域 (8列) */}
            <div className="md:col-span-8 space-y-3">
              {cart.length === 0 ? emptyCart : <>
              {/* 商品列表（按仓库分组紧凑展示） */}
              <div className="bg-white border border-gray-200 rounded-lg shadow-2xs overflow-hidden">
                <div className="bg-gray-100 text-gray-700 px-3 py-2 text-xs font-bold flex items-center justify-between border-b border-gray-200">
                  <span>企采供货仓：京东供应链 / 自营仓</span>
                  <span className="text-[10px] text-gray-500">已选 {cart.length} 件商品</span>
                </div>

                <div className="divide-y divide-gray-100 text-xs">
                  {cart.map((item) => (
                    <div key={item.product.id} className="p-3 flex items-center gap-3">
                      {/* 商品图片 */}
                      <div className="w-14 h-14 bg-gray-50 border border-gray-200 rounded p-1 flex-shrink-0 flex items-center justify-center">
                        <img src={item.product.images[0]} alt={item.product.title} className="max-h-full max-w-full object-contain" />
                      </div>

                      {/* 标题与福利标签 */}
                      <div className="flex-1 min-w-0">
                        <h3 className="font-bold text-gray-800 truncate text-xs">{item.product.title}</h3>
                        <div className="flex items-center gap-1.5 mt-1 text-[10px]">
                          <span className="bg-blue-50 text-[var(--sw-brand)] font-medium px-1 rounded">福利卡可用</span>
                          {item.product.allowedAccounts.includes('meal') && <span className="bg-emerald-50 text-emerald-700 font-medium px-1 rounded">餐卡可用</span>}
                        </div>
                      </div>

                      {/* 单价 */}
                      <div className="text-right min-w-[70px]">
                        <div className="font-black text-[#E5484D] text-xs">¥{item.product.priceWelfare.toFixed(2)}</div>
                        <div className="text-[10px] text-gray-400 line-through">¥{item.product.priceMarket.toFixed(2)}</div>
                      </div>

                      {/* 数量调节器 */}
                      <div className="flex items-center border border-gray-300 rounded">
                        <button onClick={() => updateCartQuantity(item.product.id, Math.max(1, item.quantity - 1))} className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 cursor-pointer">
                          <Minus className="w-3 h-3" />
                        </button>
                        <span className="px-2 font-bold text-gray-800 text-xs">{item.quantity}</span>
                        <button onClick={() => updateCartQuantity(item.product.id, item.quantity + 1)} className="px-1.5 py-0.5 bg-gray-100 hover:bg-gray-200 cursor-pointer">
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>

                      {/* 删除 */}
                      <button onClick={() => removeCartItem(item.product.id)} className="text-gray-400 hover:text-red-600 p-1 cursor-pointer transition-colors" title="移除商品">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* 配送与发票抬头设置 */}
              <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-2xs space-y-2.5 text-xs">
                <div className="font-bold text-gray-800 border-b border-gray-100 pb-1.5 flex items-center gap-1.5">
                  <MapPin className="w-4 h-4 text-[var(--sw-brand)]" />
                  <span>配送地址与开票抬头</span>
                </div>

                <div className="space-y-1.5">
                  <div className="p-2 bg-blue-50/60 border border-blue-200 rounded flex items-center justify-between">
                    <div className="min-w-0">
                      <div className="font-bold text-gray-800">{selectedAddress ? `${selectedAddress.name} ${selectedAddress.phone}` : '暂无收货人'}</div>
                      <div className="text-[11px] text-gray-600">{selectedAddress
                        ? `${selectedAddress.province}${selectedAddress.city}${selectedAddress.district}${selectedAddress.detail}`
                        : addressId ? '所选地址已不可用，请重新选择' : '请先新增收货地址'}</div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 pl-2">
                      {selectedAddress && (
                        <span className="text-[10px] bg-[var(--sw-brand)] text-white px-1.5 py-0.5 rounded font-bold">
                          {selectedAddress.isDefault ? '默认办公地址' : '本单使用'}
                        </span>
                      )}
                      {(addresses.length > 0 || sessionStatus === 'authenticated') && (
                        <button type="button" aria-expanded={addressChooserOpen} aria-controls={addressChooserOpen ? chooserId : undefined}
                          onClick={() => void toggleAddressChooser()}
                          className="rounded border border-blue-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-[var(--sw-brand)] hover:bg-blue-50 cursor-pointer">
                          {addressChooserOpen ? '收起地址' : '切换收货地址'}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-expanded={isAddingAddress}
                        disabled={isAddingAddress}
                        onClick={() => { setAddressChooserOpen(false); setIsAddingAddress(true); }}
                        className="rounded bg-[var(--sw-brand)] px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-blue-700 cursor-pointer"
                      >
                        新增收货地址
                      </button>
                    </div>
                  </div>

                  {addressChooserOpen && <fieldset id={chooserId} aria-busy={refreshingAddresses}
                    className="min-w-0 space-y-1.5 rounded border border-gray-200 bg-gray-50 p-2">
                    <legend className="px-1 font-bold text-gray-800">本单收货地址</legend>
                    {refreshingAddresses && <p role="status" className="text-gray-600">正在同步地址簿…</p>}
                    {addressRefreshFailed && <p role="status" className="text-gray-600">暂时无法同步，请收起后重新打开地址列表。</p>}
                    {!refreshingAddresses && !addressRefreshFailed && !addresses.length &&
                      <p className="text-gray-600">暂无已保存的收货地址。</p>}
                    {addresses.map(address => (
                      <label key={address.id} className="flex cursor-pointer items-center gap-2 rounded border border-gray-200 bg-white px-2.5 py-2 hover:bg-blue-50">
                        <input type="radio" name={chooserId} checked={selectedAddress?.id === address.id}
                          onChange={() => setAddressId(address.id)} className="shrink-0 accent-[var(--sw-brand)]" />
                        <span className="min-w-0 flex-1">
                          <span className="block font-bold text-gray-800">{address.name} {address.phone}</span>
                          <span className="block break-words text-[11px] text-gray-600">
                            {address.province}{address.city === address.province ? '' : address.city}{address.district}{address.detail}
                          </span>
                        </span>
                        {address.isDefault && <span className="shrink-0 text-[10px] text-[var(--sw-brand)]">默认</span>}
                      </label>
                    ))}
                  </fieldset>}

                  {isAddingAddress && (
                    <CheckoutAddressForm onClose={() => setIsAddingAddress(false)} />
                  )}

                  <div className="p-2 bg-gray-50 border border-gray-200 rounded flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <FileText className="w-4 h-4 text-gray-500" />
                      <span className="font-bold text-gray-700">开票抬头：</span>
                      <span className="text-[11px] text-gray-600">{invoiceHeader}</span>
                    </div>
                    <span className="text-[10px] text-emerald-600 font-bold bg-emerald-50 px-1.5 py-0.5 rounded">增值税专用发票</span>
                  </div>
                </div>
              </div>
              </>}
            </div>

            {/* 右侧：固定卡片与结算扣减算术明细 (4列) */}
            <div className="sw-web-checkout-summary md:col-span-4 bg-white border border-gray-200 rounded-lg p-3.5 shadow-xs space-y-3 sticky top-[100px]">
              <div className="font-extrabold text-sm text-gray-900 border-b border-gray-100 pb-2">结算汇总与福利卡扣减</div>

              {cart.length > 0 && <>
              {/* 抵扣勾选项 */}
              <div className="space-y-2 text-xs">
                <label className="p-2 bg-blue-50/80 rounded border border-blue-200 flex items-center justify-between cursor-pointer">
                  <div className="flex items-center gap-1.5">
                    <input type="checkbox" checked={useWelfareDeduction} onChange={(e) => setUseWelfareDeduction(e.target.checked)} className="rounded text-[var(--sw-brand)]" />
                    <CreditCard className="w-3.5 h-3.5 text-[var(--sw-brand)]" />
                    <span className="font-bold text-gray-800">福利卡抵扣</span>
                  </div>
                  <span className={`font-bold tabular-nums ${maxWelfareDeduction ? 'text-[var(--sw-brand-dark)]' : 'text-gray-500'}`}>{formatDeduction(maxWelfareDeduction)}</span>
                </label>

                <label className="p-2 bg-emerald-50/80 rounded border border-emerald-200 flex items-center justify-between cursor-pointer">
                  <div className="flex items-center gap-1.5">
                    <input type="checkbox" checked={useMealDeduction} onChange={(e) => setUseMealDeduction(e.target.checked)} className="rounded text-emerald-600" />
                    <Gift className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="font-bold text-gray-800">餐卡抵扣</span>
                  </div>
                  <span className={`font-bold tabular-nums ${maxMealDeduction ? 'text-emerald-700' : 'text-gray-500'}`}>{formatDeduction(maxMealDeduction)}</span>
                </label>
              </div>

              {/* 金额拆解明细 */}
              <div className="space-y-1.5 border-t border-gray-100 px-2 pt-2.5 text-xs tabular-nums text-gray-600">
                <div className="flex justify-between">
                  <span>商品金额小计:</span>
                  <span className="font-bold text-gray-800">¥{subtotal.toFixed(2)}</span>
                </div>
                <div className={`flex justify-between ${maxWelfareDeduction ? 'text-[var(--sw-brand)]' : 'text-gray-500'}`}>
                  <span>福利卡抵扣:</span>
                  <span>{formatDeduction(maxWelfareDeduction)}</span>
                </div>
                <div className={`flex justify-between ${maxMealDeduction ? 'text-emerald-700' : 'text-gray-500'}`}>
                  <span>餐卡抵扣:</span>
                  <span>{formatDeduction(maxMealDeduction)}</span>
                </div>
                <div className="flex justify-between font-bold text-gray-900 pt-1 border-t border-gray-100 text-sm">
                  <span>需补差额支付:</span>
                  <span className="text-[#E5484D] font-black text-base">¥{gapPayment.toFixed(2)}</span>
                </div>
              </div>

              </>}

              {paymentResult ? (
                <PaymentResultPage key={paymentResult.idempotencyKey} session={paymentResult} compact />
              ) : (
                <button
                  onClick={cartChanged ? refreshCheckout : handleCheckout}
                  disabled={isSubmittingOrder || refreshingCheckout}
                  aria-describedby={checkoutStatus ? checkoutStatusId : undefined}
                  className="w-full bg-[var(--sw-brand)] hover:bg-blue-700 text-white font-extrabold py-3 rounded-lg text-xs transition-all cursor-pointer shadow-md flex items-center justify-center gap-1.5"
                >
                  {cartChanged ? <RefreshCw className="w-4 h-4" /> : <Zap className="w-4 h-4 text-yellow-300" />}
                  {cartChanged
                    ? (refreshingCheckout ? '正在刷新…' : '刷新购物车并继续')
                    : (isSubmittingOrder ? '安全提交中…' : '确认并提交真实订单')}
                  <ArrowRight className="w-4 h-4" />
                </button>
              )}

              {checkoutStatus && (
                <div id={checkoutStatusId} role="status" className="rounded border border-blue-200 bg-blue-50/60 px-2.5 py-2 text-[11px] leading-relaxed text-gray-700">
                  {checkoutStatus}
                </div>
              )}

              <div className="text-[10px] text-gray-400 text-center flex items-center justify-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                <span>支付流程符合国企合规采购与财务报销规范</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

function CheckoutAddressForm({ onClose }: { onClose: () => void }) {
  const { addAddress, addresses } = useMall();
  const [regions, setRegions] = useState(getLoadedChinaRegions);
  const [regionLoadFailed, setRegionLoadFailed] = useState(false);
  const [provinceCode, setProvinceCode] = useState('');
  const [cityCode, setCityCode] = useState('');
  const [districtCode, setDistrictCode] = useState('');
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    let active = true;
    void loadChinaRegions().then(
      (loaded) => { if (active) setRegions(loaded); },
      () => { if (active) setRegionLoadFailed(true); },
    );
    return () => { active = false; };
  }, []);

  const province = regions?.find((region) => region.code === provinceCode);
  const city = province?.cities.find((region) => region.code === cityCode);
  const district = city?.districts.find((region) => region.code === districtCode);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !province || !city || !district) return;
    const fields = new FormData(event.currentTarget);
    const name = String(fields.get('name') ?? '').trim();
    const phone = String(fields.get('phone') ?? '').trim();
    const detail = String(fields.get('detail') ?? '').trim();
    if (!name || !detail || !/^1[3-9]\d{9}$/.test(phone)) return;

    setSaving(true);
    try {
      const saved = await addAddress({
        name,
        phone,
        province: province.name,
        city: city.name,
        district: district.name,
        detail,
        isDefault: addresses.length === 0,
        tag: '收货地址',
      });
      if (saved) onClose();
    } finally {
      setSaving(false);
    }
  };

  const fieldClass = 'w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900';
  const regionFieldClass = `${fieldClass} sw-checkout-region`;

  return (
    <form aria-label="新增收货地址" onSubmit={save} className="space-y-2.5 rounded border border-gray-200 bg-gray-50 p-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-gray-700">
          <span className="block">收货人</span>
          <input name="name" autoComplete="shipping name" pattern={'.*\\S.*'} required className={fieldClass} />
        </label>
        <label className="space-y-1 text-gray-700">
          <span className="block">手机号</span>
          <input name="phone" type="tel" autoComplete="shipping tel-national" pattern="1[3-9][0-9]{9}" required className={fieldClass} />
        </label>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <label className="space-y-1 text-gray-700">
          <span className="block">省</span>
          <select required disabled={!regions} className={regionFieldClass} value={provinceCode} onChange={(event) => {
            setProvinceCode(event.target.value);
            setCityCode('');
            setDistrictCode('');
          }}>
            <option value="">选择省</option>
            {regions?.map((region) => <option key={region.code} value={region.code}>{region.name}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-gray-700">
          <span className="block">市</span>
          <select required disabled={!province} className={regionFieldClass} value={cityCode} onChange={(event) => {
            setCityCode(event.target.value);
            setDistrictCode('');
          }}>
            <option value="">选择市</option>
            {province?.cities.map((region) => <option key={region.code} value={region.code}>{region.name}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-gray-700">
          <span className="block">区县</span>
          <select required disabled={!city} className={regionFieldClass} value={districtCode} onChange={(event) => setDistrictCode(event.target.value)}>
            <option value="">选择区县</option>
            {city?.districts.map((region) => <option key={region.code} value={region.code}>{region.name}</option>)}
          </select>
        </label>
      </div>
      {regionLoadFailed && <p role="alert" className="text-red-700">地区列表加载失败，请刷新页面后重试。</p>}
      <label className="block space-y-1 text-gray-700">
        <span className="block">详细地址</span>
        <input name="detail" autoComplete="shipping address-line1" pattern={'.*\\S.*'} required className={fieldClass} />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" disabled={saving} onClick={onClose} className="rounded border border-gray-200 bg-white px-3 py-1.5 text-gray-700 hover:bg-gray-100">取消</button>
        <button type="submit" disabled={saving || !district} className="rounded bg-[var(--sw-brand)] px-3 py-1.5 font-bold text-white hover:bg-blue-700 disabled:opacity-60">
          {saving ? '正在保存…' : '保存收货地址'}
        </button>
      </div>
    </form>
  );
}
