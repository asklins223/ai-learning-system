"use client";

import Link from "next/link";
import { type ReactNode, forwardRef } from "react";

/**
 * ButtonLink — 导航链接，视觉与 Button 一致，但使用真实 <a> / Next Link。
 *
 * 规范：UI-REFACTOR-AI-IMPLEMENTATION-SPEC.md §9.1
 * - Link 导航使用真实 a / Next Link，不得用 button 模拟
 * - variant / size / icon 支持与 Button 对齐
 */

export type ButtonLinkVariant = "primary" | "secondary" | "ghost" | "danger" | "text";
export type ButtonLinkSize = "sm" | "md" | "touch";

interface ButtonLinkProps {
  href: string;
  variant?: ButtonLinkVariant;
  size?: ButtonLinkSize;
  children: ReactNode;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  className?: string;
  /** 新窗口打开 */
  external?: boolean;
  /** 替代当前历史记录 */
  replace?: boolean;
  prefetch?: boolean;
}

const variantClass: Record<ButtonLinkVariant, string> = {
  primary: "button primary",
  secondary: "button button-secondary",
  ghost: "button button-ghost",
  danger: "button button-danger",
  text: "button button-text",
};

const sizeClass: Record<ButtonLinkSize, string> = {
  sm: "button-sm",
  md: "",
  touch: "button-touch",
};

export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(
  function ButtonLink(
    {
      href,
      variant = "primary",
      size = "md",
      children,
      leadingIcon,
      trailingIcon,
      className = "",
      external = false,
      replace,
      prefetch,
    },
    ref,
  ) {
    const classes = [
      variantClass[variant],
      sizeClass[size],
      className,
    ].filter(Boolean).join(" ");

    if (external) {
      return (
        <a
          ref={ref}
          href={href}
          className={classes}
          target="_blank"
          rel="noopener noreferrer"
        >
          {leadingIcon && <span className="button-icon leading">{leadingIcon}</span>}
          {children}
          {trailingIcon && <span className="button-icon trailing">{trailingIcon}</span>}
        </a>
      );
    }

    return (
      <Link
        ref={ref}
        href={href}
        className={classes}
        replace={replace}
        prefetch={prefetch}
      >
        {leadingIcon && <span className="button-icon leading">{leadingIcon}</span>}
        {children}
        {trailingIcon && <span className="button-icon trailing">{trailingIcon}</span>}
      </Link>
    );
  },
);
