import { useId, type SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base(size = 18, other: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...other,
  };
}

export const IconSearch = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

export const IconMusic = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M9 18V6l12-2v12" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </svg>
);

export const IconCompass = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="m15 9-2 6-6 2 2-6z" />
  </svg>
);

export const IconBell = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10 21a2 2 0 0 0 4 0" />
  </svg>
);

export const IconUpload = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 15V4" />
    <path d="m7 9 5-5 5 5" />
    <path d="M5 20h14" />
  </svg>
);

export const IconChevronRight = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}><path d="m9 6 6 6-6 6" /></svg>
);

export const IconChevronLeft = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}><path d="m15 6-6 6 6 6" /></svg>
);

export const IconArrowLeft = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}><path d="m15 18-6-6 6-6" /></svg>
);

export const IconArrowRight = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}><path d="m9 18 6-6-6-6" /></svg>
);

export const IconPlus = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}><path d="M12 5v14M5 12h14" /></svg>
);

export const IconPlay = ({ size, ...p }: IconProps) => (
  <svg width={size ?? 18} height={size ?? 18} viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M8 5.5v13a1 1 0 0 0 1.53.85l10.5-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5z" />
  </svg>
);

export const IconPause = ({ size, ...p }: IconProps) => (
  <svg width={size ?? 18} height={size ?? 18} viewBox="0 0 24 24" fill="currentColor" {...p}>
    <rect x="6" y="5" width="4" height="14" rx="1" />
    <rect x="14" y="5" width="4" height="14" rx="1" />
  </svg>
);

export const IconSkipBack = ({ size, ...p }: IconProps) => (
  <svg width={size ?? 18} height={size ?? 18} viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M7 5a1 1 0 0 1 2 0v5.4l9.47-5.85A1 1 0 0 1 21 5.5v13a1 1 0 0 1-1.53.85L9 13.6V19a1 1 0 0 1-2 0V5z" />
  </svg>
);

export const IconSkipForward = ({ size, ...p }: IconProps) => (
  <svg width={size ?? 18} height={size ?? 18} viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M17 5a1 1 0 0 0-2 0v5.4L5.53 4.55A1 1 0 0 0 3 5.5v13a1 1 0 0 0 1.53.85L15 13.6V19a1 1 0 0 0 2 0V5z" />
  </svg>
);

export const IconShuffle = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M16 3h5v5" />
    <path d="M4 20 21 3" />
    <path d="M21 16v5h-5" />
    <path d="m15 15 6 6" />
    <path d="M4 4l5 5" />
  </svg>
);

export const IconRepeat = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="m17 2 4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
    <path d="m7 22-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </svg>
);

export const IconVolume = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M11 5 6 9H3v6h3l5 4V5z" />
    <path d="M16 9a5 5 0 0 1 0 6" />
    <path d="M19 6a9 9 0 0 1 0 12" />
  </svg>
);

export const IconList = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M8 6h13M8 12h13M8 18h13" />
    <circle cx="4" cy="6" r="1" />
    <circle cx="4" cy="12" r="1" />
    <circle cx="4" cy="18" r="1" />
  </svg>
);

export const IconDots = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="5" cy="12" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="19" cy="12" r="1.5" />
  </svg>
);

export const IconMenu = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}><path d="M4 6h16M4 12h16M4 18h16" /></svg>
);

export const IconSidebar = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </svg>
);

export const IconPanelLeftClose = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
    <path d="m16 15-3-3 3-3" />
  </svg>
);

export const IconPanelLeftOpen = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
    <path d="m14 15 3-3-3-3" />
  </svg>
);

export const IconSettings = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export const IconClock = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const IconDownload = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M12 4v12" />
    <path d="m7 11 5 5 5-5" />
    <path d="M5 20h14" />
  </svg>
);

export const IconX = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}><path d="M6 6l12 12M6 18 18 6" /></svg>
);

export const IconMinus = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}><path d="M5 12h14" /></svg>
);

export const IconMaximize = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}><rect x="5" y="5" width="14" height="14" rx="1.5" /></svg>
);

export const IconAutoplay = ({ size, ...p }: IconProps) => (
  <svg {...base(size, p)}>
    <path d="M15.5 6.5a4 4 0 0 0-5.66 0L9 7.34l-.84-.84a4 4 0 1 0-5.66 5.66L9 18.66l6.5-6.5a4 4 0 0 0 0-5.66z" />
    <path d="M9 7.34l-3-3" />
    <path d="M15.5 6.5l3 3" />
  </svg>
);

export const IconYoutube = ({ size, ...p }: IconProps) => {
  const clipId = useId();
  return (
    <svg width={size ?? 18} height={size ?? 18} viewBox="0 0 24 24" {...p}>
      <defs>
        <clipPath id={clipId}>
          <circle cx="12" cy="12" r="12" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect width="24" height="24" fill="white" />
        <path
          d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.104c-3.924 0-7.104-3.18-7.104-7.104S8.076 4.896 12 4.896s7.104 3.18 7.104 7.104-3.18 7.104-7.104 7.104zm0-13.332c-3.432 0-6.228 2.796-6.228 6.228S8.568 18.228 12 18.228s6.228-2.796 6.228-6.228S15.432 5.772 12 5.772zM9.684 15.54V8.46L15.816 12l-6.132 3.54z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
};

export const IconAppleMusic = ({ size, ...p }: IconProps) => {
  const clipId = useId();
  return (
    <svg width={size ?? 18} height={size ?? 18} viewBox="0 0 24 24" {...p}>
      <defs>
        <clipPath id={clipId}>
          <path d="M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.062-2.31-2.18-3.043a5.022 5.022 0 00-1.877-.726 10.496 10.496 0 00-1.564-.15c-.04-.003-.083-.01-.124-.013H5.986c-.152.01-.303.017-.455.026-.747.043-1.49.123-2.193.4-1.336.53-2.3 1.452-2.865 2.78-.192.448-.292.925-.363 1.408-.056.392-.088.785-.1 1.18 0 .032-.007.062-.01.093v12.223c.01.14.017.283.027.424.05.815.154 1.624.497 2.373.65 1.42 1.738 2.353 3.234 2.801.42.127.856.187 1.293.228.555.053 1.11.06 1.667.06h11.03a12.5 12.5 0 001.57-.1c.822-.106 1.596-.35 2.295-.81a5.046 5.046 0 001.88-2.207c.186-.42.293-.87.37-1.324.113-.675.138-1.358.137-2.04-.002-3.8 0-7.595-.003-11.393z" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect width="24" height="24" fill="white" />
        <path
          d="M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.062-2.31-2.18-3.043a5.022 5.022 0 00-1.877-.726 10.496 10.496 0 00-1.564-.15c-.04-.003-.083-.01-.124-.013H5.986c-.152.01-.303.017-.455.026-.747.043-1.49.123-2.193.4-1.336.53-2.3 1.452-2.865 2.78-.192.448-.292.925-.363 1.408-.056.392-.088.785-.1 1.18 0 .032-.007.062-.01.093v12.223c.01.14.017.283.027.424.05.815.154 1.624.497 2.373.65 1.42 1.738 2.353 3.234 2.801.42.127.856.187 1.293.228.555.053 1.11.06 1.667.06h11.03a12.5 12.5 0 001.57-.1c.822-.106 1.596-.35 2.295-.81a5.046 5.046 0 001.88-2.207c.186-.42.293-.87.37-1.324.113-.675.138-1.358.137-2.04-.002-3.8 0-7.595-.003-11.393zm-6.423 3.99v5.712c0 .417-.058.827-.244 1.206-.29.59-.76.962-1.388 1.14-.35.1-.706.157-1.07.173-.95.045-1.773-.6-1.943-1.536a1.88 1.88 0 011.038-2.022c.323-.16.67-.25 1.018-.324.378-.082.758-.153 1.134-.24.274-.063.457-.23.51-.516a.904.904 0 00.02-.193c0-1.815 0-3.63-.002-5.443a.725.725 0 00-.026-.185c-.04-.15-.15-.243-.304-.234-.16.01-.318.035-.475.066-.76.15-1.52.303-2.28.456l-2.325.47-1.374.278c-.016.003-.032.01-.048.013-.277.077-.377.203-.39.49-.002.042 0 .086 0 .13-.002 2.602 0 5.204-.003 7.805 0 .42-.047.836-.215 1.227-.278.64-.77 1.04-1.434 1.233-.35.1-.71.16-1.075.172-.96.036-1.755-.6-1.92-1.544-.14-.812.23-1.685 1.154-2.075.357-.15.73-.232 1.108-.31.287-.06.575-.116.86-.177.383-.083.583-.323.6-.714v-.15c0-2.96 0-5.922.002-8.882 0-.123.013-.25.042-.37.07-.285.273-.448.546-.518.255-.066.515-.112.774-.165.733-.15 1.466-.296 2.2-.444l2.27-.46c.67-.134 1.34-.27 2.01-.403.22-.043.442-.088.663-.106.31-.025.523.17.554.482.008.073.012.148.012.223.002 1.91.002 3.822 0 5.732z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
};




