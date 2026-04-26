type Props = { size?: number; className?: string };

const SPOKE = "M 15.19 13 L 14.886 5.114 A 1.114 1.114 0 0 1 17.114 5.114 L 16.81 13 Z";

export default function BrandMark({ size = 32, className = "" }: Props) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      className={className} role="img" aria-label="WhatIfSabha"
    >
      <defs>
        <filter id="bm-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="0.5" stdDeviation="0.4" floodOpacity="0.18" />
        </filter>
      </defs>
      <rect width="32" height="32" rx="8" fill="#c07820" filter="url(#bm-shadow)" />
      <g fill="#fef9c3">
        <path d={SPOKE} />
        <path d={SPOKE} transform="rotate(45 16 16)" />
        <path d={SPOKE} transform="rotate(90 16 16)" />
        <path d={SPOKE} transform="rotate(135 16 16)" />
        <path d={SPOKE} transform="rotate(180 16 16)" />
        <path d={SPOKE} transform="rotate(225 16 16)" />
        <path d={SPOKE} transform="rotate(270 16 16)" />
        <path d={SPOKE} transform="rotate(315 16 16)" />
      </g>
      <g fill="none" stroke="#fef9c3">
        <circle cx="16" cy="16" r="3" strokeWidth="1.62" />
        <circle cx="16" cy="16" r="9.5" strokeWidth="2.025" />
      </g>
    </svg>
  );
}
