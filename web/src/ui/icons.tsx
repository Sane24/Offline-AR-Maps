interface IconProps {
  size?: number
  strokeWidth?: number
}

const base = (size = 26) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

export const ArrowUp = ({ size, strokeWidth = 2.4 }: IconProps) => (
  <svg {...base(size)} strokeWidth={strokeWidth}>
    <path d="M12 20V5M5.5 11.5 12 5l6.5 6.5" />
  </svg>
)

export const ArrowLeftTurn = ({ size, strokeWidth = 2.4 }: IconProps) => (
  <svg {...base(size)} strokeWidth={strokeWidth}>
    <path d="M19 20v-7a4 4 0 0 0-4-4H5" />
    <path d="m9.5 4.5-4.5 4.5L9.5 13.5" />
  </svg>
)

export const ArrowRightTurn = ({ size, strokeWidth = 2.4 }: IconProps) => (
  <svg {...base(size)} strokeWidth={strokeWidth}>
    <path d="M5 20v-7a4 4 0 0 1 4-4h10" />
    <path d="m14.5 4.5 4.5 4.5-4.5 4.5" />
  </svg>
)

export const BearLeft = ({ size, strokeWidth = 2.4 }: IconProps) => (
  <svg {...base(size)} strokeWidth={strokeWidth}>
    <path d="M14 20c0-6-1-9-5-12" />
    <path d="M8.5 12.5 8 5.5l7 .5" transform="rotate(8 9 8)" />
  </svg>
)

export const BearRight = ({ size, strokeWidth = 2.4 }: IconProps) => (
  <svg {...base(size)} strokeWidth={strokeWidth}>
    <path d="M10 20c0-6 1-9 5-12" />
    <path d="m15.5 12.5.5-7-7 .5" transform="rotate(-8 15 8)" />
  </svg>
)

export const Switchback = ({ size, strokeWidth = 2.4 }: IconProps) => (
  <svg {...base(size)} strokeWidth={strokeWidth}>
    <path d="M7 20v-8a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v1" />
    <path d="m13.5 10.5 3.5 3 3-3.5" />
  </svg>
)

export const Flag = ({ size, strokeWidth = 2.2 }: IconProps) => (
  <svg {...base(size)} strokeWidth={strokeWidth}>
    <path d="M6 21V4" />
    <path d="M6 4h11l-2.5 3.5L17 11H6" fill="currentColor" stroke="none" />
  </svg>
)

export const Alert = ({ size, strokeWidth = 2.2 }: IconProps) => (
  <svg {...base(size)} strokeWidth={strokeWidth}>
    <path d="M12 3 2.5 20h19L12 3Z" />
    <path d="M12 10v4.5" />
    <circle cx="12" cy="17.2" r="0.4" fill="currentColor" />
  </svg>
)

export const Peak = ({ size, strokeWidth = 2.2 }: IconProps) => (
  <svg {...base(size)} strokeWidth={strokeWidth}>
    <path d="m3 19 6-11 4 7 3-4.5L21 19H3Z" />
  </svg>
)

export const UTurn = ({ size, strokeWidth = 2.4 }: IconProps) => (
  <svg {...base(size)} strokeWidth={strokeWidth}>
    <path d="M8 20v-9a4.5 4.5 0 0 1 9 0v3" />
    <path d="m13.5 11.5 3.5 3 3.5-3" transform="translate(0 2.5)" />
  </svg>
)

export const Play = ({ size = 18 }: IconProps) => (
  <svg {...base(size)} strokeWidth={0}>
    <path d="M8 5.5v13l10-6.5L8 5.5Z" fill="currentColor" />
  </svg>
)

export const Pause = ({ size = 18 }: IconProps) => (
  <svg {...base(size)} strokeWidth={0}>
    <path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" fill="currentColor" />
  </svg>
)

export const CameraIcon = ({ size = 18, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size)} strokeWidth={strokeWidth}>
    <path d="M4 8h3l2-2.5h6L17 8h3v11H4V8Z" />
    <circle cx="12" cy="13" r="3.2" />
  </svg>
)

export const CompassIcon = ({ size = 18, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size)} strokeWidth={strokeWidth}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" fill="currentColor" stroke="none" />
  </svg>
)

export const GpsIcon = ({ size = 18, strokeWidth = 2 }: IconProps) => (
  <svg {...base(size)} strokeWidth={strokeWidth}>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
  </svg>
)

/** Cairn mark: three stacked trail-marker stones. */
export const Logo = ({ size = 20, color = '#e0641e' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    <rect x="8.6" y="3.4" width="6.8" height="4.6" rx="2.3" />
    <rect x="6.6" y="9.7" width="10.8" height="4.6" rx="2.3" />
    <rect x="4.6" y="16" width="14.8" height="4.6" rx="2.3" />
  </svg>
)
