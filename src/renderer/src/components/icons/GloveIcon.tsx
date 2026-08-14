import React from 'react';

interface GloveIconProps {
  /** 图标边长（px）。 */
  size?: number;
  /** 附加 className（用于颜色/布局覆写）。 */
  className?: string;
  /** 描边粗细。 */
  strokeWidth?: number;
}

/**
 * 振动手套图标（描边线条风格，继承 currentColor）。
 *
 * 与 Header 其他工具图标（打开/库/设置等）保持一致的 24 网格描边语言：
 * 默认随按钮呈灰色，连接成功时由调用方切换为品牌蓝并叠加绿色状态点。
 * 图标基于 Lucide 的 "Hand" 造型绘制（ISC 许可）。
 */
export const GloveIcon: React.FC<GloveIconProps> = ({
  size = 20,
  className,
  strokeWidth = 1.8,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {/* 三根手指 */}
    <path d="M18 11V6a2 2 0 0 0-4 0v5" />
    <path d="M14 10V4a2 2 0 0 0-4 0v2" />
    <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
    {/* 掌部 + 拇指 */}
    <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
  </svg>
);
