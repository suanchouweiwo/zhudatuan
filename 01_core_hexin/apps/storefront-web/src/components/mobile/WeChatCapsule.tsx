import { mallShortName } from '../../domain/brand/productBrand';
import React from 'react';
import { useMall } from '../../context/MallContext';
import { MoreHorizontal, Circle, Building2, ChevronDown } from 'lucide-react';

interface WeChatCapsuleProps {
  title?: string;
  showBack?: boolean;
  onBack?: () => void;
}

export const WeChatCapsule: React.FC<WeChatCapsuleProps> = ({ title, showBack, onBack }) => {
  const { currentMall, malls, switchMall, triggerPendingFeature } = useMall();
  const [showMallDropdown, setShowMallDropdown] = React.useState(false);

  return (
    <div className="bg-[var(--sw-brand-dark)] text-white select-none sticky top-0 z-40 shadow-xs">
      {/* 微信小程序 Header 与 右上角胶囊按钮 (Capsule) */}
      <div className="px-3 py-2.5 flex items-center justify-between relative">
        {/* 左侧：企业切换或返回按钮 */}
        <div className="flex items-center gap-2 max-w-[200px]">
          {showBack ? (
            <button onClick={onBack} className="text-white hover:text-yellow-300 transition-colors p-1 flex items-center gap-0.5 text-xs font-medium cursor-pointer">
              <span>‹</span>
              <span>返回</span>
            </button>
          ) : (
            <div className="relative">
              <button
                onClick={() => setShowMallDropdown(!showMallDropdown)}
                className="bg-white/15 hover:bg-white/25 text-white px-2.5 py-1 text-xs font-semibold flex items-center gap-1 transition-[background-color,border-color,box-shadow] border border-white/20 hover:border-white/40 hover:shadow-sm cursor-pointer"
              >
                <img src="/brand/morvia-mark-white.svg" alt="" className="h-5 w-5 flex-shrink-0" />
                <span className="truncate max-w-[110px]">{mallShortName(currentMall.mallName)}</span>
                <ChevronDown className="w-3 h-3 opacity-80 flex-shrink-0" />
              </button>

              {/* 企业切换 Popover */}
              {showMallDropdown && (
                <div className="absolute left-0 top-full mt-1.5 w-52 bg-white text-gray-800 shadow-xl border border-gray-100 p-1.5 z-50 text-xs animate-in fade-in duration-150">
                  <div className="text-[10px] text-gray-400 font-bold px-2.5 py-1 uppercase tracking-wider">切换所属企采空间</div>
                  {malls.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => {
                        switchMall(m.id);
                        setShowMallDropdown(false);
                      }}
                      className={`w-full text-left px-2.5 py-2 transition-colors flex items-center justify-between ${m.id === currentMall.id ? 'bg-blue-50 text-[var(--sw-brand)] font-bold' : 'hover:bg-gray-50 text-gray-700'}`}
                    >
                      <span className="truncate">{m.mallName}</span>
                      {m.id === currentMall.id && <span className="w-1.5 h-1.5 rounded-full bg-[var(--sw-brand)]" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 中间：页面标题 (有 title 时显示) */}
        {title && <div className="font-bold text-sm tracking-tight truncate max-w-[120px] text-center">{title}</div>}

        {/* 右侧：高保真微信小程序原生胶囊组件 (Capsule) */}
        <div className="flex items-center bg-black/20 backdrop-blur-sm border border-white/25 px-2 py-1 text-white gap-2 flex-shrink-0 shadow-sm">
          <button
            onClick={() => triggerPendingFeature('微信小程序页面分享与菜单', '小程序胶囊菜单包含：发送给朋友、分享到朋友圈、复制页面路径、重新加载。')}
            className="hover:text-yellow-300 transition-colors cursor-pointer"
            title="小程序菜单"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          <div className="w-[1px] h-3 bg-white/30" />
          <button onClick={() => triggerPendingFeature('微信小程序胶囊关闭/挂起', '模拟退出小程序回到微信聊天列表。')} className="hover:text-[#FF7A00] transition-colors cursor-pointer" title="关闭小程序">
            <Circle className="w-3.5 h-3.5 fill-current opacity-90" />
          </button>
        </div>
      </div>
    </div>
  );
};
